package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// The chair, with everything a dentist needs before touching a patient — and
// everything a check-out would throw away.
//
// The list was the generic queue: a name, a card number, a wait time. Whether the
// patient in the chair is allergic to penicillin, whether the work just done has
// been billed, whether anything was recorded at all — none of it was on the screen
// where the decisions are made, so "Check out" was a single unguarded click that
// could quietly end a visit with nothing written down and nothing charged.
//
// One query. A separate call per patient per fact would have been four round trips a
// card, and a chair list is refetched every twenty seconds.
// Appended to SessionMoneySQL, which already opens the WITH — so this continues the
// CTE list rather than starting a second one.
const chairsideSQL = `
, live AS (
  SELECT q.id, q.patient_id, q.state, q.stage, q.priority,
         q.enqueued_at, q.started_at, q.ended_at,
         q.department_id, q.assigned_provider_id
    FROM queue_entries q
   WHERE q.tenant_id = $1 AND q.deleted_at IS NULL
     AND ($2::uuid IS NULL OR q.branch_id = $2)
     AND q.enqueued_at >= $3
     AND ($4::timestamptz IS NULL OR q.enqueued_at < $4)
     -- Both halves of the day: who is still here, and who has been seen. The dentist
     -- needs the second to undo a mistake and to look back over the morning.
     AND q.state IN ('waiting','called','in_consult','done')
)
SELECT l.id, l.patient_id, l.state, l.stage, l.priority,
       l.enqueued_at, l.started_at, l.ended_at,
       coalesce(d.name,''), l.assigned_provider_id, coalesce(u.full_name, u.email, ''),
       trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), coalesce(p.mrn,''),
       coalesce(date_part('year', age(p.dob))::int, 0), coalesce(p.gender,''),
       coalesce(alg.list, ''),
       coalesce(owed.amt, 0)::text,
       coalesce(unbilled.amt, 0)::text,
       coalesce(rec.n, 0),
       coalesce(plan.title, ''), coalesce(plan.done, 0), coalesce(plan.total, 0)
  FROM live l
  JOIN patients p ON p.id = l.patient_id AND p.tenant_id = $1
  LEFT JOIN departments d ON d.id = l.department_id AND d.tenant_id = $1
  LEFT JOIN users u ON u.id = l.assigned_provider_id AND u.tenant_id = $1
  -- Anything that could hurt them, named on the card rather than one click away.
  LEFT JOIN LATERAL (
      SELECT string_agg(a.substance, ', ' ORDER BY a.substance) AS list
        FROM allergies a
       WHERE a.tenant_id = $1 AND a.patient_id = p.id AND a.deleted_at IS NULL
         AND a.severity <> 'mild'
  ) alg ON true
  LEFT JOIN LATERAL (
      SELECT sum(c.amount) AS amt FROM charges c
       WHERE c.tenant_id = $1 AND c.patient_id = p.id
         AND c.status = 'pending' AND c.deleted_at IS NULL
  ) owed ON true
  -- Treatment delivered and never billed. The same definition the Unbilled
  -- treatment report uses, so the chair and the report cannot disagree.
  LEFT JOIN LATERAL (
      SELECT sum(sm.amount_due) AS amt
        FROM session_money sm
       WHERE sm.patient_id = p.id
         AND sm.owed_now AND sm.pay_state = 'unpaid'
         AND sm.session_status <> 'cancelled'
  ) unbilled ON true
  -- Did anything actually get written down during THIS visit? Counted from the
  -- moment they were enqueued, so yesterday's notes cannot vouch for today.
  LEFT JOIN LATERAL (
      SELECT (
        (SELECT count(*) FROM treatment_sessions se
          WHERE se.tenant_id = $1 AND se.patient_id = p.id
            AND se.completed_at IS NOT NULL AND se.completed_at >= l.enqueued_at)
      + (SELECT count(*) FROM dental_visits dv
          WHERE dv.tenant_id = $1 AND dv.patient_id = p.id
            AND dv.created_at >= l.enqueued_at)
      )::int AS n
  ) rec ON true
  -- Where they are in their course, so the dentist knows before opening the chart.
  LEFT JOIN LATERAL (
      SELECT tp.title,
             count(*) FILTER (WHERE se.status = 'done')::int AS done,
             count(*) FILTER (WHERE se.status <> 'cancelled' AND se.kind = 'visit')::int AS total
        FROM treatment_plans tp
        LEFT JOIN treatment_sessions se ON se.plan_id = tp.id AND se.tenant_id = tp.tenant_id
       WHERE tp.tenant_id = $1 AND tp.patient_id = p.id AND tp.status = 'active'
       GROUP BY tp.id, tp.title
       ORDER BY max(se.scheduled_date) DESC NULLS LAST
       LIMIT 1
  ) plan ON true
 ORDER BY (l.state = 'done'), l.priority DESC, l.enqueued_at`

// Chairside returns the chair list for one provider, or the whole clinic's when no
// provider is given. Unassigned arrivals come back too — somebody has to pick them
// up, and a patient nobody has claimed is the one most likely to be forgotten.
func (s *Service) Chairside(ctx context.Context, providerID *uuid.UUID, from time.Time, until *time.Time) ([]dental.ChairPatient, error) {
	tenantID, _ := actorOf(ctx)
	out := []dental.ChairPatient{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, dental.SessionMoneySQL+chairsideSQL,
			tenantID, branchAny(ctx), from, until)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var c dental.ChairPatient
			var qid, pid uuid.UUID
			var prov *uuid.UUID
			if e := rows.Scan(&qid, &pid, &c.State, &c.Stage, &c.Priority,
				&c.EnqueuedAt, &c.StartedAt, &c.EndedAt,
				&c.DepartmentName, &prov, &c.ProviderName,
				&c.PatientName, &c.MRN, &c.Age, &c.Sex,
				&c.Allergies, &c.Owed, &c.Unbilled, &c.RecordedThisVisit,
				&c.PlanTitle, &c.PlanDone, &c.PlanTotal); e != nil {
				return e
			}
			c.QueueID, c.PatientID, c.ProviderID = qid, pid, prov
			out = append(out, c)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	// Filtering here rather than in SQL: the unassigned pool must come back whoever
	// is being viewed, and expressing "mine OR nobody's" as a parameter made the
	// query harder to read than the loop that replaces it.
	if providerID != nil {
		kept := out[:0]
		for _, c := range out {
			if c.ProviderID == nil || *c.ProviderID == *providerID {
				kept = append(kept, c)
			}
		}
		out = kept
	}
	return out, nil
}

// branchAny hands activeBranchOf's pointer to pgx as a nullable uuid: nil means
// "every branch", which is what a clinic with one branch and no switcher wants.
func branchAny(ctx context.Context) any {
	if b := activeBranchOf(ctx); b != nil {
		return *b
	}
	return nil
}
