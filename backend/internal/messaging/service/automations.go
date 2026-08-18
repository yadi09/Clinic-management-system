package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
	"github.com/reicb/clinicsaas/internal/messaging"
)

// --- templates ----------------------------------------------------------------

// ListTemplates returns the clinic's wording for every occasion, in both
// languages, each already rendered with sample values.
//
// The rendered preview is the point. A template reading "{{clinic}}: {{name}}, you
// owe {{amount}} ETB" is 44 characters and tells the clinic nothing useful; filled
// in it is 61 and costs a second Amharic segment. Only the rendered form can be
// priced, so only the rendered form is shown.
func (s *Service) ListTemplates(ctx context.Context) ([]messaging.Template, error) {
	tid, _ := actorOf(ctx)
	out := []messaging.Template{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, clinicName, e := s.creds(ctx, tx, tid)
		if e != nil {
			return e
		}
		vals := messaging.SampleVars(clinicName)
		rows, e := tx.Query(ctx,
			`SELECT kind, lang, body FROM message_templates
			  WHERE tenant_id = $1 ORDER BY kind, lang`, tid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var t messaging.Template
			if e := rows.Scan(&t.Kind, &t.Lang, &t.Body); e != nil {
				return e
			}
			t.Preview = messaging.Render(t.Body, vals)
			t.Segments, t.Unicode = sms.Segments(t.Preview)
			t.Cost = fmt.Sprintf("%.2f", float64(t.Segments)*s.cost)
			out = append(out, t)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SaveTemplate replaces one occasion's wording in one language.
func (s *Service) SaveTemplate(ctx context.Context, kind, lang, body string) error {
	tid, actor := actorOf(ctx)
	if !validKind(kind) || kind == messaging.KindCustom {
		return apperr.Validation("that is not a message the clinic sends automatically")
	}
	if lang != "en" && lang != "am" {
		return apperr.Validation("the language must be English or Amharic")
	}
	body = strings.TrimSpace(body)
	// Placeholders are checked now, not at send time: by then the mistake is on
	// hundreds of phones and has been paid for.
	if e := messaging.ValidateTemplate(body); e != nil {
		return apperr.Validation(e.Error())
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO message_templates (tenant_id, kind, lang, body, updated_by)
			 VALUES ($1,$2,$3,$4,$5)
			 ON CONFLICT (tenant_id, kind, lang)
			 DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			tid, kind, lang, body, actor)
		return e
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func validKind(k string) bool {
	switch k {
	case messaging.KindWelcome, messaging.KindAppointment, messaging.KindBill, messaging.KindCustom:
		return true
	}
	return false
}

// --- rules --------------------------------------------------------------------

// ListRules returns each automation's timing, whether it is on, and how much it
// has actually done this month.
func (s *Service) ListRules(ctx context.Context) ([]messaging.Rule, error) {
	tid, _ := actorOf(ctx)
	out := []messaging.Rule{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT r.kind, r.enabled, r.offset_hours,
			        coalesce(to_char(r.send_at,'HH24:MI'),''), r.repeat_days, r.max_repeats,
			        (SELECT count(*) FROM messages m
			          WHERE m.tenant_id = r.tenant_id AND m.kind = r.kind
			            AND m.status IN ('sent','delivered')
			            AND m.sent_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Addis_Ababa'))
			   FROM message_rules r
			  WHERE r.tenant_id = $1
			  ORDER BY CASE r.kind WHEN 'welcome' THEN 1 WHEN 'appointment_reminder' THEN 2 ELSE 3 END`,
			tid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var r messaging.Rule
			if e := rows.Scan(&r.Kind, &r.Enabled, &r.OffsetHours, &r.SendAt,
				&r.RepeatDays, &r.MaxRepeats, &r.Sent); e != nil {
				return e
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

// SaveRule changes one automation's timing or switches it on.
func (s *Service) SaveRule(ctx context.Context, in messaging.RuleInput) error {
	tid, _ := actorOf(ctx)
	if !validKind(in.Kind) || in.Kind == messaging.KindCustom {
		return apperr.Validation("that is not a message the clinic sends automatically")
	}
	// Bounded to a fortnight either side. A reminder six months out is not a
	// reminder, and the wider the window the more of the queue is speculative.
	if in.OffsetHours < -336 || in.OffsetHours > 336 {
		return apperr.Validation("choose a time within two weeks of the appointment or bill")
	}
	if in.MaxRepeats < 0 || in.MaxRepeats > 5 {
		return apperr.Validation("a message can be repeated at most 5 times")
	}
	if in.MaxRepeats > 0 && in.RepeatDays < 1 {
		return apperr.Validation("say how many days apart the repeats should be")
	}
	sendAt := strings.TrimSpace(in.SendAt)
	if sendAt != "" {
		v, e := parseClock(sendAt, "")
		if e != nil {
			return apperr.Validation("the send time must look like 18:00")
		}
		sendAt = v
	}
	// Turning an automation on with nothing to say would queue empty messages.
	if in.Enabled {
		var body string
		if e := s.db.WithTx(ctx, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx,
				`SELECT coalesce(t.body,'') FROM clinics c
				  LEFT JOIN message_templates t
				         ON t.tenant_id = c.tenant_id AND t.kind = $2 AND t.lang = c.sms_lang
				  WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
				  ORDER BY c.created_at LIMIT 1`, tid, in.Kind).Scan(&body)
		}); e != nil {
			return apperr.Internal(e)
		}
		if strings.TrimSpace(body) == "" {
			return apperr.Validation("write the message for this in your clinic's language before switching it on")
		}
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO message_rules (tenant_id, kind, enabled, offset_hours, send_at, repeat_days, max_repeats)
			 VALUES ($1,$2,$3,$4,NULLIF($5,'')::time,$6,$7)
			 ON CONFLICT (tenant_id, kind) DO UPDATE SET
			   enabled = EXCLUDED.enabled, offset_hours = EXCLUDED.offset_hours,
			   send_at = EXCLUDED.send_at, repeat_days = EXCLUDED.repeat_days,
			   max_repeats = EXCLUDED.max_repeats, updated_at = now()`,
			tid, in.Kind, in.Enabled, in.OffsetHours, sendAt, in.RepeatDays, in.MaxRepeats)
		return e
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- audience -----------------------------------------------------------------

// Audience lists patients a hand-picked send could go to.
//
// It reports unreachable patients rather than filtering them out. A clinic that
// asks for "everyone seen in the last six months" and gets 138 back when the real
// answer is 143 has been quietly lied to; being told "5 have no usable number" is
// both honest and actionable, because someone can go and fix those records.
func (s *Service) Audience(ctx context.Context, f messaging.AudienceFilter) ([]messaging.Audience, error) {
	tid, _ := actorOf(ctx)
	if f.Limit <= 0 || f.Limit > 2000 {
		f.Limit = 500
	}
	out := []messaging.Audience{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`WITH owed AS (
			   SELECT c.patient_id, sum(c.amount) AS amt
			     FROM charges c
			    WHERE c.tenant_id = $1 AND c.status = 'pending' AND c.deleted_at IS NULL
			    GROUP BY c.patient_id
			 ),
			 seen AS (
			   SELECT e.patient_id, max(e.started_at) AS last_at
			     FROM encounters e WHERE e.tenant_id = $1 GROUP BY e.patient_id
			 )
			 SELECT p.id, trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
			        coalesce(p.mrn,''), coalesce(p.phone,''), p.sms_opt_out,
			        coalesce(to_char(seen.last_at AT TIME ZONE 'Africa/Addis_Ababa','YYYY-MM-DD'),''),
			        coalesce(owed.amt, 0)::text
			   FROM patients p
			   LEFT JOIN owed ON owed.patient_id = p.id
			   LEFT JOIN seen ON seen.patient_id = p.id
			  WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
			    AND ($2 = '' OR p.first_name ILIKE '%'||$2||'%' OR p.last_name ILIKE '%'||$2||'%'
			         OR p.mrn ILIKE '%'||$2||'%')
			    AND ($3 = 0 OR seen.last_at >= now() - ($3 || ' days')::interval)
			    AND (NOT $4 OR coalesce(owed.amt,0) > 0)
			  ORDER BY seen.last_at DESC NULLS LAST, p.created_at DESC
			  LIMIT $5`,
			tid, strings.TrimSpace(f.Search), f.SeenWithinDays, f.OwingOnly, f.Limit)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var a messaging.Audience
			var raw string
			if e := rows.Scan(&a.PatientID, &a.Name, &a.MRN, &raw, &a.OptedOut,
				&a.LastVisit, &a.Owes); e != nil {
				return e
			}
			_, st := phone.MSISDN(raw)
			a.Reachable = st == phone.OK
			if !a.Reachable {
				a.PhoneIssue = string(st)
			}
			a.Phone = raw
			out = append(out, a)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// --- campaigns ----------------------------------------------------------------

// SendCampaign queues one message to the patients somebody chose.
//
// The whole send is priced and checked against the month's allowance before a
// single row is written, so a campaign is either affordable or refused — never
// half-delivered, which would leave the clinic guessing who got it and no clean way
// to finish.
func (s *Service) SendCampaign(ctx context.Context, in messaging.CampaignInput) (*messaging.CampaignResult, error) {
	tid, actor := actorOf(ctx)
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "Message to patients"
	}
	if strings.TrimSpace(in.Body) == "" {
		return nil, apperr.Validation("write the message first")
	}
	if len(in.PatientIDs) == 0 {
		return nil, apperr.Validation("choose at least one patient")
	}
	if len(in.PatientIDs) > 2000 {
		return nil, apperr.Validation("that is more than 2,000 patients — send it in smaller groups")
	}
	set, err := s.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	if !set.Enabled {
		return nil, apperr.Validation("turn sending on before messaging patients")
	}

	out := &messaging.CampaignResult{}
	when := time.Now()
	if in.ScheduledFor != nil {
		when = *in.ScheduledFor
	}

	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Resolve the chosen patients once. Names go into the rendered body, so this
		// is also what makes {{name}} work per recipient.
		rows, e := tx.Query(ctx,
			`SELECT id, coalesce(first_name,''), coalesce(mrn,''), coalesce(phone,''), sms_opt_out
			   FROM patients
			  WHERE tenant_id = $1 AND deleted_at IS NULL AND id = ANY($2)`,
			tid, in.PatientIDs)
		if e != nil {
			return e
		}
		type target struct {
			id     uuid.UUID
			name   string
			mrn    string
			msisdn string
			skip   string
		}
		var targets []target
		for rows.Next() {
			var t target
			var raw string
			var optedOut bool
			if e := rows.Scan(&t.id, &t.name, &t.mrn, &raw, &optedOut); e != nil {
				rows.Close()
				return e
			}
			msisdn, st := phone.MSISDN(raw)
			switch {
			case optedOut:
				// Honoured even here. Somebody ticking a name in a list is not a
				// reason to overrule a patient who asked not to be contacted.
				t.skip = "no_consent"
			case st == phone.Missing:
				t.skip = "no_phone"
			case st == phone.Unsupported:
				t.skip = "unsupported_network"
			case st != phone.OK:
				t.skip = "bad_phone"
			default:
				t.msisdn = msisdn
			}
			targets = append(targets, t)
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return e
		}

		// Price it before writing anything.
		vals := messaging.SampleVars(set.SenderName)
		total := 0
		bodies := make([]string, len(targets))
		for i, t := range targets {
			v := map[string]string{}
			for k, val := range vals {
				v[k] = val
			}
			v["name"], v["card"] = t.name, t.mrn
			body := withSender(set.BodyPrefix, messaging.Render(in.Body, v))
			bodies[i] = body
			if t.skip == "" {
				n, _ := sms.Segments(body)
				total += n
			}
		}
		if total == 0 {
			return apperr.Validation("none of those patients has a usable mobile number")
		}
		if e := limits.EnsureSMSRoom(ctx, tx, tid, int64(total)); e != nil {
			return e
		}

		var campaignID uuid.UUID
		if e := tx.QueryRow(ctx,
			`INSERT INTO message_campaigns (tenant_id, title, body, lang, status, scheduled_for, total, created_by)
			 VALUES ($1,$2,$3,$4,'sending',$5,$6,$7) RETURNING id`,
			tid, title, strings.TrimSpace(in.Body), set.Lang, when, len(targets), actor).Scan(&campaignID); e != nil {
			return e
		}
		out.ID = campaignID

		for i, t := range targets {
			segs, _ := sms.Segments(bodies[i])
			status, skip := "scheduled", any(nil)
			if t.skip != "" {
				// Recorded, not dropped: the clinic asked for this person and is
				// entitled to know why they were not reached.
				status, skip = "skipped", t.skip
				out.Skipped++
			} else {
				out.Queued++
				out.Segments += segs
			}
			if _, e := tx.Exec(ctx,
				`INSERT INTO messages (tenant_id, patient_id, kind, lang, msisdn, body, segments, cost,
				                       status, skip_reason, scheduled_for, campaign_id, created_by)
				 VALUES ($1,$2,'custom',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
				tid, t.id, set.Lang, t.msisdn, bodies[i], segs, float64(segs)*s.cost,
				status, skip, when, campaignID, actor); e != nil {
				return e
			}
		}
		out.Cost = fmt.Sprintf("%.2f", float64(out.Segments)*s.cost)
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
