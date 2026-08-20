// Package service implements the finance views over the charge ledger.
//
// Every figure here comes from `charges`, which is the one place money is
// recorded: a settled charge is revenue, a negative charge reversing another is
// a refund, a waived charge is money forgone, a pending charge is money owed.
// Nothing is summed from an intention (a plan's total, a session's planned fee)
// except where the view is explicitly about the future.
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/finance"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

type Service struct {
	db     *kerneldb.DB
	dental finance.Dental // nil when the clinic has no dental module
}

var _ finance.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, dental finance.Dental) *Service {
	return &Service{db: db, dental: dental}
}

func tenantOf(ctx context.Context) uuid.UUID {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		return p.TenantID
	}
	return uuid.Nil
}

// branchArg renders the optional branch filter as a nullable uuid, so one query
// serves "all branches" and "this branch" without string-building SQL.
func branchArg(b *uuid.UUID) any {
	if b == nil {
		return nil
	}
	return *b
}

func money(v string) string {
	if v == "" {
		return "0.00"
	}
	return v
}

// Overview answers "did we take money, and is that normal".
func (s *Service) Overview(ctx context.Context, f finance.Filter) (*finance.Overview, error) {
	tid := tenantOf(ctx)
	out := &finance.Overview{
		Series: []finance.DayPoint{}, SeriesPrev: []finance.DayPoint{},
		BySource: []finance.Line{}, Attention: []finance.Alert{},
	}
	span := f.Days()
	prevFrom := f.From.AddDate(0, 0, -span)

	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// --- settled money in the window. sum(amount) nets refunds, because a
		// refund is stored as a negative charge against the same ledger. ---
		if e := tx.QueryRow(ctx,
			`SELECT coalesce(sum(amount),0)::text, count(*) FILTER (WHERE amount > 0)
			   FROM charges
			  WHERE tenant_id = $1 AND status = 'paid' AND deleted_at IS NULL
			    AND settled_at >= $2 AND settled_at < $3
			    AND ($4::uuid IS NULL OR branch_id = $4)`,
			tid, f.From, f.To, branchArg(f.Branch)).Scan(&out.Collected, &out.CollectedCount); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx,
			`SELECT coalesce(sum(amount),0)::text FROM charges
			  WHERE tenant_id = $1 AND status = 'paid' AND deleted_at IS NULL
			    AND settled_at >= $2 AND settled_at < $3
			    AND ($4::uuid IS NULL OR branch_id = $4)`,
			tid, prevFrom, f.From, branchArg(f.Branch)).Scan(&out.CollectedPrev); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx,
			`SELECT coalesce(-sum(amount),0)::text FROM charges
			  WHERE tenant_id = $1 AND status = 'paid' AND deleted_at IS NULL AND amount < 0
			    AND settled_at >= $2 AND settled_at < $3
			    AND ($4::uuid IS NULL OR branch_id = $4)`,
			tid, f.From, f.To, branchArg(f.Branch)).Scan(&out.Refunded); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx,
			`SELECT coalesce(sum(amount),0)::text FROM charges
			  WHERE tenant_id = $1 AND status = 'waived' AND deleted_at IS NULL
			    AND settled_at >= $2 AND settled_at < $3
			    AND ($4::uuid IS NULL OR branch_id = $4)`,
			tid, f.From, f.To, branchArg(f.Branch)).Scan(&out.Waived); e != nil {
			return e
		}

		// --- money owed. Deliberately NOT period-bound (see the field comment). ---
		if e := tx.QueryRow(ctx,
			`SELECT coalesce(sum(amount),0)::text,
			        count(DISTINCT patient_id),
			        coalesce(max((now() AT TIME ZONE 'Africa/Addis_Ababa')::date
			                      - (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date), 0)
			   FROM charges
			  WHERE tenant_id = $1 AND status = 'pending' AND deleted_at IS NULL
			    AND ($2::uuid IS NULL OR branch_id = $2)`,
			tid, branchArg(f.Branch)).Scan(&out.Outstanding, &out.OutstandingPatients, &out.OldestDays); e != nil {
			return e
		}

		// --- the daily shape of the period, and the same length before it ---
		//
		// Every bucket is a day in ADDIS, not a UTC day. `d` is a bare timestamp, and
		// comparing it against settled_at cast it at the session timezone — UTC on this
		// server — so each bar actually covered 03:00 to 03:00 Addis. Cure Dental takes
		// money just after midnight often enough that it showed on the chart constantly:
		// 6,000 ETB settled at 00:16 on the 17th was drawn on the 16th, and a 4,000 and
		// an 11,500 taken on two different days merged into one 15,500 spike. The
		// headline total was right the whole time, which is what makes it nasty — only
		// the split between days was wrong, so nothing looked broken enough to doubt.
		load := func(from, to time.Time) ([]finance.DayPoint, error) {
			rows, e := tx.Query(ctx,
				`SELECT d::date::text, coalesce(sum(c.amount),0)::text
				   FROM generate_series($2::date, ($3::date - interval '1 day'), interval '1 day') d
				   LEFT JOIN charges c
				     ON c.tenant_id = $1 AND c.status = 'paid' AND c.deleted_at IS NULL
				    AND c.settled_at >= (d AT TIME ZONE 'Africa/Addis_Ababa')
				    AND c.settled_at <  ((d + interval '1 day') AT TIME ZONE 'Africa/Addis_Ababa')
				    AND ($4::uuid IS NULL OR c.branch_id = $4)
				  GROUP BY d ORDER BY d`,
				tid, from, to, branchArg(f.Branch))
			if e != nil {
				return nil, e
			}
			defer rows.Close()
			pts := []finance.DayPoint{}
			for rows.Next() {
				var p finance.DayPoint
				if e := rows.Scan(&p.Date, &p.Amount); e != nil {
					return nil, e
				}
				pts = append(pts, p)
			}
			return pts, rows.Err()
		}
		var e error
		if out.Series, e = load(f.From, f.To); e != nil {
			return e
		}
		if out.SeriesPrev, e = load(prevFrom, f.From); e != nil {
			return e
		}

		// --- where it came from ---
		srows, e := tx.Query(ctx,
			`SELECT source, coalesce(sum(amount),0)::text, count(*)
			   FROM charges
			  WHERE tenant_id = $1 AND status = 'paid' AND deleted_at IS NULL AND amount > 0
			    AND settled_at >= $2 AND settled_at < $3
			    AND ($4::uuid IS NULL OR branch_id = $4)
			  GROUP BY source HAVING sum(amount) > 0 ORDER BY sum(amount) DESC`,
			tid, f.From, f.To, branchArg(f.Branch))
		if e != nil {
			return e
		}
		defer srows.Close()
		for srows.Next() {
			var l finance.Line
			if e := srows.Scan(&l.Key, &l.Amount, &l.Count); e != nil {
				return e
			}
			l.Label = sourceLabel(l.Key)
			out.BySource = append(out.BySource, l)
		}
		if e := srows.Err(); e != nil {
			return e
		}

		// --- things somebody should do something about ---
		//
		// These errors are RETURNED, not swallowed. The first cut wrote
		// `if e := ...; e == nil && count > 0` and pointed at a table that does not
		// exist; the failure aborted the surrounding transaction, every later query
		// in it failed too, and the endpoint returned "commit unexpectedly resulted
		// in rollback" with no clue which query was at fault. Inside a transaction
		// there is no such thing as an error you can ignore.
		var vCount int
		var vAmount string
		if e := tx.QueryRow(ctx,
			`SELECT count(*), coalesce(sum(abs(variance)),0)::text
			   FROM cash_reconciliations
			  WHERE tenant_id = $1 AND variance <> 0
			    AND business_date >= $2::date AND business_date < $3::date`,
			tid, f.From, f.To).Scan(&vCount, &vAmount); e != nil {
			return e
		}
		if vCount > 0 {
			out.Attention = append(out.Attention, finance.Alert{
				Kind: "shift_variance", Count: vCount, Amount: money(vAmount),
				Text: fmt.Sprintf("%d cash count(s) did not balance", vCount), Href: "/finance?tab=cash",
			})
		}

		var overdueCount int
		var overdueAmount string
		if e := tx.QueryRow(ctx,
			`SELECT count(DISTINCT patient_id), coalesce(sum(amount),0)::text
			   FROM charges
			  WHERE tenant_id = $1 AND status = 'pending' AND deleted_at IS NULL
			    AND created_at < now() - interval '60 days'
			    AND ($2::uuid IS NULL OR branch_id = $2)`,
			tid, branchArg(f.Branch)).Scan(&overdueCount, &overdueAmount); e != nil {
			return e
		}
		if overdueCount > 0 {
			out.Attention = append(out.Attention, finance.Alert{
				Kind: "overdue", Count: overdueCount, Amount: money(overdueAmount),
				Text: fmt.Sprintf("%d patient(s) owing for over 60 days", overdueCount),
				Href: "/finance?tab=receivables&bucket=90%2B",
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}

	// Dental adds two figures the charge ledger cannot know: treatment delivered
	// that nobody billed, and money already booked into future visits.
	if s.dental != nil {
		if amt, n, e := s.dental.UnbilledTotal(ctx); e == nil && n > 0 {
			out.Attention = append(out.Attention, finance.Alert{
				Kind: "unbilled", Count: n, Amount: amt,
				Text: fmt.Sprintf("%d visit(s) treated and never billed", n),
				Href: "/dental/unbilled",
			})
		}
		if amt, n, e := s.dental.BookedAhead(ctx, f.Branch); e == nil {
			out.BookedAhead, out.BookedVisits = amt, n
		}
	}
	return out, nil
}

func sourceLabel(k string) string {
	switch k {
	case "consultation":
		return "Consultation"
	case "service":
		return "Services"
	case "lab":
		return "Laboratory"
	case "pharmacy":
		return "Pharmacy"
	case "dental":
		return "Dental"
	case "bed":
		return "Inpatient"
	case "refund":
		return "Refunds"
	default:
		return "Other"
	}
}

// Receivables answers "who owes me, and for how long".
//
// Two kinds of debt, kept apart because they are chased differently: a charge
// raised and not settled (the patient is at, or should be at, the cashier), and
// dental treatment that was delivered and never billed at all. The second is read
// from the dental module rather than recomputed here — it already owns the rule
// for what a session owes, and a second copy of that rule is a second answer.
func (s *Service) Receivables(ctx context.Context, f finance.Filter) (*finance.Receivables, error) {
	tid := tenantOf(ctx)
	out := &finance.Receivables{Buckets: []finance.Bucket{}, Rows: []finance.ReceivableRow{}, Total: "0.00"}

	byPatient := map[uuid.UUID]*acc{}

	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT c.patient_id, p.mrn,
			        trim(p.first_name || ' ' || coalesce(p.last_name,'')),
			        coalesce(p.phone,''),
			        sum(c.amount)::float8,
			        max((now() AT TIME ZONE 'Africa/Addis_Ababa')::date
			            - (c.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date)::int,
			        coalesce((max(lp.settled_at) AT TIME ZONE 'Africa/Addis_Ababa')::date::text, '')
			   FROM charges c
			   JOIN patients p ON p.id = c.patient_id AND p.tenant_id = c.tenant_id
			   LEFT JOIN charges lp ON lp.patient_id = c.patient_id AND lp.tenant_id = c.tenant_id
			        AND lp.status = 'paid' AND lp.amount > 0 AND lp.deleted_at IS NULL
			  WHERE c.tenant_id = $1 AND c.status = 'pending' AND c.deleted_at IS NULL
			    AND p.deleted_at IS NULL
			    AND ($2::uuid IS NULL OR c.branch_id = $2)
			  GROUP BY c.patient_id, p.mrn, p.first_name, p.last_name, p.phone`,
			tid, branchArg(f.Branch))
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var pid uuid.UUID
			var mrn, name, phone, lastPaid string
			var owed float64
			var days int
			if e := rows.Scan(&pid, &mrn, &name, &phone, &owed, &days, &lastPaid); e != nil {
				return e
			}
			byPatient[pid] = &acc{owed: owed, row: finance.ReceivableRow{
				PatientID: pid, MRN: mrn, Name: name, Phone: phone,
				OldestDays: days, LastPaid: lastPaid, Why: "with the cashier",
			}}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}

	if s.dental != nil {
		ups, e := s.dental.UnbilledByPatient(ctx)
		if e == nil {
			for _, u := range ups {
				a, ok := byPatient[u.PatientID]
				if !ok {
					// A patient who owes only for unbilled treatment still needs a name
					// and a phone number, or the row cannot be acted on.
					a = &acc{row: finance.ReceivableRow{PatientID: u.PatientID, Why: "treated, not billed"}}
					byPatient[u.PatientID] = a
					if e := s.fillPatient(ctx, tid, a); e != nil {
						continue
					}
				} else {
					a.row.Why = "cashier + unbilled treatment"
				}
				var amt float64
				fmt.Sscanf(u.Amount, "%f", &amt)
				a.owed += amt
				if u.OldestDay > a.row.OldestDays {
					a.row.OldestDays = u.OldestDay
				}
			}
		}
	}

	buckets := map[string]*finance.Bucket{
		"0-30":  {Key: "0-30", Label: "0–30 days"},
		"31-60": {Key: "31-60", Label: "31–60 days"},
		"61-90": {Key: "61-90", Label: "61–90 days"},
		"90+":   {Key: "90+", Label: "Over 90 days"},
	}
	total := 0.0
	for _, a := range byPatient {
		if a.owed <= 0.005 {
			continue
		}
		a.row.ID = a.row.PatientID.String()
		a.row.Owed = fmt.Sprintf("%.2f", a.owed)
		a.row.Bucket = bucketOf(a.row.OldestDays)
		b := buckets[a.row.Bucket]
		var bAmt float64
		fmt.Sscanf(b.Amount, "%f", &bAmt)
		b.Amount = fmt.Sprintf("%.2f", bAmt+a.owed)
		b.Count++
		total += a.owed
		out.Rows = append(out.Rows, a.row)
	}
	// Oldest first: the debt least likely to arrive is the one to chase today.
	for i := 0; i < len(out.Rows); i++ {
		for j := i + 1; j < len(out.Rows); j++ {
			if out.Rows[j].OldestDays > out.Rows[i].OldestDays {
				out.Rows[i], out.Rows[j] = out.Rows[j], out.Rows[i]
			}
		}
	}
	for _, k := range []string{"0-30", "31-60", "61-90", "90+"} {
		b := buckets[k]
		if b.Amount == "" {
			b.Amount = "0.00"
		}
		out.Buckets = append(out.Buckets, *b)
	}
	out.Total = fmt.Sprintf("%.2f", total)
	out.Count = len(out.Rows)
	return out, nil
}

// acc accumulates one patient's debt while the two sources are merged.
type acc struct {
	row  finance.ReceivableRow
	owed float64
}

func bucketOf(days int) string {
	switch {
	case days <= 30:
		return "0-30"
	case days <= 60:
		return "31-60"
	case days <= 90:
		return "61-90"
	default:
		return "90+"
	}
}

func (s *Service) fillPatient(ctx context.Context, tid uuid.UUID, a *acc) error {
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT mrn, trim(first_name || ' ' || coalesce(last_name,'')), coalesce(phone,'')
			   FROM patients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
			tid, a.row.PatientID).Scan(&a.row.MRN, &a.row.Name, &a.row.Phone)
	})
}
