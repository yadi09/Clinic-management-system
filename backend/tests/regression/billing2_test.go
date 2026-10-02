package regression

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Cash control (day close, reconciliations), the finance views, the home-screen money
// chart, the legacy card fee and the intake fee — through the HTTP API.
//
// Rules held here:
//   - A cashier's day close expects the CASH they took (cash rails, or legacy 'cash'
//     with no rail), net of cash refunds THEY paid out; other methods are reported but
//     not held against the drawer. Closing records counted and variance = counted −
//     expected. The business day is the UTC day today (FIN-1 is tested in REG_PAY_011).
//   - Finance views are billing.manage + finance_advanced; periods are Addis days,
//     inclusive, `to` before `from` refused; ?branch narrows to one branch.
//   - The intake (default-service) fee is raised once per patient per Addis day and
//     holds the patient at the door until settled; a covered follow-up raises none.

func blUTCToday() string { return time.Now().UTC().Format("2006-01-02") }

type blExpectedDay struct {
	BusinessDate string `json:"business_date"`
	ByMethod     []struct {
		Label string `json:"label"`
		Total string `json:"total"`
		Count int    `json:"count"`
		Cash  bool   `json:"cash"`
	} `json:"by_method"`
	ExpectedTotal  string `json:"expected_total"`
	NonCashTotal   string `json:"non_cash_total"`
	Closed         bool   `json:"closed"`
	Reconciliation *struct {
		CountedTotal string `json:"counted_total"`
		Variance     string `json:"variance"`
		Note         string `json:"note"`
	} `json:"reconciliation"`
}

func blDayClose(t *testing.T, c *testkit.Client, q string) blExpectedDay {
	t.Helper()
	var d blExpectedDay
	c.Do("GET", "/billing/day-close"+q, nil).Expect(t, 200, "day close").Decode(t, &d)
	return d
}

// TestREG_BILL_060_DayCloseHoldsTheDrawerToCash: Given a cashier who took 500 by the
// cash rail, 200 as legacy 'cash', 300 by transfer and 50 by card, Then their day close
// expects 700 in the drawer and reports 350 non-cash, by method; another cashier's
// close is untouched. Closing with 690 counted stores variance −10, and the day then
// reads closed with that count; the day list and the reconciliations agree.
func TestREG_BILL_060_DayCloseHoldsTheDrawerToCash(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	rails := blRails(t, cashier)
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Drawer"), "Day")
	take := func(amount float64, body map[string]any) {
		cid := payRaise(t, cashier, clinic, p.ID, amount)
		cashier.Do("POST", "/billing/charges/"+cid+"/settle", body).Expect(t, 204, "settle")
	}
	take(500, map[string]any{"rail_id": rails["cash"]})
	take(200, map[string]any{"method": "cash"})
	take(300, map[string]any{"rail_id": rails["transfer"], "reference": "FT" + strings.ToUpper(uniq(""))})
	take(50, map[string]any{"rail_id": rails["card"]})

	d := blDayClose(t, cashier, "")
	if d.BusinessDate != blUTCToday() || !payEq(payNum(t, d.ExpectedTotal), 700) || !payEq(payNum(t, d.NonCashTotal), 350) || d.Closed {
		t.Fatalf("day close %s: expected %s non-cash %s closed %v; want %s, 700, 350, open",
			d.BusinessDate, d.ExpectedTotal, d.NonCashTotal, d.Closed, blUTCToday())
	}
	methods := map[string]string{}
	for _, m := range d.ByMethod {
		methods[fmt.Sprintf("%s/%v", m.Label, m.Cash)] = m.Total
	}
	if !payEq(payNum(t, methods["cash/true"]), 700) || !payEq(payNum(t, methods["transfer/false"]), 300) || !payEq(payNum(t, methods["card/false"]), 50) {
		t.Fatalf("day close by method %v, want cash 700 (cash), transfer 300, card 50", methods)
	}
	if o := blDayClose(t, mgr, "?date="+blUTCToday()); !payEq(payNum(t, o.ExpectedTotal), 0) || len(o.ByMethod) != 0 {
		t.Fatalf("another cashier's drawer shows %s / %d lines, want nothing", o.ExpectedTotal, len(o.ByMethod))
	}
	if y := blDayClose(t, cashier, "?date="+time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")); !payEq(payNum(t, y.ExpectedTotal), 0) {
		t.Fatalf("yesterday's drawer expects %s, want 0", y.ExpectedTotal)
	}
	blExpect(t, cashier.Do("GET", "/billing/day-close?date=02/10/2026", nil), 400, "VALIDATION_FAILED", "bad date")

	var rec struct {
		BusinessDate  string `json:"business_date"`
		ExpectedTotal string `json:"expected_total"`
		CountedTotal  string `json:"counted_total"`
		Variance      string `json:"variance"`
		Note          string `json:"note"`
	}
	cashier.Do("POST", "/billing/day-close", map[string]any{"counted": 690, "note": "10 short"}).Expect(t, 200, "close day").Decode(t, &rec)
	if rec.BusinessDate != blUTCToday() || !payEq(payNum(t, rec.ExpectedTotal), 700) || !payEq(payNum(t, rec.CountedTotal), 690) ||
		!payEq(payNum(t, rec.Variance), -10) || rec.Note != "10 short" {
		t.Fatalf("Z-report %+v, want expected 700, counted 690, variance -10", rec)
	}
	var stored, byMethod string
	one(t, `SELECT expected_total::text||'|'||counted_total::text||'|'||variance::text FROM cash_reconciliations WHERE tenant_id=$1 AND cashier_id=$2`,
		&stored, clinic.TenantID, clinic.Staff["cashier"].ID)
	one(t, `SELECT by_method::text FROM cash_reconciliations WHERE tenant_id=$1 AND cashier_id=$2`, &byMethod, clinic.TenantID, clinic.Staff["cashier"].ID)
	if stored != "700.00|690.00|-10.00" || !strings.Contains(byMethod, "transfer") {
		t.Fatalf("stored close %q by_method %s", stored, byMethod)
	}
	d = blDayClose(t, cashier, "?date="+blUTCToday())
	if !d.Closed || d.Reconciliation == nil || !payEq(payNum(t, d.Reconciliation.CountedTotal), 690) || !payEq(payNum(t, d.Reconciliation.Variance), -10) {
		t.Fatalf("day after closing: closed=%v rec=%+v", d.Closed, d.Reconciliation)
	}

	var days []struct {
		BusinessDate  string `json:"business_date"`
		ExpectedTotal string `json:"expected_total"`
		Count         int    `json:"count"`
		Closed        bool   `json:"closed"`
		CountedTotal  string `json:"counted_total"`
		Variance      string `json:"variance"`
	}
	cashier.Do("GET", "/billing/day-closes", nil).Expect(t, 200, "day list").Decode(t, &days)
	if len(days) != 1 || days[0].BusinessDate != blUTCToday() || !days[0].Closed || days[0].Count != 4 ||
		!payEq(payNum(t, days[0].ExpectedTotal), 1050) || !payEq(payNum(t, days[0].CountedTotal), 690) {
		t.Fatalf("day list %+v, want today: 4 payments, 1,050 taken (all methods), closed at 690", days)
	}
	cashier.Do("GET", "/billing/day-closes?from=2020-01-01&to=2020-01-31", nil).Expect(t, 200, "old range").Decode(t, &days)
	if len(days) != 0 {
		t.Fatalf("a 2020 range lists %d days", len(days))
	}
	blExpect(t, cashier.Do("GET", "/billing/day-closes?from=x", nil), 400, "VALIDATION_FAILED", "bad from")
	blExpect(t, cashier.Do("GET", "/billing/day-closes?to=x", nil), 400, "VALIDATION_FAILED", "bad to")
	blExpect(t, cashier.Do("POST", "/billing/day-close", map[string]any{"counted": "lots"}), 400, "VALIDATION_FAILED", "counted not a number")
	blExpect(t, cashier.Do("POST", "/billing/day-close", map[string]any{"counted": 1, "business_date": "yesterday"}), 400, "VALIDATION_FAILED", "bad business date")

	type recon struct {
		Cashier      string `json:"cashier"`
		BusinessDate string `json:"business_date"`
		CountedTotal string `json:"counted_total"`
	}
	mgr.Do("POST", "/billing/day-close", map[string]any{"counted": 0}).Expect(t, 200, "manager closes an empty drawer")
	var mine, all []recon
	cashier.Do("GET", "/billing/reconciliations", nil).Expect(t, 200, "own closes").Decode(t, &mine)
	mgr.Do("GET", "/billing/reconciliations?all=1", nil).Expect(t, 200, "all closes").Decode(t, &all)
	if len(mine) != 1 || !payEq(payNum(t, mine[0].CountedTotal), 690) || mine[0].Cashier == "" || len(all) != 2 {
		t.Fatalf("reconciliations: own %+v (want the cashier's one, named), all %d (want 2)", mine, len(all))
	}
	recp := srv.As(t, clinic, "receptionist")
	for _, path := range []string{"/billing/day-close", "/billing/day-closes", "/billing/reconciliations"} {
		blExpect(t, recp.Do("GET", path, nil), 403, "FORBIDDEN_PERMISSION", "reception "+path)
	}
	blExpect(t, recp.Do("POST", "/billing/day-close", map[string]any{"counted": 1}), 403, "FORBIDDEN_PERMISSION", "reception closes")

	// A cashier is one of several drawers; "all" is the finance view.
	var leaked []recon
	cashier.Do("GET", "/billing/reconciliations?all=1", nil).Expect(t, 200, "cashier asks for all").Decode(t, &leaked)
	if len(leaked) > 1 {
		testkit.KnownBug(t, "NEW-PAY-1", true, fmt.Sprintf(
			"a cashier (no billing.manage) reads every cashier's closeouts with ?all=1 (%d rows) — "+
				"billing/http/handlers.go:842 passes all=1 through without checking billing.manage", len(leaked)))
	}
	testkit.KnownBug(t, "NEW-PAY-1", false, "a cashier's ?all=1 returns only their own closeouts")
}

// TestREG_BILL_061_ReclosingADayKeepsTheFirstCount (FIN-9): Given a day closed at 690
// against 700, When the cashier closes it again at 700, Then the first count must
// still be on record. The close is an upsert, so the 10 short disappears.
func TestREG_BILL_061_ReclosingADayKeepsTheFirstCount(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Reclose"), "Day")
	paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 700)).Expect(t, 204, "settle")
	cashier.Do("POST", "/billing/day-close", map[string]any{"counted": 690, "note": "short"}).Expect(t, 200, "first close")
	cashier.Do("POST", "/billing/day-close", map[string]any{"counted": 700, "note": "found it"}).Expect(t, 200, "re-close")
	var rows int
	var counted string
	one(t, `SELECT count(*) FROM cash_reconciliations WHERE tenant_id=$1`, &rows, clinic.TenantID)
	one(t, `SELECT string_agg(counted_total::text, ',') FROM cash_reconciliations WHERE tenant_id=$1`, &counted, clinic.TenantID)
	var trail int
	one(t, `SELECT count(*) FROM event_outbox WHERE tenant_id=$1 AND event_type='billing.day.closed'`, &trail, clinic.TenantID)
	if trail != 2 {
		t.Fatalf("%d day.closed events for two closes, want 2", trail)
	}
	if rows == 1 && counted == "700.00" {
		testkit.KnownBug(t, "FIN-9", true,
			"closing the same day twice left one reconciliation reading 700 — the first count (690, 10 short) is overwritten "+
				"(billing.sql InsertReconciliation ON CONFLICT DO UPDATE)")
	}
	testkit.KnownBug(t, "FIN-9", false, "re-closing a day keeps the earlier count")
}

// TestREG_BILL_062_RefundComesOutOfTheCashiersDrawer (FIN-9): Given the cashier took
// 500 cash and a manager refunded it in cash, Then the cashier's drawer expects 0. The
// refund row is settled_by the manager, so it lands in the manager's drawer (−500) and
// the cashier is still expected to hold 500.
func TestREG_BILL_062_RefundComesOutOfTheCashiersDrawer(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Refund"), "Drawer")
	cid := payRaise(t, cashier, clinic, p.ID, 500)
	paySettle(cashier, cid).Expect(t, 204, "settle")
	mgr.Do("POST", "/billing/charges/"+cid+"/refund", map[string]any{"reason": "unhappy"}).Expect(t, 204, "refund")
	c, m := blDayClose(t, cashier, ""), blDayClose(t, mgr, "")
	// The refund is classified as cash, by its original.
	refundLine := false
	for _, l := range m.ByMethod {
		if l.Label == "refund · cash" && l.Cash && payEq(payNum(t, l.Total), -500) {
			refundLine = true
		}
	}
	if !refundLine && !payEq(payNum(t, c.ExpectedTotal), 0) {
		t.Fatalf("refund appears in neither drawer: cashier %s, manager lines %+v", c.ExpectedTotal, m.ByMethod)
	}
	if payEq(payNum(t, c.ExpectedTotal), 500) && payEq(payNum(t, m.ExpectedTotal), -500) {
		testkit.KnownBug(t, "FIN-9", true,
			"a manager's cash refund of the cashier's 500 is booked to the manager's drawer (-500); the cashier is still expected to hold 500")
	}
	testkit.KnownBug(t, "FIN-9", false, "a refund of the cashier's takings comes out of the cashier's drawer")
}

// TestREG_BILL_063_LegacyCashView: Given 400 collected, 100 refunded, 60 waived and
// 250 outstanding in the last day, Then the manager's /billing/cash summary says so,
// grouped by source, method, cashier and branch; a window in the past is empty except
// for outstanding (never period-bound); a cashier may not read it.
func TestREG_BILL_063_LegacyCashView(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Cash"), "View")
	paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 300)).Expect(t, 204, "settle 300")
	r := payRaise(t, cashier, clinic, p.ID, 100)
	paySettle(cashier, r).Expect(t, 204, "settle 100")
	mgr.Do("POST", "/billing/charges/"+r+"/refund", map[string]any{"reason": "x"}).Expect(t, 204, "refund")
	w := payRaise(t, cashier, clinic, p.ID, 60)
	cashier.Do("POST", "/billing/charges/"+w+"/waive", map[string]any{"reason": "Other"}).Expect(t, 204, "waive")
	payRaise(t, cashier, clinic, p.ID, 250)

	type group struct {
		Label string `json:"label"`
		Total string `json:"total"`
	}
	var cs struct {
		Collected      string `json:"collected"`
		CollectedCount int    `json:"collected_count"`
		Waived         string `json:"waived"`
		Outstanding    string `json:"outstanding"`
		Refunded       string `json:"refunded"`
		BySource       []struct {
			Source string `json:"source"`
			Total  string `json:"total"`
		} `json:"by_source"`
		ByMethod  []group `json:"by_method"`
		ByCashier []group `json:"by_cashier"`
		ByBranch  []group `json:"by_branch"`
	}
	mgr.Do("GET", "/billing/cash", nil).Expect(t, 200, "cash view").Decode(t, &cs)
	if !payEq(payNum(t, cs.Collected), 300) || !payEq(payNum(t, cs.Refunded), 100) || !payEq(payNum(t, cs.Waived), 60) ||
		!payEq(payNum(t, cs.Outstanding), 250) || len(cs.BySource) == 0 || len(cs.ByMethod) == 0 || len(cs.ByCashier) == 0 || len(cs.ByBranch) == 0 {
		t.Fatalf("cash view %+v, want collected 300 (net), refunded 100, waived 60, outstanding 250, with every breakdown", cs)
	}
	since := time.Now().Add(-72 * time.Hour).UTC().Format(time.RFC3339)
	until := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	mgr.Do("GET", "/billing/cash?since="+since+"&until="+until, nil).Expect(t, 200, "past window").Decode(t, &cs)
	if !payEq(payNum(t, cs.Collected), 0) || !payEq(payNum(t, cs.Outstanding), 250) {
		t.Fatalf("cash view two days ago: collected %s outstanding %s, want 0 / 250", cs.Collected, cs.Outstanding)
	}
	blExpect(t, cashier.Do("GET", "/billing/cash", nil), 403, "FORBIDDEN_PERMISSION", "cashier cash view")
}

// ---- finance views ----

// TestREG_FIN_010_OverviewPeriodsBranchesAndAlerts: Given 1,000 settled today, 600
// settled 10 days ago, 80 settled today with no branch, a 70-day-old unpaid 200 and a
// closed shift 5 short, Then today's overview collects 1,080 (1,000 for ?branch=main),
// a 15-day window includes the 600 and draws one point per day, the previous window
// is what came before it, and the alerts name the short count and the old debt.
// Malformed periods and branches are refused.
func TestREG_FIN_010_OverviewPeriodsBranchesAndAlerts(t *testing.T) {
	clinic := payClinic(t)
	cashier, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	rails := blRails(t, cashier)
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Overview"), "Periods")
	today := payRaise(t, cashier, clinic, p.ID, 1000)
	cashier.Do("POST", "/billing/charges/"+today+"/settle", map[string]any{"rail_id": rails["mobile"], "reference": "MM" + uniq("")}).Expect(t, 204, "settle today")
	old := payRaise(t, cashier, clinic, p.ID, 600)
	paySettle(cashier, old).Expect(t, 204, "settle old")
	blExec(t, `UPDATE charges SET settled_at = now() - interval '10 days' WHERE id = $1`, blUUID(t, id.PrefixCharge, old))
	paySettle(cashier, blRaiseNoBranch(t, cashier, p.ID, 80)).Expect(t, 204, "settle unbranched")
	debt := payRaise(t, cashier, clinic, p.ID, 200)
	blExec(t, `UPDATE charges SET created_at = now() - interval '70 days' WHERE id = $1`, blUUID(t, id.PrefixCharge, debt))
	blExec(t, `INSERT INTO cash_reconciliations (tenant_id, cashier_id, business_date, expected_total, counted_total, variance)
	           VALUES ($1, $2, (now() AT TIME ZONE 'Africa/Addis_Ababa')::date, 100, 95, -5)`, clinic.TenantID, clinic.Staff["cashier"].ID)

	type ov struct {
		Collected      string `json:"collected"`
		CollectedCount int    `json:"collected_count"`
		CollectedPrev  string `json:"collected_prev"`
		Outstanding    string `json:"outstanding"`
		OldestDays     int    `json:"oldest_days"`
		Series         []struct {
			Date   string `json:"date"`
			Amount string `json:"amount"`
		} `json:"series"`
		SeriesPrev []struct{} `json:"series_prev"`
		BySource   []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
		} `json:"by_source"`
		ByMethod []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
		} `json:"by_method"`
		Attention []struct {
			Kind   string `json:"kind"`
			Amount string `json:"amount"`
			Count  int    `json:"count"`
		} `json:"attention"`
	}
	get := func(q string) ov {
		var o ov
		owner.Do("GET", "/finance/overview"+q, nil).Expect(t, 200, "overview "+q).Decode(t, &o)
		return o
	}
	o := get("")
	if !payEq(payNum(t, o.Collected), 1080) || o.CollectedCount != 2 || !payEq(payNum(t, o.Outstanding), 200) || o.OldestDays < 69 || len(o.Series) != 1 {
		t.Fatalf("today: collected %s (%d) outstanding %s oldest %d series %d; want 1080 (2), 200, ~70 days, 1 point",
			o.Collected, o.CollectedCount, o.Outstanding, o.OldestDays, len(o.Series))
	}
	kinds := map[string]bool{}
	for _, a := range o.Attention {
		kinds[a.Kind] = true
		if a.Kind == "shift_variance" && (!payEq(payNum(t, a.Amount), 5) || a.Count != 1) {
			t.Fatalf("variance alert %+v, want 1 count, 5", a)
		}
		if a.Kind == "overdue" && (!payEq(payNum(t, a.Amount), 200) || a.Count != 1) {
			t.Fatalf("overdue alert %+v, want 1 patient, 200", a)
		}
	}
	if !kinds["shift_variance"] || !kinds["overdue"] {
		t.Fatalf("alerts %v, want shift_variance and overdue", kinds)
	}
	labels := map[string]string{}
	for _, m := range o.ByMethod {
		labels[m.Key] = m.Label
	}
	if labels["mobile"] != "mobile" || labels["cash"] != "Cash" {
		t.Fatalf("by_method labels %v, want mobile→mobile, cash→Cash", labels)
	}
	if len(o.BySource) != 1 || o.BySource[0].Label != "Services" {
		t.Fatalf("by_source %+v, want Services", o.BySource)
	}
	if b := get("?branch=" + payBranch(t, clinic)); !payEq(payNum(t, b.Collected), 1000) {
		t.Fatalf("branch overview collected %s, want 1000 (the unbranched 80 is not this branch's)", b.Collected)
	}
	addis, _ := time.LoadLocation("Africa/Addis_Ababa")
	now := time.Now().In(addis)
	from := now.AddDate(0, 0, -14).Format("2006-01-02")
	w := get("?from=" + from + "&to=" + now.Format("2006-01-02"))
	if !payEq(payNum(t, w.Collected), 1680) || len(w.Series) != 15 || len(w.SeriesPrev) != 15 {
		t.Fatalf("15-day window: collected %s, %d/%d points; want 1680, 15/15", w.Collected, len(w.Series), len(w.SeriesPrev))
	}
	y := get("?from=" + now.AddDate(0, 0, -1).Format("2006-01-02") + "&to=" + now.Format("2006-01-02"))
	if !payEq(payNum(t, y.Collected), 1080) || !payEq(payNum(t, y.CollectedPrev), 0) {
		t.Fatalf("2-day window: collected %s prev %s, want 1080 / 0", y.Collected, y.CollectedPrev)
	}
	pw := get("?from=" + now.AddDate(0, 0, -10).Format("2006-01-02") + "&to=" + now.AddDate(0, 0, -10).Format("2006-01-02"))
	if !payEq(payNum(t, pw.Collected), 600) {
		t.Fatalf("the day 10 days ago collected %s, want 600", pw.Collected)
	}
	for _, q := range []string{"?from=2026-13-01", "?to=nope", "?from=2026-05-10&to=2026-05-01", "?branch=bad"} {
		blExpect(t, owner.Do("GET", "/finance/overview"+q, nil), 400, "VALIDATION_FAILED", "overview "+q)
	}
}

// TestREG_FIN_011_CashTabShiftsAndOpenDrawers: Given a closed shift 10 short and a
// second cashier who took 250 today without closing, Then the cash tab lists the shift
// with its variance, totals |variance|, splits takings by method / cashier / branch,
// and names the open drawer — until that cashier closes.
func TestREG_FIN_011_CashTabShiftsAndOpenDrawers(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Cash"), "Tab")
	paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 700)).Expect(t, 204, "cashier takes 700")
	cashier.Do("POST", "/billing/day-close", map[string]any{"counted": 690}).Expect(t, 200, "close")
	mc := payRaise(t, cashier, clinic, p.ID, 250)
	paySettle(mgr, mc).Expect(t, 204, "manager takes 250")
	// Settled at a plain afternoon hour of today (Addis), so the open-drawer check
	// is about the drawer, not the clock.
	addis, _ := time.LoadLocation("Africa/Addis_Ababa")
	n := time.Now().In(addis)
	noon := time.Date(n.Year(), n.Month(), n.Day(), 12, 0, 0, 0, addis)
	if noon.Before(time.Now()) {
		blExec(t, `UPDATE charges SET settled_at = $2 WHERE id = $1`, blUUID(t, id.PrefixCharge, mc), noon)
	}

	type line struct {
		Label  string `json:"label"`
		Amount string `json:"amount"`
	}
	var cv struct {
		Shifts []struct {
			Cashier  string `json:"cashier"`
			Expected string `json:"expected"`
			Counted  string `json:"counted"`
			Variance string `json:"variance"`
		} `json:"shifts"`
		Variance    string `json:"variance"`
		ByMethod    []line `json:"by_method"`
		ByCashier   []line `json:"by_cashier"`
		ByBranch    []line `json:"by_branch"`
		OpenDrawers []line `json:"open_drawers"`
	}
	from := time.Now().In(addis).AddDate(0, 0, -1).Format("2006-01-02")
	owner.Do("GET", "/finance/cash?from="+from, nil).Expect(t, 200, "cash tab").Decode(t, &cv)
	if len(cv.Shifts) != 1 || !payEq(payNum(t, cv.Shifts[0].Variance), -10) || !payEq(payNum(t, cv.Variance), 10) {
		t.Fatalf("shifts %+v total variance %s, want one shift -10 and |variance| 10", cv.Shifts, cv.Variance)
	}
	if len(cv.ByCashier) != 2 || len(cv.ByMethod) != 1 || cv.ByMethod[0].Label != "cash" || len(cv.ByBranch) != 1 || !payEq(payNum(t, cv.ByBranch[0].Amount), 950) {
		t.Fatalf("splits: cashier %+v method %+v branch %+v; want 2 cashiers, cash, one branch of 950", cv.ByCashier, cv.ByMethod, cv.ByBranch)
	}
	mgrName := ""
	one(t, `SELECT full_name FROM users WHERE id=$1`, &mgrName, clinic.Staff["branch_manager"].ID)
	open := map[string]string{}
	for _, l := range cv.OpenDrawers {
		open[l.Label] = l.Amount
	}
	if noon.Before(time.Now()) && (len(open) != 1 || !payEq(payNum(t, open[mgrName]), 250)) {
		t.Fatalf("open drawers %v, want only %s with 250 (the cashier has closed)", open, mgrName)
	}
	mgr.Do("POST", "/billing/day-close", map[string]any{"counted": 250}).Expect(t, 200, "manager closes")
	owner.Do("GET", "/finance/cash", nil).Expect(t, 200, "cash tab after").Decode(t, &cv)
	if len(cv.OpenDrawers) != 0 {
		t.Fatalf("open drawers after everyone closed: %+v", cv.OpenDrawers)
	}
	blExpect(t, owner.Do("GET", "/finance/cash?to=bad", nil), 400, "VALIDATION_FAILED", "cash tab bad period")

	// Money taken just after midnight Addis is today's — and its drawer is open.
	early := payRaise(t, cashier, clinic, p.ID, 40)
	paySettle(cashier, early).Expect(t, 204, "settle")
	blExec(t, `UPDATE charges SET settled_at = (date_trunc('day', now() AT TIME ZONE 'Africa/Addis_Ababa') + interval '30 minutes') AT TIME ZONE 'Africa/Addis_Ababa'
	           WHERE id = $1`, blUUID(t, id.PrefixCharge, early))
	blExec(t, `DELETE FROM cash_reconciliations WHERE tenant_id=$1 AND cashier_id=$2`, clinic.TenantID, clinic.Staff["cashier"].ID)
	owner.Do("GET", "/finance/cash", nil).Expect(t, 200, "cash tab early").Decode(t, &cv)
	cashierName := ""
	one(t, `SELECT full_name FROM users WHERE id=$1`, &cashierName, clinic.Staff["cashier"].ID)
	// An unclosed drawer holds what that cashier took today (Addis), as the same tab's
	// by-cashier split (an Addis window) reports it: 700 + the 40 just after midnight.
	took, openAmt := "", ""
	for _, l := range cv.ByCashier {
		if l.Label == cashierName {
			took = l.Amount
		}
	}
	for _, l := range cv.OpenDrawers {
		if l.Label == cashierName {
			openAmt = l.Amount
		}
	}
	if !payEq(payNum(t, took), 740) {
		t.Fatalf("by-cashier today for the cashier %q, want 740", took)
	}
	if !payEq(payNum(t, openAmt), payNum(t, took)) {
		testkit.KnownBug(t, "NEW-PAY-2", true, fmt.Sprintf(
			"the cashier's open drawer reads %q but they took %s today (incl. 40 at 00:30 Addis) — finance/service/views.go:101 "+
				"compares settled_at::date (session time zone) with the Addis date", openAmt, took))
	}
	testkit.KnownBug(t, "NEW-PAY-2", false, "open drawers count money taken just after midnight Addis")
}

// TestREG_FIN_012_ServicesCountsProceduresNotReceipts: Given a 2-visit dental course
// whose visits were both paid, and two catalogued X-rays, Then the services tab counts
// the course once (its revenue is both visits) and the X-ray twice at its list price.
func TestREG_FIN_012_ServicesCountsProceduresNotReceipts(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	mgr := srv.As(t, clinic, "branch_manager")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Svc"), "Count")
	plan := createPlan(t, doctor, p.ID, "2000", 2, "")
	for _, s := range plan.Sessions {
		payDone(t, doctor, p.ID, s.ID)
		payCollect(t, doctor, p.ID, s.ID)
		paySettle(cashier, payOnePending(t, cashier, p.ID, 1000).ID).Expect(t, 204, "settle visit")
	}
	xray := blService(t, mgr, "Periapical X-ray", "general", 150, "")
	for i := 0; i < 2; i++ {
		var out struct {
			ID string `json:"id"`
		}
		cashier.Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "service_item_id": xray, "description": "X-ray", "amount": 150}).
			Expect(t, 201, "raise x-ray").Decode(t, &out)
		paySettle(cashier, out.ID).Expect(t, 204, "settle x-ray")
	}
	var lines []struct {
		Label      string `json:"label"`
		Source     string `json:"source"`
		Count      int    `json:"count"`
		Revenue    string `json:"revenue"`
		Avg        string `json:"avg"`
		Catalogued bool   `json:"catalogued"`
		ListPrice  string `json:"list_price"`
	}
	owner.Do("GET", "/finance/services", nil).Expect(t, 200, "services").Decode(t, &lines)
	got := map[string]string{}
	for _, l := range lines {
		got[l.Label] = fmt.Sprintf("%d|%.0f|%.0f|%v|%s", l.Count, payNum(t, l.Revenue), payNum(t, l.Avg), l.Catalogued, l.ListPrice)
	}
	if got[plan.Title] != "1|2000|2000|false|" || got["Periapical X-ray"] != "2|300|150|true|150.00" {
		t.Fatalf("services tab %v; want %q → 1 course of 2000, X-ray → 2 at 150 (list 150.00)", got, plan.Title)
	}
	blExpect(t, owner.Do("GET", "/finance/services?branch=bad", nil), 400, "VALIDATION_FAILED", "services bad branch")
}

// TestREG_FIN_013_TreatmentBookAndAtRisk: Given a 3-visit course whose first visit's
// date has passed unrecorded, Then the book lists the future planned visits by month
// and the course is at risk with "1 visit(s) missed".
func TestREG_FIN_013_TreatmentBookAndAtRisk(t *testing.T) {
	clinic := payClinic(t)
	doctor, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Book"), "Risk")
	plan := createPlan(t, doctor, p.ID, "3000", 3, "")
	blExec(t, `UPDATE treatment_sessions SET scheduled_date = (now() AT TIME ZONE 'Africa/Addis_Ababa')::date - 3 WHERE id = $1`,
		blUUID(t, id.PrefixTreatmentSession, plan.Sessions[0].ID))
	var b struct {
		Total   string `json:"total"`
		Visits  int    `json:"visits"`
		ByMonth []struct {
			Amount string `json:"amount"`
			Count  int    `json:"count"`
		} `json:"by_month"`
		AtRisk []struct {
			ID     string `json:"id"`
			Plan   string `json:"plan"`
			AtRisk string `json:"at_risk"`
			Reason string `json:"reason"`
		} `json:"at_risk"`
	}
	owner.Do("GET", "/finance/book", nil).Expect(t, 200, "book").Decode(t, &b)
	months, monthTotal := 0, 0.0
	for _, m := range b.ByMonth {
		months += m.Count
		monthTotal += payNum(t, m.Amount)
	}
	if months != 2 || !payEq(monthTotal, 2000) {
		t.Fatalf("book by month: %d visits totalling %.2f, want the 2 future visits = 2000", months, monthTotal)
	}
	if len(b.AtRisk) != 1 || b.AtRisk[0].ID != p.ID || b.AtRisk[0].Reason != "1 visit(s) missed" || !payEq(payNum(t, b.AtRisk[0].AtRisk), 3000) {
		t.Fatalf("at risk %+v, want this course, 1 missed, 3000 still planned", b.AtRisk)
	}
	blExpect(t, owner.Do("GET", "/finance/book?from=x", nil), 400, "VALIDATION_FAILED", "book bad period")
}

// TestREG_FIN_014_FinanceIsGatedByPermissionAndPlan: Then a cashier gets 403 on every
// finance tab; a plan without the finance dashboard returns MODULE_DISABLED even for
// the owner; anonymous callers are 401.
func TestREG_FIN_014_FinanceIsGatedByPermissionAndPlan(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	chair := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-chair"})
	chairOwner := srv.As(t, chair, "owner")
	for _, tab := range []string{"overview", "receivables", "cash", "services", "book"} {
		blExpect(t, cashier.Do("GET", "/finance/"+tab, nil), 403, "FORBIDDEN_PERMISSION", "cashier "+tab)
		blExpect(t, chairOwner.Do("GET", "/finance/"+tab, nil), 403, "MODULE_DISABLED", "chair plan "+tab)
		blExpect(t, srv.Anon(t).Do("GET", "/finance/"+tab, nil), 401, "", "anonymous "+tab)
	}
	blExpect(t, srv.As(t, clinic, "owner").Do("GET", "/finance/receivables?branch=bad", nil), 400, "VALIDATION_FAILED", "receivables bad branch")
}

// ---- home screen ----

// TestREG_FIN_020_TakingsChartWindows: Given 500 today and 300 twelve days ago, Then the
// takings chart for 7 days totals 500 over 7 points, 30 days 800 over 30, 90 days 800
// over 90; any other ?days is 30; a dentist (no money permission) gets no chart.
func TestREG_FIN_020_TakingsChartWindows(t *testing.T) {
	clinic := payClinic(t)
	cashier, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Takings"), "Chart")
	paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 500)).Expect(t, 204, "settle")
	old := payRaise(t, cashier, clinic, p.ID, 300)
	paySettle(cashier, old).Expect(t, 204, "settle old")
	blExec(t, `UPDATE charges SET settled_at = now() - interval '12 days' WHERE id = $1`, blUUID(t, id.PrefixCharge, old))
	type takings struct {
		Days     int    `json:"days"`
		Total    string `json:"total"`
		Prev     string `json:"prev"`
		Series   []any  `json:"series"`
		BySource []any  `json:"by_source"`
		ByMethod []any  `json:"by_method"`
	}
	for _, c := range []struct {
		q     string
		days  int
		total float64
	}{{"7", 7, 500}, {"30", 30, 800}, {"90", 90, 800}, {"5", 30, 800}, {"abc", 30, 800}, {"", 30, 800}} {
		var tk takings
		owner.Do("GET", "/dashboard/takings?days="+c.q, nil).Expect(t, 200, "takings "+c.q).Decode(t, &tk)
		if tk.Days != c.days || len(tk.Series) != c.days || !payEq(payNum(t, tk.Total), c.total) || len(tk.BySource) == 0 || len(tk.ByMethod) == 0 {
			t.Fatalf("takings days=%q: %d days, %d points, total %s; want %d, %d, %.0f", c.q, tk.Days, len(tk.Series), tk.Total, c.days, c.days, c.total)
		}
		if c.q == "7" && !payEq(payNum(t, tk.Prev), 300) {
			t.Fatalf("7-day takings prev %s, want the 300 from the week before", tk.Prev)
		}
	}
	r := srv.As(t, clinic, "doctor").Do("GET", "/dashboard/takings?days=7", nil).Expect(t, 200, "dentist takings")
	if strings.TrimSpace(string(r.Data)) != "null" {
		t.Fatalf("a dentist sees the takings chart: %s", r.Data)
	}
}

// TestREG_FIN_021_HomeAlertsLoudestFirst: Given a patient waiting 150 minutes, one
// waiting 30, a visit missed this week and a 70-day-old debt, Then the home screen
// names the longest wait ("over 2 hours"), counts the missed visit, and orders danger
// (overdue) before warnings.
func TestREG_FIN_021_HomeAlertsLoudestFirst(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	recp := srv.As(t, clinic, "receptionist")
	long := createPatient(t, recp, uniq("Long"), "Wait")
	short := createPatient(t, recp, uniq("Short"), "Wait")
	for _, w := range []struct {
		p   patientRef
		min int
	}{{long, 150}, {short, 30}} {
		blExec(t, `INSERT INTO queue_entries (tenant_id, branch_id, department_id, patient_id, enqueued_at, assigned_provider_id)
		           VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5), $6)`,
			clinic.TenantID, clinic.BranchID, clinic.DeptID, blPatientUUID(t, w.p), w.min, clinic.Staff["doctor"].ID)
	}
	missed := createPatient(t, recp, uniq("Missed"), "Visit")
	plan := createPlan(t, doctor, missed.ID, "1000", 2, "")
	blExec(t, `UPDATE treatment_sessions SET scheduled_date = (now() AT TIME ZONE 'Africa/Addis_Ababa')::date - 2 WHERE id = $1`,
		blUUID(t, id.PrefixTreatmentSession, plan.Sessions[0].ID))
	debt := payRaise(t, cashier, clinic, short.ID, 200)
	blExec(t, `UPDATE charges SET created_at = now() - interval '70 days' WHERE id = $1`, blUUID(t, id.PrefixCharge, debt))

	var d struct {
		Attention []struct {
			Kind      string `json:"kind"`
			Tone      string `json:"tone"`
			Text      string `json:"text"`
			Detail    string `json:"detail"`
			PatientID string `json:"patient_id"`
			Count     int    `json:"count"`
		} `json:"attention"`
	}
	owner.Do("GET", "/dashboard/today", nil).Expect(t, 200, "today").Decode(t, &d)
	seenWarn, kinds := false, map[string]int{}
	for _, a := range d.Attention {
		if a.Tone == "warn" {
			seenWarn = true
		}
		if a.Tone == "danger" && seenWarn {
			t.Fatalf("a danger alert comes after a warning: %+v", d.Attention)
		}
		kinds[a.Kind] = a.Count
		if a.Kind == "long_wait" && (a.PatientID != long.ID || !strings.HasSuffix(a.Text, "has waited over 2 hours") || !strings.Contains(a.Detail, "Waiting for")) {
			t.Fatalf("long-wait alert %+v, want %s waiting over 2 hours for the dentist", a, long.ID)
		}
		if a.Kind == "missed_visit" && a.Text != "1 patient missed a treatment visit this week" {
			t.Fatalf("missed-visit text %q", a.Text)
		}
	}
	if _, ok := kinds["long_wait"]; !ok || kinds["missed_visit"] != 1 || kinds["overdue"] != 1 {
		t.Fatalf("alerts %v, want long_wait, missed_visit (1) and overdue (1)", kinds)
	}
	// Wait wording: under an hour in minutes, then "over an hour".
	blExec(t, `UPDATE queue_entries SET state = 'done' WHERE patient_id = $1`, blPatientUUID(t, long))
	owner.Do("GET", "/dashboard/today", nil).Expect(t, 200, "today 2").Decode(t, &d)
	for _, a := range d.Attention {
		if a.Kind == "long_wait" && !strings.HasSuffix(a.Text, "has waited 30 minutes") {
			t.Fatalf("30-minute wait reads %q", a.Text)
		}
	}
	blExec(t, `UPDATE queue_entries SET enqueued_at = now() - interval '75 minutes' WHERE patient_id = $1`, blPatientUUID(t, short))
	owner.Do("GET", "/dashboard/today", nil).Expect(t, 200, "today 3").Decode(t, &d)
	for _, a := range d.Attention {
		if a.Kind == "long_wait" && !strings.HasSuffix(a.Text, "has waited over an hour") {
			t.Fatalf("75-minute wait reads %q", a.Text)
		}
	}
}

// ---- legacy card fee ----

// TestREG_BILL_070_LegacyCardFee (FIN-13): Given a clinic charging a 150 card fee,
// Then assess says due; collecting it records a receipt and assess then says already
// paid today; a waived collect is 0; history lists both; a disabled fee, an unconfigured
// clinic and a covered follow-up are each free with their reason. But the card fee is
// written outside the charges ledger: Finance never sees the 150, and the route that
// takes it is still mounted.
func TestREG_BILL_070_LegacyCardFee(t *testing.T) {
	clinic := payClinic(t)
	recp, owner, cashier := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "owner"), srv.As(t, clinic, "cashier")
	blExec(t, `UPDATE clinics SET card_fee_enabled = true, card_fee_amount = 150 WHERE tenant_id = $1`, clinic.TenantID)
	p := createPatient(t, recp, uniq("Card"), "Fee")
	type assessment struct {
		RequiresPayment bool   `json:"requires_payment"`
		CardEnabled     bool   `json:"card_enabled"`
		Amount          string `json:"amount"`
		Reason          string `json:"reason"`
	}
	assess := func(q string) assessment {
		var a assessment
		cashier.Do("GET", "/billing/card/assess?patient="+p.ID+q, nil).Expect(t, 200, "assess").Decode(t, &a)
		return a
	}
	if a := assess(""); !a.RequiresPayment || !a.CardEnabled || !payEq(payNum(t, a.Amount), 150) || a.Reason != "card fee due" {
		t.Fatalf("assess %+v, want 150 due", a)
	}
	// A doctor-booked follow-up inside its window is free.
	var appt struct {
		ID string `json:"id"`
	}
	recp.Do("POST", "/appointments", map[string]any{
		"branch_id": payBranch(t, clinic), "patient_id": p.ID, "provider_id": blUser(clinic.Staff["doctor"]), "department_id": blDept(clinic),
		"starts_at": time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339), "duration_min": 30, "is_followup": true,
		"free_until": time.Now().Add(7 * 24 * time.Hour).UTC().Format(time.RFC3339),
	}).Expect(t, 201, "book follow-up").Decode(t, &appt)
	if a := assess("&appointment=" + appt.ID); a.RequiresPayment || a.Reason != "covered follow-up (free)" {
		t.Fatalf("covered follow-up assess %+v", a)
	}
	if a := assess("&appointment=" + id.Encode(id.PrefixAppointment, blUUID(t, id.PrefixPatient, p.ID))); !a.RequiresPayment {
		t.Fatalf("an unknown appointment made the visit free: %+v", a)
	}
	blExpect(t, cashier.Do("GET", "/billing/card/assess?patient="+p.ID+"&appointment=bad", nil), 400, "VALIDATION_FAILED", "bad appointment")
	blExpect(t, cashier.Do("GET", "/billing/card/assess", nil), 400, "VALIDATION_FAILED", "no patient")

	var pay struct {
		ID     string `json:"id"`
		Amount string `json:"amount"`
		Waived bool   `json:"waived"`
	}
	r := cashier.Do("POST", "/billing/card/collect", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "appointment_id": appt.ID})
	collected := r.Status == 201
	blExpect(t, r, 201, "", "collect card fee")
	r.Decode(t, &pay)
	if !strings.HasPrefix(pay.ID, "cpy_") || !payEq(payNum(t, pay.Amount), 150) || pay.Waived {
		t.Fatalf("card receipt %+v, want cpy_… for 150", pay)
	}
	if a := assess(""); a.RequiresPayment || a.Reason != "already paid today" {
		t.Fatalf("assess after paying %+v, want already paid today", a)
	}
	cashier.Do("POST", "/billing/card/collect", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "waived": true, "waive_reason": "Other"}).
		Expect(t, 201, "waived collect").Decode(t, &pay)
	if !pay.Waived || !payEq(payNum(t, pay.Amount), 0) {
		t.Fatalf("waived card receipt %+v, want 0 waived", pay)
	}
	var hist []struct {
		ID          string `json:"id"`
		Amount      string `json:"amount"`
		WaiveReason string `json:"waive_reason"`
	}
	cashier.Do("GET", "/billing/card/history?patient="+p.ID, nil).Expect(t, 200, "history").Decode(t, &hist)
	if len(hist) != 2 || hist[0].WaiveReason != "Other" {
		t.Fatalf("card history %+v, want 2 receipts, newest the waiver", hist)
	}
	blExpect(t, cashier.Do("GET", "/billing/card/history", nil), 400, "VALIDATION_FAILED", "history without patient")
	for _, b := range []map[string]any{
		{"patient_id": p.ID},
		{"patient_id": "bad", "branch_id": payBranch(t, clinic)},
		{"patient_id": p.ID, "branch_id": "bad"},
		{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "appointment_id": "bad"},
	} {
		blExpect(t, cashier.Do("POST", "/billing/card/collect", b), 400, "VALIDATION_FAILED", fmt.Sprintf("collect %v", b))
	}
	blExpect(t, recp.Do("GET", "/billing/card/assess?patient="+p.ID, nil), 403, "FORBIDDEN_PERMISSION", "reception (no payment.collect) assesses")

	blExec(t, `UPDATE clinics SET card_fee_enabled = false WHERE tenant_id = $1`, clinic.TenantID)
	if a := assess(""); a.RequiresPayment || a.CardEnabled || a.Reason != "card fee not collected at this clinic" {
		t.Fatalf("disabled card fee assess %+v", a)
	}
	blExec(t, `UPDATE clinics SET deleted_at = now() WHERE tenant_id = $1`, clinic.TenantID)
	if a := assess(""); a.RequiresPayment || a.Reason != "clinic not configured" {
		t.Fatalf("unconfigured clinic assess %+v", a)
	}
	cashier.Do("POST", "/billing/card/collect", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic)}).Expect(t, 201, "collect with no clinic row").Decode(t, &pay)
	if !payEq(payNum(t, pay.Amount), 0) {
		t.Fatalf("collect with no clinic settings took %s", pay.Amount)
	}
	blExec(t, `UPDATE clinics SET deleted_at = NULL WHERE tenant_id = $1`, clinic.TenantID)

	ov := payGetOverview(t, owner, "")
	if collected && payEq(payNum(t, ov.Collected), 0) {
		testkit.KnownBug(t, "FIN-13", true,
			"POST /billing/card/collect is still mounted and took a 150 card fee into card_payments; Finance's collected today is 0 — the money is outside the charges ledger")
	}
	testkit.KnownBug(t, "FIN-13", false, "the legacy card-fee route is gone or its money reaches Finance")
}

// ---- intake fee (the default service) ----

// TestREG_BILL_080_IntakeFeeRaisedOnceAndGatesTheDoor: Given a default 200 registration
// service, When reception receives a walk-in, Then one fee is raised and the patient
// waits for payment; pressing again hands back the same charge; settling it queues the
// patient; pressing again after payment raises nothing and queues nobody twice; a
// covered follow-up checks in with no fee and goes straight to the queue.
func TestREG_BILL_080_IntakeFeeRaisedOnceAndGatesTheDoor(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, mgr := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	svc := blService(t, mgr, "Registration", "general", 200, "")
	mgr.Do("PUT", "/billing/services/"+svc+"/default", map[string]any{"is_default": true}).Expect(t, 204, "make default")
	p := createPatient(t, recp, uniq("Walk"), "In")
	type arrival struct {
		Gated     bool     `json:"gated"`
		ChargeIDs []string `json:"charge_ids"`
	}
	walk := func(pid string) arrival {
		var a arrival
		recp.Do("POST", "/queue/walk-in", map[string]any{"patient_id": pid, "department_id": blDept(clinic), "branch_id": payBranch(t, clinic)}).
			Expect(t, 201, "walk-in").Decode(t, &a)
		return a
	}
	first := walk(p.ID)
	if !first.Gated || len(first.ChargeIDs) != 1 {
		t.Fatalf("walk-in %+v, want gated on one fee", first)
	}
	if again := walk(p.ID); !again.Gated || len(again.ChargeIDs) != 1 || again.ChargeIDs[0] != first.ChargeIDs[0] {
		t.Fatalf("second press %+v, want the same fee %s handed back", again, first.ChargeIDs[0])
	}
	var fees, q int
	one(t, `SELECT count(*) FROM charges WHERE patient_id=$1`, &fees, blPatientUUID(t, p))
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1`, &q, blPatientUUID(t, p))
	if fees != 1 || q != 0 {
		t.Fatalf("after two presses: %d fees, %d queue entries; want 1 fee, nobody queued", fees, q)
	}
	paySettle(cashier, first.ChargeIDs[0]).Expect(t, 204, "pay the fee")
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1`, &q, blPatientUUID(t, p))
	if q != 1 {
		t.Fatalf("paying the fee queued the patient %d times, want 1", q)
	}
	if after := walk(p.ID); after.Gated || len(after.ChargeIDs) != 0 {
		t.Fatalf("press after payment %+v, want nothing raised", after)
	}
	one(t, `SELECT count(*) FROM charges WHERE patient_id=$1`, &fees, blPatientUUID(t, p))
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1`, &q, blPatientUUID(t, p))
	if fees != 1 || q != 1 {
		t.Fatalf("press after payment: %d fees, %d queue entries; want still 1 and 1", fees, q)
	}

	// A covered follow-up: checked in, no fee, straight to the queue.
	f := createPatient(t, recp, uniq("Follow"), "Up")
	var appt struct {
		ID string `json:"id"`
	}
	recp.Do("POST", "/appointments", map[string]any{
		"branch_id": payBranch(t, clinic), "patient_id": f.ID, "provider_id": blUser(clinic.Staff["doctor"]), "department_id": blDept(clinic),
		"starts_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339), "duration_min": 30, "is_followup": true,
		"free_until": time.Now().Add(7 * 24 * time.Hour).UTC().Format(time.RFC3339),
	}).Expect(t, 201, "book follow-up").Decode(t, &appt)
	var ci arrival
	recp.Do("POST", "/appointments/"+appt.ID+"/check-in", map[string]any{}).Expect(t, 200, "check in").Decode(t, &ci)
	one(t, `SELECT count(*) FROM charges WHERE patient_id=$1`, &fees, blPatientUUID(t, f))
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1`, &q, blPatientUUID(t, f))
	if ci.Gated || fees != 0 || q != 1 {
		t.Fatalf("covered follow-up check-in: gated=%v fees=%d queued=%d; want free and queued", ci.Gated, fees, q)
	}
}

// TestREG_BILL_081_UndoWriteOffVoidsTheWaiver: Given a dental visit written off, When
// the write-off is undone, Then the waived charge is voided (not left counting as
// waived), the visit is owed again, and undoing twice is NOT_WAIVED.
func TestREG_BILL_081_UndoWriteOffVoidsTheWaiver(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Undo"), "WriteOff")
	plan := createPlan(t, doctor, p.ID, "1000", 1, "")
	sid := plan.Sessions[0].ID
	payDone(t, doctor, p.ID, sid)
	path := "/dental/patients/" + p.ID + "/sessions/" + sid
	cashier.Do("POST", path+"/write-off", map[string]any{"reason": "goodwill"}).Expect(t, 204, "write off")
	if ov := payGetOverview(t, owner, ""); !payEq(payNum(t, ov.Waived), 1000) {
		t.Fatalf("waived after write-off %s, want 1000", ov.Waived)
	}
	cashier.Do("POST", path+"/undo-write-off", map[string]any{"reason": "mistake"}).Expect(t, 204, "undo write-off")
	var void int
	one(t, `SELECT count(*) FROM charges WHERE patient_id=$1 AND status='void' AND void_reason='write-off reversed'`, &void, blPatientUUID(t, p))
	if void != 1 {
		t.Fatalf("undoing the write-off left %d voided waivers, want 1", void)
	}
	if ov := payGetOverview(t, owner, ""); !payEq(payNum(t, ov.Waived), 0) {
		t.Fatalf("waived after undo %s, want 0", ov.Waived)
	}
	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 0, 1000, 0, "after undoing the write-off")
	r := cashier.Do("POST", path+"/undo-write-off", map[string]any{"reason": "again"})
	blExpect(t, r, 409, "NOT_WAIVED", "undo twice")
}

// ---- routing after payment, and odd amounts ----

// TestREG_BILL_082_PaymentRoutesThePatientOnce: Given routed visit charges, Then a
// one-click checkout queues the patient; paying a routed charge for a patient already
// in today's queue queues nobody twice; a charge marked to_triage queues to triage; a
// zero charge refunds to a zero reversal; an empty batch is refused; and a dentist
// pulling a visit back from the cashier voids its charge.
func TestREG_BILL_082_PaymentRoutesThePatientOnce(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, mgr, doctor := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager"), srv.As(t, clinic, "doctor")
	queued := func(p patientRef) (n int, stage string) {
		one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1`, &n, blPatientUUID(t, p))
		if n > 0 {
			one(t, `SELECT min(stage) FROM queue_entries WHERE patient_id=$1`, &stage, blPatientUUID(t, p))
		}
		return
	}
	routed := func(p patientRef, toTriage bool) string {
		var out struct {
			ID string `json:"id"`
		}
		recp.Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "description": "Exam", "amount": 250,
			"branch_id": payBranch(t, clinic), "department_id": blDept(clinic), "to_triage": toTriage}).Expect(t, 201, "routed charge").Decode(t, &out)
		return out.ID
	}

	p1 := createPatient(t, recp, uniq("Checkout"), "Routed")
	recp.Do("POST", "/billing/charges/batch", map[string]any{"patient_id": p1.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic),
		"items": []map[string]any{{"description": "Registration", "amount": 100}, {"description": "Exam", "amount": 200}}}).Expect(t, 201, "batch")
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p1.ID, "method": "cash"}).Expect(t, 200, "checkout")
	if n, stage := queued(p1); n != 1 || stage != "with_doctor" {
		t.Fatalf("checkout of a routed visit queued the patient %d times (%s), want once with_doctor", n, stage)
	}

	p2 := createPatient(t, recp, uniq("Already"), "Queued")
	blExec(t, `INSERT INTO queue_entries (tenant_id, branch_id, department_id, patient_id) VALUES ($1,$2,$3,$4)`,
		clinic.TenantID, clinic.BranchID, clinic.DeptID, blPatientUUID(t, p2))
	paySettle(cashier, routed(p2, false)).Expect(t, 204, "settle for a queued patient")
	if n, _ := queued(p2); n != 1 {
		t.Fatalf("paying for a patient already in the queue left %d entries, want 1", n)
	}

	p3 := createPatient(t, recp, uniq("Triage"), "First")
	paySettle(cashier, routed(p3, true)).Expect(t, 204, "settle to-triage charge")
	if n, stage := queued(p3); n != 1 || stage != "triage" {
		t.Fatalf("a to_triage charge queued %d (%s), want once to triage", n, stage)
	}

	zero := payRaise(t, cashier, clinic, p3.ID, 0)
	paySettle(cashier, zero).Expect(t, 204, "settle a zero charge")
	mgr.Do("POST", "/billing/charges/"+zero+"/refund", map[string]any{"reason": "nothing to refund"}).Expect(t, 204, "refund a zero charge")
	var amt string
	one(t, `SELECT amount::text FROM charges WHERE reverses_charge_id=$1`, &amt, blUUID(t, id.PrefixCharge, zero))
	if !payEq(payNum(t, amt), 0) {
		t.Fatalf("zero charge refunded as %s, want 0", amt)
	}
	blExpect(t, recp.Do("POST", "/billing/charges/batch", map[string]any{"patient_id": p3.ID, "branch_id": payBranch(t, clinic),
		"department_id": blDept(clinic), "items": []map[string]any{}}), 400, "VALIDATION_FAILED", "empty batch")

	p4 := createPatient(t, recp, uniq("Pull"), "Back")
	plan := createPlan(t, doctor, p4.ID, "800", 1, "")
	payDone(t, doctor, p4.ID, plan.Sessions[0].ID)
	payCollect(t, doctor, p4.ID, plan.Sessions[0].ID)
	ch := payOnePending(t, cashier, p4.ID, 800)
	doctor.Do("POST", "/dental/patients/"+p4.ID+"/sessions/"+plan.Sessions[0].ID+"/uncollect", map[string]any{"reason": "wrong tooth"}).
		Expect(t, 204, "uncollect")
	var st string
	one(t, `SELECT status || '|' || coalesce(void_reason,'') FROM charges WHERE id=$1`, &st, blUUID(t, id.PrefixCharge, ch.ID))
	if st != "void|pulled back from the cashier: wrong tooth" || len(payPendingFor(t, cashier, p4.ID)) != 0 {
		t.Fatalf("pulled-back charge reads %q, want void with the reason and off the worklist", st)
	}
	payExpectBal(t, payBalance(t, cashier, p4.ID), 800, 0, 800, 0, "after pulling the bill back")
}

// TestREG_BILL_090_AFailedWriteTakesNoMoney: Given the clinic's event log refuses
// writes (a database failure mid-transaction), Then every money write — raise, batch,
// settle, checkout, waive, void, defer, refund, receipt refund, day close, card fee,
// intake — answers 500 INTERNAL_ERROR and leaves nothing half-done: no new charge, no
// status change, no receipt, no reversal, no closeout. Once the fault clears, the same
// settle succeeds.
func TestREG_BILL_090_AFailedWriteTakesNoMoney(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, mgr := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	svc := blService(t, mgr, "Registration", "general", 200, "")
	mgr.Do("PUT", "/billing/services/"+svc+"/default", map[string]any{"is_default": true}).Expect(t, 204, "default")
	p := createPatient(t, recp, uniq("Fault"), "Tolerant")
	walkIn := createPatient(t, recp, uniq("Fault"), "WalkIn")
	pending := payRaise(t, cashier, clinic, p.ID, 300)
	paid := payRaise(t, cashier, clinic, p.ID, 200)
	paySettle(cashier, paid).Expect(t, 204, "settle")
	receipt := blReceipt(t, paid)

	fn := "regress_fail_" + strings.ReplaceAll(clinic.TenantID.String(), "-", "")
	blExec(t, `CREATE FUNCTION `+fn+`() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`)
	blExec(t, `CREATE TRIGGER `+fn+` BEFORE INSERT ON event_outbox FOR EACH ROW
	           WHEN (NEW.tenant_id = '`+clinic.TenantID.String()+`'::uuid) EXECUTE FUNCTION `+fn+`()`)
	cleared := false
	clear := func() {
		if !cleared {
			cleared = true
			blExecBg(t, `DROP TRIGGER IF EXISTS `+fn+` ON event_outbox`)
			blExecBg(t, `DROP FUNCTION IF EXISTS `+fn+`()`)
		}
	}
	t.Cleanup(clear)

	snapshot := func() string {
		var s string
		one(t, `SELECT (SELECT count(*) FROM charges WHERE tenant_id=$1)::text || '/' ||
		               (SELECT count(*) FROM charges WHERE tenant_id=$1 AND status='paid')::text || '/' ||
		               (SELECT count(*) FROM charges WHERE tenant_id=$1 AND deferred_at IS NOT NULL)::text || '/' ||
		               (SELECT coalesce(max(receipt_no),0) FROM charges WHERE tenant_id=$1)::text || '/' ||
		               (SELECT count(*) FROM cash_reconciliations WHERE tenant_id=$1)::text || '/' ||
		               (SELECT count(*) FROM card_payments WHERE tenant_id=$1)::text || '/' ||
		               (SELECT count(*) FROM queue_entries WHERE tenant_id=$1)::text`, &s, clinic.TenantID)
		return s
	}
	before := snapshot()
	writes := []struct {
		c    *testkit.Client
		m, p string
		body any
	}{
		{recp, "POST", "/billing/charges", map[string]any{"patient_id": p.ID, "description": "x", "amount": 5}},
		{recp, "POST", "/billing/charges/batch", map[string]any{"patient_id": walkIn.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic),
			"items": []map[string]any{{"description": "x", "amount": 5}}}},
		{cashier, "POST", "/billing/charges/" + pending + "/settle", map[string]any{"method": "cash"}},
		{cashier, "POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "method": "cash"}},
		{cashier, "POST", "/billing/charges/" + pending + "/waive", map[string]any{"reason": "Other"}},
		{cashier, "POST", "/billing/charges/" + pending + "/void", map[string]any{"reason": "x"}},
		{cashier, "POST", "/billing/patients/" + p.ID + "/defer", map[string]any{"reason": "x"}},
		{mgr, "POST", "/billing/charges/" + paid + "/refund", map[string]any{"reason": "x"}},
		{mgr, "POST", "/billing/refund-visit", map[string]any{"receipt_no": receipt, "reason": "x"}},
		{cashier, "POST", "/billing/day-close", map[string]any{"counted": 200}},
		{cashier, "POST", "/billing/card/collect", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic)}},
		{recp, "POST", "/queue/walk-in", map[string]any{"patient_id": walkIn.ID, "department_id": blDept(clinic)}},
	}
	for _, w := range writes {
		blExpect(t, w.c.Do(w.m, w.p, w.body), 500, "INTERNAL_ERROR", w.m+" "+w.p+" with the database failing")
		if after := snapshot(); after != before {
			t.Fatalf("%s %s failed but changed money state: %s → %s (charges/paid/deferred/max receipt/closes/card/queue)", w.m, w.p, before, after)
		}
	}
	clear()
	paySettle(cashier, pending).Expect(t, 204, "settle once the fault clears")
	if n := blReceipt(t, pending); n != receipt+1 {
		t.Fatalf("receipt after the failed attempts is %d, want %d (failures consume no numbers)", n, receipt+1)
	}
}

// ---- receivables ageing and labels ----

// TestREG_FIN_015_ReceivablesAgeingBuckets: Given four patients owing 100 for 45 days,
// 150 for 65, 200 for 100 and 300 today plus 1,000 of treatment delivered 20 days ago
// and never billed (and one owing 0), Then receivables lists them oldest first in the
// 31-60 / 61-90 / 90+ / 0-30 buckets, splits 1,000 unbilled from 750 at the cashier,
// labels the mixed one "cashier + unbilled treatment", and the overview's overdue
// alert counts two patients.
func TestREG_FIN_015_ReceivablesAgeingBuckets(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, doctor, owner := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "doctor"), srv.As(t, clinic, "owner")
	aged := func(amount float64, days int) patientRef {
		p := createPatient(t, recp, uniq("Aged"), fmt.Sprint(days))
		cid := payRaise(t, cashier, clinic, p.ID, amount)
		blExec(t, `UPDATE charges SET created_at = now() - make_interval(days => $2) WHERE id = $1`, blUUID(t, id.PrefixCharge, cid), days)
		return p
	}
	a45, a65, a100 := aged(100, 45), aged(150, 65), aged(200, 100)
	paySettle(cashier, payRaise(t, cashier, clinic, a100.ID, 50)).Expect(t, 204, "a past payment")
	mixed := aged(300, 0)
	plan := createPlan(t, doctor, mixed.ID, "1000", 1, "")
	payDone(t, doctor, mixed.ID, plan.Sessions[0].ID)
	blExec(t, `UPDATE treatment_sessions SET completed_at = now() - interval '20 days' WHERE id = $1`, blUUID(t, id.PrefixTreatmentSession, plan.Sessions[0].ID))
	aged(0, 3)

	var rec struct {
		Total     string `json:"total"`
		AtCashier string `json:"at_cashier"`
		Unbilled  string `json:"unbilled"`
		Count     int    `json:"count"`
		Buckets   []struct {
			Key    string `json:"key"`
			Amount string `json:"amount"`
			Count  int    `json:"count"`
		} `json:"buckets"`
		Rows []struct {
			ID         string `json:"id"`
			Owed       string `json:"owed"`
			OldestDays int    `json:"oldest_days"`
			Bucket     string `json:"bucket"`
			Why        string `json:"why"`
			LastPaid   string `json:"last_paid"`
		} `json:"rows"`
	}
	owner.Do("GET", "/finance/receivables", nil).Expect(t, 200, "receivables").Decode(t, &rec)
	if !payEq(payNum(t, rec.Total), 1750) || !payEq(payNum(t, rec.Unbilled), 1000) || !payEq(payNum(t, rec.AtCashier), 750) || rec.Count != 4 {
		t.Fatalf("receivables total=%s unbilled=%s at_cashier=%s count=%d; want 1750 / 1000 / 750 / 4", rec.Total, rec.Unbilled, rec.AtCashier, rec.Count)
	}
	order := []string{}
	for _, r := range rec.Rows {
		order = append(order, r.ID+":"+r.Bucket)
	}
	want := []string{a100.ID + ":90+", a65.ID + ":61-90", a45.ID + ":31-60", mixed.ID + ":0-30"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("receivables rows %v, want oldest first %v", order, want)
	}
	last := rec.Rows[3]
	if last.Why != "cashier + unbilled treatment" || !payEq(payNum(t, last.Owed), 1300) || last.OldestDays < 19 {
		t.Fatalf("mixed patient row %+v, want 1300, cashier + unbilled, aged by the 20-day-old treatment", last)
	}
	if rec.Rows[0].LastPaid == "" {
		t.Fatalf("patient with a past payment shows no last_paid")
	}
	for _, b := range rec.Buckets {
		if b.Count != 1 {
			t.Fatalf("bucket %s holds %d patients, want 1 each: %+v", b.Key, b.Count, rec.Buckets)
		}
	}
	var o struct {
		Attention []struct {
			Kind string `json:"kind"`
			Text string `json:"text"`
		} `json:"attention"`
	}
	owner.Do("GET", "/finance/overview", nil).Expect(t, 200, "overview").Decode(t, &o)
	texts := map[string]string{}
	for _, a := range o.Attention {
		texts[a.Kind] = a.Text
	}
	if texts["overdue"] != "2 patients have owed for over 60 days" || texts["unbilled"] != "1 treated visit not sent to the cashier" {
		t.Fatalf("overview alerts %v", texts)
	}
}

// TestREG_FIN_016_SourcesAndMethodsAreNamed: Given payments from every source and by
// every method (including one with no method recorded and one with no branch), Then
// the overview names them as the owner reads them and the cash tab labels the
// unrecorded method and the missing branch instead of showing a blank.
func TestREG_FIN_016_SourcesAndMethodsAreNamed(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, owner := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, recp, uniq("Labels"), "All")
	pay := func(source, method string) string {
		var out struct {
			ID string `json:"id"`
		}
		cashier.Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "source": source, "description": source, "amount": 10,
			"branch_id": payBranch(t, clinic)}).Expect(t, 201, "raise "+source).Decode(t, &out)
		cashier.Do("POST", "/billing/charges/"+out.ID+"/settle", map[string]any{"method": method}).Expect(t, 204, "settle "+source)
		return out.ID
	}
	pay("consultation", "telebirr")
	pay("lab", "bank")
	pay("pharmacy", "card")
	pay("bed", "cash")
	pay("other", "chapa")
	blank := pay("service", "cash")
	blExec(t, `UPDATE charges SET payment_method = NULL, branch_id = NULL WHERE id = $1`, blUUID(t, id.PrefixCharge, blank))

	var o struct {
		BySource []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
		} `json:"by_source"`
		ByMethod []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
		} `json:"by_method"`
	}
	owner.Do("GET", "/finance/overview", nil).Expect(t, 200, "overview").Decode(t, &o)
	got := map[string]string{}
	for _, l := range o.BySource {
		got["s:"+l.Key] = l.Label
	}
	for _, l := range o.ByMethod {
		got["m:"+l.Key] = l.Label
	}
	want := map[string]string{
		"s:consultation": "Consultation", "s:lab": "Laboratory", "s:pharmacy": "Pharmacy", "s:bed": "Inpatient", "s:other": "Other", "s:service": "Services",
		"m:telebirr": "telebirr", "m:bank": "Bank transfer", "m:card": "Card", "m:cash": "Cash", "m:chapa": "chapa", "m:": "Not recorded",
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("label %s = %q, want %q (all: %v)", k, got[k], v, got)
		}
	}
	var cv struct {
		ByMethod []struct {
			Label string `json:"label"`
		} `json:"by_method"`
		ByBranch []struct {
			Label string `json:"label"`
		} `json:"by_branch"`
	}
	owner.Do("GET", "/finance/cash", nil).Expect(t, 200, "cash tab").Decode(t, &cv)
	labels := []string{}
	for _, l := range append(cv.ByMethod, cv.ByBranch...) {
		labels = append(labels, l.Label)
	}
	all := strings.Join(labels, "|")
	if !strings.Contains(all, "not recorded") || !strings.Contains(all, "no branch") {
		t.Fatalf("cash tab labels %v, want 'not recorded' and 'no branch' for the blank method and branch", labels)
	}
}

// ---- fault injection, scoped to one test clinic ----

// blExecBg is blExec for cleanups, which run after the test's context is cancelled.
func blExecBg(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := super.Pool.Exec(context.Background(), q, args...); err != nil {
		t.Errorf("%v\n%s", err, q)
	}
}

// blFailWrites makes INSERT/UPDATE on table fail for this clinic only (a trigger
// keyed on its tenant_id), until the returned func (also run at cleanup) clears it.
func blFailWrites(t *testing.T, clinic *testkit.Clinic, table string) func() {
	t.Helper()
	name := "regress_fw_" + table + "_" + strings.ReplaceAll(clinic.TenantID.String(), "-", "")[:12]
	blExec(t, `CREATE OR REPLACE FUNCTION `+name+`() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`)
	blExec(t, `CREATE TRIGGER `+name+` BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW
	           WHEN (NEW.tenant_id = '`+clinic.TenantID.String()+`'::uuid) EXECUTE FUNCTION `+name+`()`)
	done := false
	clear := func() {
		if !done {
			done = true
			blExecBg(t, `DROP TRIGGER IF EXISTS `+name+` ON `+table)
			blExecBg(t, `DROP FUNCTION IF EXISTS `+name+`()`)
		}
	}
	t.Cleanup(clear)
	return clear
}

// blFailReads makes every read of table fail for this clinic only (a restrictive
// row-level policy whose check raises for its tenant_id; other tenants are untouched).
func blFailReads(t *testing.T, clinic *testkit.Clinic, table string) func() {
	t.Helper()
	tid := clinic.TenantID.String()
	name := "regress_fr_" + table + "_" + strings.ReplaceAll(tid, "-", "")[:12]
	blExec(t, `CREATE OR REPLACE FUNCTION `+name+`(t uuid) RETURNS boolean LANGUAGE plpgsql AS $$
	           BEGIN IF t = '`+tid+`'::uuid THEN RAISE EXCEPTION 'injected read failure'; END IF; RETURN true; END $$`)
	blExec(t, `CREATE POLICY `+name+` ON `+table+` AS RESTRICTIVE USING (`+name+`(tenant_id))`)
	done := false
	clear := func() {
		if !done {
			done = true
			blExecBg(t, `DROP POLICY IF EXISTS `+name+` ON `+table)
			blExecBg(t, `DROP FUNCTION IF EXISTS `+name+`(uuid)`)
		}
	}
	t.Cleanup(clear)
	return clear
}

// TestREG_BILL_091_EachStepOfTakingMoneyIsAtomic: Given a failure at each table a
// payment touches — the receipt counter, the queue, the reference register, the day
// close, the charge itself, the provider list — Then the request is a 500 and the
// money is exactly as before: the charge still pending with no receipt, no reversal,
// no closeout, nobody admitted for a payment that did not happen.
func TestREG_BILL_091_EachStepOfTakingMoneyIsAtomic(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, mgr := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	rails := blRails(t, cashier)
	p := createPatient(t, recp, uniq("Atomic"), "Pay")
	pending := payRaise(t, cashier, clinic, p.ID, 300)
	paid := payRaise(t, cashier, clinic, p.ID, 200)
	paySettle(cashier, paid).Expect(t, 204, "settle")
	receipt := blReceipt(t, paid)
	var routed struct {
		ID string `json:"id"`
	}
	recp.Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "description": "Exam", "amount": 250,
		"branch_id": payBranch(t, clinic), "department_id": blDept(clinic)}).Expect(t, 201, "routed").Decode(t, &routed)
	svc := blService(t, mgr, "Scaling", "dental", 500, "")
	fail := func(r testkit.Resp, what string) { t.Helper(); blExpect(t, r, 500, "INTERNAL_ERROR", what) }
	unchanged := func(what string) {
		t.Helper()
		var n int
		one(t, `SELECT count(*) FROM charges WHERE tenant_id=$1 AND (status='paid' AND id <> $2) OR reverses_charge_id IS NOT NULL AND tenant_id=$1`,
			&n, clinic.TenantID, blUUID(t, id.PrefixCharge, paid))
		if n != 0 || blStatus(t, pending) != "pending" || blStatus(t, routed.ID) != "pending" {
			t.Fatalf("%s: a failed request changed money (%d new paid/reversal rows, pending=%s routed=%s)",
				what, n, blStatus(t, pending), blStatus(t, routed.ID))
		}
	}

	clear := blFailWrites(t, clinic, "billing_counters")
	fail(paySettle(cashier, pending), "settle with the receipt counter failing")
	fail(cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID}), "checkout with the receipt counter failing")
	fail(mgr.Do("POST", "/billing/charges/"+paid+"/refund", map[string]any{"reason": "x"}), "refund with the receipt counter failing")
	fail(mgr.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": receipt, "reason": "x"}), "receipt refund with the counter failing")
	unchanged("receipt counter")
	clear()

	clear = blFailWrites(t, clinic, "queue_entries")
	fail(paySettle(cashier, routed.ID), "settle a routed visit with the queue failing")
	fail(cashier.Do("POST", "/billing/charges/"+routed.ID+"/waive", map[string]any{"reason": "Other"}), "waive a routed visit with the queue failing")
	fail(cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "x", "charge_ids": []string{routed.ID}}), "defer with the queue failing")
	fail(cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "charge_ids": []string{routed.ID}}), "checkout with the queue failing")
	unchanged("queue")
	clear()

	clear = blFailWrites(t, clinic, "payment_references")
	fail(cashier.Do("POST", "/billing/charges/"+pending+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": "FT" + uniq("")}), "settle with the reference register failing")
	unchanged("reference register")
	clear()

	clear = blFailWrites(t, clinic, "cash_reconciliations")
	fail(cashier.Do("POST", "/billing/day-close", map[string]any{"counted": 200}), "close the day with closeouts failing")
	clear()

	clear = blFailWrites(t, clinic, "charges")
	fail(recp.Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "description": "x", "amount": 1}), "raise with charges failing")
	clear()

	clear = blFailWrites(t, clinic, "card_payments")
	fail(cashier.Do("POST", "/billing/card/collect", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic)}), "card fee with card_payments failing")
	clear()

	clear = blFailWrites(t, clinic, "service_providers")
	fail(mgr.Do("PUT", "/billing/services/"+svc+"/providers", map[string]any{"user_ids": []string{blUser(clinic.Staff["doctor"])}}), "set providers failing")
	clear()

	var n int
	one(t, `SELECT count(*) FROM cash_reconciliations WHERE tenant_id=$1`, &n, clinic.TenantID)
	if n != 0 {
		t.Fatalf("a failed day close stored %d closeouts", n)
	}
	paySettle(cashier, pending).Expect(t, 204, "settle once the faults clear")
	if got := blReceipt(t, pending); got != receipt+1 {
		t.Fatalf("receipt after failed attempts %d, want %d", got, receipt+1)
	}
}

// TestREG_FIN_017_AFailedReadIsAnErrorNotZero: Given the clinic's charges cannot be
// read (a database failure), Then every money view — the cashier's worklist, ledger,
// paid list, cash summary, day close, day list, every finance tab and the takings chart
// — answers 500, never a page of zeros the owner would believe.
func TestREG_FIN_017_AFailedReadIsAnErrorNotZero(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Read"), "Fail")
	paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 100)).Expect(t, 204, "settle")
	payRaise(t, cashier, clinic, p.ID, 40) // rows to read: a policy check runs per row it reads
	cashier.Do("POST", "/billing/day-close", map[string]any{"counted": 100}).Expect(t, 200, "close")
	blService(t, mgr, "Scaling", "dental", 500, "")
	cashier.Do("POST", "/billing/card/collect", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic)}).Expect(t, 201, "card fee")
	clear := blFailReads(t, clinic, "charges")
	for _, r := range []struct {
		c    *testkit.Client
		path string
	}{
		{cashier, "/billing/charges/pending"}, {cashier, "/billing/charges?patient=" + p.ID}, {cashier, "/billing/payments"},
		{mgr, "/billing/cash"}, {cashier, "/billing/day-close"}, {cashier, "/billing/day-closes"},
		{owner, "/finance/overview"}, {owner, "/finance/receivables"}, {owner, "/finance/cash"}, {owner, "/finance/services"},
		{owner, "/dashboard/takings?days=7"},
	} {
		blExpect(t, r.c.Do("GET", r.path, nil), 500, "INTERNAL_ERROR", r.path+" with charges unreadable")
	}
	clear()
	clear = blFailReads(t, clinic, "cash_reconciliations")
	blExpect(t, cashier.Do("GET", "/billing/reconciliations", nil), 500, "INTERNAL_ERROR", "reconciliations unreadable")
	clear()
	clear = blFailReads(t, clinic, "service_items")
	blExpect(t, cashier.Do("GET", "/billing/services", nil), 500, "INTERNAL_ERROR", "catalogue unreadable")
	clear()
	clear = blFailReads(t, clinic, "card_payments")
	blExpect(t, cashier.Do("GET", "/billing/card/history?patient="+p.ID, nil), 500, "INTERNAL_ERROR", "card history unreadable")
	clear()
	owner.Do("GET", "/finance/overview", nil).Expect(t, 200, "overview once readable again")
}

// TestREG_FIN_018_DentalMoneyFailureIsReported (FIN-12): Given 300 at the cashier and a
// delivered, unbilled 1,000 dental visit, When the dental money query fails, Then
// Finance must answer with an error — not report 300 owed as if the 1,000 did not exist.
func TestREG_FIN_018_DentalMoneyFailureIsReported(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Dental"), "Fail")
	payRaise(t, cashier, clinic, p.ID, 300)
	plan := createPlan(t, doctor, p.ID, "1000", 1, "")
	payDone(t, doctor, p.ID, plan.Sessions[0].ID)
	if got := payGetReceivables(t, owner); !payEq(payNum(t, got.Total), 1300) {
		t.Fatalf("receivables before the fault %s, want 1300", got.Total)
	}
	clear := blFailReads(t, clinic, "treatment_sessions")
	r := owner.Do("GET", "/finance/receivables", nil)
	var rec payReceivables
	if r.Status == 200 {
		r.Decode(t, &rec)
	}
	clear()
	if r.Status == 200 && payEq(payNum(t, rec.Total), 300) {
		testkit.KnownBug(t, "FIN-12", true,
			"with the dental money query failing, /finance/receivables answered 200 with 300 owed instead of an error (the unbilled 1,000 silently dropped; finance/service/service.go:415)")
	}
	blExpect(t, r, 500, "INTERNAL_ERROR", "receivables with dental money unreadable")
	testkit.KnownBug(t, "FIN-12", false, "a failed dental money query is reported as an error")
}
