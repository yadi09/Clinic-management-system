package dispatch

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/ethiocal"
	"github.com/reicb/clinicsaas/internal/messaging"
)

// A dental clinic keeps its appointments and its debts somewhere else.
//
// The general planner reads the appointments table and pending charges, which is
// right for a clinic that books consultations and bills at the desk. A dental
// practice does neither. Its appointments are the dated visits of a treatment plan
// — 48 of them upcoming at the live clinic, against 2 rows in the appointments
// table, both months past. And its debts are sessions that were delivered and not
// paid for, or deposits agreed and not collected; a charge only exists once
// somebody presses Collect, so "pending charges" is a narrow slice that is usually
// empty.
//
// So both automations looked switched on and did nothing at all. These two passes
// are the same features reading the right tables.

// PlanDentalAppointments reminds patients about treatment-plan visits.
//
// A session carries a DATE and no clock time — a course says "the 21st", not
// "the 21st at 3pm" — so the reminder gives the date and the template's {{time}}
// resolves to nothing. Render drops the dangling preposition that leaves behind,
// which is why the wording reads correctly for both kinds of appointment without
// the clinic having to keep two versions of it.
func (p *Planner) PlanDentalAppointments(ctx context.Context) (int, error) {
	queued := 0
	err := p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT se.tenant_id, se.id, se.patient_id, se.branch_id, se.scheduled_date,
			        coalesce(pt.first_name,''), coalesce(pt.mrn,''), coalesce(pt.phone,''), pt.sms_opt_out,
			        c.name, c.sms_lang, c.timezone, coalesce(t.body,''),
			        r.offset_hours, r.send_at
			   FROM treatment_sessions se
			   JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
			   JOIN patients pt ON pt.id = se.patient_id AND pt.tenant_id = se.tenant_id
			                   AND pt.deleted_at IS NULL
			   JOIN message_rules r ON r.tenant_id = se.tenant_id AND r.kind = 'appointment_reminder'
			                       AND r.enabled = true
			   JOIN LATERAL (
			         SELECT * FROM clinics c2
			          WHERE c2.tenant_id = se.tenant_id AND c2.deleted_at IS NULL
			          ORDER BY c2.created_at LIMIT 1
			        ) c ON true
			   LEFT JOIN message_templates t ON t.tenant_id = se.tenant_id
			                                AND t.kind = 'appointment_reminder' AND t.lang = c.sms_lang
			  WHERE c.sms_enabled = true
			    -- A visit that is still going to happen. Deposits are money, not
			    -- appointments, and extras were done at a visit that already passed.
			    AND se.kind = 'visit'
			    AND se.status = 'planned'
			    AND pl.status = 'active'
			    AND se.scheduled_date >= (now() AT TIME ZONE c.timezone)::date
			    -- Due now, judged from the start of the session's day in clinic time.
			    AND (se.scheduled_date::timestamp AT TIME ZONE c.timezone)
			        + (r.offset_hours || ' hours')::interval <= now() + interval '1 hour'
			    AND se.scheduled_date < ((now() AT TIME ZONE c.timezone)::date + 30)`)
		if e != nil {
			return e
		}
		defer rows.Close()

		type job struct {
			m     plannedMessage
			day   time.Time
			at    *time.Time
			tz    string
			hours int
		}
		var jobs []job
		for rows.Next() {
			var tenantID, sessionID, patientID uuid.UUID
			var branchID *uuid.UUID
			var day time.Time
			var first, mrn, rawPhone, clinicName, lang, tz, body string
			var optedOut bool
			var offsetHours int
			var sendAt *time.Time
			if e := rows.Scan(&tenantID, &sessionID, &patientID, &branchID, &day,
				&first, &mrn, &rawPhone, &optedOut, &clinicName, &lang, &tz, &body,
				&offsetHours, &sendAt); e != nil {
				return e
			}
			if body == "" {
				continue
			}
			_, em, ed := ethiocal.ToEthiopian(day)
			vals := map[string]string{
				"clinic":  clinicName,
				"name":    first,
				"card":    mrn,
				"date":    day.Format("2 Jan"),
				"date_ec": fmt.Sprintf("%s %d", ethiocal.Months[em-1], ed),
				// No clock time exists on a treatment session. Left empty rather than
				// invented: telling a patient 9am when the clinic never said so is
				// worse than telling them the day.
				"time": "",
			}
			m, ok := buildPlanned(tenantID, branchID, patientID, messaging.KindAppointment, lang,
				rawPhone, optedOut, body, vals, "tss:"+sessionID.String())
			if !ok {
				continue
			}
			jobs = append(jobs, job{m: m, day: day, at: sendAt, tz: tz, hours: offsetHours})
		}
		if e := rows.Err(); e != nil {
			return e
		}

		for _, j := range jobs {
			due := j.day.Add(time.Duration(j.hours) * time.Hour)
			j.m.when = sendMoment(due, j.at, j.tz)
			// Never after the visit it is reminding about.
			if j.m.when.After(j.day.AddDate(0, 0, 1)) {
				j.m.when = time.Now()
			}
			ok, e := p.queue(ctx, tx, j.m)
			if e != nil {
				return e
			}
			if ok {
				queued++
			}
		}
		return nil
	})
	return queued, err
}

// PlanDentalBills chases what a dental patient actually owes.
//
// Read from the shared money projection rather than a query of its own, so this
// agrees with the balance on the patient's page, the cashier, and the receivables
// report. A second definition would eventually disagree with those, and the way it
// would surface is a patient being texted about a bill they had already settled.
//
// Two kinds of debt, and one deliberate exclusion:
//
//	delivered and unpaid   treatment done, nothing collected for it
//	deposit not collected  agreed up front, the course is waiting on it
//	NOT 'billed'           already sent to the cashier, so it is a pending charge
//	                       and the general pass counts it — counting it here too
//	                       would chase the same money twice
func (p *Planner) PlanDentalBills(ctx context.Context) (int, error) {
	// The projection is scoped to one tenant, so the pass walks the clinics that
	// have the automation on. There are few of them and the alternative is a
	// second copy of the money rules.
	var tenants []uuid.UUID
	if err := p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT r.tenant_id
			   FROM message_rules r
			   JOIN LATERAL (
			         SELECT * FROM clinics c2
			          WHERE c2.tenant_id = r.tenant_id AND c2.deleted_at IS NULL
			          ORDER BY c2.created_at LIMIT 1
			        ) c ON true
			  WHERE r.kind = 'bill_reminder' AND r.enabled = true AND c.sms_enabled = true`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			if e := rows.Scan(&id); e != nil {
				return e
			}
			tenants = append(tenants, id)
		}
		return rows.Err()
	}); err != nil {
		return 0, err
	}

	queued := 0
	for _, tid := range tenants {
		n, err := p.planDentalBillsFor(ctx, tid)
		if err != nil {
			return queued, err
		}
		queued += n
	}
	return queued, nil
}

func (p *Planner) planDentalBillsFor(ctx context.Context, tid uuid.UUID) (int, error) {
	queued := 0
	err := p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, dental.SessionMoneySQL+`
			SELECT sm.patient_id,
			       sum(sm.owed_amount)::text AS owed,
			       min(coalesce(sm.completed_at, sm.scheduled_date::timestamptz)) AS since,
			       coalesce(pt.first_name,''), coalesce(pt.mrn,''), coalesce(pt.phone,''), pt.sms_opt_out,
			       c.name, c.sms_lang, c.timezone, coalesce(t.body,''),
			       r.offset_hours, r.send_at, r.repeat_days, r.max_repeats
			  FROM session_money sm
			  -- The projection does not carry the session kind, and ten other queries
			  -- depend on its exact shape, so the deposit/visit distinction is read by
			  -- joining back rather than by widening something shared.
			  JOIN treatment_sessions se ON se.id = sm.session_id AND se.tenant_id = $1
			  JOIN patients pt ON pt.id = sm.patient_id AND pt.tenant_id = $1 AND pt.deleted_at IS NULL
			  JOIN message_rules r ON r.tenant_id = $1 AND r.kind = 'bill_reminder' AND r.enabled = true
			  JOIN LATERAL (
			        SELECT * FROM clinics c2 WHERE c2.tenant_id = $1 AND c2.deleted_at IS NULL
			         ORDER BY c2.created_at LIMIT 1
			       ) c ON true
			  LEFT JOIN message_templates t ON t.tenant_id = $1
			                               AND t.kind = 'bill_reminder' AND t.lang = c.sms_lang
			 WHERE sm.session_status <> 'cancelled'
			   AND sm.pay_state IN ('unpaid','refunded')
			   AND ( sm.delivered OR se.kind = 'deposit' )
			 GROUP BY sm.patient_id, pt.first_name, pt.mrn, pt.phone, pt.sms_opt_out,
			          c.name, c.sms_lang, c.timezone, t.body,
			          r.offset_hours, r.send_at, r.repeat_days, r.max_repeats
			HAVING sum(sm.owed_amount) > 0`, tid)
		if e != nil {
			return e
		}
		defer rows.Close()

		type job struct {
			m  plannedMessage
			tz string
			at *time.Time
		}
		var jobs []job
		for rows.Next() {
			var patientID uuid.UUID
			var owed string
			var since time.Time
			var first, mrn, rawPhone, clinicName, lang, tz, body string
			var optedOut bool
			var offsetHours, repeatDays, maxRepeats int
			var sendAt *time.Time
			if e := rows.Scan(&patientID, &owed, &since, &first, &mrn, &rawPhone, &optedOut,
				&clinicName, &lang, &tz, &body, &offsetHours, &sendAt,
				&repeatDays, &maxRepeats); e != nil {
				return e
			}
			if body == "" {
				continue
			}
			daysOwed := int(time.Since(since).Hours() / 24)
			// Not due yet: the debt has to have sat for the configured delay.
			if time.Since(since) < time.Duration(offsetHours)*time.Hour {
				continue
			}
			nth := 0
			if repeatDays > 0 {
				if elapsed := daysOwed - offsetHours/24; elapsed > 0 {
					nth = elapsed / repeatDays
				}
				if nth > maxRepeats {
					nth = maxRepeats
				}
			}
			vals := map[string]string{
				"clinic": clinicName,
				"name":   first,
				"card":   mrn,
				"amount": money(owed),
				"days":   fmt.Sprintf("%d", daysOwed),
			}
			// Keyed on the dental debt specifically, so it cannot collide with a
			// general pending-charge reminder for the same patient.
			m, ok := buildPlanned(tid, nil, patientID, messaging.KindBill, lang,
				rawPhone, optedOut, body, vals,
				fmt.Sprintf("dbill:%s:%s:%d", patientID, since.Format("20060102"), nth))
			if !ok {
				continue
			}
			jobs = append(jobs, job{m: m, tz: tz, at: sendAt})
		}
		if e := rows.Err(); e != nil {
			return e
		}
		for _, j := range jobs {
			j.m.when = sendMoment(time.Now(), j.at, j.tz)
			ok, e := p.queue(ctx, tx, j.m)
			if e != nil {
				return e
			}
			if ok {
				queued++
			}
		}
		return nil
	})
	return queued, err
}
