package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/finance"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

// DentalAdapter reads the two dental figures the charge ledger cannot know.
//
// It queries treatment_sessions directly, but only through the SAME predicate the
// dental module uses for "delivered and still owed" — a session that is done, on a
// live plan, whose charge is missing, void, or has been refunded. If that rule
// ever changes in dental it must change here too, which is why the predicate is
// written once in this file and used by both methods.
type DentalAdapter struct{ db *kerneldb.DB }

var _ finance.Dental = (*DentalAdapter)(nil)

func NewDentalAdapter(db *kerneldb.DB) *DentalAdapter { return &DentalAdapter{db: db} }

// owedSessions is dental's "delivered but not paid for", as a joinable CTE.
const owedSessions = `
owed_session AS (
  SELECT se.patient_id,
         CASE
           WHEN c.id IS NULL OR c.status = 'void' THEN se.amount_due
           ELSE coalesce(rev.refunded, 0)
         END AS amount,
         coalesce(se.completed_at::date, se.scheduled_date) AS since
  FROM treatment_sessions se
  JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
  LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT sum(-r.amount) AS refunded FROM charges r
     WHERE r.tenant_id = c.tenant_id AND r.reverses_charge_id = c.id AND r.deleted_at IS NULL
  ) rev ON true
  WHERE se.tenant_id = $1
    AND se.kind = 'visit'
    AND se.status = 'done'
    AND pl.status <> 'cancelled'
    AND (c.id IS NULL OR c.status = 'void' OR (c.status = 'paid' AND rev.refunded IS NOT NULL))
)`

func (a *DentalAdapter) UnbilledTotal(ctx context.Context) (string, int, error) {
	tid := tenantOf(ctx)
	var amount string
	var n int
	err := a.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `WITH `+owedSessions+`
			SELECT coalesce(sum(amount),0)::text, count(*) FROM owed_session WHERE amount > 0.005`,
			tid).Scan(&amount, &n)
	})
	return money(amount), n, err
}

func (a *DentalAdapter) UnbilledByPatient(ctx context.Context) ([]finance.UnbilledPatient, error) {
	tid := tenantOf(ctx)
	out := []finance.UnbilledPatient{}
	err := a.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `WITH `+owedSessions+`
			SELECT patient_id, sum(amount)::text, max((now()::date - since))::int
			  FROM owed_session WHERE amount > 0.005 GROUP BY patient_id`, tid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var u finance.UnbilledPatient
			if e := rows.Scan(&u.PatientID, &u.Amount, &u.OldestDay); e != nil {
				return e
			}
			out = append(out, u)
		}
		return rows.Err()
	})
	return out, err
}

// BookedAhead is the forward book: visits scheduled from today onward that nobody
// has been charged for yet. It is an INTENTION, not revenue, and the page must say
// so — a course can be abandoned at any point.
func (a *DentalAdapter) BookedAhead(ctx context.Context, branch *uuid.UUID) (string, int, error) {
	tid := tenantOf(ctx)
	var amount string
	var n int
	err := a.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT coalesce(sum(se.amount_due),0)::text, count(*)
			   FROM treatment_sessions se
			   JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
			   LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
			  WHERE se.tenant_id = $1 AND se.kind = 'visit' AND se.status = 'planned'
			    AND pl.status = 'active'
			    AND se.scheduled_date >= (now() AT TIME ZONE 'Africa/Addis_Ababa')::date
			    AND (c.id IS NULL OR c.status = 'void')
			    AND ($2::uuid IS NULL OR se.branch_id = $2 OR se.branch_id IS NULL)`,
			tid, branchArg(branch)).Scan(&amount, &n)
	})
	return money(amount), n, err
}
