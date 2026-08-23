package service

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dashboard"
	"github.com/reicb/clinicsaas/internal/finance"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// The clinic's day, assembled from the modules that already own each answer.
//
// Money comes from the finance service — not from queries written here. The finance
// page and this page must be arithmetically incapable of disagreeing, and the way to
// guarantee that is to have one of them ask the other rather than both ask the
// database. The clinical counts below are counts, not money, and are read directly.

type Service struct {
	db      *kerneldb.DB
	finance finance.Service
}

var _ dashboard.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, fin finance.Service) *Service {
	return &Service{db: db, finance: fin}
}

// addis is the clinic's day. Counting "seen today" in UTC moves three hours of every
// evening into tomorrow, which is the bug class this codebase keeps rediscovering.
const addisTZ = "Africa/Addis_Ababa"

func (s *Service) Today(ctx context.Context) (*dashboard.Today, error) {
	out := &dashboard.Today{Attention: []dashboard.Alert{}}
	p, _ := tenancy.PrincipalFromContext(ctx)

	// --- money, and the alerts that come with it -----------------------------
	//
	// One finance call covers the lot: a fortnight of collections (so today and
	// yesterday are just the last two points), what is owed, what is booked ahead,
	// and the attention list finance already assembles from shift variances,
	// overdue debt and unbilled treatment.
	if canSeeMoney(p) {
		now := time.Now().In(addis())
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, addis())
		ov, err := s.finance.Overview(ctx, finance.Filter{
			From: today.AddDate(0, 0, -13),
			To:   today.AddDate(0, 0, 1),
		})
		if err != nil {
			return nil, err
		}
		m := &dashboard.Money{
			Owed: ov.Outstanding, OwedPatients: ov.OutstandingPatients,
			OldestDays: ov.OldestDays, BookedAhead: ov.BookedAhead, BookedVisits: ov.BookedVisits,
		}
		for i, pt := range ov.Series {
			out.Series = append(out.Series, dashboard.DayPoint{Date: pt.Date, Amount: pt.Amount})
			if i == len(ov.Series)-1 {
				m.CollectedToday = pt.Amount
			}
			if i == len(ov.Series)-2 {
				m.CollectedYesterday = pt.Amount
			}
		}
		out.Money = m
		for _, a := range ov.Attention {
			out.Attention = append(out.Attention, dashboard.Alert{
				Kind: a.Kind, Text: a.Text, Amount: a.Amount, Count: a.Count,
				Href: a.Href, Tone: toneOf(a.Kind),
			})
		}
	}

	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		tid := tenantOf(ctx)
		if e := tx.QueryRow(ctx,
			`SELECT count(*) FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL`,
			tid).Scan(&out.Patients); e != nil {
			return e
		}
		_ = tx.QueryRow(ctx,
			`SELECT name FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
			tid).Scan(&out.ClinicName)

		if canSeeFlow(p) {
			f := &dashboard.Flow{}
			// One pass over today's work. The day is Addis, not UTC.
			if e := tx.QueryRow(ctx, `
				WITH d AS (SELECT (now() AT TIME ZONE $2)::date AS today)
				SELECT
				  (SELECT count(*) FROM queue_entries q, d
				    WHERE q.tenant_id = $1 AND q.state = 'waiting'
				      AND (q.created_at AT TIME ZONE $2)::date = d.today),
				  (SELECT count(*) FROM queue_entries q, d
				    WHERE q.tenant_id = $1 AND q.state IN ('called','in_consult')
				      AND (q.created_at AT TIME ZONE $2)::date = d.today),
				  (SELECT count(*) FROM encounters e, d
				    WHERE e.tenant_id = $1 AND e.status = 'closed'
				      AND (e.started_at AT TIME ZONE $2)::date = d.today),
				  (SELECT count(*) FROM appointments a, d
				    WHERE a.tenant_id = $1 AND a.status <> 'cancelled'
				      AND (a.starts_at AT TIME ZONE $2)::date = d.today),
				  (SELECT count(*) FROM appointments a, d
				    WHERE a.tenant_id = $1 AND a.status IN ('checked_in','completed')
				      AND (a.starts_at AT TIME ZONE $2)::date = d.today),
				  -- Booked for earlier today and still not here. A list to phone, not
				  -- a statistic: only counted once the slot is actually past.
				  (SELECT count(*) FROM appointments a, d
				    WHERE a.tenant_id = $1 AND a.status IN ('booked','confirmed')
				      AND (a.starts_at AT TIME ZONE $2)::date = d.today
				      AND a.starts_at < now())`,
				tid, addisTZ).Scan(&f.Waiting, &f.InConsult, &f.SeenToday, &f.BookedToday, &f.Arrived, &f.Overdue); e != nil {
				return e
			}
			out.Flow = f
			if f.Overdue > 0 {
				out.Attention = append(out.Attention, dashboard.Alert{
					Kind: "no_show", Tone: "warn", Count: f.Overdue,
					Text: plural(f.Overdue, "booked patient has", "booked patients have") + " not arrived yet",
					Href: "/appointments",
				})
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

// toneOf decides how loudly an alert is drawn. Money already given away is the
// loudest thing on the page; a cash-drawer discrepancy is a question, not a loss.
func toneOf(kind string) string {
	switch kind {
	case "unbilled", "overdue":
		return "danger"
	case "shift_variance", "stalled", "no_show":
		return "warn"
	default:
		return "info"
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

func addis() *time.Location {
	loc, err := time.LoadLocation(addisTZ)
	if err != nil {
		return time.FixedZone("EAT", 3*60*60)
	}
	return loc
}

// The codes are the real ones from the permission catalogue. Guessing at a plausible
// name means the section silently never renders, which looks like a bug in the data.
func canSeeMoney(p *tenancy.Principal) bool {
	return p != nil && (p.HasPermission("billing.manage") || p.HasPermission("payment.collect"))
}

func canSeeFlow(p *tenancy.Principal) bool {
	return p != nil && (p.HasPermission("queue.manage") || p.HasPermission("appointment.manage") ||
		p.HasPermission("encounter.manage"))
}

func tenantOf(ctx context.Context) uuid.UUID {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		return p.TenantID
	}
	return uuid.Nil
}
