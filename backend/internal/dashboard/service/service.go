package service

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dashboard"
	"github.com/reicb/clinicsaas/internal/finance"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// The clinic's day, assembled from the modules that already own each answer.
//
// Money comes from the finance service — not from queries written here. The finance
// page and this page must be arithmetically incapable of disagreeing, and the way to
// guarantee that is to have one of them ask the other rather than both ask the
// database. The clinical counts below are counts, not money, and are read directly,
// with the same rules the reception and chairside screens use: the queue by
// enqueued_at, deleted entries ignored, the active branch only.

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

// A wait long enough that someone should look. Below it, a queue is just a queue.
const longWaitMinutes = 20

func (s *Service) Today(ctx context.Context) (*dashboard.Today, error) {
	out := &dashboard.Today{Attention: []dashboard.Alert{}}
	p, _ := tenancy.PrincipalFromContext(ctx)
	branch := activeBranch(p)
	now := time.Now().In(addis())
	today := midnight(now)
	out.Date, out.Hour = today.Format("2006-01-02"), now.Hour()

	// --- money, and the alerts that come with it -----------------------------
	if canSeeMoney(p) {
		m, alerts, err := s.money(ctx, branch, now, p.FlagEnabled("debt_ageing"))
		if err != nil {
			return nil, err
		}
		out.Money = m
		out.Attention = append(out.Attention, alerts...)
	}

	var week []dashboard.WeekDay
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
		if branch != nil {
			_ = tx.QueryRow(ctx,
				`SELECT name FROM branches WHERE tenant_id = $1 AND id = $2`, tid, *branch).Scan(&out.BranchName)
		}

		if !canSeeFlow(p) {
			return nil
		}
		f, alerts, e := flowToday(ctx, tx, tid, branch, p.FlagEnabled("dental"))
		if e != nil {
			return e
		}
		out.Flow = f
		out.Attention = append(out.Attention, alerts...)

		week, e = appointmentsAhead(ctx, tx, tid, branch, today)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}

	// The week ahead adds the dental forward book to the appointments book. The
	// amount is only for people who may see money.
	if week != nil {
		booked, e := s.finance.BookedByDay(ctx, finance.Filter{
			From: today.AddDate(0, 0, 1), To: today.AddDate(0, 0, 7), Branch: branch,
		})
		if e != nil {
			return nil, e
		}
		byDate := map[string]finance.DayBooked{}
		for _, b := range booked {
			byDate[b.Date] = b
		}
		for i := range week {
			b := byDate[week[i].Date]
			week[i].Visits += b.Visits
			if canSeeMoney(p) {
				week[i].Amount = money(b.Amount)
			}
		}
		out.Week = week
	}

	// Loudest first, so the three the page shows are the three that matter most.
	sort.SliceStable(out.Attention, func(i, j int) bool {
		return toneRank(out.Attention[i].Tone) < toneRank(out.Attention[j].Tone)
	})
	return out, nil
}

// money is the owner's half, every figure asked of finance.
// The total owed is everyone's; who owes it and for how long is the "debt ageing"
// line a plan may not include, so aging and top owers are only filled when it does.
func (s *Service) money(ctx context.Context, branch *uuid.UUID, now time.Time, ageing bool) (*dashboard.Money, []dashboard.Alert, error) {
	today := midnight(now)
	ov, err := s.finance.Overview(ctx, finance.Filter{
		From: today.AddDate(0, 0, -13), To: today.AddDate(0, 0, 1), Branch: branch,
	})
	if err != nil {
		return nil, nil, err
	}
	// Yesterday up to this minute: a morning compared with a morning.
	byNow, err := s.finance.Collected(ctx, finance.Filter{
		From: today.AddDate(0, 0, -1), To: now.AddDate(0, 0, -1), Branch: branch,
	})
	if err != nil {
		return nil, nil, err
	}
	rec, err := s.finance.Receivables(ctx, finance.Filter{Branch: branch})
	if err != nil {
		return nil, nil, err
	}

	m := &dashboard.Money{
		CollectedYesterdayByNow: byNow,
		Series:                  []dashboard.DayPoint{},
		Owed:                    rec.Total, OwedAtCashier: rec.AtCashier, OwedUnbilled: rec.Unbilled,
		OwedPatients: rec.Count,
		Aging:        []dashboard.Bucket{}, TopOwers: []dashboard.Ower{},
		BookedAhead: money(ov.BookedAhead), BookedVisits: ov.BookedVisits,
	}
	n := len(ov.Series)
	var last7, prev7 float64
	for i, pt := range ov.Series {
		m.Series = append(m.Series, dashboard.DayPoint{Date: pt.Date, Amount: pt.Amount, Count: pt.Count})
		switch {
		case i == n-1:
			m.CollectedToday = pt.Amount
		case i == n-2:
			m.CollectedYesterday = pt.Amount
		}
		if i >= n-7 {
			last7 += num(pt.Amount)
		} else if i >= n-14 {
			prev7 += num(pt.Amount)
		}
	}
	m.Last7, m.Prev7 = fmt.Sprintf("%.2f", last7), fmt.Sprintf("%.2f", prev7)
	m.CollectedToday, m.CollectedYesterday = money(m.CollectedToday), money(m.CollectedYesterday)

	for _, b := range rec.Buckets {
		if !ageing {
			break
		}
		m.Aging = append(m.Aging, dashboard.Bucket{Key: b.Key, Label: b.Label, Amount: b.Amount, Count: b.Count})
	}
	for i, r := range rec.Rows {
		if r.OldestDays > m.OldestDays {
			m.OldestDays = r.OldestDays
		}
		if ageing && i < 5 {
			m.TopOwers = append(m.TopOwers, dashboard.Ower{
				PatientID: id.Encode(id.PrefixPatient, r.PatientID), Name: r.Name,
				Owed: r.Owed, OldestDays: r.OldestDays, Why: r.Why,
			})
		}
	}

	alerts := []dashboard.Alert{}
	for _, a := range ov.Attention {
		alerts = append(alerts, dashboard.Alert{
			Kind: a.Kind, Text: a.Text, Amount: a.Amount, Count: a.Count,
			Href: a.Href, Tone: toneOf(a.Kind), Action: actionOf(a.Kind), Detail: detailOf(a.Kind),
		})
	}
	return m, alerts, nil
}

// flowToday is today's patients, counted the way the reception screen counts them.
func flowToday(ctx context.Context, tx pgx.Tx, tid uuid.UUID, branch *uuid.UUID, dental bool) (*dashboard.Flow, []dashboard.Alert, error) {
	f := &dashboard.Flow{Upcoming: []dashboard.Upcoming{}}
	var first *time.Time
	if e := tx.QueryRow(ctx, todayCTE+`
		SELECT
		  (SELECT count(*) FROM booked),
		  (SELECT count(DISTINCT patient_id) FROM q WHERE patient_id NOT IN (SELECT patient_id FROM booked)),
		  (SELECT count(DISTINCT patient_id) FROM q WHERE state = 'waiting'),
		  (SELECT count(DISTINCT patient_id) FROM q WHERE state IN ('called','in_consult')),
		  (SELECT count(DISTINCT patient_id) FROM q WHERE state = 'done'),
		  (SELECT count(*) FROM booked b WHERE NOT EXISTS (SELECT 1 FROM q WHERE q.patient_id = b.patient_id)),
		  (SELECT count(DISTINCT a.patient_id) FROM appointments a, d
		    WHERE a.tenant_id = $1 AND a.deleted_at IS NULL AND a.status IN ('booked','confirmed')
		      AND (a.starts_at AT TIME ZONE $2)::date = d.today AND a.starts_at < now()
		      AND ($3::uuid IS NULL OR a.branch_id = $3)
		      AND NOT EXISTS (SELECT 1 FROM q WHERE q.patient_id = a.patient_id)),
		  coalesce((SELECT max(extract(epoch FROM now() - enqueued_at))::int / 60 FROM q WHERE state = 'waiting'), 0),
		  coalesce((SELECT avg(extract(epoch FROM coalesce(called_at, started_at) - enqueued_at))::int / 60
		              FROM q WHERE coalesce(called_at, started_at) IS NOT NULL), 0),
		  coalesce((SELECT avg(extract(epoch FROM ended_at - started_at))::int / 60
		              FROM q WHERE state = 'done' AND started_at IS NOT NULL AND ended_at IS NOT NULL), 0),
		  (SELECT min(enqueued_at) FROM q)`,
		tid, addisTZ, branchArg(branch)).Scan(&f.Booked, &f.WalkIns, &f.Waiting, &f.InChair, &f.Done,
		&f.ToCome, &f.Late, &f.LongestWait, &f.AvgWait, &f.AvgVisit, &first); e != nil {
		return nil, nil, e
	}
	if first != nil {
		f.FirstArrival = first.Format(time.RFC3339)
	}

	// Who is still to come, earliest first. A patient booked twice (an appointment
	// and a treatment visit) is one person in the doorway, so one row.
	rows, e := tx.Query(ctx, todayCTE+`
		SELECT b.patient_id, trim(p.first_name || ' ' || coalesce(p.last_name,'')),
		       b.what, coalesce(u.full_name, ''), b.starts_at
		  FROM (
		    SELECT DISTINCT ON (x.patient_id) x.* FROM (
		      SELECT a.patient_id, coalesce(nullif(a.reason,''), 'Appointment') AS what,
		             a.provider_id, a.starts_at
		        FROM appointments a, d
		       WHERE a.tenant_id = $1 AND a.deleted_at IS NULL AND a.status IN ('booked','confirmed')
		         AND (a.starts_at AT TIME ZONE $2)::date = d.today
		         AND ($3::uuid IS NULL OR a.branch_id = $3)
		      UNION ALL
		      SELECT se.patient_id, pl.title, NULL::uuid, NULL::timestamptz
		        FROM treatment_sessions se
		        JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id, d
		       WHERE se.tenant_id = $1 AND se.kind = 'visit' AND se.status = 'planned'
		         AND pl.status = 'active' AND se.scheduled_date = d.today
		         AND ($3::uuid IS NULL OR se.branch_id = $3 OR se.branch_id IS NULL)
		    ) x
		    ORDER BY x.patient_id, x.starts_at NULLS LAST
		  ) b
		  JOIN patients p ON p.id = b.patient_id AND p.tenant_id = $1 AND p.deleted_at IS NULL
		  LEFT JOIN users u ON u.id = b.provider_id AND u.tenant_id = $1
		 WHERE NOT EXISTS (SELECT 1 FROM q WHERE q.patient_id = b.patient_id)
		 ORDER BY b.starts_at NULLS LAST, 2
		 LIMIT 6`,
		tid, addisTZ, branchArg(branch))
	if e != nil {
		return nil, nil, e
	}
	for rows.Next() {
		var u dashboard.Upcoming
		var pid uuid.UUID
		var starts *time.Time
		if e := rows.Scan(&pid, &u.Name, &u.What, &u.Provider, &starts); e != nil {
			rows.Close()
			return nil, nil, e
		}
		u.PatientID = id.Encode(id.PrefixPatient, pid)
		if starts != nil {
			u.StartsAt = starts.Format(time.RFC3339)
			if late := int(time.Since(*starts).Minutes()); late > 0 {
				u.LateMin = late
			}
		}
		f.Upcoming = append(f.Upcoming, u)
	}
	rows.Close()
	if e := rows.Err(); e != nil {
		return nil, nil, e
	}

	alerts := []dashboard.Alert{}
	queuePage := "/reception"
	if dental {
		queuePage = "/chairside"
	}

	// The person waiting longest, by name: a patient forgotten in the waiting room is
	// the failure a number alone does not prevent.
	if f.LongestWait >= longWaitMinutes {
		var pid uuid.UUID
		var name, prov string
		if e := tx.QueryRow(ctx, todayCTE+`
			SELECT q.patient_id, trim(p.first_name || ' ' || coalesce(p.last_name,'')), coalesce(u.full_name,'')
			  FROM q
			  JOIN patients p ON p.id = q.patient_id AND p.tenant_id = $1
			  LEFT JOIN users u ON u.id = q.assigned_provider_id AND u.tenant_id = $1
			 WHERE q.state = 'waiting' ORDER BY q.enqueued_at LIMIT 1`,
			tid, addisTZ, branchArg(branch)).Scan(&pid, &name, &prov); e != nil {
			return nil, nil, e
		}
		detail := "Waiting to be called"
		if prov != "" {
			detail = "Waiting for " + prov
		}
		alerts = append(alerts, dashboard.Alert{
			Kind: "long_wait", Tone: "warn", Count: 1, Href: queuePage, Action: "Open the queue",
			Text: fmt.Sprintf("%s has waited %s", name, waited(f.LongestWait)), Detail: detail,
			PatientID: id.Encode(id.PrefixPatient, pid),
		})
	}
	if f.Late > 0 {
		alerts = append(alerts, dashboard.Alert{
			Kind: "no_show", Tone: "warn", Count: f.Late, Href: "/reception", Action: "Call them",
			Text:   plural(f.Late, "booked patient has", "booked patients have") + " not arrived",
			Detail: "Their appointment time has passed",
		})
	}

	// Dental: patients who missed a treatment visit in the last week and have not been
	// rebooked. A missed visit stalls the whole treatment, and the list is the one to
	// phone. Rebooking moves the visit forward, which is what clears it from here.
	if dental {
		var missed int
		if e := tx.QueryRow(ctx, `
			SELECT count(DISTINCT se.patient_id)
			  FROM treatment_sessions se
			  JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
			  JOIN patients p ON p.id = se.patient_id AND p.tenant_id = se.tenant_id AND p.deleted_at IS NULL
			 WHERE se.tenant_id = $1 AND se.kind = 'visit' AND se.status = 'planned' AND pl.status = 'active'
			   AND se.scheduled_date <  (now() AT TIME ZONE $2)::date
			   AND se.scheduled_date >= (now() AT TIME ZONE $2)::date - 7
			   AND ($3::uuid IS NULL OR se.branch_id = $3 OR se.branch_id IS NULL)`,
			tid, addisTZ, branchArg(branch)).Scan(&missed); e != nil {
			return nil, nil, e
		}
		if missed > 0 {
			alerts = append(alerts, dashboard.Alert{
				Kind: "missed_visit", Tone: "warn", Count: missed,
				Href: "/appointments?view=followups", Action: "Rebook",
				Text:   plural(missed, "patient", "patients") + " missed a treatment visit this week",
				Detail: "Their treatment is on hold until they are rebooked",
			})
		}
	}
	return f, alerts, nil
}

// todayCTE is today's queue and today's bookings for one branch ($1 tenant, $2 the
// clinic's timezone, $3 branch or NULL).
const todayCTE = `
WITH d AS (SELECT (now() AT TIME ZONE $2)::date AS today),
q AS (
  SELECT q.patient_id, q.state, q.enqueued_at, q.called_at, q.started_at, q.ended_at, q.assigned_provider_id
    FROM queue_entries q, d
   WHERE q.tenant_id = $1 AND q.deleted_at IS NULL
     AND (q.enqueued_at AT TIME ZONE $2)::date = d.today
     AND q.state IN ('waiting','called','in_consult','done')
     AND ($3::uuid IS NULL OR q.branch_id = $3)
),
booked AS (
  SELECT a.patient_id FROM appointments a, d
   WHERE a.tenant_id = $1 AND a.deleted_at IS NULL AND a.status <> 'cancelled'
     AND (a.starts_at AT TIME ZONE $2)::date = d.today
     AND ($3::uuid IS NULL OR a.branch_id = $3)
  UNION
  SELECT se.patient_id FROM treatment_sessions se
    JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id, d
   WHERE se.tenant_id = $1 AND se.kind = 'visit' AND se.status IN ('planned','done')
     AND pl.status <> 'cancelled' AND se.scheduled_date = d.today
     AND ($3::uuid IS NULL OR se.branch_id = $3 OR se.branch_id IS NULL)
)`

// appointmentsAhead counts the appointments book for the next seven days. Dental
// treatment visits are added by the caller, from finance's forward book.
func appointmentsAhead(ctx context.Context, tx pgx.Tx, tid uuid.UUID, branch *uuid.UUID, today time.Time) ([]dashboard.WeekDay, error) {
	rows, e := tx.Query(ctx, `
		SELECT d::date::text, count(DISTINCT a.patient_id)
		  FROM generate_series($2::date, $3::date, interval '1 day') d
		  LEFT JOIN appointments a
		    ON a.tenant_id = $1 AND a.deleted_at IS NULL AND a.status IN ('booked','confirmed')
		   AND (a.starts_at AT TIME ZONE $5)::date = d::date
		   AND ($4::uuid IS NULL OR a.branch_id = $4)
		 GROUP BY d ORDER BY d`,
		tid, today.AddDate(0, 0, 1), today.AddDate(0, 0, 7), branchArg(branch), addisTZ)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []dashboard.WeekDay{}
	for rows.Next() {
		var w dashboard.WeekDay
		if e := rows.Scan(&w.Date, &w.Visits); e != nil {
			return nil, e
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// Takings is the money chart, asked of finance for the chosen range.
func (s *Service) Takings(ctx context.Context, days int) (*dashboard.Takings, error) {
	p, _ := tenancy.PrincipalFromContext(ctx)
	if !canSeeMoney(p) {
		return nil, nil
	}
	switch days {
	case 7, 30, 90:
	default:
		days = 30
	}
	today := midnight(time.Now().In(addis()))
	ov, err := s.finance.Overview(ctx, finance.Filter{
		From: today.AddDate(0, 0, -(days - 1)), To: today.AddDate(0, 0, 1), Branch: activeBranch(p),
	})
	if err != nil {
		return nil, err
	}
	out := &dashboard.Takings{
		Days: days, Total: money(ov.Collected), Prev: money(ov.CollectedPrev),
		Series: []dashboard.DayPoint{}, BySource: []dashboard.Line{}, ByMethod: []dashboard.Line{},
	}
	for _, pt := range ov.Series {
		out.Series = append(out.Series, dashboard.DayPoint{Date: pt.Date, Amount: pt.Amount, Count: pt.Count})
	}
	for _, l := range ov.BySource {
		out.BySource = append(out.BySource, dashboard.Line{Key: l.Key, Label: l.Label, Amount: l.Amount, Count: l.Count})
	}
	for _, l := range ov.ByMethod {
		out.ByMethod = append(out.ByMethod, dashboard.Line{Key: l.Key, Label: l.Label, Amount: l.Amount, Count: l.Count})
	}
	return out, nil
}

// toneOf decides how loudly an alert is drawn. Money already given away is the
// loudest thing on the page; a cash-drawer discrepancy is a question, not a loss.
func toneOf(kind string) string {
	switch kind {
	case "unbilled", "overdue":
		return "danger"
	case "shift_variance", "stalled", "no_show", "long_wait", "missed_visit":
		return "warn"
	default:
		return "info"
	}
}

func toneRank(t string) int {
	switch t {
	case "danger":
		return 0
	case "warn":
		return 1
	default:
		return 2
	}
}

// actionOf is the button's words: what the page behind the alert lets you do.
func actionOf(kind string) string {
	switch kind {
	case "unbilled":
		return "Send to cashier"
	case "overdue":
		return "See who owes"
	case "shift_variance":
		return "Review"
	default:
		return "Open"
	}
}

func detailOf(kind string) string {
	switch kind {
	case "unbilled":
		return "The patients were treated, but no charge exists yet"
	case "overdue":
		return "Old debt is the debt that usually never arrives"
	case "shift_variance":
		return "In the last two weeks"
	default:
		return ""
	}
}

// waited is a wait in the words a receptionist would say it: "24 minutes",
// "over 4 hours". Past an hour the minutes stop mattering; the hours do.
func waited(m int) string {
	switch {
	case m < 60:
		return plural(m, "minute", "minutes")
	case m < 120:
		return "over an hour"
	default:
		return fmt.Sprintf("over %d hours", m/60)
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

func money(v string) string {
	if v == "" {
		return "0.00"
	}
	return v
}

func num(v string) float64 {
	f, _ := strconv.ParseFloat(v, 64)
	return f
}

func midnight(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

func addis() *time.Location {
	loc, err := time.LoadLocation(addisTZ)
	if err != nil {
		return time.FixedZone("EAT", 3*60*60)
	}
	return loc
}

func branchArg(b *uuid.UUID) any {
	if b == nil {
		return nil
	}
	return *b
}

// activeBranch is the branch the session is working in; nil is all branches.
func activeBranch(p *tenancy.Principal) *uuid.UUID {
	if p == nil {
		return nil
	}
	return p.ActiveBranchID
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
