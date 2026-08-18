package dispatch

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
)

// Reconciler asks the gateway what became of messages it accepted.
//
// "Sent" only means the network took it. Whether it reached a handset is a
// different fact, and it is the one the front desk is actually asked about — a
// patient who says "I never got a reminder" is not disputing that we tried.
//
// Polling rather than the gateway's webhook, deliberately. Their callback is a paid
// add-on that support has to switch on per campaign, it carries no signature so
// anyone who learns the URL could post a false confirmation, and it currently fires
// only on success — a message that fails produces no callback at all. Their own
// documentation points at the status endpoint for reconciliation, and that endpoint
// answers only for our own campaign, which makes it the one authoritative check
// available.
type Reconciler struct {
	db  *kerneldb.DB // privileged: the queue spans tenants
	gw  sms.Gateway
	log *slog.Logger
}

// NewReconciler constructs a Reconciler over the privileged pool.
func NewReconciler(db *kerneldb.DB, gw sms.Gateway, log *slog.Logger) *Reconciler {
	return &Reconciler{db: db, gw: gw, log: log}
}

// maxStatusChecks bounds how many times one message is asked about.
//
// Not politeness — necessity. Messages sent before the gateway's status upgrade
// rolled out stay ACCEPTED permanently, so a reconciler without a ceiling chases
// them forever and the worklist only ever grows. Twelve checks over the schedule
// below covers about a day, which is far longer than a delivery that is ever going
// to happen.
const maxStatusChecks = 12

// reconcileBatch is how many are checked per tick. Small: this is background work
// competing with sending for the account's shared rate limit, and sending wins.
const reconcileBatch = 20

// Run polls until the context is cancelled.
func (r *Reconciler) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := r.RunOnce(ctx); err != nil {
				r.log.Error("delivery reconcile error", "err", err)
			} else if n > 0 {
				r.log.Debug("delivery statuses checked", "count", n)
			}
		}
	}
}

type pending struct {
	id     uuid.UUID
	gwID   string
	checks int
}

// RunOnce checks a batch of accepted-but-unconfirmed messages.
func (r *Reconciler) RunOnce(ctx context.Context) (int, error) {
	if !r.gw.Live() {
		return 0, nil
	}
	var batch []pending
	err := r.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		// Back off between checks rather than asking every tick: each ask spends the
		// account's shared rate limit. The first gap is short because the gateway
		// delivers in about a second, so the great majority confirm on the first or
		// second look and the clinic sees "Delivered" almost at once; the interval
		// then doubles so the rare straggler is not polled all day.
		rows, e := tx.Query(ctx,
			`SELECT id, gateway_id, status_checks
			   FROM messages
			  WHERE status = 'sent'
			    AND gateway_id IS NOT NULL
			    AND status_checks < $1
			    AND (status_checked_at IS NULL
			         OR status_checked_at < now() - (interval '15 seconds' * power(2, LEAST(status_checks, 6))))
			  ORDER BY status_checked_at NULLS FIRST
			  LIMIT $2`, maxStatusChecks, reconcileBatch)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var p pending
			if e := rows.Scan(&p.id, &p.gwID, &p.checks); e != nil {
				return e
			}
			batch = append(batch, p)
		}
		return rows.Err()
	})
	if err != nil || len(batch) == 0 {
		return 0, err
	}

	done := 0
	for _, p := range batch {
		if ctx.Err() != nil {
			break
		}
		del, e := r.gw.Status(ctx, p.gwID)
		if errors.Is(e, sms.ErrNoStatus) {
			return done, nil // this gateway cannot answer; stop asking entirely
		}
		if e := r.record(ctx, p, del, e); e != nil {
			return done, e
		}
		done++
	}
	return done, nil
}

// record writes back what the gateway said, or notes that we asked and got nowhere.
func (r *Reconciler) record(ctx context.Context, p pending, del *sms.Delivery, callErr error) error {
	return r.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		if callErr != nil {
			// A permanent error means this message will never be looked up
			// successfully — its id is unknown to the gateway, or the key is wrong.
			// Stop asking by exhausting its budget rather than retrying forever.
			checks := p.checks + 1
			if sms.IsPermanent(callErr) {
				checks = maxStatusChecks
			}
			_, e := tx.Exec(ctx,
				`UPDATE messages SET status_checks = $2, status_checked_at = now(), updated_at = now()
				  WHERE id = $1`, p.id, checks)
			return e
		}
		if del != nil && del.Final() {
			// The one upgrade this whole loop exists for: a handset confirmed it.
			_, e := tx.Exec(ctx,
				`UPDATE messages
				    SET status = 'delivered', gateway_status = $2, delivered_at = now(),
				        status_checked_at = now(), status_checks = status_checks + 1, updated_at = now()
				  WHERE id = $1`, p.id, del.Status)
			return e
		}
		status := ""
		if del != nil {
			status = del.Status
		}
		_, e := tx.Exec(ctx,
			`UPDATE messages
			    SET gateway_status = COALESCE(NULLIF($2,''), gateway_status),
			        status_checked_at = now(), status_checks = status_checks + 1, updated_at = now()
			  WHERE id = $1`, p.id, status)
		return e
	})
}
