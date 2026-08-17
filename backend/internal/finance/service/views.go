package service

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/finance"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// Cash answers "is the drawer what we billed".
//
// A variance is never rounded away or hidden behind a total: the number that
// matters is the one that does not match, and it is the reason this view exists.
func (s *Service) Cash(ctx context.Context, f finance.Filter) (*finance.CashView, error) {
	tid := tenantOf(ctx)
	out := &finance.CashView{
		Shifts: []finance.Shift{}, ByMethod: []finance.Line{}, ByCashier: []finance.Line{},
		ByBranch: []finance.Line{}, OpenDrawers: []finance.Line{}, Variance: "0.00",
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT r.business_date::text, coalesce(u.full_name, u.email, 'unknown'),
			        r.expected_total::text, r.counted_total::text, r.variance::text, coalesce(r.note,'')
			   FROM cash_reconciliations r
			   LEFT JOIN users u ON u.id = r.cashier_id AND u.tenant_id = r.tenant_id
			  WHERE r.tenant_id = $1
			    AND r.business_date >= $2::date AND r.business_date < $3::date
			  ORDER BY r.business_date DESC`,
			tid, f.From, f.To)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var sh finance.Shift
			if e := rows.Scan(&sh.Date, &sh.Cashier, &sh.Expected, &sh.Counted, &sh.Variance, &sh.Note); e != nil {
				return e
			}
			out.Shifts = append(out.Shifts, sh)
		}
		if e := rows.Err(); e != nil {
			return e
		}

		if e := tx.QueryRow(ctx,
			`SELECT coalesce(sum(abs(variance)),0)::text FROM cash_reconciliations
			  WHERE tenant_id = $1 AND business_date >= $2::date AND business_date < $3::date`,
			tid, f.From, f.To).Scan(&out.Variance); e != nil {
			return e
		}

		// The three splits of what was actually collected in the window.
		group := func(sel, label string) ([]finance.Line, error) {
			q := fmt.Sprintf(`SELECT %s, coalesce(sum(c.amount),0)::text, count(*)
			   FROM charges c
			   LEFT JOIN users u ON u.id = c.settled_by AND u.tenant_id = c.tenant_id
			   LEFT JOIN branches b ON b.id = c.branch_id AND b.tenant_id = c.tenant_id
			  WHERE c.tenant_id = $1 AND c.status = 'paid' AND c.deleted_at IS NULL AND c.amount > 0
			    AND c.settled_at >= $2 AND c.settled_at < $3
			    AND ($4::uuid IS NULL OR c.branch_id = $4)
			  GROUP BY 1 ORDER BY 2 DESC`, sel)
			rr, e := tx.Query(ctx, q, tid, f.From, f.To, branchArg(f.Branch))
			if e != nil {
				return nil, e
			}
			defer rr.Close()
			lines := []finance.Line{}
			for rr.Next() {
				var l finance.Line
				if e := rr.Scan(&l.Key, &l.Amount, &l.Count); e != nil {
					return nil, e
				}
				l.Label = l.Key
				if l.Label == "" {
					l.Label = label
				}
				lines = append(lines, l)
			}
			return lines, rr.Err()
		}
		var e2 error
		if out.ByMethod, e2 = group("coalesce(c.payment_method,'')", "not recorded"); e2 != nil {
			return e2
		}
		if out.ByCashier, e2 = group("coalesce(u.full_name, u.email, '')", "not recorded"); e2 != nil {
			return e2
		}
		if out.ByBranch, e2 = group("coalesce(b.name,'')", "no branch"); e2 != nil {
			return e2
		}

		// Money taken today whose drawer has not been counted.
		orows, e := tx.Query(ctx,
			`SELECT coalesce(u.full_name, u.email, 'unknown'), coalesce(sum(c.amount),0)::text, count(*)
			   FROM charges c
			   LEFT JOIN users u ON u.id = c.settled_by AND u.tenant_id = c.tenant_id
			  WHERE c.tenant_id = $1 AND c.status = 'paid' AND c.deleted_at IS NULL AND c.amount > 0
			    AND c.settled_at::date = (now() AT TIME ZONE 'Africa/Addis_Ababa')::date
			    AND c.settled_by IS NOT NULL
			    AND NOT EXISTS (
			      SELECT 1 FROM cash_reconciliations r
			       WHERE r.tenant_id = c.tenant_id AND r.cashier_id = c.settled_by
			         AND r.business_date = (now() AT TIME ZONE 'Africa/Addis_Ababa')::date)
			  GROUP BY 1 ORDER BY 2 DESC`, tid)
		if e != nil {
			return e
		}
		defer orows.Close()
		for orows.Next() {
			var l finance.Line
			if e := orows.Scan(&l.Key, &l.Amount, &l.Count); e != nil {
				return e
			}
			l.Label = l.Key
			out.OpenDrawers = append(out.OpenDrawers, l)
		}
		return orows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// Services answers "what actually earns".
//
// Named by what the clinic sells: a catalogue service by its own name, and dental
// work by the course it belongs to — a charge described "Root canal — session 2/6"
// is one instalment of a root canal, and forty of those are one product line, not
// forty of them.
func (s *Service) Services(ctx context.Context, f finance.Filter) ([]finance.ServiceLine, error) {
	tid := tenantOf(ctx)
	out := []finance.ServiceLine{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT coalesce(nullif(si.name,''), nullif(pl.title,''), initcap(c.source)) AS label,
			        c.source,
			        count(*), coalesce(sum(c.amount),0)::text
			   FROM charges c
			   LEFT JOIN service_items si ON si.id = c.service_item_id AND si.tenant_id = c.tenant_id
			   LEFT JOIN treatment_sessions se ON se.charge_id = c.id AND se.tenant_id = c.tenant_id
			   LEFT JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = c.tenant_id
			  WHERE c.tenant_id = $1 AND c.status = 'paid' AND c.deleted_at IS NULL AND c.amount > 0
			    AND c.settled_at >= $2 AND c.settled_at < $3
			    AND ($4::uuid IS NULL OR c.branch_id = $4)
			  GROUP BY 1, 2 ORDER BY 4::numeric DESC`,
			tid, f.From, f.To, branchArg(f.Branch))
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var l finance.ServiceLine
			if e := rows.Scan(&l.Label, &l.Source, &l.Count, &l.Revenue); e != nil {
				return e
			}
			var rev float64
			fmt.Sscanf(l.Revenue, "%f", &rev)
			if l.Count > 0 {
				l.Avg = fmt.Sprintf("%.2f", rev/float64(l.Count))
			}
			out = append(out, l)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// Book answers "what is booked but not yet earned" — dental only.
//
// Every figure here is an INTENTION. A course can be abandoned at any visit, so
// this is never added to revenue and the page says so where it is shown.
func (s *Service) Book(ctx context.Context, f finance.Filter) (*finance.Book, error) {
	tid := tenantOf(ctx)
	out := &finance.Book{ByMonth: []finance.Line{}, AtRisk: []finance.PlanAtRisk{}, Total: "0.00"}
	if s.dental == nil {
		return out, nil
	}
	amt, n, err := s.dental.BookedAhead(ctx, f.Branch)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	out.Total, out.Visits = amt, n

	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT to_char(se.scheduled_date, 'YYYY-MM'), to_char(se.scheduled_date, 'Mon YYYY'),
			        coalesce(sum(se.amount_due),0)::text, count(*)
			   FROM treatment_sessions se
			   JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
			   LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
			  WHERE se.tenant_id = $1 AND se.kind = 'visit' AND se.status = 'planned'
			    AND pl.status = 'active'
			    AND se.scheduled_date >= (now() AT TIME ZONE 'Africa/Addis_Ababa')::date
			    AND (c.id IS NULL OR c.status = 'void')
			    AND ($2::uuid IS NULL OR se.branch_id = $2 OR se.branch_id IS NULL)
			  GROUP BY 1, 2 ORDER BY 1 LIMIT 12`,
			tid, branchArg(f.Branch))
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var l finance.Line
			if e := rows.Scan(&l.Key, &l.Label, &l.Amount, &l.Count); e != nil {
				return e
			}
			out.ByMonth = append(out.ByMonth, l)
		}
		if e := rows.Err(); e != nil {
			return e
		}

		// A course is at risk when the patient has stopped turning up: a visit whose
		// date has passed and was never recorded, or nothing recorded for a month.
		// Both are money the clinic has planned for and will not see.
		arows, e := tx.Query(ctx,
			`SELECT p.id, p.mrn, trim(p.first_name || ' ' || coalesce(p.last_name,'')), coalesce(p.phone,''),
			        pl.title,
			        coalesce(sum(se.amount_due) FILTER (WHERE se.status = 'planned'),0)::text,
			        max((now() AT TIME ZONE 'Africa/Addis_Ababa')::date - se.scheduled_date)::int,
			        count(*) FILTER (WHERE se.status = 'planned' AND se.scheduled_date < (now() AT TIME ZONE 'Africa/Addis_Ababa')::date)
			   FROM treatment_plans pl
			   JOIN treatment_sessions se ON se.plan_id = pl.id AND se.tenant_id = pl.tenant_id AND se.kind = 'visit'
			   JOIN patients p ON p.id = pl.patient_id AND p.tenant_id = pl.tenant_id
			  WHERE pl.tenant_id = $1 AND pl.status = 'active' AND p.deleted_at IS NULL
			  GROUP BY p.id, p.mrn, p.first_name, p.last_name, p.phone, pl.id, pl.title
			 HAVING count(*) FILTER (WHERE se.status = 'planned'
			                           AND se.scheduled_date < (now() AT TIME ZONE 'Africa/Addis_Ababa')::date) > 0
			  ORDER BY 6::numeric DESC LIMIT 25`, tid)
		if e != nil {
			return e
		}
		defer arows.Close()
		for arows.Next() {
			var r finance.PlanAtRisk
			var missed int
			if e := arows.Scan(&r.PatientID, &r.MRN, &r.Patient, &r.Phone, &r.Plan, &r.AtRisk, &r.DaysIdle, &missed); e != nil {
				return e
			}
			r.Reason = fmt.Sprintf("%d visit(s) missed", missed)
			out.AtRisk = append(out.AtRisk, r)
		}
		return arows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}
