package dispatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
	"github.com/reicb/clinicsaas/internal/messaging"
)

// WelcomeOnRegistration queues the welcome message when a patient is registered.
//
// Event-driven rather than planned on a clock, because the useful moment is now:
// the card number matters while the patient is still at the desk and can be told
// "we have also texted it to you". A five-minute planner would arrive after they
// had left.
//
// It rides the existing transactional outbox, so it inherits that relay's
// guarantees — the patient and the event are committed together, and a handler that
// fails is retried rather than lost. The relay may deliver an event more than once,
// which is why the dedupe key is per patient: a second delivery finds the row
// already there and does nothing.
func WelcomeOnRegistration(p *Planner) events.Handler {
	return func(ctx context.Context, e events.Event) error {
		if e.TenantID == nil {
			return nil
		}
		var payload struct {
			PatientID uuid.UUID `json:"patient_id"`
			MRN       string    `json:"mrn"`
			Source    string    `json:"source"`
		}
		if err := json.Unmarshal(e.Payload, &payload); err != nil {
			return nil // an event we cannot read is not worth retrying forever
		}
		// A bulk import of an old register would otherwise text hundreds of people
		// at once to welcome them to a clinic they have attended for years.
		if payload.Source == "legacy_import" {
			return nil
		}
		if payload.PatientID == uuid.Nil {
			return nil
		}
		return p.queueWelcome(ctx, *e.TenantID, payload.PatientID)
	}
}

// queueWelcome builds and queues one welcome message.
func (p *Planner) queueWelcome(ctx context.Context, tenantID, patientID uuid.UUID) error {
	return p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var first, mrn, rawPhone, clinicName, lang, body string
		var optedOut, enabled, ruleOn bool
		e := tx.QueryRow(ctx,
			`SELECT coalesce(pt.first_name,''), coalesce(pt.mrn,''), coalesce(pt.phone,''), pt.sms_opt_out,
			        c.sms_enabled, c.name, c.sms_lang,
			        coalesce(t.body,''), coalesce(r.enabled, false)
			   FROM patients pt
			   JOIN LATERAL (
			         SELECT * FROM clinics c2
			          WHERE c2.tenant_id = pt.tenant_id AND c2.deleted_at IS NULL
			          ORDER BY c2.created_at LIMIT 1
			        ) c ON true
			   LEFT JOIN message_templates t ON t.tenant_id = pt.tenant_id
			                                AND t.kind = 'welcome' AND t.lang = c.sms_lang
			   LEFT JOIN message_rules r ON r.tenant_id = pt.tenant_id AND r.kind = 'welcome'
			  WHERE pt.tenant_id = $1 AND pt.id = $2 AND pt.deleted_at IS NULL`,
			tenantID, patientID).
			Scan(&first, &mrn, &rawPhone, &optedOut, &enabled, &clinicName, &lang, &body, &ruleOn)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e != nil {
			return e
		}
		// Both switches have to be on: the clinic's master switch, and this
		// automation. Neither implies the other.
		if !enabled || !ruleOn || body == "" {
			return nil
		}
		m, ok := buildPlanned(tenantID, nil, patientID, messaging.KindWelcome, lang,
			rawPhone, optedOut, body,
			map[string]string{"clinic": clinicName, "name": first, "card": mrn},
			fmt.Sprintf("welcome:%s", patientID))
		if !ok {
			return nil
		}
		m.when = time.Now()
		_, e = p.queue(ctx, tx, m)
		return e
	})
}

// buildPlanned renders a template for one recipient and decides whether it can go.
//
// An unreachable or opted-out patient still produces a row, marked skipped with the
// reason. That is deliberate: "we never told this patient because we have no number
// for her" is information the clinic needs, and a silently absent row is
// indistinguishable from a system that did not try.
func buildPlanned(tenantID uuid.UUID, branchID *uuid.UUID, patientID uuid.UUID,
	kind, lang, rawPhone string, optedOut bool, body string, vals map[string]string,
	dedupeKey string) (plannedMessage, bool) {
	m := plannedMessage{
		tenantID: tenantID, branchID: branchID, patientID: patientID,
		kind: kind, lang: lang, dedupeKey: dedupeKey, status: "scheduled",
	}
	m.body = messaging.Render(body, vals)
	if m.body == "" {
		return m, false
	}
	switch {
	case optedOut:
		m.status, m.skipReason = "skipped", "no_consent"
	default:
		msisdn, st := phone.MSISDN(rawPhone)
		switch st {
		case phone.OK:
			m.msisdn = msisdn
		case phone.Missing:
			m.status, m.skipReason = "skipped", "no_phone"
		case phone.Unsupported:
			m.status, m.skipReason = "skipped", "unsupported_network"
		default:
			m.status, m.skipReason = "skipped", "bad_phone"
		}
	}
	return m, true
}
