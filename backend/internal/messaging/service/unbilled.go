package service

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
	"github.com/reicb/clinicsaas/internal/messaging"
)

// UnbilledReminders messages the patients behind selected unbilled-treatment rows.
//
// The page selects SESSIONS (its rows), but a phone receives one message per
// PATIENT: someone with two owed visits picked together gets a single text naming
// the whole debt, not two texts thirty seconds apart that read as a system stuck
// in a loop.
//
// Every fact in the message is re-derived here from the money projection at send
// time, never taken from the browser. The page the desk is looking at may be ten
// minutes old, and the patient may have paid at the desk in between — a reminder
// built from stale rows would text someone about money they no longer owe, which
// costs more goodwill than the debt was worth.
//
// Preview mode runs the identical derivation and returns what each patient would
// receive, what it costs, and who cannot be reached — so the person pressing send
// approves the actual messages, not a template with the blanks still in it.
func (s *Service) UnbilledReminders(ctx context.Context, in messaging.UnbilledRemindInput) (*messaging.UnbilledRemindResult, error) {
	tid, actor := actorOf(ctx)
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return nil, apperr.Validation("write the message first")
	}
	if e := messaging.ValidateTemplate(body); e != nil {
		return nil, apperr.Validation(e.Error())
	}
	if len(in.SessionIDs) == 0 {
		return nil, apperr.Validation("choose at least one owed visit")
	}
	if len(in.SessionIDs) > 500 {
		return nil, apperr.Validation("that is more than 500 rows — narrow the selection")
	}

	set, err := s.GetSettings(ctx)
	if err != nil {
		return nil, err
	}
	if !in.Preview && !set.Enabled {
		return nil, apperr.Validation("turn sending on under Patient messages first")
	}

	out := &messaging.UnbilledRemindResult{Rows: []messaging.UnbilledRemindRow{}}
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// One patient's slice of the selection: the sessions they still owe for,
		// with the plan-level paid figure the message quotes.
		type debt struct {
			patientID    uuid.UUID
			first, mrn   string
			rawPhone     string
			optedOut     bool
			planTitles   map[string]bool
			countedPlans map[string]bool
			// every owed visit's number, so the message can say "visit 2 and 3"
			seqs       []int
			hasDeposit bool
			count      int // visits in the course, for "visit 3 of 4"
			owed, paid float64
			oldest     time.Time
		}
		byPatient := map[uuid.UUID]*debt{}

		// The projection filter mirrors the unbilled report's own definition of
		// "owed": delivered work in an unpaid/refunded state. A session that was
		// settled since the page loaded simply drops out here, so the reminder can
		// never disagree with the cashier.
		rows, e := tx.Query(ctx, dental.SessionMoneySQL+`
			SELECT sm.session_id, sm.patient_id, sm.seq, sm.kind, sm.owed_amount::text,
			       p.title, p.session_count,
			       sm.owed_since,
			       (SELECT coalesce(sum(x.net_paid), 0) FROM session_money x
			         WHERE x.plan_id = sm.plan_id)::text,
			       coalesce(pt.first_name,''), coalesce(pt.mrn,''), coalesce(pt.phone,''), pt.sms_opt_out
			  FROM session_money sm
			  JOIN treatment_plans p ON p.id = sm.plan_id AND p.tenant_id = $1
			  JOIN patients pt ON pt.id = sm.patient_id AND pt.tenant_id = $1 AND pt.deleted_at IS NULL
			 WHERE sm.session_id = ANY($2)
			   AND sm.session_status <> 'cancelled'
			   AND sm.owed_now
			   AND sm.pay_state IN ('unpaid','refunded')`,
			tid, in.SessionIDs)
		if e != nil {
			return e
		}
		for rows.Next() {
			var sessionID, patientID uuid.UUID
			var seq, count int
			var kind, owed, title, paid, first, mrn, rawPhone string
			var since time.Time
			var optedOut bool
			if e := rows.Scan(&sessionID, &patientID, &seq, &kind, &owed, &title, &count,
				&since, &paid, &first, &mrn, &rawPhone, &optedOut); e != nil {
				rows.Close()
				return e
			}
			d := byPatient[patientID]
			if d == nil {
				d = &debt{patientID: patientID, first: first, mrn: mrn, rawPhone: rawPhone,
					optedOut: optedOut, planTitles: map[string]bool{}, countedPlans: map[string]bool{}, oldest: since}
				byPatient[patientID] = d
			}
			d.planTitles[title] = true
			// A down payment has no visit number — it is the price of starting the
			// course, and left to the seq column the message would call it "visit 0".
			if kind == "deposit" {
				d.hasDeposit = true
			} else {
				d.count = count
				d.seqs = append(d.seqs, seq)
			}
			d.owed += money64(owed)
			// paid is a PLAN-level figure arriving on every session row — counted
			// once per plan or two selected visits would double the "you have paid".
			if !d.countedPlans[title] {
				d.countedPlans[title] = true
				d.paid += money64(paid)
			}
			if since.Before(d.oldest) {
				d.oldest = since
			}
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return e
		}
		if len(byPatient) == 0 {
			return apperr.Validation("none of those visits is still owed — the page may be out of date, refresh it")
		}

		// "Reminded 2 days ago" — the fact that stops a clinic accidentally
		// harassing someone who was already chased this week.
		lastReminded := map[uuid.UUID]*time.Time{}
		patientIDs := make([]uuid.UUID, 0, len(byPatient))
		for id := range byPatient {
			patientIDs = append(patientIDs, id)
		}
		lr, e := tx.Query(ctx,
			`SELECT patient_id, max(coalesce(sent_at, created_at))
			   FROM messages
			  WHERE tenant_id = $1 AND kind = 'bill_reminder'
			    AND status IN ('scheduled','sending','sent','delivered')
			    AND patient_id = ANY($2)
			  GROUP BY patient_id`,
			tid, patientIDs)
		if e != nil {
			return e
		}
		for lr.Next() {
			var pid uuid.UUID
			var at time.Time
			if e := lr.Scan(&pid, &at); e != nil {
				lr.Close()
				return e
			}
			t := at
			lastReminded[pid] = &t
		}
		lr.Close()
		if e := lr.Err(); e != nil {
			return e
		}

		totalSegs := 0
		type prepared struct {
			d      *debt
			msisdn string
			body   string
			segs   int
			skip   string
		}
		var batch []prepared
		for _, d := range byPatient {
			titles := make([]string, 0, len(d.planTitles))
			for t := range d.planTitles {
				titles = append(titles, t)
			}
			treatment := titles[0]
			if len(titles) > 1 {
				treatment = fmt.Sprintf("%d treatments", len(titles))
			}
			visit := whatIsOwed(d.seqs, d.count, d.hasDeposit, set.Lang)
			vals := map[string]string{
				"clinic":    set.SenderName,
				"name":      d.first,
				"card":      d.mrn,
				"treatment": treatment,
				"visit":     visit,
				"paid":      messaging.FormatAmount(fmt.Sprintf("%f", d.paid)),
				"amount":    messaging.FormatAmount(fmt.Sprintf("%f", d.owed)),
				"days":      fmt.Sprintf("%d", int(time.Since(d.oldest).Hours()/24)),
			}
			rendered := withSender(set.BodyPrefix, messaging.Render(body, vals))
			segs, _ := sms.Segments(rendered)

			p := prepared{d: d, body: rendered, segs: segs}
			msisdn, st := phone.MSISDN(d.rawPhone)
			switch {
			case d.optedOut:
				p.skip = "no_consent"
			case st == phone.Missing:
				p.skip = "no_phone"
			case st == phone.Unsupported:
				p.skip = "unsupported_network"
			case st != phone.OK:
				p.skip = "bad_phone"
			default:
				p.msisdn = msisdn
				totalSegs += segs
			}
			batch = append(batch, p)

			row := messaging.UnbilledRemindRow{
				PatientID: d.patientID, PatientName: strings.TrimSpace(d.first),
				MRN: d.mrn, Body: rendered, Segments: segs,
				Cost: fmt.Sprintf("%.2f", float64(segs)*s.cost), SkipReason: p.skip,
			}
			if at := lastReminded[d.patientID]; at != nil {
				row.LastRemindedAt = at.Format(time.RFC3339)
			}
			out.Rows = append(out.Rows, row)
		}
		out.Segments = totalSegs
		out.Cost = fmt.Sprintf("%.2f", float64(totalSegs)*s.cost)

		if in.Preview {
			return nil
		}
		if totalSegs == 0 {
			return apperr.Validation("none of the selected patients has a usable mobile number")
		}
		// The whole batch is affordable or the whole batch is refused — half a
		// send leaves the desk guessing who was told.
		if e := limits.EnsureSMSRoom(ctx, tx, tid, int64(totalSegs)); e != nil {
			return e
		}
		for _, p := range batch {
			status, skip := "scheduled", any(nil)
			if p.skip != "" {
				status, skip = "skipped", p.skip
			} else {
				// Double-click guard: the only duplicate that reaches a patient twice
				// is one still waiting to go.
				var pending int
				if e := tx.QueryRow(ctx,
					`SELECT count(*) FROM messages
					  WHERE tenant_id = $1 AND msisdn = $2 AND body = $3
					    AND status IN ('scheduled','sending')`,
					tid, p.msisdn, p.body).Scan(&pending); e != nil {
					return e
				}
				if pending > 0 {
					continue
				}
				out.Queued++
			}
			if p.skip != "" {
				out.Skipped++
			}
			if _, e := tx.Exec(ctx,
				`INSERT INTO messages (tenant_id, patient_id, kind, lang, msisdn, body, segments, cost,
				                       status, skip_reason, scheduled_for, created_by)
				 VALUES ($1,$2,'bill_reminder',$3,$4,$5,$6,$7,$8,$9,now(),$10)`,
				tid, p.d.patientID, set.Lang, p.msisdn, p.body, p.segs,
				float64(p.segs)*s.cost, status, skip, actor); e != nil {
				return e
			}
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

func money64(raw string) float64 {
	var f float64
	_, _ = fmt.Sscanf(raw, "%f", &f)
	return f
}

// whatIsOwed names the thing being chased, in the clinic's own language.
//
// The message says "for your {{treatment}} ({{visit}})", so this value has to carry
// its own noun: a down payment is not visit number zero, and "visit 2 visits" is the
// kind of sentence that makes a patient distrust every other number in the text.
//
//	one visit        visit 3 of 4
//	several          visits 2 and 3
//	a down payment   down payment
//	both             down payment and visit 3
func whatIsOwed(seqs []int, count int, deposit bool, lang string) string {
	am := lang == "am"
	parts := []string{}
	if deposit {
		parts = append(parts, pick(am, "የቅድሚያ ክፍያ", "down payment"))
	}
	switch {
	case len(seqs) == 1 && count > 0:
		parts = append(parts, fmt.Sprintf("%s %d %s %d",
			pick(am, "ጉብኝት", "visit"), seqs[0], pick(am, "ከ", "of"), count))
	case len(seqs) == 1:
		parts = append(parts, fmt.Sprintf("%s %d", pick(am, "ጉብኝት", "visit"), seqs[0]))
	case len(seqs) > 1:
		parts = append(parts, fmt.Sprintf("%s %s", pick(am, "ጉብኝት", "visits"), seqList(seqs, am)))
	}
	return strings.Join(parts, pick(am, " እና ", " and "))
}

func pick(am bool, amharic, english string) string {
	if am {
		return amharic
	}
	return english
}

// seqList joins visit numbers the way a sentence needs them: "2 and 3", "2, 3 and 4".
func seqList(seqs []int, am bool) string {
	sort.Ints(seqs)
	parts := make([]string, len(seqs))
	for i, n := range seqs {
		parts[i] = fmt.Sprintf("%d", n)
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + pick(am, " እና ", " and ") + parts[len(parts)-1]
}
