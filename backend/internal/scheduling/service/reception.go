package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/scheduling"
)

// The front desk, in one request.
//
// Reception used to begin with an empty form: to receive a patient you had to know
// their name and type it, even though most arrivals were booked weeks ago and the
// system already knew who was coming, when, and to whom. Three lists answer the
// desk's actual questions — who is expected, who is waiting, who has been seen — and
// each row carries the facts that decide what happens next.
//
// The day is Addis, not UTC. Counting "today" at the session timezone moves three
// hours of every evening into tomorrow, which is a bug this codebase has fixed twice
// in other places and will not reintroduce here.
const addisTZ = "Africa/Addis_Ababa"

// receptionCols keeps the three queries returning the same shape, so one scanner
// serves all of them and a column added to one cannot be forgotten in another.
const receptionCols = `
	p.id, trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
	coalesce(p.mrn,''),
	coalesce(date_part('year', age(p.dob))::int, 0), coalesce(p.gender,''), coalesce(p.phone,''),
	coalesce(owed.amt, 0)::text, coalesce(owed.oldest, 0)::int, coalesce(owed.all_agreed, false),
	coalesce(unbilled.amt, 0)::text`

// owedCTE is the same definition Finance uses for "Owed to you" — charges raised and
// still pending — so the number on a reception row and the number on the Finance page
// cannot disagree. Ageing is counted in the clinic's day.
//
// It is appended to dental.SessionMoneySQL, which opens the WITH and takes the same
// $1 (tenant), so "unbilled" here is the dental report's own definition.
var owedCTE = dental.SessionMoneySQL + `,
owed AS (
  SELECT c.patient_id,
         sum(c.amount) AS amt,
         max((now() AT TIME ZONE $2)::date - (c.created_at AT TIME ZONE $2)::date) AS oldest,
         -- Money the clinic agreed to be owed is not the same fact as a charge nobody
         -- collected, and the desk should not have to treat them alike. Both are still
         -- owed; only one is a surprise.
         bool_and(c.deferred_at IS NOT NULL) AS all_agreed
    FROM charges c
   WHERE c.tenant_id = $1 AND c.status = 'pending' AND c.deleted_at IS NULL
   GROUP BY c.patient_id
),
unbilled AS (
  SELECT sm.patient_id, sum(sm.owed_amount) AS amt
    FROM session_money sm
    JOIN treatment_plans pl ON pl.id = sm.plan_id AND pl.tenant_id = sm.tenant_id
   WHERE sm.owed_now AND pl.status <> 'cancelled' AND sm.session_status <> 'cancelled'
     AND sm.pay_state IN ('unpaid','refunded') AND sm.owed_amount > 0.005
   GROUP BY sm.patient_id
)`

func (s *Service) ReceptionToday(ctx context.Context) (*scheduling.ReceptionToday, error) {
	tenantID, _ := actorOf(ctx)
	branch := activeBranchOf(ctx)
	out := &scheduling.ReceptionToday{
		Expected: []scheduling.ReceptionPatient{},
		Waiting:  []scheduling.ReceptionPatient{},
		Seen:     []scheduling.ReceptionPatient{},
		Recent:   []scheduling.ReceptionPatient{},
	}

	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// --- expected: booked today, not yet arrived -------------------------
		rows, e := tx.Query(ctx, owedCTE+`
			SELECT `+receptionCols+`,
			       a.id, a.starts_at, a.provider_id, coalesce(u.full_name,''),
			       a.department_id, coalesce(d.name,''), coalesce(a.reason,''),
			       a.is_followup, a.free_until
			  FROM appointments a
			  JOIN patients p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id AND p.deleted_at IS NULL
			  LEFT JOIN users u ON u.id = a.provider_id AND u.tenant_id = a.tenant_id
			  LEFT JOIN departments d ON d.id = a.department_id AND d.tenant_id = a.tenant_id
			  LEFT JOIN owed ON owed.patient_id = p.id
			  LEFT JOIN unbilled ON unbilled.patient_id = p.id
			 WHERE a.tenant_id = $1
			   AND a.status IN ('booked','confirmed')
			   AND (a.starts_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
			   AND ($3::uuid IS NULL OR a.branch_id = $3)
			 ORDER BY a.starts_at`,
			tenantID, addisTZ, branchArg(branch))
		if e != nil {
			return e
		}
		for rows.Next() {
			var r scheduling.ReceptionPatient
			var pid, apptID uuid.UUID
			var provID, deptID *uuid.UUID
			var startsAt time.Time
			var freeUntil *time.Time
			if e := rows.Scan(&pid, &r.Name, &r.MRN, &r.Age, &r.Sex, &r.Phone, &r.Owed, &r.OwedOldestDays, &r.OwedAgreed, &r.Unbilled,
				&apptID, &startsAt, &provID, &r.ProviderName, &deptID, &r.DepartmentName,
				&r.Reason, &r.IsFollowup, &freeUntil); e != nil {
				rows.Close()
				return e
			}
			r.PatientID = id.Encode(id.PrefixPatient, pid)
			r.AppointmentID = id.Encode(id.PrefixAppointment, apptID)
			r.StartsAt = startsAt.Format(time.RFC3339)
			// Late is measured now, not at page load: a row that goes amber while the
			// desk is looking at it is the point.
			r.LateMinutes = int(time.Since(startsAt).Minutes())
			if provID != nil {
				r.ProviderID = id.Encode(id.PrefixUser, *provID)
			}
			if deptID != nil {
				r.DepartmentID = id.Encode(id.PrefixDepartment, *deptID)
			}
			if freeUntil != nil {
				r.FreeUntil = freeUntil.Format(time.RFC3339)
			}
			out.Expected = append(out.Expected, r)
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return e
		}

		// --- expected: treatment visits planned for today (APT-1) ------------------
		//
		// A dental clinic's day is mostly visits of a course (root canal, visit 2 of 3),
		// which are planned on the treatment plan and are not appointments. The home
		// screen counted them; this list did not, so the desk saw a day with half its
		// patients missing. One row per patient, the earliest planned visit; a patient
		// already booked today appears once, as the booking; a patient already received
		// leaves the list, as a booked one does.
		trows, e := tx.Query(ctx, owedCTE+`
			SELECT `+receptionCols+`, pl.title, v.seq, pl.session_count
			  FROM (
			    SELECT DISTINCT ON (se.patient_id) se.patient_id, se.plan_id, se.seq
			      FROM treatment_sessions se
			      JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
			     WHERE se.tenant_id = $1 AND se.kind = 'visit' AND se.status = 'planned' AND pl.status = 'active'
			       AND se.scheduled_date = (now() AT TIME ZONE $2)::date
			       AND ($3::uuid IS NULL OR se.branch_id IS NULL OR se.branch_id = $3)
			     ORDER BY se.patient_id, se.seq
			  ) v
			  JOIN treatment_plans pl ON pl.id = v.plan_id
			  JOIN patients p ON p.id = v.patient_id AND p.tenant_id = $1 AND p.deleted_at IS NULL
			  LEFT JOIN owed ON owed.patient_id = p.id
			  LEFT JOIN unbilled ON unbilled.patient_id = p.id
			 WHERE NOT EXISTS (SELECT 1 FROM appointments a
			                    WHERE a.tenant_id = $1 AND a.patient_id = p.id AND a.status IN ('booked','confirmed')
			                      AND (a.starts_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
			                      AND ($3::uuid IS NULL OR a.branch_id = $3))
			   AND NOT EXISTS (SELECT 1 FROM queue_entries q
			                    WHERE q.tenant_id = $1 AND q.patient_id = p.id AND q.deleted_at IS NULL
			                      AND (q.enqueued_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
			                      AND q.state IN ('waiting','called','in_consult','done')
			                      AND ($3::uuid IS NULL OR q.branch_id = $3))
			 ORDER BY lower(p.first_name), p.id`,
			tenantID, addisTZ, branchArg(branch))
		if e != nil {
			return e
		}
		visits, e := pgx.CollectRows(trows, func(row pgx.CollectableRow) (scheduling.ReceptionPatient, error) {
			var r scheduling.ReceptionPatient
			var pid uuid.UUID
			var title string
			var seq, of int
			err := row.Scan(&pid, &r.Name, &r.MRN, &r.Age, &r.Sex, &r.Phone, &r.Owed, &r.OwedOldestDays, &r.OwedAgreed, &r.Unbilled,
				&title, &seq, &of)
			r.PatientID = id.Encode(id.PrefixPatient, pid)
			r.TreatmentVisit = true
			r.Reason = fmt.Sprintf("%s · visit %d of %d", title, seq, of)
			return r, err
		})
		if e != nil {
			return e
		}
		out.Expected = append(out.Expected, visits...)

		// --- waiting and seen: the queue this desk created --------------------
		//
		// Read from queue_entries rather than appointments, because a walk-in has no
		// appointment and is just as much a person in the room.
		qrows, e := tx.Query(ctx, owedCTE+`
			SELECT `+receptionCols+`,
			       q.state, q.stage, q.enqueued_at, coalesce(d.name,''), coalesce(u.full_name,'')
			  FROM queue_entries q
			  JOIN patients p ON p.id = q.patient_id AND p.tenant_id = q.tenant_id AND p.deleted_at IS NULL
			  LEFT JOIN departments d ON d.id = q.department_id AND d.tenant_id = q.tenant_id
			  LEFT JOIN users u ON u.id = q.assigned_provider_id AND u.tenant_id = q.tenant_id
			  LEFT JOIN owed ON owed.patient_id = p.id
			  LEFT JOIN unbilled ON unbilled.patient_id = p.id
			 WHERE q.tenant_id = $1
			   AND (q.enqueued_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
			   AND q.state IN ('waiting','called','in_consult','done')
			   AND ($3::uuid IS NULL OR q.branch_id = $3)
			 ORDER BY q.enqueued_at`,
			tenantID, addisTZ, branchArg(branch))
		if e != nil {
			return e
		}
		defer qrows.Close()
		for qrows.Next() {
			var r scheduling.ReceptionPatient
			var pid uuid.UUID
			var state string
			var enqueuedAt time.Time
			if e := qrows.Scan(&pid, &r.Name, &r.MRN, &r.Age, &r.Sex, &r.Phone, &r.Owed, &r.OwedOldestDays, &r.OwedAgreed, &r.Unbilled,
				&state, &r.Stage, &enqueuedAt, &r.DepartmentName, &r.ProviderName); e != nil {
				return e
			}
			r.PatientID = id.Encode(id.PrefixPatient, pid)
			r.WaitingSince = enqueuedAt.Format(time.RFC3339)
			if state == "done" {
				r.Finished = true
				out.Seen = append(out.Seen, r)
			} else {
				out.Waiting = append(out.Waiting, r)
			}
		}
		if e := qrows.Err(); e != nil {
			return e
		}
		qrows.Close() // the connection is needed for the two small queries below

		// --- for an empty day: returning patients, and when the diary fills again ----
		c := &cardTx{ctx: ctx, tx: tx}
		c.each(`
			SELECT p.id, trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), coalesce(p.mrn,''),
			       coalesce(date_part('year', age(p.dob))::int, 0), coalesce(p.gender,''), coalesce(p.phone,''),
			       max(q.enqueued_at)
			  FROM queue_entries q
			  JOIN patients p ON p.id = q.patient_id AND p.tenant_id = q.tenant_id AND p.deleted_at IS NULL
			 WHERE q.tenant_id = $1 AND q.deleted_at IS NULL AND q.state = 'done'
			   AND (q.enqueued_at AT TIME ZONE $2)::date < (now() AT TIME ZONE $2)::date
			   AND ($3::uuid IS NULL OR q.branch_id = $3)
			 GROUP BY p.id ORDER BY max(q.enqueued_at) DESC LIMIT 5`,
			[]any{tenantID, addisTZ, branchArg(branch)}, func(r pgx.Rows) error {
				var x scheduling.ReceptionPatient
				var pid uuid.UUID
				var at time.Time
				if e := r.Scan(&pid, &x.Name, &x.MRN, &x.Age, &x.Sex, &x.Phone, &at); e != nil {
					return e
				}
				x.PatientID, x.WaitingSince = id.Encode(id.PrefixPatient, pid), at.Format(time.RFC3339)
				out.Recent = append(out.Recent, x)
				return nil
			})
		var nb scheduling.NextBooking
		var nbAt *time.Time
		if c.one(`
			SELECT min(a.starts_at), count(*) FILTER (
			         WHERE (a.starts_at AT TIME ZONE $2)::date = (d.first AT TIME ZONE $2)::date)::int
			  FROM appointments a
			  CROSS JOIN LATERAL (
			    SELECT min(b.starts_at) AS first FROM appointments b
			     WHERE b.tenant_id = $1 AND b.status IN ('booked','confirmed')
			       AND (b.starts_at AT TIME ZONE $2)::date > (now() AT TIME ZONE $2)::date
			       AND ($3::uuid IS NULL OR b.branch_id = $3)) d
			 WHERE a.tenant_id = $1 AND a.status IN ('booked','confirmed')
			   AND (a.starts_at AT TIME ZONE $2)::date > (now() AT TIME ZONE $2)::date
			   AND ($3::uuid IS NULL OR a.branch_id = $3)`,
			[]any{tenantID, addisTZ, branchArg(branch)}, &nbAt, &nb.Count) && nbAt != nil && nb.Count > 0 {
			nb.StartsAt = nbAt.Format(time.RFC3339)
			out.NextBooking = &nb
		}
		return c.err
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func branchArg(b *uuid.UUID) any {
	if b == nil {
		return nil
	}
	return *b
}

// cardTx runs the card's queries one after another and remembers the first failure, so
// the assembly below reads as the list of questions it is, not as error handling.
type cardTx struct {
	ctx context.Context
	tx  pgx.Tx
	err error
}

// one reads a single row. False means there was none (or an earlier query failed).
func (c *cardTx) one(sql string, args []any, dest ...any) bool {
	if c.err != nil {
		return false
	}
	e := c.tx.QueryRow(c.ctx, sql, args...).Scan(dest...)
	if errors.Is(e, pgx.ErrNoRows) {
		return false
	}
	c.err = e
	return e == nil
}

// each reads every row through scan.
func (c *cardTx) each(sql string, args []any, scan func(pgx.Rows) error) {
	if c.err != nil {
		return
	}
	rows, e := c.tx.Query(c.ctx, sql, args...)
	if e != nil {
		c.err = e
		return
	}
	defer rows.Close()
	for rows.Next() {
		if e := scan(rows); e != nil {
			c.err = e
			return
		}
	}
	c.err = rows.Err()
}

// ReceptionCard assembles one patient's card in a single transaction, so the sections
// cannot disagree with each other or with the Finance page (the bills use the same
// "pending" definition as Owed to you).
func (s *Service) ReceptionCard(ctx context.Context, patientID uuid.UUID) (*scheduling.ReceptionCard, error) {
	tenantID, _ := actorOf(ctx)
	branch := branchArg(activeBranchOf(ctx))
	out := &scheduling.ReceptionCard{Missed: []scheduling.CardVisit{}, Bills: []scheduling.CardBill{}, OwedTotal: "0", UnbilledTotal: "0"}
	const today = `(now() AT TIME ZONE $2)::date`
	eat := time.FixedZone("EAT", 3*3600)
	// Args shared by every query below: tenant, clinic timezone, patient (and branch).
	args := []any{tenantID, addisTZ, patientID}

	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		c := &cardTx{ctx: ctx, tx: tx}
		var exists bool
		if !c.one(`SELECT true FROM patients WHERE tenant_id = $1 AND $2::text IS NOT NULL AND id = $3 AND deleted_at IS NULL`,
			args, &exists) && c.err == nil {
			return pgx.ErrNoRows
		}

		// --- today's booking: the first one not cancelled or missed -------------
		var apptID uuid.UUID
		var startsAt time.Time
		var title, prov, dept, status string
		var follow bool
		if c.one(`
			SELECT a.id, a.starts_at, coalesce(a.reason,''), coalesce(u.full_name,''), coalesce(d.name,''), a.status, a.is_followup
			  FROM appointments a
			  LEFT JOIN users u ON u.id = a.provider_id AND u.tenant_id = a.tenant_id
			  LEFT JOIN departments d ON d.id = a.department_id AND d.tenant_id = a.tenant_id
			 WHERE a.tenant_id = $1 AND a.patient_id = $3
			   AND a.status IN ('booked','confirmed','checked_in')
			   AND (a.starts_at AT TIME ZONE $2)::date = `+today+`
			   AND ($4::uuid IS NULL OR a.branch_id = $4)
			 ORDER BY a.starts_at LIMIT 1`, append(args, branch),
			&apptID, &startsAt, &title, &prov, &dept, &status, &follow) {
			out.Appointment = &scheduling.CardVisit{
				Kind: "appointment", AppointmentID: id.Encode(id.PrefixAppointment, apptID),
				When: startsAt.Format(time.RFC3339), Title: title, ProviderName: prov, DepartmentName: dept,
				Status: status, IsFollowup: follow,
			}
		}

		// --- today's treatment session, "Root canal, visit 2 of 3" --------------
		var when time.Time
		var seq, count int
		if c.one(`
			SELECT ts.scheduled_date::timestamp, pl.title, ts.seq, pl.session_count
			  FROM treatment_sessions ts
			  JOIN treatment_plans pl ON pl.id = ts.plan_id AND pl.tenant_id = ts.tenant_id
			 WHERE ts.tenant_id = $1 AND ts.patient_id = $3 AND ts.status = 'planned'
			   AND pl.status <> 'cancelled' AND ts.scheduled_date = `+today+`
			 ORDER BY ts.seq LIMIT 1`, args, &when, &title, &seq, &count) {
			out.Session = &scheduling.CardVisit{
				Kind: "session", When: when.Format("2006-01-02"),
				Title: fmt.Sprintf("%s, visit %d of %d", title, seq, count),
			}
		}

		// --- missed in the last 90 days (3 newest) ------------------------------
		c.each(`
			SELECT * FROM (
			  SELECT 'appointment', (a.starts_at AT TIME ZONE $2)::date AS d,
			         coalesce(a.reason,''), coalesce(u.full_name,''), a.id
			    FROM appointments a
			    LEFT JOIN users u ON u.id = a.provider_id AND u.tenant_id = a.tenant_id
			   WHERE a.tenant_id = $1 AND a.patient_id = $3 AND a.status = 'no_show'
			     AND (a.starts_at AT TIME ZONE $2)::date >= `+today+` - 90
			     AND (a.starts_at AT TIME ZONE $2)::date < `+today+`
			  UNION ALL
			  SELECT 'session', ts.scheduled_date AS d,
			         pl.title || ', visit ' || ts.seq || ' of ' || pl.session_count, '', NULL::uuid
			    FROM treatment_sessions ts
			    JOIN treatment_plans pl ON pl.id = ts.plan_id AND pl.tenant_id = ts.tenant_id
			   WHERE ts.tenant_id = $1 AND ts.patient_id = $3 AND ts.status = 'planned'
			     AND pl.status <> 'cancelled'
			     AND ts.scheduled_date >= `+today+` - 90 AND ts.scheduled_date < `+today+`
			) m ORDER BY d DESC LIMIT 3`, args, func(r pgx.Rows) error {
			var v scheduling.CardVisit
			var d time.Time
			var aid *uuid.UUID
			if e := r.Scan(&v.Kind, &d, &v.Title, &v.ProviderName, &aid); e != nil {
				return e
			}
			v.When, v.Status = d.Format("2006-01-02"), "missed"
			if aid != nil {
				v.AppointmentID = id.Encode(id.PrefixAppointment, *aid)
			}
			out.Missed = append(out.Missed, v)
			return nil
		})

		// --- next visit after today: the earlier of a booking and a session -----
		var next scheduling.CardVisit
		var nextAt time.Time
		var nextAID *uuid.UUID
		if c.one(`
			SELECT kind, d, title, prov, dept, aid FROM (
			  SELECT 'appointment' AS kind, a.starts_at AS d, coalesce(a.reason,'') AS title,
			         coalesce(u.full_name,'') AS prov, coalesce(dp.name,'') AS dept, a.id AS aid
			    FROM appointments a
			    LEFT JOIN users u ON u.id = a.provider_id AND u.tenant_id = a.tenant_id
			    LEFT JOIN departments dp ON dp.id = a.department_id AND dp.tenant_id = a.tenant_id
			   WHERE a.tenant_id = $1 AND a.patient_id = $3 AND a.status IN ('booked','confirmed')
			     AND (a.starts_at AT TIME ZONE $2)::date > `+today+`
			  UNION ALL
			  SELECT 'session', ts.scheduled_date::timestamp AT TIME ZONE $2,
			         pl.title || ', visit ' || ts.seq || ' of ' || pl.session_count, '', '', NULL::uuid
			    FROM treatment_sessions ts
			    JOIN treatment_plans pl ON pl.id = ts.plan_id AND pl.tenant_id = ts.tenant_id
			   WHERE ts.tenant_id = $1 AND ts.patient_id = $3 AND ts.status = 'planned'
			     AND pl.status <> 'cancelled' AND ts.scheduled_date > `+today+`
			) n ORDER BY d LIMIT 1`, args,
			&next.Kind, &nextAt, &next.Title, &next.ProviderName, &next.DepartmentName, &nextAID) {
			next.When = nextAt.Format(time.RFC3339)
			if next.Kind == "session" {
				next.When = nextAt.In(eat).Format("2006-01-02")
			}
			if nextAID != nil {
				next.AppointmentID = id.Encode(id.PrefixAppointment, *nextAID)
			}
			out.Next = &next
		}

		// --- itemised unpaid bills, oldest first --------------------------------
		//
		// Today's own routed intake charge is the fee block's business, not an
		// "earlier bill": listing it twice would let the desk tick the same fee in two
		// places.
		c.each(`
			SELECT c.id, c.description, c.amount::text, c.source, c.created_at,
			       ((now() AT TIME ZONE $2)::date - (c.created_at AT TIME ZONE $2)::date)::int,
			       c.department_id IS NOT NULL, c.deferred_at IS NOT NULL, coalesce(c.defer_reason,''),
			       c.desk_selected_at IS NOT NULL
			  FROM charges c
			 WHERE c.tenant_id = $1 AND c.patient_id = $3 AND c.status = 'pending' AND c.deleted_at IS NULL
			   AND c.source <> 'refund'
			   AND NOT (c.department_id IS NOT NULL AND c.deferred_at IS NULL
			            AND (c.created_at AT TIME ZONE $2)::date = `+today+`)
			 ORDER BY c.created_at`, args, func(r pgx.Rows) error {
			var cid uuid.UUID
			var b scheduling.CardBill
			var created time.Time
			if e := r.Scan(&cid, &b.Description, &b.Amount, &b.Source, &created, &b.AgeDays,
				&b.AtCashier, &b.Agreed, &b.AgreedWhy, &b.DeskPicked); e != nil {
				return e
			}
			b.ID, b.CreatedAt = id.Encode(id.PrefixCharge, cid), created.Format(time.RFC3339)
			out.Bills = append(out.Bills, b)
			return nil
		})

		// --- totals on the same definition the list rows use --------------------
		c.one(owedCTE+`
			SELECT coalesce(owed.amt,0)::text, coalesce(unbilled.amt,0)::text
			  FROM patients p
			  LEFT JOIN owed ON owed.patient_id = p.id
			  LEFT JOIN unbilled ON unbilled.patient_id = p.id
			 WHERE p.tenant_id = $1 AND p.id = $3`, args, &out.OwedTotal, &out.UnbilledTotal)

		// --- usual clinician and last visit ---------------------------------------
		var usual *uuid.UUID
		var usualName string
		var last time.Time
		if c.one(`
			SELECT q.assigned_provider_id, coalesce(u.full_name,''), q.enqueued_at
			  FROM queue_entries q
			  LEFT JOIN users u ON u.id = q.assigned_provider_id AND u.tenant_id = q.tenant_id
			 WHERE q.tenant_id = $1 AND $2::text IS NOT NULL AND q.patient_id = $3 AND q.deleted_at IS NULL
			   AND q.assigned_provider_id IS NOT NULL
			 ORDER BY q.enqueued_at DESC LIMIT 1`, args, &usual, &usualName, &last) {
			out.UsualProviderID = id.Encode(id.PrefixUser, *usual)
			out.UsualProviderName, out.LastVisitAt = usualName, last.Format(time.RFC3339)
		}

		// --- already in today's queue ---------------------------------------------
		var live int
		c.one(`
			SELECT count(*)::int FROM queue_entries
			 WHERE tenant_id = $1 AND patient_id = $3 AND deleted_at IS NULL
			   AND state NOT IN ('done','no_show')
			   AND (enqueued_at AT TIME ZONE $2)::date = `+today, args, &live)
		out.InQueue = live > 0
		return c.err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("PATIENT_NOT_FOUND", "patient not found")
	}
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}
