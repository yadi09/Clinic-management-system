package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dental"
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

// owedSessions is dental's "delivered but not paid for", as a joinable CTE — built
// on dental.SessionMoneySQL, so Finance's Receivables and Overview agree with the
// dental Unbilled report. Its own copy left out down payments and extras
// (kind = 'visit'), ignored deleted patients and aged debt in UTC (audit D21/N-M3).
var owedSessions = dental.SessionMoneySQL + `,
owed_session AS (
  SELECT sm.patient_id, sm.owed_amount AS amount,
         (sm.owed_since AT TIME ZONE 'Africa/Addis_Ababa')::date AS since
    FROM session_money sm
    JOIN patients pt ON pt.id = sm.patient_id AND pt.tenant_id = sm.tenant_id AND pt.deleted_at IS NULL
   WHERE sm.alive AND sm.owed_now AND sm.pay_state IN ('unpaid','refunded')
)`

func (a *DentalAdapter) UnbilledTotal(ctx context.Context) (string, int, error) {
	tid := tenantOf(ctx)
	var amount string
	var n int
	err := a.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, owedSessions+`
			SELECT coalesce(sum(amount),0)::text, count(*) FROM owed_session WHERE amount > 0.005`,
			tid).Scan(&amount, &n)
	})
	return money(amount), n, err
}

func (a *DentalAdapter) UnbilledByPatient(ctx context.Context) ([]finance.UnbilledPatient, error) {
	tid := tenantOf(ctx)
	out := []finance.UnbilledPatient{}
	err := a.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, owedSessions+`
			SELECT patient_id, sum(amount)::text, max(((now() AT TIME ZONE 'Africa/Addis_Ababa')::date - since))::int
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

// BookedByDay is the forward book one day at a time, for "the week ahead". Every
// planned visit on a live plan is counted, paid ahead or not, because it is a patient
// coming in; the amount keeps BookedAhead's rule (nothing charged yet), so the two
// figures on the dashboard can be added up and agree.
func (a *DentalAdapter) BookedByDay(ctx context.Context, branch *uuid.UUID, from, to time.Time) ([]finance.DayBooked, error) {
	tid := tenantOf(ctx)
	out := []finance.DayBooked{}
	err := a.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT d::date::text, count(se.id),
			        coalesce(sum(se.amount_due) FILTER (WHERE c.id IS NULL OR c.status = 'void'), 0)::text
			   FROM generate_series($2::date, $3::date, interval '1 day') d
			   LEFT JOIN treatment_sessions se
			     ON se.tenant_id = $1 AND se.kind = 'visit' AND se.status = 'planned'
			    AND se.scheduled_date = d::date
			    AND ($4::uuid IS NULL OR se.branch_id = $4 OR se.branch_id IS NULL)
			    AND EXISTS (SELECT 1 FROM treatment_plans pl
			                 WHERE pl.id = se.plan_id AND pl.tenant_id = se.tenant_id AND pl.status = 'active')
			   LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
			  GROUP BY d ORDER BY d`,
			tid, from, to, branchArg(branch))
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var b finance.DayBooked
			if e := rows.Scan(&b.Date, &b.Visits, &b.Amount); e != nil {
				return e
			}
			out = append(out, b)
		}
		return rows.Err()
	})
	return out, err
}
