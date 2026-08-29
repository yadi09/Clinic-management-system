package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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
	coalesce(owed.amt, 0)::text, coalesce(owed.oldest, 0)::int, coalesce(owed.all_agreed, false)`

// owedCTE is the same definition Finance uses for "Owed to you" — charges raised and
// still pending — so the number on a reception row and the number on the Finance page
// cannot disagree. Ageing is counted in the clinic's day.
const owedCTE = `
WITH owed AS (
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
)`

func (s *Service) ReceptionToday(ctx context.Context) (*scheduling.ReceptionToday, error) {
	tenantID, _ := actorOf(ctx)
	branch := activeBranchOf(ctx)
	out := &scheduling.ReceptionToday{
		Expected: []scheduling.ReceptionPatient{},
		Waiting:  []scheduling.ReceptionPatient{},
		Seen:     []scheduling.ReceptionPatient{},
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
			if e := rows.Scan(&pid, &r.Name, &r.MRN, &r.Age, &r.Sex, &r.Phone, &r.Owed, &r.OwedOldestDays, &r.OwedAgreed,
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
			if e := qrows.Scan(&pid, &r.Name, &r.MRN, &r.Age, &r.Sex, &r.Phone, &r.Owed, &r.OwedOldestDays, &r.OwedAgreed,
				&state, &r.Stage, &enqueuedAt, &r.DepartmentName, &r.ProviderName); e != nil {
				return e
			}
			r.PatientID = id.Encode(id.PrefixPatient, pid)
			r.WaitingSince = enqueuedAt.Format(time.RFC3339)
			if state == "done" {
				out.Seen = append(out.Seen, r)
			} else {
				out.Waiting = append(out.Waiting, r)
			}
		}
		return qrows.Err()
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
