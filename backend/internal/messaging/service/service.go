// Package service implements the messaging use-cases: how a clinic sends, what it
// has spent, what it has said, and a way to prove the path works before aiming it
// at six hundred people.
package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/messaging"
)

var _ messaging.Service = (*Service)(nil)

// Service is the messaging implementation.
type Service struct {
	db      *kerneldb.DB
	gateway sms.Gateway
	cost    float64
}

// New constructs the service. gateway is the log adapter when no key is set, so
// every surface works before the platform has credentials.
func New(db *kerneldb.DB, gateway sms.Gateway, costPerSegment float64) *Service {
	return &Service{db: db, gateway: gateway, cost: costPerSegment}
}

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

// --- settings -----------------------------------------------------------------

// GetSettings returns how this clinic sends, plus whether the platform can
// actually deliver.
func (s *Service) GetSettings(ctx context.Context) (*messaging.Settings, error) {
	tid, _ := actorOf(ctx)
	out := &messaging.Settings{
		GatewayLive: s.gateway.Live(), GatewayName: s.gateway.Name(), CostPerSegment: s.cost,
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var name string
		e := tx.QueryRow(ctx,
			`SELECT sms_enabled, sms_lang, to_char(sms_quiet_from,'HH24:MI'), to_char(sms_quiet_to,'HH24:MI'),
			        sms_sender_name, name
			   FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL
			  ORDER BY created_at LIMIT 1`, tid).
			Scan(&out.Enabled, &out.Lang, &out.QuietFrom, &out.QuietTo, &out.SenderName, &name)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("CLINIC_NOT_CONFIGURED", "set up the clinic profile first")
		}
		if e != nil {
			return e
		}
		// The gateway has no sender-ID field, so the only thing identifying the
		// clinic is the text itself. Default to the clinic's own name rather than
		// making someone invent one.
		if strings.TrimSpace(out.SenderName) == "" {
			out.SenderName = name
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SaveSettings updates how the clinic sends.
func (s *Service) SaveSettings(ctx context.Context, in messaging.SettingsInput) (*messaging.Settings, error) {
	tid, _ := actorOf(ctx)
	if in.Lang != "en" && in.Lang != "am" {
		in.Lang = "en"
	}
	from, e1 := parseClock(in.QuietFrom, "21:00")
	to, e2 := parseClock(in.QuietTo, "07:00")
	if e1 != nil || e2 != nil {
		return nil, apperr.Validation("quiet hours must be a time like 21:00")
	}
	sender := strings.TrimSpace(in.SenderName)
	// The sender name is prefixed to every message, and every character of it is
	// paid for on every send. A long one silently costs a clinic a second segment
	// on messages that would otherwise fit in one.
	if len([]rune(sender)) > 20 {
		return nil, apperr.Validation("keep the sender name to 20 characters — it is added to every message and counts towards its length")
	}
	if in.Enabled && sender == "" {
		return nil, apperr.Validation("give the clinic a sender name — patients need to know who is messaging them")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE clinics
			    SET sms_enabled = $2, sms_lang = $3, sms_quiet_from = $4::time, sms_quiet_to = $5::time,
			        sms_sender_name = $6, updated_at = now()
			  WHERE tenant_id = $1 AND deleted_at IS NULL`,
			tid, in.Enabled, in.Lang, from, to, sender)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("CLINIC_NOT_CONFIGURED", "set up the clinic profile first")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.GetSettings(ctx)
}

// parseClock accepts "21:00" or "21:00:00" and falls back to def when empty.
func parseClock(v, def string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return def, nil
	}
	parts := strings.Split(v, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return "", fmt.Errorf("bad clock %q", v)
	}
	var h, m int
	if _, err := fmt.Sscanf(parts[0]+":"+parts[1], "%d:%d", &h, &m); err != nil {
		return "", err
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return "", fmt.Errorf("bad clock %q", v)
	}
	return fmt.Sprintf("%02d:%02d", h, m), nil
}

// --- usage --------------------------------------------------------------------

// Usage reports this month's spend against the plan allowance.
func (s *Service) Usage(ctx context.Context) (*messaging.Usage, error) {
	tid, _ := actorOf(ctx)
	out := &messaging.Usage{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		used, e := limits.SMSUsedThisMonth(ctx, tx, tid)
		if e != nil {
			return e
		}
		out.UsedSegments = used
		l, e := limits.Effective(ctx, tx, tid)
		if e != nil {
			return e
		}
		out.Limit = l.SMSMonthly
		return tx.QueryRow(ctx,
			`SELECT count(*) FILTER (WHERE status IN ('sent','delivered')),
			        count(*) FILTER (WHERE status = 'failed'),
			        count(*) FILTER (WHERE status = 'skipped'),
			        -- 'delivered' is a later state of 'sent', not an alternative to it.
			        -- Filtering on 'sent' alone made the month's spend fall as messages
			        -- were confirmed, which is the opposite of what happened.
			        coalesce(sum(cost) FILTER (WHERE status IN ('sent','delivered')), 0)::text
			   FROM messages
			  WHERE tenant_id = $1
			    AND created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Addis_Ababa')`,
			tid).Scan(&out.Sent, &out.Failed, &out.Skipped, &out.Cost)
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// --- preview ------------------------------------------------------------------

// Preview prices a body without queueing it. The clinic's sender prefix is
// included, because it is part of what gets sent and therefore part of the cost.
func (s *Service) Preview(ctx context.Context, body string) (*messaging.Preview, error) {
	set, err := s.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	full := withSender(set.SenderName, body)
	n, uni := sms.Segments(full)
	per := 160
	if uni {
		per = 70
	}
	if n > 1 {
		per = 153
		if uni {
			per = 67
		}
	}
	return &messaging.Preview{
		Body: full, Segments: n, Unicode: uni, Chars: len([]rune(full)), PerSegment: per,
		Cost: fmt.Sprintf("%.2f", float64(n)*s.cost),
	}, nil
}

// withSender puts the clinic's name in front of the message.
//
// Not decoration: with one shared gateway account every clinic's SMS arrives from
// the same identity, so without this the patient gets an unsigned message about
// their own health from a number they do not recognise. Skipped when the body
// already opens with the name, so an author who writes it themselves is not
// charged for it twice.
func withSender(sender, body string) string {
	body = strings.TrimSpace(body)
	sender = strings.TrimSpace(sender)
	if sender == "" || body == "" {
		return body
	}
	if strings.HasPrefix(strings.ToLower(body), strings.ToLower(sender)) {
		return body
	}
	return sender + ": " + body
}

// --- log ----------------------------------------------------------------------

// Log returns what was sent, newest first.
func (s *Service) Log(ctx context.Context, f messaging.LogFilter) ([]messaging.LogRow, error) {
	tid, _ := actorOf(ctx)
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	out := []messaging.LogRow{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT m.id, m.kind, m.lang, m.msisdn, m.body, m.segments, m.cost::text, m.status,
			        coalesce(m.skip_reason,''), coalesce(m.last_error,''),
			        m.scheduled_for, m.sent_at, m.created_at, m.delivered_at, m.patient_id,
			        trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), coalesce(p.mrn,'')
			   FROM messages m
			   LEFT JOIN patients p ON p.id = m.patient_id AND p.tenant_id = m.tenant_id
			  WHERE m.tenant_id = $1
			    AND ($2 = '' OR m.kind = $2)
			    AND ($3 = '' OR m.status = $3)
			    AND ($4::uuid IS NULL OR m.patient_id = $4)
			  ORDER BY m.created_at DESC
			  LIMIT $5`,
			tid, f.Kind, f.Status, f.PatientID, f.Limit)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var r messaging.LogRow
			var sched, created time.Time
			var sentAt, deliveredAt *time.Time
			if e := rows.Scan(&r.ID, &r.Kind, &r.Lang, &r.MSISDN, &r.Body, &r.Segments, &r.Cost, &r.Status,
				&r.SkipReason, &r.LastError, &sched, &sentAt, &created, &deliveredAt, &r.PatientID,
				&r.PatientName, &r.MRN); e != nil {
				return e
			}
			if deliveredAt != nil {
				r.DeliveredAt = deliveredAt.Format(time.RFC3339)
			}
			r.ScheduledAt = sched.Format(time.RFC3339)
			r.CreatedAt = created.Format(time.RFC3339)
			if sentAt != nil {
				r.SentAt = sentAt.Format(time.RFC3339)
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// --- test send ----------------------------------------------------------------

// SendTest queues one message to a number the sender types in.
//
// Deliberately queued rather than sent inline: it has to travel the same path as
// every other message — quiet hours, quota, dispatcher, log — or it proves nothing
// about whether real messages will arrive.
func (s *Service) SendTest(ctx context.Context, rawPhone, body string) error {
	tid, actor := actorOf(ctx)
	body = strings.TrimSpace(body)
	if body == "" {
		return apperr.Validation("write something to send")
	}
	msisdn, st := phone.MSISDN(rawPhone)
	switch st {
	case phone.Missing:
		return apperr.Validation("enter the phone number to test with")
	case phone.Invalid:
		return apperr.Validation("that is not an Ethiopian mobile number — it should look like 0911 22 33 44")
	case phone.Unsupported:
		return apperr.Validation("this gateway only reaches Ethio Telecom numbers (09…) — Safaricom numbers cannot be messaged")
	}
	// Sending while switched off would queue a message the dispatcher then refuses,
	// which reads as a broken test rather than an unfinished setup.
	if set0, e := s.GetSettings(ctx); e == nil && !set0.Enabled {
		return apperr.Validation("turn sending on before testing — a test is a real message")
	}
	set, err := s.GetSettings(ctx)
	if err != nil {
		return err
	}
	full := withSender(set.SenderName, body)
	segs, _ := sms.Segments(full)

	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := limits.EnsureSMSRoom(ctx, tx, tid, int64(segs)); e != nil {
			return e
		}
		_, e := tx.Exec(ctx,
			`INSERT INTO messages (tenant_id, kind, lang, msisdn, body, segments, cost, status, scheduled_for, created_by)
			 VALUES ($1, 'custom', $2, $3, $4, $5, $6, 'scheduled', now(), $7)`,
			tid, set.Lang, msisdn, full, segs, float64(segs)*s.cost, actor)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}
