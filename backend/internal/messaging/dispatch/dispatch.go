// Package dispatch drains the message queue and puts text on phones.
//
// It runs in the worker beside the event relay and borrows that relay's
// discipline — one row at a time, FOR UPDATE SKIP LOCKED, bounded attempts, a
// terminal state on give-up — because the failure it is guarding against is the
// same one: a queue that stalls behind a poison row, or a row processed twice.
// Here a double-process costs the clinic money and messages a patient twice, so
// the bar is higher, not lower.
//
// It uses the RLS-bypassing pool, as the platform module does, because one queue
// spans every tenant. It never hands rows to a user: it reads what is due, acts,
// and writes the outcome back to the same row.
//
// Three gates stand between a queued message and the gateway — sending switched
// on, quiet hours, monthly allowance. A message stopped by one of them is written
// back with the reason, never dropped, because the question the front desk will
// ask is "why didn't she get it?" and there has to be an answer.
package dispatch

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
)

// maxAttempts is how many times a message is retried before it is given up on.
// Lower than the event relay's, because a message that has failed four times over
// an hour is not going to succeed on the fifth, and an appointment reminder that
// arrives after the appointment is worse than none.
const maxAttempts = 4

// maxAmbiguousAttempts is the leash on failures where we never heard back at all —
// a timeout, a dropped connection. The gateway has no idempotency key, so it may
// well have accepted a message whose reply we lost, and every retry of one of those
// risks charging the clinic twice and buzzing the patient twice. An explicit
// refusal is safe to retry because the gateway told us it did not take it; silence
// is not, so silence gets one more go and then stops.
const maxAmbiguousAttempts = 2

// batchSize caps one tick. Sending is sequential, so this is also the pace: at a
// 10-second tick it is roughly 300 a minute, enough to clear a whole clinic's
// patient list in a couple of minutes without hammering a gateway that has no
// bulk endpoint.
const batchSize = 50

// Dispatcher sends what is due.
type Dispatcher struct {
	db  *kerneldb.DB // privileged: the queue spans tenants
	gw  sms.Gateway
	log *slog.Logger
}

// New constructs a Dispatcher over the privileged pool.
func New(db *kerneldb.DB, gw sms.Gateway, log *slog.Logger) *Dispatcher {
	return &Dispatcher{db: db, gw: gw, log: log}
}

// Run polls until the context is cancelled.
func (d *Dispatcher) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := d.RunOnce(ctx); err != nil {
				d.log.Error("message dispatch error", "err", err)
			} else if n > 0 {
				d.log.Info("messages dispatched", "count", n)
			}
		}
	}
}

// stuckAfter is how long a message may sit mid-send before it is assumed abandoned.
// Generous: the HTTP client gives up at 20 seconds, so anything past a few minutes
// means the worker died or a write failed, not that the gateway is slow.
const stuckAfter = "5 minutes"

// recoverStuck rescues messages left in 'sending'.
//
// Only 'scheduled' rows are picked up, so a row stranded mid-send is invisible
// forever — the patient never hears from us and the log shows a state that cannot
// change. That happens if the worker is killed between claiming and writing back,
// or if the write itself fails.
//
// Which way to resolve it is decided by whether we have a gateway id. With one, the
// gateway definitely accepted the message and 'sent' is the truth. Without one we
// cannot know, and requeueing would risk a second charge and a second buzz for a
// patient who already got it — so it is failed with a plain explanation, and a human
// decides whether to send again. Losing a message is recoverable; sending it twice
// and denying it is not.
func (d *Dispatcher) recoverStuck(ctx context.Context) error {
	return d.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE messages
			    SET status = CASE WHEN gateway_id IS NOT NULL THEN 'sent' ELSE 'failed' END,
			        sent_at = CASE WHEN gateway_id IS NOT NULL THEN coalesce(sent_at, now()) ELSE sent_at END,
			        last_error = CASE WHEN gateway_id IS NOT NULL THEN last_error
			                          ELSE 'interrupted while sending — we cannot tell whether it arrived, so it was not retried' END,
			        updated_at = now()
			  WHERE status = 'sending' AND updated_at < now() - $1::interval`, stuckAfter)
		if e != nil {
			return e
		}
		if n := ct.RowsAffected(); n > 0 {
			d.log.Warn("recovered messages stranded mid-send", "count", n)
		}
		return nil
	})
}

// RunOnce processes up to batchSize due messages and returns how many it handled.
func (d *Dispatcher) RunOnce(ctx context.Context) (int, error) {
	if err := d.recoverStuck(ctx); err != nil {
		return 0, err
	}
	done := 0
	for i := 0; i < batchSize; i++ {
		more, err := d.processOne(ctx)
		if err != nil {
			return done, err
		}
		if !more {
			break
		}
		done++
	}
	return done, nil
}

type due struct {
	id       uuid.UUID
	tenantID uuid.UUID
	msisdn   string
	body     string
	segments int
	attempts int
	// enabled is the clinic's master switch.
	enabled bool
	// quiet says the local clock is inside the clinic's quiet hours right now.
	quiet bool
	// nextOpen is when those quiet hours end, in absolute time.
	nextOpen time.Time
}

func (d *Dispatcher) processOne(ctx context.Context) (bool, error) {
	var m due
	found := false

	// Claim a row and read everything the decision needs, in one locked read.
	err := d.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		// The quiet-hours arithmetic is done by Postgres in the clinic's own
		// timezone. Doing it in Go would mean shipping a timezone database into the
		// worker image and getting DST-free Addis right by luck rather than design.
		//
		// nextOpen reads as: today at the hour quiet ends, or tomorrow if that hour
		// has already passed. That is correct whether or not the quiet window wraps
		// midnight, which is why it is expressed this way rather than as two cases.
		e := tx.QueryRow(ctx,
			`SELECT m.id, m.tenant_id, m.msisdn, m.body, m.segments, m.attempts,
			        c.sms_enabled,
			        CASE WHEN c.sms_quiet_from = c.sms_quiet_to THEN false
			             WHEN c.sms_quiet_from < c.sms_quiet_to
			               THEN (now() AT TIME ZONE c.timezone)::time >= c.sms_quiet_from
			                AND (now() AT TIME ZONE c.timezone)::time <  c.sms_quiet_to
			             ELSE (now() AT TIME ZONE c.timezone)::time >= c.sms_quiet_from
			               OR  (now() AT TIME ZONE c.timezone)::time <  c.sms_quiet_to
			        END AS in_quiet,
			        (date_trunc('day', now() AT TIME ZONE c.timezone)
			           + c.sms_quiet_to
			           + CASE WHEN (now() AT TIME ZONE c.timezone)::time < c.sms_quiet_to
			                  THEN interval '0 day' ELSE interval '1 day' END
			        ) AT TIME ZONE c.timezone AS next_open
			   FROM messages m
			   JOIN LATERAL (
			         SELECT * FROM clinics c2
			          WHERE c2.tenant_id = m.tenant_id AND c2.deleted_at IS NULL
			          ORDER BY c2.created_at LIMIT 1
			        ) c ON true
			  WHERE m.status = 'scheduled' AND m.scheduled_for <= now()
			  ORDER BY m.scheduled_for
			  LIMIT 1
			  FOR UPDATE OF m SKIP LOCKED`).
			Scan(&m.id, &m.tenantID, &m.msisdn, &m.body, &m.segments, &m.attempts,
				&m.enabled, &m.quiet, &m.nextOpen)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e != nil {
			return e
		}
		found = true

		// Gate 1 — the clinic turned sending off after this was queued.
		if !m.enabled {
			return skip(ctx, tx, m.id, "sending_off")
		}

		// Gate 2 — quiet hours. Deferred, never dropped: a 4am reminder is still
		// wanted at 7am. The row stays 'scheduled' and comes back round.
		if m.quiet {
			_, e := tx.Exec(ctx,
				`UPDATE messages SET scheduled_for = $2, updated_at = now() WHERE id = $1`,
				m.id, m.nextOpen)
			return e
		}

		// Gate 3 — the platform has no gateway credentials. Marked as skipped
		// rather than sent, because a log that says "sent" when nothing left the
		// building is worse than no log at all.
		if !d.gw.Live() {
			return skip(ctx, tx, m.id, "not_configured")
		}

		// Gate 4 — this month's allowance.
		if e := limits.EnsureSMSRoom(ctx, tx, m.tenantID, int64(m.segments)); e != nil {
			return skip(ctx, tx, m.id, "quota")
		}

		// Claimed. Marking it 'sending' inside the same transaction as the lock
		// means a worker that dies mid-send leaves evidence rather than a row that
		// silently reappears in the queue and charges the clinic twice.
		_, e = tx.Exec(ctx,
			`UPDATE messages SET status = 'sending', attempts = attempts + 1, updated_at = now()
			  WHERE id = $1`, m.id)
		return e
	})
	if err != nil || !found {
		return found, err
	}

	// Re-read the claim: the transaction above may have deferred or skipped it, in
	// which case there is nothing to send.
	var claimed bool
	if e := d.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT status = 'sending' FROM messages WHERE id = $1`, m.id).Scan(&claimed)
	}); e != nil {
		return true, e
	}
	if !claimed {
		return true, nil
	}

	// The send itself happens outside a transaction. Holding a row lock across a
	// network call to a third party is how a slow gateway becomes a database
	// incident.
	receipt, sendErr := d.gw.Send(ctx, sms.Message{MSISDN: m.msisdn, Text: m.body})

	return true, d.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		if sendErr == nil {
			// The gateway's segment count is authoritative — it is what was actually
			// deducted from the package. Our pre-send estimate priced the draft; this
			// is the bill, so the quota and the log both switch to it.
			segs := m.segments
			if receipt != nil && receipt.Segments > 0 {
				segs = receipt.Segments
				if segs != m.segments {
					d.log.Info("segment estimate differed from the gateway",
						"id", m.id, "estimated", m.segments, "charged", segs)
				}
			}
			var gwID, gwStatus *string
			if receipt != nil {
				if receipt.ID != "" {
					gwID = &receipt.ID
				}
				if receipt.Status != "" {
					gwStatus = &receipt.Status
				}
			}
			_, e := tx.Exec(ctx,
				`UPDATE messages
				    SET status = 'sent', sent_at = now(), last_error = NULL,
				        -- Cast both uses: the same parameter is an int as a column value
				        -- and a numeric inside the arithmetic, and Postgres will not
				        -- infer one type for both.
				        segments = $2::int,
				        cost = round(cost / GREATEST(segments, 1) * $2::numeric, 4),
				        gateway_id = $3, gateway_status = $4, updated_at = now()
				  WHERE id = $1`, m.id, segs, gwID, gwStatus)
			return e
		}

		attempts := m.attempts + 1
		// A refusal the gateway spelled out — bad number, no credit, sender not
		// approved — will be refused identically forever. Retrying it burns attempts,
		// delays everything behind it, and tells the clinic nothing new.
		permanent := sms.IsPermanent(sendErr)
		ambiguous := !permanent && attempts >= maxAmbiguousAttempts && isSilence(sendErr)
		if permanent || ambiguous || attempts >= maxAttempts {
			why := "gave up after retries"
			switch {
			case permanent:
				why = "refused by the gateway"
			case ambiguous:
				why = "no reply from the gateway; not retried again to avoid sending twice"
			}
			d.log.Warn("message not sent", "id", m.id, "attempts", attempts, "why", why, "err", sendErr)
			_, e := tx.Exec(ctx,
				`UPDATE messages SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
				m.id, sendErr.Error())
			return e
		}
		wait := backoff(attempts)
		if ra := sms.RetryAfter(sendErr); ra > 0 {
			// The gateway's rate limit is per account and shared by every clinic, so
			// when it asks us to wait, waiting is the only correct response.
			wait = fmt.Sprintf("%d seconds", int(ra.Seconds()))
		}
		_, e := tx.Exec(ctx,
			`UPDATE messages
			    SET status = 'scheduled', scheduled_for = now() + $3::interval,
			        last_error = $2, updated_at = now()
			  WHERE id = $1`,
			m.id, sendErr.Error(), wait)
		return e
	})
}

// isSilence reports whether we never got an answer, as opposed to being told no.
// Only these are ambiguous about whether the message was taken.
func isSilence(err error) bool {
	return strings.Contains(err.Error(), "could not reach the SMS gateway")
}

// skip writes a terminal non-send with the reason a person will read.
func skip(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) error {
	_, e := tx.Exec(ctx,
		`UPDATE messages SET status = 'skipped', skip_reason = $2, updated_at = now() WHERE id = $1`,
		id, reason)
	return e
}

// backoff spaces out retries. Short at first — most failures are a blip — then
// long enough that a gateway outage is not hammered.
func backoff(attempt int) string {
	switch attempt {
	case 1:
		return "1 minute"
	case 2:
		return "5 minutes"
	default:
		return "20 minutes"
	}
}
