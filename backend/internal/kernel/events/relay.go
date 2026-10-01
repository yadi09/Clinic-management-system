package events

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

// Relay drains the outbox and dispatches events to registered handlers. It runs
// in the worker process. Each event is processed in its own transaction with
// FOR UPDATE SKIP LOCKED so multiple workers can run safely and a poison
// message cannot block the queue (it is retried, then dead-lettered).
type Relay struct {
	db          *kerneldb.DB
	reg         *Registry
	log         *slog.Logger
	batchSize   int
	maxAttempts int
}

// NewRelay constructs a Relay.
func NewRelay(db *kerneldb.DB, reg *Registry, log *slog.Logger) *Relay {
	return &Relay{db: db, reg: reg, log: log, batchSize: 100, maxAttempts: 5}
}

// Run polls the outbox on an interval until the context is cancelled.
func (r *Relay) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := r.RunOnce(ctx); err != nil {
				r.log.Error("outbox relay error", "err", err)
			} else if n > 0 {
				r.log.Debug("outbox relay dispatched", "count", n)
			}
		}
	}
}

// RunOnce dispatches up to batchSize pending events and returns how many were
// processed (dispatched or retried/dead-lettered).
func (r *Relay) RunOnce(ctx context.Context) (int, error) {
	processed := 0
	for i := 0; i < r.batchSize; i++ {
		more, err := r.processOne(ctx)
		if err != nil {
			return processed, err
		}
		if !more {
			break
		}
		processed++
	}
	return processed, nil
}

func (r *Relay) processOne(ctx context.Context) (bool, error) {
	found := false
	err := r.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var e Event
		var attempts int
		row := tx.QueryRow(ctx,
			`SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, attempts, actor_id, branch_id
			   FROM event_outbox
			  WHERE dispatched_at IS NULL AND dead_lettered = false
			  ORDER BY sequence
			  LIMIT 1
			  FOR UPDATE SKIP LOCKED`)
		if err := row.Scan(&e.ID, &e.TenantID, &e.AggregateType, &e.AggregateID, &e.EventType, &e.Payload, &attempts, &e.ActorID, &e.BranchID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		found = true

		if derr := r.dispatch(ctx, e); derr != nil {
			attempts++
			dead := attempts >= r.maxAttempts
			r.log.Warn("event handler failed", "event_type", e.EventType, "event_id", e.ID, "attempts", attempts, "dead_lettered", dead, "err", derr)
			_, uerr := tx.Exec(ctx,
				`UPDATE event_outbox SET attempts = $1, last_error = $2, dead_lettered = $3 WHERE id = $4`,
				attempts, derr.Error(), dead, e.ID)
			return uerr
		}
		_, uerr := tx.Exec(ctx, `UPDATE event_outbox SET dispatched_at = now() WHERE id = $1`, e.ID)
		return uerr
	})
	return found, err
}

func (r *Relay) dispatch(ctx context.Context, e Event) error {
	for _, h := range r.reg.handlersFor(e.EventType) {
		if err := h(ctx, e); err != nil {
			return err
		}
	}
	return nil
}
