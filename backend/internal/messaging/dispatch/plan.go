package dispatch

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/ethiocal"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
	"github.com/reicb/clinicsaas/internal/messaging"
)

// Planner turns things that are about to happen, or have not been paid for, into
// queued messages.
//
// It only ever writes rows. Whether they are then sent is the dispatcher's
// business, decided by its own gates — so a planner cannot accidentally bypass
// quiet hours, the monthly allowance or the clinic's master switch, and there is
// exactly one place in the system where a message leaves the building.
//
// Every insert carries a dedupe_key with a UNIQUE index behind it, which is what
// makes running this every few minutes safe. Nothing here checks whether it already
// queued something: it tries, and the database refuses the duplicate. A check would
// be a race; the constraint is a fact.
type Planner struct {
	db  *kerneldb.DB // privileged: plans across every tenant
	log *slog.Logger
	// cost prices a row when it is queued, for the clinic's running total.
	cost float64
}

// NewPlanner constructs a Planner over the privileged pool.
func NewPlanner(db *kerneldb.DB, costPerSegment float64, log *slog.Logger) *Planner {
	return &Planner{db: db, log: log, cost: costPerSegment}
}

// Run plans on an interval until the context is cancelled.
func (p *Planner) Run(ctx context.Context, interval time.Duration) {
	// One pass immediately, so a clinic that has just switched an automation on sees
	// something happen rather than waiting out the first tick.
	p.once(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.once(ctx)
		}
	}
}

func (p *Planner) once(ctx context.Context) {
	if n, err := p.PlanAppointments(ctx); err != nil {
		p.log.Error("appointment reminder planning failed", "err", err)
	} else if n > 0 {
		p.log.Info("appointment reminders queued", "count", n)
	}
	if n, err := p.PlanBills(ctx); err != nil {
		p.log.Error("bill reminder planning failed", "err", err)
	} else if n > 0 {
		p.log.Info("bill reminders queued", "count", n)
	}
	// A dental clinic keeps both of these somewhere else — see plan_dental.go.
	if n, err := p.PlanDentalAppointments(ctx); err != nil {
		p.log.Error("dental visit reminder planning failed", "err", err)
	} else if n > 0 {
		p.log.Info("dental visit reminders queued", "count", n)
	}
	if n, err := p.PlanDentalBills(ctx); err != nil {
		p.log.Error("dental bill reminder planning failed", "err", err)
	} else if n > 0 {
		p.log.Info("dental bill reminders queued", "count", n)
	}
}

// queue writes one planned message, or silently does nothing if its dedupe key is
// already taken.
//
// The ON CONFLICT is the whole idempotency story. A planner that ran twice in the
// same minute, or a worker restarting mid-pass, must not produce two reminders for
// one appointment: that is a double charge and a patient who thinks the clinic
// cannot keep track of them.
func (p *Planner) queue(ctx context.Context, tx pgx.Tx, m plannedMessage) (bool, error) {
	segs, _ := sms.Segments(m.body)
	ct, err := tx.Exec(ctx,
		`INSERT INTO messages (tenant_id, branch_id, patient_id, kind, lang, msisdn, body,
		                       segments, cost, status, skip_reason, scheduled_for, dedupe_key,
		                       bypass_quiet_hours)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		 ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
		m.tenantID, m.branchID, m.patientID, m.kind, m.lang, m.msisdn, m.body,
		segs, float64(segs)*p.cost, m.status, m.skipReason, m.when, m.dedupeKey,
		m.bypassQuiet)
	if err != nil {
		return false, err
	}
	return ct.RowsAffected() > 0, nil
}

type plannedMessage struct {
	tenantID   uuid.UUID
	branchID   *uuid.UUID
	patientID  uuid.UUID
	kind       string
	lang       string
	msisdn     string
	body       string
	status     string
	skipReason any
	when       time.Time
	dedupeKey  string
	// bypassQuiet is set for messages the recipient is waiting on right now.
	bypassQuiet bool
}

// --- appointment reminders ----------------------------------------------------

// PlanAppointments queues a reminder for each appointment coming up inside its
// clinic's configured window.
//
// The window is bounded at both ends. Without a lower bound it would re-queue
// reminders for appointments already past — the dedupe key would refuse them, but
// only after the query had dragged the clinic's whole history through every pass.
func (p *Planner) PlanAppointments(ctx context.Context) (int, error) {
	queued := 0
	err := p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		// The send time is worked out per clinic, in its own timezone: the rule says
		// "a day before, at 18:00", which is 18:00 in Addis, not in UTC.
		rows, e := tx.Query(ctx,
			`SELECT a.tenant_id, a.id, a.patient_id, a.branch_id, a.starts_at,
			        coalesce(p.first_name,''), coalesce(p.mrn,''), coalesce(p.phone,''), p.sms_opt_out,
			        c.name, c.sms_lang, c.timezone,
			        coalesce(t.body,''),
			        (a.starts_at + (r.offset_hours || ' hours')::interval) AS due_at,
			        r.send_at
			   FROM appointments a
			   JOIN patients p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id AND p.deleted_at IS NULL
			   JOIN message_rules r ON r.tenant_id = a.tenant_id AND r.kind = 'appointment_reminder'
			                       AND r.enabled = true
			   JOIN LATERAL (
			         SELECT * FROM clinics c2
			          WHERE c2.tenant_id = a.tenant_id AND c2.deleted_at IS NULL
			          ORDER BY c2.created_at LIMIT 1
			        ) c ON true
			   LEFT JOIN message_templates t ON t.tenant_id = a.tenant_id
			                                AND t.kind = 'appointment_reminder' AND t.lang = c.sms_lang
			  WHERE c.sms_enabled = true
			    AND a.deleted_at IS NULL
			    AND a.status IN ('booked','confirmed')
			    AND a.starts_at > now()
			    -- Due now or overdue, but not so overdue that the appointment has been
			    -- and gone: a reminder that arrives afterwards is worse than none.
			    AND a.starts_at + (r.offset_hours || ' hours')::interval <= now() + interval '1 hour'
			    AND a.starts_at < now() + interval '30 days'`)
		if e != nil {
			return e
		}
		defer rows.Close()

		type job struct {
			m        plannedMessage
			apptID   uuid.UUID
			startsAt time.Time
			dueAt    time.Time
			sendAt   *time.Time
			tz       string
		}
		var jobs []job
		for rows.Next() {
			var tenantID, apptID, patientID uuid.UUID
			var branchID *uuid.UUID
			var startsAt, dueAt time.Time
			var first, mrn, rawPhone, clinicName, lang, tz, body string
			var optedOut bool
			var sendAt *time.Time
			if e := rows.Scan(&tenantID, &apptID, &patientID, &branchID, &startsAt,
				&first, &mrn, &rawPhone, &optedOut, &clinicName, &lang, &tz, &body,
				&dueAt, &sendAt); e != nil {
				return e
			}
			if body == "" {
				continue // nothing to say in this clinic's language
			}
			loc, lerr := time.LoadLocation(tz)
			if lerr != nil {
				loc = time.UTC
			}
			local := startsAt.In(loc)
			_, em, ed := ethiocal.ToEthiopian(local)
			vals := map[string]string{
				"clinic":  clinicName,
				"name":    first,
				"card":    mrn,
				"date":    local.Format("2 Jan"),
				"date_ec": fmt.Sprintf("%s %d", ethiocal.Months[em-1], ed),
				"time":    local.Format("3:04 PM"),
			}
			m, ok := buildPlanned(tenantID, branchID, patientID, messaging.KindAppointment, lang,
				rawPhone, optedOut, body, vals,
				// One reminder per appointment, whatever the offset is later changed
				// to. Keying on the offset too would mean a clinic that moved the
				// timing from -24h to -48h re-reminded everyone already told.
				"appt:"+apptID.String())
			if !ok {
				continue
			}
			jobs = append(jobs, job{m: m, apptID: apptID, startsAt: startsAt, dueAt: dueAt, sendAt: sendAt, tz: tz})
		}
		if e := rows.Err(); e != nil {
			return e
		}

		for _, j := range jobs {
			j.m.when = sendMoment(j.dueAt, j.sendAt, j.tz)
			// Never schedule a reminder for after the appointment it is reminding
			// about. If the clinic's chosen hour has already passed today, send now.
			if j.m.when.After(j.startsAt) {
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

// sendMoment resolves "the day it falls due, at this clock time, in this clinic's
// timezone". With no clock time configured the message goes as soon as it is due.
//
// The timezone database is embedded in the binary (see the tzdata import below):
// the runtime image is distroless and has no /usr/share/zoneinfo, so without that
// every clinic would silently fall back to UTC and a reminder set for 18:00 would
// arrive at 21:00 Addis — inside quiet hours, and held until morning.
func sendMoment(dueAt time.Time, sendAt *time.Time, tz string) time.Time {
	if sendAt == nil {
		return dueAt
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	d := dueAt.In(loc)
	at := time.Date(d.Year(), d.Month(), d.Day(), sendAt.Hour(), sendAt.Minute(), 0, 0, loc)
	if at.Before(time.Now()) {
		// The hour has passed; go now rather than waiting a day and being late.
		return time.Now()
	}
	return at
}

// --- unpaid bill reminders ----------------------------------------------------

// PlanBills queues a reminder for each patient whose bill has gone quiet.
//
// The debt is read from the charge ledger — pending charges, the same source the
// cashier and the receivables report use — so a patient who has since paid drops
// out on the next pass without anything having to remember to cancel a reminder.
func (p *Planner) PlanBills(ctx context.Context) (int, error) {
	queued := 0
	err := p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`WITH owed AS (
			   SELECT ch.tenant_id, ch.patient_id,
			          sum(ch.amount) AS amt,
			          min(ch.created_at) AS since
			     FROM charges ch
			    WHERE ch.status = 'pending' AND ch.deleted_at IS NULL
			    GROUP BY ch.tenant_id, ch.patient_id
			   HAVING sum(ch.amount) > 0
			 )
			 SELECT o.tenant_id, o.patient_id, o.amt::text, o.since,
			        coalesce(p.first_name,''), coalesce(p.mrn,''), coalesce(p.phone,''), p.sms_opt_out,
			        c.name, c.sms_lang, c.timezone, coalesce(t.body,''),
			        r.offset_hours, r.send_at, r.repeat_days, r.max_repeats,
			        floor(extract(epoch from (now() - o.since)) / 86400)::int AS days_owed
			   FROM owed o
			   JOIN patients p ON p.id = o.patient_id AND p.tenant_id = o.tenant_id AND p.deleted_at IS NULL
			   JOIN message_rules r ON r.tenant_id = o.tenant_id AND r.kind = 'bill_reminder'
			                       AND r.enabled = true
			   JOIN LATERAL (
			         SELECT * FROM clinics c2
			          WHERE c2.tenant_id = o.tenant_id AND c2.deleted_at IS NULL
			          ORDER BY c2.created_at LIMIT 1
			        ) c ON true
			   LEFT JOIN message_templates t ON t.tenant_id = o.tenant_id
			                                AND t.kind = 'bill_reminder' AND t.lang = c.sms_lang
			  WHERE c.sms_enabled = true
			    AND o.since + (r.offset_hours || ' hours')::interval <= now()`)
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
			var tenantID, patientID uuid.UUID
			var amount string
			var since time.Time
			var first, mrn, rawPhone, clinicName, lang, tz, body string
			var optedOut bool
			var offsetHours, repeatDays, maxRepeats, daysOwed int
			var sendAt *time.Time
			if e := rows.Scan(&tenantID, &patientID, &amount, &since,
				&first, &mrn, &rawPhone, &optedOut, &clinicName, &lang, &tz, &body,
				&offsetHours, &sendAt, &repeatDays, &maxRepeats, &daysOwed); e != nil {
				return e
			}
			if body == "" {
				continue
			}
			// Which reminder in the sequence is due. The first falls at the offset;
			// each repeat repeatDays later. Capped so a long-unpaid bill does not
			// become a standing weekly message the clinic pays for indefinitely.
			nth := 0
			if repeatDays > 0 {
				elapsed := daysOwed - offsetHours/24
				if elapsed > 0 {
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
				"amount": messaging.FormatAmount(amount),
				"days":   fmt.Sprintf("%d", daysOwed),
			}
			// The key includes which reminder this is, so repeat 2 is a different
			// message from repeat 1 while neither can be sent twice.
			m, ok := buildPlanned(tenantID, nil, patientID, messaging.KindBill, lang,
				rawPhone, optedOut, body, vals,
				fmt.Sprintf("bill:%s:%s:%d", patientID, since.Format("20060102"), nth))
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
