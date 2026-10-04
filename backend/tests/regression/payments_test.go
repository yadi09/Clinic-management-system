package regression

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Payments and balances, through the HTTP API, as the desk and the chair use them.
//
// The money rules these tests hold the app to (read from the code, not invented):
//   - A treatment visit is owed once it is DONE; a deposit is owed from the day the
//     course is agreed (dental.SessionMoneySQL owed_now).
//   - "Collect" on a session raises ONE pending charge at the cashier. While it is
//     there the session is `at_cashier`, deliberately NOT part of `due`.
//   - The cashier settles a charge (POST /billing/charges/:id/settle) or a whole
//     visit (POST /billing/checkout); either stamps a receipt number.
//   - A refund is a separate negative `refund` row reversing the original, which
//     stays 'paid'. The refunded treatment is owed again.
//   - There is NO part-payment of a single charge (audit FIN-8): a charge is paid in
//     full or not at all. "Instalments" are modelled as a course split into visits
//     (plus an optional deposit), each its own charge — so that is what we test.
//
// Every money test runs in its own clinic so the totals it asserts are exact.

// ---- helpers (pay-prefixed: other files in this package are written concurrently) ----

func payNum(t *testing.T, s string) float64 {
	t.Helper()
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		t.Fatalf("not a money amount: %q", s)
	}
	return f
}

func payEq(a, b float64) bool { return math.Abs(a-b) < 0.005 }

type payBal struct {
	Owed      string `json:"owed"`
	Paid      string `json:"paid"`
	Balance   string `json:"balance"`
	Due       string `json:"due"`
	AtCashier string `json:"at_cashier"`
	Waived    string `json:"waived"`
}

// payBalance is the patient's dental balance as the summary reports it.
func payBalance(t *testing.T, c *testkit.Client, patientID string) payBal {
	t.Helper()
	s := summary(t, c, patientID)
	var b payBal
	if err := json.Unmarshal(s["balance"], &b); err != nil {
		t.Fatalf("summary balance: %v (%s)", err, s["balance"])
	}
	return b
}

// payExpectBal checks the money fields that matter for a test (owed, paid, due, at_cashier).
func payExpectBal(t *testing.T, b payBal, owed, paid, due, atCashier float64, when string) {
	t.Helper()
	if !payEq(payNum(t, b.Owed), owed) || !payEq(payNum(t, b.Paid), paid) ||
		!payEq(payNum(t, b.Due), due) || !payEq(payNum(t, b.AtCashier), atCashier) {
		t.Fatalf("%s: balance owed=%s paid=%s due=%s at_cashier=%s; want owed=%.2f paid=%.2f due=%.2f at_cashier=%.2f",
			when, b.Owed, b.Paid, b.Due, b.AtCashier, owed, paid, due, atCashier)
	}
}

type payPendingRow struct {
	ID        string `json:"id"`
	PatientID string `json:"patient_id"`
	Source    string `json:"source"`
	Amount    string `json:"amount"`
}

// payPendingFor is the cashier worklist, narrowed to one patient.
func payPendingFor(t *testing.T, cashier *testkit.Client, patientID string) []payPendingRow {
	t.Helper()
	var all []payPendingRow
	cashier.Do("GET", "/billing/charges/pending", nil).Expect(t, 200, "pending charges").Decode(t, &all)
	out := []payPendingRow{}
	for _, r := range all {
		if r.PatientID == patientID {
			out = append(out, r)
		}
	}
	return out
}

// payOnePending asserts exactly one pending charge of `amount` for the patient and returns it.
func payOnePending(t *testing.T, cashier *testkit.Client, patientID string, amount float64) payPendingRow {
	t.Helper()
	rows := payPendingFor(t, cashier, patientID)
	if len(rows) != 1 || !payEq(payNum(t, rows[0].Amount), amount) {
		t.Fatalf("want one pending charge of %.2f for the patient, got %+v", amount, rows)
	}
	return rows[0]
}

// payDone marks a planned visit as delivered (the dentist's act that makes it owed).
func payDone(t *testing.T, doctor *testkit.Client, patientID, sessionID string) {
	t.Helper()
	doctor.Do("PUT", "/dental/patients/"+patientID+"/sessions/"+sessionID,
		map[string]any{"status": "done", "notes": "treated"}).Expect(t, 204, "mark visit done")
}

// payCollect sends a session's fee to the cashier.
func payCollect(t *testing.T, c *testkit.Client, patientID, sessionID string) {
	t.Helper()
	c.Do("POST", "/dental/patients/"+patientID+"/sessions/"+sessionID+"/collect", nil).
		Expect(t, 204, "collect session")
}

func paySettle(c *testkit.Client, chargeID string) testkit.Resp {
	return c.Do("POST", "/billing/charges/"+chargeID+"/settle", map[string]any{"method": "cash"})
}

// payRaise puts a plain (non-dental) charge on the cashier's queue; returns its id.
func payRaise(t *testing.T, c *testkit.Client, clinic *testkit.Clinic, patientID string, amount float64) string {
	t.Helper()
	r := c.Do("POST", "/billing/charges", map[string]any{
		"patient_id": patientID, "source": "service", "description": uniq("Service "), "amount": amount,
		"branch_id": payBranch(t, clinic),
	}).Expect(t, 201, "raise charge")
	var out struct {
		ID string `json:"id"`
	}
	r.Decode(t, &out)
	return out.ID
}

// payBranch is the clinic's branch as the API spells it.
func payBranch(t *testing.T, clinic *testkit.Clinic) string {
	t.Helper()
	return id.Encode(id.PrefixBranch, clinic.BranchID)
}

// payChargeUUID turns a prefixed charge id into the row's uuid for DB assertions.
func payChargeUUID(t *testing.T, _ *testkit.Clinic, chargeID string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(id.PrefixCharge, chargeID)
	if err != nil {
		t.Fatalf("charge id %q: %v", chargeID, err)
	}
	return u
}

type payReceivables struct {
	Total     string `json:"total"`
	AtCashier string `json:"at_cashier"`
	Unbilled  string `json:"unbilled"`
	Count     int    `json:"count"`
	Rows      []struct {
		ID   string `json:"id"`
		Owed string `json:"owed"`
		Why  string `json:"why"`
	} `json:"rows"`
}

func payGetReceivables(t *testing.T, owner *testkit.Client) payReceivables {
	t.Helper()
	var r payReceivables
	owner.Do("GET", "/finance/receivables", nil).Expect(t, 200, "finance receivables").Decode(t, &r)
	return r
}

// payOwedIn is what receivables says the patient owes ("" when not listed).
func payOwedIn(r payReceivables, patientID string) string {
	for _, row := range r.Rows {
		if row.ID == patientID {
			return row.Owed
		}
	}
	return ""
}

type payOverview struct {
	Collected      string `json:"collected"`
	CollectedCount int    `json:"collected_count"`
	Refunded       string `json:"refunded"`
	Waived         string `json:"waived"`
	Outstanding    string `json:"outstanding"`
}

func payGetOverview(t *testing.T, owner *testkit.Client, query string) payOverview {
	t.Helper()
	var o payOverview
	owner.Do("GET", "/finance/overview"+query, nil).Expect(t, 200, "finance overview").Decode(t, &o)
	return o
}

type payDashMoney struct {
	CollectedToday string `json:"collected_today"`
	Owed           string `json:"owed"`
	OwedAtCashier  string `json:"owed_at_cashier"`
	OwedUnbilled   string `json:"owed_unbilled"`
	OwedPatients   int    `json:"owed_patients"`
}

func payDashboard(t *testing.T, c *testkit.Client) payDashMoney {
	t.Helper()
	var d struct {
		Money *payDashMoney `json:"money"`
	}
	c.Do("GET", "/dashboard/today", nil).Expect(t, 200, "dashboard today").Decode(t, &d)
	if d.Money == nil {
		t.Fatalf("dashboard returned no money section for a user who may see money")
	}
	return *d.Money
}

// payAddisToday is today's date in the clinic's timezone.
func payAddisToday() string { return time.Now().In(addisLoc()).Format("2006-01-02") }

// addisLoc is the clinic's time zone. Every "today" a test computes must come from
// it: the test host and the database run in UTC, three hours behind.
func addisLoc() *time.Location {
	loc, err := time.LoadLocation("Africa/Addis_Ababa")
	if err != nil {
		loc = time.FixedZone("EAT", 3*3600)
	}
	return loc
}

// addisAt is h:m Addis time on the clinic's day dayOffset days from today. A row
// stamped 00:30 Addis today sits on yesterday's date in UTC at every hour, so a
// product query that buckets days in UTC fails whenever the suite runs, not only at
// night (the way TestREG_PAY_011 and TestREG_BILL_096 catch it).
func addisAt(dayOffset, h, m int) time.Time {
	now := time.Now().In(addisLoc())
	return time.Date(now.Year(), now.Month(), now.Day()+dayOffset, h, m, 0, 0, addisLoc())
}

// payPaidVisit is the standard arrangement: a 1-visit course of `fee`, done,
// collected and settled in cash. Returns the patient and the settled charge.
func payPaidVisit(t *testing.T, clinic *testkit.Clinic, doctor, cashier *testkit.Client, fee string) (patientRef, string) {
	t.Helper()
	p := createPatient(t, doctor2Receptionist(t, clinic), uniq("Pay"), "Patient")
	plan := createPlan(t, doctor, p.ID, fee, 1, "")
	payDone(t, doctor, p.ID, plan.Sessions[0].ID)
	payCollect(t, doctor, p.ID, plan.Sessions[0].ID)
	ch := payOnePending(t, cashier, p.ID, payNum(t, fee))
	paySettle(cashier, ch.ID).Expect(t, 204, "settle")
	return p, ch.ID
}

// doctor2Receptionist registers patients the way a clinic does: at the front desk.
func doctor2Receptionist(t *testing.T, clinic *testkit.Clinic) *testkit.Client {
	t.Helper()
	return srv.As(t, clinic, "receptionist")
}

// payClinic is a private dental clinic on the Practice plan, which includes the
// finance dashboard and aged debt (/finance/receivables is gated on debt_ageing).
func payClinic(t *testing.T) *testkit.Clinic {
	t.Helper()
	return testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-practice"})
}

// ---- tests ----

// TestREG_PAY_001_VisitPaidInFull: Given a 1-visit course of 1,000 that the dentist
// has delivered, When the dentist sends it to the cashier and the cashier settles the
// charge in cash, Then the charge is paid with a receipt number, the patient's due is
// 0 (and was 1,000 before), and Finance no longer lists them as owing.
func TestREG_PAY_001_VisitPaidInFull(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Abebe"), "Kebede")
	plan := createPlan(t, doctor, p.ID, "1000", 1, "")
	sid := plan.Sessions[0].ID

	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 0, 0, 0, "planned, not yet done")
	payDone(t, doctor, p.ID, sid)
	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 0, 1000, 0, "done, not yet billed")
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); !payEq(payNum(t, got), 1000) {
		t.Fatalf("receivables before billing: owed %q, want 1000 (treated, not billed)", got)
	}

	payCollect(t, doctor, p.ID, sid)
	ch := payOnePending(t, cashier, p.ID, 1000)
	if ch.Source != "dental" {
		t.Fatalf("collected charge source %q, want dental", ch.Source)
	}
	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 0, 0, 1000, "at the cashier")

	paySettle(cashier, ch.ID).Expect(t, 204, "settle")

	var status string
	var receipt *int64
	uid := payChargeUUID(t, clinic, ch.ID)
	one(t, `SELECT status FROM charges WHERE id = $1`, &status, uid)
	one(t, `SELECT receipt_no FROM charges WHERE id = $1`, &receipt, uid)
	if status != "paid" || receipt == nil || *receipt <= 0 {
		t.Fatalf("after settle: status=%s receipt=%v, want paid with a receipt number", status, receipt)
	}
	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 1000, 0, 0, "after settle")
	if b := payBalance(t, cashier, p.ID); !payEq(payNum(t, b.Balance), 0) {
		t.Fatalf("remaining balance %s, want 0", b.Balance)
	}
	if len(payPendingFor(t, cashier, p.ID)) != 0 {
		t.Fatalf("charge still on the cashier worklist after settle")
	}
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); got != "" {
		t.Fatalf("receivables still lists a paid-up patient as owing %s", got)
	}
}

// TestREG_PAY_002_DepositAndInstalmentVisits: Given a course of 6,500 with a 1,000
// deposit over 5 visits (1,100 each), Then the deposit is owed from day one, paying
// it drops due by 1,000, a delivered visit adds 1,100, and paying that leaves the
// course's remaining balance at 4,400. (No part-payment of one charge exists — FIN-8.)
func TestREG_PAY_002_DepositAndInstalmentVisits(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Hana"), "Girma")
	plan := createPlan(t, doctor, p.ID, "6500", 5, "1000")
	if plan.Deposit == nil || !payEq(payNum(t, plan.Deposit.AmountDue), 1000) {
		t.Fatalf("plan has no 1000 deposit: %+v", plan.Deposit)
	}
	if len(plan.Sessions) != 5 {
		t.Fatalf("want 5 visits, got %d", len(plan.Sessions))
	}
	for _, s := range plan.Sessions {
		if !payEq(payNum(t, s.AmountDue), 1100) {
			t.Fatalf("visit fee %s, want (6500-1000)/5 = 1100", s.AmountDue)
		}
	}

	payExpectBal(t, payBalance(t, cashier, p.ID), 6500, 0, 1000, 0, "course agreed: deposit owed from day one")

	payCollect(t, cashier, p.ID, plan.Deposit.ID)
	dep := payOnePending(t, cashier, p.ID, 1000)
	paySettle(cashier, dep.ID).Expect(t, 204, "settle deposit")
	payExpectBal(t, payBalance(t, cashier, p.ID), 6500, 1000, 0, 0, "deposit paid")

	payDone(t, doctor, p.ID, plan.Sessions[0].ID)
	payExpectBal(t, payBalance(t, cashier, p.ID), 6500, 1000, 1100, 0, "visit 1 delivered")
	payCollect(t, doctor, p.ID, plan.Sessions[0].ID)
	v1 := payOnePending(t, cashier, p.ID, 1100)
	paySettle(cashier, v1.ID).Expect(t, 204, "settle visit 1")

	b := payBalance(t, cashier, p.ID)
	payExpectBal(t, b, 6500, 2100, 0, 0, "deposit + visit 1 paid")
	if !payEq(payNum(t, b.Balance), 4400) {
		t.Fatalf("remaining on the course %s, want 6500-2100 = 4400", b.Balance)
	}
}

// TestREG_PAY_003_PayLaterIsOwedOnReturn: Given a visit delivered with "pay later",
// Then the patient shows as owing it (summary due, Finance "treated, not billed")
// until they return, are collected and settle — then they owe 0.
func TestREG_PAY_003_PayLaterIsOwedOnReturn(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Selam"), "Tadesse")
	plan := createPlan(t, doctor, p.ID, "1000", 1, "")
	sid := plan.Sessions[0].ID

	doctor.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/pay-later",
		map[string]any{"on": true, "note": "will pay Friday"}).Expect(t, 204, "pay later")
	payDone(t, doctor, p.ID, sid)

	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 0, 1000, 0, "treated, pay later")
	rec := payGetReceivables(t, owner)
	if got := payOwedIn(rec, p.ID); !payEq(payNum(t, got), 1000) {
		t.Fatalf("receivables: pay-later patient owes %q, want 1000", got)
	}

	// The patient comes back: the desk sends the visit to the cashier, who settles it.
	payCollect(t, cashier, p.ID, sid)
	ch := payOnePending(t, cashier, p.ID, 1000)
	paySettle(cashier, ch.ID).Expect(t, 204, "settle on return")

	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 1000, 0, 0, "paid on return")
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); got != "" {
		t.Fatalf("receivables still lists the patient after they paid: %s", got)
	}
}

// TestREG_PAY_004_DoubleSettleIsRefused: Given a settled charge, When the cashier
// settles it again (or checks the patient out), Then it is refused as a conflict and
// the database holds exactly one paid charge with one receipt number.
func TestREG_PAY_004_DoubleSettleIsRefused(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	p, chargeID := payPaidVisit(t, clinic, doctor, cashier, "1000")

	r := paySettle(cashier, chargeID)
	if r.Status != 409 || r.Code != "ALREADY_SETTLED" {
		t.Fatalf("second settle: HTTP %d %s, want 409 ALREADY_SETTLED", r.Status, r.Code)
	}
	co := cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "method": "cash"})
	if co.Status != 409 || co.Code != "NOTHING_PENDING" {
		t.Fatalf("checkout of a paid-up patient: HTTP %d %s, want 409 NOTHING_PENDING", co.Status, co.Code)
	}

	var paid, receipts int
	one(t, `SELECT count(*) FROM charges WHERE tenant_id = $1 AND status = 'paid'`, &paid, clinic.TenantID)
	one(t, `SELECT count(DISTINCT receipt_no) FROM charges WHERE tenant_id = $1 AND receipt_no IS NOT NULL`, &receipts, clinic.TenantID)
	if paid != 1 || receipts != 1 {
		t.Fatalf("after a double settle: %d paid charges, %d receipts; want 1 and 1", paid, receipts)
	}
}

// payRace fires n copies of the same request at once and returns their statuses/codes.
func payRace(t *testing.T, clients []*testkit.Client, method, path string, body any) []testkit.Resp {
	t.Helper()
	out := make([]testkit.Resp, len(clients))
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i, c := range clients {
		wg.Add(1)
		go func(i int, c *testkit.Client) {
			defer wg.Done()
			<-start
			out[i] = c.Do(method, path, body)
		}(i, c)
	}
	close(start)
	wg.Wait()
	return out
}

func payCount(rs []testkit.Resp, status int) int {
	n := 0
	for _, r := range rs {
		if r.Status == status {
			n++
		}
	}
	return n
}

func payDescribe(rs []testkit.Resp) string {
	parts := []string{}
	for _, r := range rs {
		parts = append(parts, fmt.Sprintf("%d %s", r.Status, r.Code))
	}
	return strings.Join(parts, ", ")
}

// TestREG_PAY_005_ConcurrentSettleTakesTheMoneyOnce: Given one pending charge, When
// several cashier requests settle it at the same instant (double click, two tills),
// Then exactly one succeeds, the rest are refused, and the DB holds one paid charge
// with one receipt. The same holds for concurrent one-click checkouts.
func TestREG_PAY_005_ConcurrentSettleTakesTheMoneyOnce(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	manager := srv.As(t, clinic, "branch_manager")
	tills := []*testkit.Client{cashier, manager, cashier, manager}

	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Race"), "Settle")
	plan := createPlan(t, doctor, p.ID, "1000", 1, "")
	payDone(t, doctor, p.ID, plan.Sessions[0].ID)
	payCollect(t, doctor, p.ID, plan.Sessions[0].ID)
	ch := payOnePending(t, cashier, p.ID, 1000)

	rs := payRace(t, tills, "POST", "/billing/charges/"+ch.ID+"/settle", map[string]any{"method": "cash"})
	if payCount(rs, 204) != 1 || payCount(rs, 409) != len(rs)-1 {
		t.Fatalf("concurrent settle: want exactly one 204 and the rest 409, got [%s]", payDescribe(rs))
	}
	var paid, withReceipt int
	one(t, `SELECT count(*) FROM charges WHERE tenant_id = $1 AND status = 'paid'`, &paid, clinic.TenantID)
	one(t, `SELECT count(*) FROM charges WHERE tenant_id = $1 AND receipt_no IS NOT NULL`, &withReceipt, clinic.TenantID)
	if paid != 1 || withReceipt != 1 {
		t.Fatalf("concurrent settle left %d paid charges / %d receipts, want 1 / 1", paid, withReceipt)
	}

	// Checkout race: two pending plain charges, four tills press "Checkout" at once.
	p2 := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Race"), "Checkout")
	payRaise(t, cashier, clinic, p2.ID, 300)
	payRaise(t, cashier, clinic, p2.ID, 200)
	rs = payRace(t, tills, "POST", "/billing/checkout", map[string]any{"patient_id": p2.ID, "method": "cash"})
	if payCount(rs, 200) != 1 || payCount(rs, 409) != len(rs)-1 {
		t.Fatalf("concurrent checkout: want exactly one 200 and the rest 409, got [%s]", payDescribe(rs))
	}
	var paid2, receipts2 int
	var total2 string
	one(t, `SELECT count(*) FROM charges c JOIN patients x ON x.id = c.patient_id
	         WHERE c.tenant_id = $1 AND x.mrn = $2 AND c.status = 'paid'`, &paid2, clinic.TenantID, p2.MRN)
	one(t, `SELECT count(DISTINCT c.receipt_no) FROM charges c JOIN patients x ON x.id = c.patient_id
	         WHERE c.tenant_id = $1 AND x.mrn = $2 AND c.receipt_no IS NOT NULL`, &receipts2, clinic.TenantID, p2.MRN)
	one(t, `SELECT coalesce(sum(c.amount),0)::text FROM charges c JOIN patients x ON x.id = c.patient_id
	         WHERE c.tenant_id = $1 AND x.mrn = $2 AND c.status = 'paid'`, &total2, clinic.TenantID, p2.MRN)
	if paid2 != 2 || receipts2 != 1 || !payEq(payNum(t, total2), 500) {
		t.Fatalf("concurrent checkout: %d paid lines on %d receipts totalling %s; want 2 lines, 1 receipt, 500",
			paid2, receipts2, total2)
	}
}

// TestREG_PAY_006_RefundPostsOneReversal: Given a settled 1,000 visit, When a
// manager refunds it, Then a linked -1,000 refund row exists, the original stays
// paid, the treatment is owed again, a second refund is ALREADY_REFUNDED, and a
// cashier (no billing.manage) cannot refund at all.
func TestREG_PAY_006_RefundPostsOneReversal(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	manager := srv.As(t, clinic, "branch_manager")
	p, chargeID := payPaidVisit(t, clinic, doctor, cashier, "1000")

	if r := cashier.Do("POST", "/billing/charges/"+chargeID+"/refund", map[string]any{"reason": "unhappy"}); r.Status != 403 {
		t.Fatalf("cashier refund: HTTP %d %s, want 403 (refund is manager-gated)", r.Status, r.Code)
	}
	if r := manager.Do("POST", "/billing/charges/"+chargeID+"/refund", map[string]any{"reason": ""}); r.Status != 400 && r.Status != 422 {
		t.Fatalf("refund without a reason: HTTP %d %s, want a validation error", r.Status, r.Code)
	}
	manager.Do("POST", "/billing/charges/"+chargeID+"/refund", map[string]any{"reason": "treatment redone"}).
		Expect(t, 204, "refund")

	uid := payChargeUUID(t, clinic, chargeID)
	var n int
	var amt, origStatus string
	one(t, `SELECT count(*) FROM charges WHERE reverses_charge_id = $1 AND source = 'refund' AND status = 'paid'`, &n, uid)
	one(t, `SELECT coalesce(sum(amount),0)::text FROM charges WHERE reverses_charge_id = $1`, &amt, uid)
	one(t, `SELECT status FROM charges WHERE id = $1`, &origStatus, uid)
	if n != 1 || !payEq(payNum(t, amt), -1000) || origStatus != "paid" {
		t.Fatalf("after refund: %d reversal rows totalling %s, original %s; want 1 row of -1000, original paid", n, amt, origStatus)
	}
	// Refunded treatment is owed again; nothing is retained — and Finance agrees.
	payExpectBal(t, payBalance(t, cashier, p.ID), 1000, 0, 1000, 0, "after refund")
	if got := payOwedIn(payGetReceivables(t, srv.As(t, clinic, "owner")), p.ID); !payEq(payNum(t, got), 1000) {
		t.Fatalf("receivables after refunding a delivered visit: owed %q, want 1000 (owed again)", got)
	}

	r := manager.Do("POST", "/billing/charges/"+chargeID+"/refund", map[string]any{"reason": "again"})
	if r.Status != 409 || r.Code != "ALREADY_REFUNDED" {
		t.Fatalf("second refund: HTTP %d %s, want 409 ALREADY_REFUNDED", r.Status, r.Code)
	}
	one(t, `SELECT count(*) FROM charges WHERE reverses_charge_id = $1`, &n, uid)
	if n != 1 {
		t.Fatalf("second refund posted another reversal: %d rows", n)
	}
}

// TestREG_PAY_007_ConcurrentRefundsPayBackOnce: Given a settled charge, When five
// refund requests arrive at once, Then exactly one succeeds, the rest are
// ALREADY_REFUNDED (not 500), and exactly one reversal row exists.
func TestREG_PAY_007_ConcurrentRefundsPayBackOnce(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	manager, owner := srv.As(t, clinic, "branch_manager"), srv.As(t, clinic, "owner")
	_, chargeID := payPaidVisit(t, clinic, doctor, cashier, "1000")

	rs := payRace(t, []*testkit.Client{manager, owner, manager, owner, manager},
		"POST", "/billing/charges/"+chargeID+"/refund", map[string]any{"reason": "double click"})
	ok, refused := payCount(rs, 204), 0
	for _, r := range rs {
		if r.Status == 409 && r.Code == "ALREADY_REFUNDED" {
			refused++
		}
	}
	if ok != 1 || refused != len(rs)-1 {
		t.Fatalf("concurrent refunds: want one 204 and the rest 409 ALREADY_REFUNDED, got [%s]", payDescribe(rs))
	}
	var n int
	one(t, `SELECT count(*) FROM charges WHERE reverses_charge_id = $1`, &n, payChargeUUID(t, clinic, chargeID))
	if n != 1 {
		t.Fatalf("concurrent refunds posted %d reversal rows, want 1", n)
	}
}

// TestREG_PAY_008_VoidAndWaiveStopTheDebt: Given two pending plain charges, When one
// is voided (mistake) and the other waived (forgiven), Then neither is on the
// cashier's worklist or in Finance's receivables, the waiver shows in the overview's
// waived total, and a paid charge cannot be voided.
func TestREG_PAY_008_VoidAndWaiveStopTheDebt(t *testing.T) {
	clinic := payClinic(t)
	cashier, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Void"), "Waive")
	voidID := payRaise(t, cashier, clinic, p.ID, 300)
	waiveID := payRaise(t, cashier, clinic, p.ID, 200)
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); !payEq(payNum(t, got), 500) {
		t.Fatalf("receivables before: owed %q, want 500", got)
	}

	if r := cashier.Do("POST", "/billing/charges/"+voidID+"/void", map[string]any{"reason": ""}); r.Status == 204 {
		t.Fatalf("void without a reason succeeded")
	}
	cashier.Do("POST", "/billing/charges/"+voidID+"/void", map[string]any{"reason": "keyed twice"}).Expect(t, 204, "void")
	cashier.Do("POST", "/billing/charges/"+waiveID+"/waive", map[string]any{"reason": "staff family"}).Expect(t, 204, "waive")

	if rows := payPendingFor(t, cashier, p.ID); len(rows) != 0 {
		t.Fatalf("voided/waived charges still on the worklist: %+v", rows)
	}
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); got != "" {
		t.Fatalf("receivables still lists the patient as owing %s after void + waive", got)
	}
	ov := payGetOverview(t, owner, "")
	if !payEq(payNum(t, ov.Waived), 200) || !payEq(payNum(t, ov.Collected), 0) || !payEq(payNum(t, ov.Outstanding), 0) {
		t.Fatalf("overview after void + waive: waived=%s collected=%s outstanding=%s; want 200 / 0 / 0",
			ov.Waived, ov.Collected, ov.Outstanding)
	}

	// A paid charge cannot be voided to make the money disappear.
	paidID := payRaise(t, cashier, clinic, p.ID, 150)
	paySettle(cashier, paidID).Expect(t, 204, "settle")
	r := cashier.Do("POST", "/billing/charges/"+paidID+"/void", map[string]any{"reason": "oops"})
	if r.Status != 409 || r.Code != "NOT_PENDING" {
		t.Fatalf("voiding a paid charge: HTTP %d %s, want 409 NOT_PENDING", r.Status, r.Code)
	}
}

// TestREG_PAY_009_DentalWriteOffForgivesTheVisit: Given a delivered visit of 1,000,
// When a payment.waive holder writes it off, Then the patient's due is 0, the 1,000
// is reported as waived, and Finance no longer lists them; a dentist (no
// payment.waive) cannot write a fee off.
func TestREG_PAY_009_DentalWriteOffForgivesTheVisit(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Write"), "Off")
	plan := createPlan(t, doctor, p.ID, "1000", 1, "")
	sid := plan.Sessions[0].ID
	payDone(t, doctor, p.ID, sid)

	if r := doctor.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/write-off", map[string]any{"reason": "goodwill"}); r.Status != 403 {
		t.Fatalf("dentist write-off: HTTP %d %s, want 403", r.Status, r.Code)
	}
	cashier.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/write-off", map[string]any{"reason": "goodwill"}).
		Expect(t, 204, "write off")

	b := payBalance(t, cashier, p.ID)
	if !payEq(payNum(t, b.Due), 0) || !payEq(payNum(t, b.Waived), 1000) || !payEq(payNum(t, b.AtCashier), 0) {
		t.Fatalf("after write-off: due=%s waived=%s at_cashier=%s; want 0 / 1000 / 0", b.Due, b.Waived, b.AtCashier)
	}
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); got != "" {
		t.Fatalf("receivables still lists a written-off patient as owing %s", got)
	}
}

// TestREG_PAY_010_CheckoutSettlesAVisitUnderOneReceipt: Given a patient with three
// pending charges, When the cashier checks them out in one click, Then all three are
// paid under ONE receipt, the reported total is their sum, and the ledger agrees.
func TestREG_PAY_010_CheckoutSettlesAVisitUnderOneReceipt(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Check"), "Out")
	for _, a := range []float64{250, 400, 350} {
		payRaise(t, cashier, clinic, p.ID, a)
	}
	var out struct {
		ReceiptNo int64  `json:"receipt_no"`
		Total     string `json:"total"`
		Count     int    `json:"count"`
	}
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "method": "cash"}).
		Expect(t, 200, "checkout").Decode(t, &out)
	if out.Count != 3 || !payEq(payNum(t, out.Total), 1000) || out.ReceiptNo <= 0 {
		t.Fatalf("checkout result %+v, want 3 lines totalling 1000 with a receipt", out)
	}
	var n int
	one(t, `SELECT count(*) FROM charges WHERE tenant_id = $1 AND receipt_no = $2 AND status = 'paid'`, &n, clinic.TenantID, out.ReceiptNo)
	if n != 3 {
		t.Fatalf("receipt %d covers %d paid lines, want 3", out.ReceiptNo, n)
	}
	var led struct {
		Paid     string `json:"paid"`
		Awaiting string `json:"awaiting"`
	}
	cashier.Do("GET", "/billing/charges?patient="+p.ID, nil).Expect(t, 200, "patient ledger").Decode(t, &led)
	if !payEq(payNum(t, led.Paid), 1000) || !payEq(payNum(t, led.Awaiting), 0) {
		t.Fatalf("ledger after checkout: paid=%s awaiting=%s, want 1000 / 0", led.Paid, led.Awaiting)
	}
}

// TestREG_PAY_012_RefundWholeReceiptOnce: Given a checkout of two charges under one
// receipt, When a manager refunds the receipt, Then both lines get exactly one
// reversal each; refunding it again is refused; and on a second receipt, concurrent
// whole-receipt refunds still post exactly one reversal per line.
func TestREG_PAY_012_RefundWholeReceiptOnce(t *testing.T) {
	clinic := payClinic(t)
	cashier, manager, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager"), srv.As(t, clinic, "owner")
	recp := srv.As(t, clinic, "receptionist")
	checkout := func(amounts ...float64) int64 {
		p := createPatient(t, recp, uniq("Receipt"), "Refund")
		for _, a := range amounts {
			payRaise(t, cashier, clinic, p.ID, a)
		}
		var out struct {
			ReceiptNo int64 `json:"receipt_no"`
		}
		cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "method": "cash"}).
			Expect(t, 200, "checkout").Decode(t, &out)
		return out.ReceiptNo
	}
	reversals := func(receipt int64) (int, string) {
		var n int
		var sum string
		one(t, `SELECT count(*) FROM charges r JOIN charges o ON o.id = r.reverses_charge_id
		         WHERE o.tenant_id = $1 AND o.receipt_no = $2`, &n, clinic.TenantID, receipt)
		one(t, `SELECT coalesce(sum(r.amount),0)::text FROM charges r JOIN charges o ON o.id = r.reverses_charge_id
		         WHERE o.tenant_id = $1 AND o.receipt_no = $2`, &sum, clinic.TenantID, receipt)
		return n, sum
	}

	rc := checkout(600, 400)
	manager.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": rc, "reason": "wrong patient"}).
		Expect(t, 204, "refund receipt")
	if n, sum := reversals(rc); n != 2 || !payEq(payNum(t, sum), -1000) {
		t.Fatalf("receipt refund: %d reversals totalling %s, want 2 totalling -1000", n, sum)
	}
	again := manager.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": rc, "reason": "again"})
	if again.Status != 409 {
		t.Fatalf("second receipt refund: HTTP %d %s, want 409", again.Status, again.Code)
	}

	rc2 := checkout(300, 200)
	rs := payRace(t, []*testkit.Client{manager, owner, manager, owner},
		"POST", "/billing/refund-visit", map[string]any{"receipt_no": rc2, "reason": "double click"})
	if payCount(rs, 204) != 1 || payCount(rs, 409) != len(rs)-1 {
		t.Fatalf("concurrent receipt refunds: want one 204 and the rest 409, got [%s]", payDescribe(rs))
	}
	if n, sum := reversals(rc2); n != 2 || !payEq(payNum(t, sum), -500) {
		t.Fatalf("concurrent receipt refunds: %d reversals totalling %s, want 2 totalling -500", n, sum)
	}
}

// TestREG_PAY_011_CashDayCloseUsesTheAddisDay (FIN-1): Given a cash payment settled
// at 00:30 Addis time today, When the cashier opens today's day close (Addis date),
// Then the payment is in the expected cash. The close uses the UTC day, so a payment
// taken between 00:00 and 03:00 Addis is booked to the previous day's drawer.
func TestREG_PAY_011_CashDayCloseUsesTheAddisDay(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Early"), "Payer")
	cid := payRaise(t, cashier, clinic, p.ID, 700)
	paySettle(cashier, cid).Expect(t, 204, "settle cash")
	if _, err := super.Pool.Exec(t.Context(),
		`UPDATE charges SET settled_at = (date_trunc('day', now() AT TIME ZONE 'Africa/Addis_Ababa') + interval '30 minutes') AT TIME ZONE 'Africa/Addis_Ababa'
		  WHERE id = $1`, payChargeUUID(t, clinic, cid)); err != nil {
		t.Fatal(err)
	}

	// Finance already uses the Addis day: the payment is today's money there.
	if ov := payGetOverview(t, srv.As(t, clinic, "owner"), ""); !payEq(payNum(t, ov.Collected), 700) {
		t.Fatalf("finance overview today collected %s, want 700 (00:30 Addis is today)", ov.Collected)
	}

	var day struct {
		BusinessDate  string `json:"business_date"`
		ExpectedTotal string `json:"expected_total"`
	}
	cashier.Do("GET", "/billing/day-close?date="+payAddisToday(), nil).Expect(t, 200, "day close").Decode(t, &day)
	counted := payEq(payNum(t, day.ExpectedTotal), 700)
	if !counted {
		testkit.KnownBug(t, "FIN-1", true, fmt.Sprintf(
			"cash day close for Addis %s expects %s, not the 700 settled at 00:30 Addis — it windows by the UTC day "+
				"(billing/service/service.go parseDay/ExpectedForDay)", day.BusinessDate, day.ExpectedTotal))
	}
	testkit.KnownBug(t, "FIN-1", false, "day close counts a 00:30 Addis cash payment in today's drawer")
}

// ---- finance ----

// TestREG_FIN_001_ReceivablesCountsADebtOnce: Given a patient with four past paid
// charges and one pending 500, When Finance lists receivables, Then they owe 500 —
// not 500 × (number of past payments). Regression for the LEFT JOIN fan-out fixed
// with a LATERAL last-payment lookup (finance/service/service.go Receivables).
func TestREG_FIN_001_ReceivablesCountsADebtOnce(t *testing.T) {
	clinic := payClinic(t)
	cashier, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Loyal"), "Patient")
	for i := 0; i < 4; i++ {
		paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 100)).Expect(t, 204, "settle past visit")
	}
	payRaise(t, cashier, clinic, p.ID, 500)

	rec := payGetReceivables(t, owner)
	if got := payOwedIn(rec, p.ID); !payEq(payNum(t, got), 500) {
		t.Fatalf("receivables: patient with 4 past payments owes %q, want 500", got)
	}
	if !payEq(payNum(t, rec.Total), 500) || !payEq(payNum(t, rec.AtCashier), 500) || rec.Count != 1 {
		t.Fatalf("receivables totals: total=%s at_cashier=%s count=%d; want 500 / 500 / 1", rec.Total, rec.AtCashier, rec.Count)
	}
}

// TestREG_FIN_002_OverviewNetsRefundsAndSplitsOwed: Given 1,000 and 400 settled
// today, the 400 refunded, and 250 still pending, Then the overview reports collected
// 1,000 (net), refunded 400, two payments, and 250 outstanding.
func TestREG_FIN_002_OverviewNetsRefundsAndSplitsOwed(t *testing.T) {
	clinic := payClinic(t)
	cashier, owner := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Net"), "Refund")
	paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 1000)).Expect(t, 204, "settle 1000")
	r400 := payRaise(t, cashier, clinic, p.ID, 400)
	paySettle(cashier, r400).Expect(t, 204, "settle 400")
	owner.Do("POST", "/billing/charges/"+r400+"/refund", map[string]any{"reason": "overcharged"}).Expect(t, 204, "refund 400")
	payRaise(t, cashier, clinic, p.ID, 250)

	ov := payGetOverview(t, owner, "")
	if !payEq(payNum(t, ov.Collected), 1000) || !payEq(payNum(t, ov.Refunded), 400) ||
		ov.CollectedCount != 2 || !payEq(payNum(t, ov.Outstanding), 250) {
		t.Fatalf("overview: collected=%s refunded=%s count=%d outstanding=%s; want 1000 / 400 / 2 / 250",
			ov.Collected, ov.Refunded, ov.CollectedCount, ov.Outstanding)
	}
	// Cashiers do not get the finance views.
	if r := cashier.Do("GET", "/finance/overview", nil); r.Status != 403 {
		t.Fatalf("cashier finance overview: HTTP %d, want 403", r.Status)
	}
}

// ---- dashboard ----

// TestREG_DASH_001_DashboardOwedAgreesWithFinance: Given 300 waiting at the cashier
// and a delivered-but-unbilled 1,000 dental visit, Then the home screen's owed equals
// Finance's receivables total (1,300), and owed_at_cashier + owed_unbilled == owed.
func TestREG_DASH_001_DashboardOwedAgreesWithFinance(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	recp := srv.As(t, clinic, "receptionist")
	p1 := createPatient(t, recp, uniq("Desk"), "Owes")
	payRaise(t, cashier, clinic, p1.ID, 300)
	p2 := createPatient(t, recp, uniq("Chair"), "Owes")
	plan := createPlan(t, doctor, p2.ID, "1000", 1, "")
	payDone(t, doctor, p2.ID, plan.Sessions[0].ID)

	rec := payGetReceivables(t, owner)
	d := payDashboard(t, owner)
	if !payEq(payNum(t, rec.Total), 1300) {
		t.Fatalf("receivables total %s, want 1300", rec.Total)
	}
	if d.Owed != rec.Total {
		t.Fatalf("dashboard owed %s != finance receivables total %s", d.Owed, rec.Total)
	}
	if !payEq(payNum(t, d.OwedAtCashier)+payNum(t, d.OwedUnbilled), payNum(t, d.Owed)) ||
		!payEq(payNum(t, d.OwedAtCashier), 300) || !payEq(payNum(t, d.OwedUnbilled), 1000) {
		t.Fatalf("dashboard owed split: at_cashier=%s + unbilled=%s vs owed=%s; want 300 + 1000 = 1300",
			d.OwedAtCashier, d.OwedUnbilled, d.Owed)
	}
	if d.OwedPatients != 2 {
		t.Fatalf("dashboard owed_patients %d, want 2", d.OwedPatients)
	}
	// The cashier sees the same money section (payment.collect).
	if c := payDashboard(t, cashier); c.Owed != d.Owed {
		t.Fatalf("cashier's dashboard owed %s != owner's %s", c.Owed, d.Owed)
	}
}

// TestREG_DASH_002_CollectedTodayAgreesWithFinance: Given 1,000 + 450 settled today,
// Then the home screen's collected_today, Finance's overview for today and the
// 30-day takings chart's total all say 1,450.
func TestREG_DASH_002_CollectedTodayAgreesWithFinance(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	payPaidVisit(t, clinic, doctor, cashier, "1000")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Desk"), "Pays")
	paySettle(cashier, payRaise(t, cashier, clinic, p.ID, 450)).Expect(t, 204, "settle")

	ov := payGetOverview(t, owner, "")
	d := payDashboard(t, owner)
	var tk struct {
		Total string `json:"total"`
	}
	owner.Do("GET", "/dashboard/takings?days=30", nil).Expect(t, 200, "takings").Decode(t, &tk)
	if !payEq(payNum(t, ov.Collected), 1450) || d.CollectedToday != ov.Collected || !payEq(payNum(t, tk.Total), 1450) {
		t.Fatalf("collected today: finance=%s dashboard=%s takings(30d)=%s; want all 1450",
			ov.Collected, d.CollectedToday, tk.Total)
	}
}

// TestREG_DASH_003_CollectedTodayNetsATodayRefund (FIN-2): Given 1,000 settled today
// and refunded today, Then the home screen's collected_today is 0, as Finance's
// all-branch overview says. Refund rows carry no branch_id, so the branch-scoped
// home screen still shows the 1,000 as taken.
func TestREG_DASH_003_CollectedTodayNetsATodayRefund(t *testing.T) {
	clinic := payClinic(t)
	doctor, cashier, owner := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	_, chargeID := payPaidVisit(t, clinic, doctor, cashier, "1000")
	owner.Do("POST", "/billing/charges/"+chargeID+"/refund", map[string]any{"reason": "redo"}).Expect(t, 204, "refund")

	ov := payGetOverview(t, owner, "")
	if !payEq(payNum(t, ov.Collected), 0) || !payEq(payNum(t, ov.Refunded), 1000) {
		t.Fatalf("finance (all branches): collected=%s refunded=%s, want 0 / 1000", ov.Collected, ov.Refunded)
	}
	d := payDashboard(t, owner)
	if !payEq(payNum(t, d.CollectedToday), 0) {
		var refundBranch *string
		one(t, `SELECT branch_id::text FROM charges WHERE reverses_charge_id = $1`, &refundBranch, payChargeUUID(t, clinic, chargeID))
		testkit.KnownBug(t, "FIN-2", true, fmt.Sprintf(
			"dashboard collected_today=%s after a same-day full refund (finance says %s); the refund row's branch_id=%v "+
				"so the branch-scoped series drops it (billing.sql CreateReversalCharge)", d.CollectedToday, ov.Collected, refundBranch))
	}
	testkit.KnownBug(t, "FIN-2", false, "dashboard collected_today nets a same-day refund")
}
