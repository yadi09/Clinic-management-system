package regression

// Pay from home. The rule under test is the clinic's: money becomes a receipt only when
// the bank confirms the exact amount to the clinic's own account. Every other answer waits
// for the cashier or is refused — and nothing is booked twice.
//
// The bank is a stand-in (internal/testkit/fakebank.go); the transaction number says what
// it answers: OK<amount>-… confirmed, WRONGAMT… wrong amount, ELSEWHERE… someone else's
// account, NF… no such transaction, SLOW… still working, anything else unreachable.

import (
	"strconv"
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/testkit"
)

type payItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Amount   string `json:"amount"`
	Payable  bool   `json:"payable"`
	Upcoming bool   `json:"upcoming"`
	Date     string `json:"date"`
}

type payOpts struct {
	Items []payItem `json:"items"`
	Rails []struct {
		ID            string `json:"id"`
		AccountNumber string `json:"account_number"`
	} `json:"rails"`
	Open []payStatus `json:"open"`
}

type payStatus struct {
	ID        string `json:"id"`
	State     string `json:"state"`
	Amount    string `json:"amount"`
	Reason    string `json:"reason"`
	ReceiptNo *int64 `json:"receipt_no"`
}

type payWorld struct {
	c       *testkit.Clinic
	patient patientRef
	plan    planRef
	token   string
	rail    string
	doc     *testkit.Client
	cashier *testkit.Client
}

func portalPayWorld(t *testing.T, allowPay bool) *payWorld {
	t.Helper()
	c := newClinic(t)
	w := &payWorld{c: c, doc: srv.As(t, c, "doctor"), cashier: srv.As(t, c, "cashier")}
	w.patient = createPatient(t, srv.As(t, c, "receptionist"), "Meron", "Alem")
	w.plan = createPlan(t, w.doc, w.patient.ID, "4500", 3, "")
	var rail struct {
		ID string `json:"id"`
	}
	srv.As(t, c, "owner").Do("POST", "/org/payment-rails", map[string]any{
		"label": "Telebirr", "kind": "wallet", "bank_key": "telebirr", "account_number": "0911223344", "account_name": "Yoya Dental",
	}).Expect(t, 201, "add rail").Decode(t, &rail)
	w.rail = rail.ID
	portalOn(t, c, map[string]any{"allow_pay": allowPay})
	tok, r := portalSignIn(t, c.Slug, w.patient.MRN)
	r.Expect(t, 200, "sign in")
	w.token = tok
	return w
}

func (w *payWorld) as(t *testing.T, token string) *testkit.Client {
	cl := srv.Anon(t)
	cl.Header = map[string]string{"X-Portal-Token": token}
	return cl
}

func (w *payWorld) options(t *testing.T) (payOpts, testkit.Resp) {
	t.Helper()
	r := w.as(t, w.token).Do("GET", "/portal/"+w.c.Slug+"/pay/options", nil)
	var o payOpts
	if r.Status == 200 {
		r.Decode(t, &o)
	}
	return o, r
}

func (w *payWorld) pay(t *testing.T, ref string, keys ...string) (payStatus, testkit.Resp) {
	t.Helper()
	cl := w.as(t, w.token)
	cl.Header["CF-Connecting-IP"] = "196.188." + strconv.Itoa(int(portalIP.Add(1)%250)) + ".9"
	r := cl.Do("POST", "/portal/"+w.c.Slug+"/pay", map[string]any{"items": keys, "rail_id": w.rail, "reference": ref})
	var s payStatus
	if r.Status == 200 {
		r.Decode(t, &s)
	}
	return s, r
}

func (w *payWorld) nextVisit(t *testing.T) payItem {
	t.Helper()
	o, r := w.options(t)
	r.Expect(t, 200, "options")
	for _, it := range o.Items {
		if it.Upcoming {
			return it
		}
	}
	t.Fatalf("no next visit offered: %+v", o.Items)
	return payItem{}
}

func ref(prefix string) string { return prefix + strings.ToUpper(uniq("")) }

func (w *payWorld) paidSoFar(t *testing.T) string {
	me, r := portalMeOf(t, w.c.Slug, w.token)
	r.Expect(t, 200, "me")
	return me.Money.Paid
}

// REG_PORTAL_PAY_001: paying is a separate switch, off by default; the menu lists the next
// visit (ahead of time) and the clinic's own account, and nothing else leaks.
func TestREG_PORTAL_PAY_001_OffByDefaultThenAMenu(t *testing.T) {
	w := portalPayWorld(t, false)
	if _, r := w.options(t); r.Status != 403 || r.Code != "PORTAL_PAY_OFF" {
		t.Fatalf("pay options while off = %d %s", r.Status, r.Code)
	}
	if _, r := w.pay(t, "OK1500-AAAA1", "s:x"); r.Status != 403 {
		t.Fatalf("pay while off = %d", r.Status)
	}
	portalOn(t, w.c, map[string]any{"allow_pay": true})
	o, r := w.options(t)
	r.Expect(t, 200, "options")
	if len(o.Rails) != 1 || o.Rails[0].AccountNumber != "0911223344" {
		t.Fatalf("rails = %+v", o.Rails)
	}
	next := w.nextVisit(t)
	if !next.Payable || next.Amount != "1500.00" || !strings.Contains(next.Label, "visit 1") || len(next.Date) != 10 {
		t.Fatalf("next visit = %+v", next)
	}
	// Hiding payments hides paying: you cannot pay what you cannot see.
	portalOn(t, w.c, map[string]any{"allow_pay": true, "show_money": false})
	if _, r := w.options(t); r.Status != 403 {
		t.Fatalf("pay options with money hidden = %d", r.Status)
	}
}

// REG_PORTAL_PAY_002: the bank confirms the exact amount to the clinic's account → a real
// receipt on the clinic's own books, at once; the transaction number cannot be used again.
func TestREG_PORTAL_PAY_002_ConfirmedByTheBankBecomesAReceipt(t *testing.T) {
	w := portalPayWorld(t, true)
	next := w.nextVisit(t)
	tx := ref("OK1500-")
	st, r := w.pay(t, tx, next.Key)
	r.Expect(t, 200, "pay")
	if st.State != "paid" || st.ReceiptNo == nil || st.Amount != "1500.00" {
		t.Fatalf("status = %+v", st)
	}
	if got := w.paidSoFar(t); got != "1500.00" {
		t.Fatalf("portal says paid %s", got)
	}
	// The clinic's books agree: the visit's bill is paid, with this reference and receipt.
	var status, payRef string
	one(t, `SELECT c.status FROM charges c JOIN treatment_sessions se ON se.charge_id = c.id
	         WHERE se.tenant_id = (SELECT id FROM tenants WHERE slug=$1) AND se.seq = 1 AND se.kind='visit'`, &status, w.c.Slug)
	one(t, `SELECT coalesce(c.payment_reference,'') FROM charges c JOIN treatment_sessions se ON se.charge_id = c.id
	         WHERE se.tenant_id = (SELECT id FROM tenants WHERE slug=$1) AND se.seq = 1 AND se.kind='visit'`, &payRef, w.c.Slug)
	if !strings.EqualFold(payRef, tx) {
		t.Fatalf("the receipt carries reference %q, want %q", payRef, tx)
	}
	if status != "paid" {
		t.Fatalf("visit 1 bill is %s", status)
	}
	var refs int
	one(t, `SELECT count(*) FROM payment_references WHERE tenant_id=(SELECT id FROM tenants WHERE slug=$1) AND reference_norm=upper($2) AND receipt_no IS NOT NULL`, &refs, w.c.Slug, tx)
	if refs != 1 {
		t.Fatalf("payment_references rows = %d", refs)
	}
	// Same number again: refused, nothing booked twice.
	if _, r := w.pay(t, tx, w.nextVisit(t).Key); r.Status != 409 {
		t.Fatalf("reusing a paid transaction number = %d", r.Status)
	}
	if got := w.paidSoFar(t); got != "1500.00" {
		t.Fatalf("paid after reuse attempt = %s", got)
	}
	// The cashier's list is empty: nothing is waiting.
	var open []map[string]any
	w.cashier.Do("GET", "/portal-payments", nil).Expect(t, 200, "list").Decode(t, &open)
	if len(open) != 0 {
		t.Fatalf("nothing should wait: %+v", open)
	}
}

// REG_PORTAL_PAY_003: a transfer for the wrong amount is NOT booked. It waits; the cashier
// sees it with the bank's words, and Confirm books it under the cashier's own name.
func TestREG_PORTAL_PAY_003_WrongAmountWaitsForTheCashier(t *testing.T) {
	w := portalPayWorld(t, true)
	st, r := w.pay(t, ref("OK1000-"), w.nextVisit(t).Key)
	r.Expect(t, 200, "pay")
	if st.State != "waiting" || st.ReceiptNo != nil {
		t.Fatalf("status = %+v", st)
	}
	if got := w.paidSoFar(t); got != "0.00" {
		t.Fatalf("money moved on a wrong amount: %s", got)
	}
	o, _ := w.options(t)
	if len(o.Open) != 1 || o.Open[0].State != "waiting" {
		t.Fatalf("patient's open attempts = %+v", o.Open)
	}
	var open []struct {
		ID           string `json:"id"`
		Patient      string `json:"patient"`
		Items        string `json:"items"`
		VerifyState  string `json:"verify_state"`
		VerifyReason string `json:"verify_reason"`
	}
	w.cashier.Do("GET", "/portal-payments", nil).Expect(t, 200, "list").Decode(t, &open)
	if len(open) != 1 || !strings.Contains(open[0].Patient, "Meron") || !strings.Contains(open[0].VerifyReason, "1.00") && !strings.Contains(open[0].VerifyReason, "1000") {
		t.Fatalf("cashier's list = %+v", open)
	}
	var done payStatus
	w.cashier.Do("POST", "/portal-payments/"+open[0].ID+"/confirm", nil).Expect(t, 200, "confirm").Decode(t, &done)
	if done.State != "paid" || done.ReceiptNo == nil {
		t.Fatalf("confirmed = %+v", done)
	}
	if got := w.paidSoFar(t); got != "1500.00" {
		t.Fatalf("paid after confirm = %s", got)
	}
	// A second Confirm cannot book it twice.
	if r := w.cashier.Do("POST", "/portal-payments/"+open[0].ID+"/confirm", nil); r.Status != 409 {
		t.Fatalf("second confirm = %d", r.Status)
	}
}

// REG_PORTAL_PAY_004: the bank has no such transaction, or it went to somebody else's
// account: refused in plain words, nothing booked, and a corrected number may be sent.
func TestREG_PORTAL_PAY_004_NotFoundOrElsewhereIsRefused(t *testing.T) {
	w := portalPayWorld(t, true)
	next := w.nextVisit(t)
	for _, prefix := range []string{"NF", "ELSEWHERE"} {
		st, r := w.pay(t, ref(prefix), next.Key)
		r.Expect(t, 200, "pay "+prefix)
		if st.State != "rejected" || !strings.Contains(st.Reason, "could not confirm") {
			t.Fatalf("%s: %+v", prefix, st)
		}
	}
	if got := w.paidSoFar(t); got != "0.00" {
		t.Fatalf("money moved: %s", got)
	}
	// Refused attempts do not hold the bill: the right number still works.
	if st, _ := w.pay(t, ref("OK1500-"), next.Key); st.State != "paid" {
		t.Fatalf("retry with the right number = %+v", st)
	}
}

// REG_PORTAL_PAY_005: when the bank cannot be asked (down, out of credit) the attempt
// waits for the cashier; the cashier can turn it down, and the patient sees why in words.
func TestREG_PORTAL_PAY_005_BankUnreachableWaitsAndCashierCanRefuse(t *testing.T) {
	w := portalPayWorld(t, true)
	tx := ref("PLAIN")
	st, r := w.pay(t, tx, w.nextVisit(t).Key)
	r.Expect(t, 200, "pay")
	if st.State != "waiting" {
		t.Fatalf("status = %+v", st)
	}
	var open []struct {
		ID string `json:"id"`
	}
	w.cashier.Do("GET", "/portal-payments", nil).Expect(t, 200, "list").Decode(t, &open)
	if len(open) != 1 {
		t.Fatalf("list = %+v", open)
	}
	w.cashier.Do("POST", "/portal-payments/"+open[0].ID+"/reject", map[string]any{"reason": "SMS shows another phone number"}).Expect(t, 200, "reject")
	got := w.as(t, w.token).Do("GET", "/portal/"+w.c.Slug+"/pay/"+open[0].ID, nil).Expect(t, 200, "status")
	var s payStatus
	got.Decode(t, &s)
	if s.State != "rejected" || !strings.Contains(s.Reason, "contact the clinic") {
		t.Fatalf("patient sees %+v", s)
	}
	if strings.Contains(s.Reason, "SMS shows") {
		t.Fatalf("the cashier's private note reached the patient")
	}
	if r := w.cashier.Do("POST", "/portal-payments/"+open[0].ID+"/reject", nil); r.Status != 409 {
		t.Fatalf("reject twice = %d", r.Status)
	}
}

// REG_PORTAL_PAY_006: while the bank is still working the attempt stays "checking"; asking
// again later asks the bank again.
func TestREG_PORTAL_PAY_006_StillCheckingStaysChecking(t *testing.T) {
	w := portalPayWorld(t, true)
	st, r := w.pay(t, ref("SLOW"), w.nextVisit(t).Key)
	r.Expect(t, 200, "pay")
	if st.State != "checking" {
		t.Fatalf("status = %+v", st)
	}
	var again payStatus
	w.as(t, w.token).Do("GET", "/portal/"+w.c.Slug+"/pay/"+st.ID, nil).Expect(t, 200, "status").Decode(t, &again)
	if again.State != "checking" || again.ID != st.ID {
		t.Fatalf("again = %+v", again)
	}
}

// REG_PORTAL_PAY_007: an already-billed treatment bill can be paid; the patient can never
// pay another patient's bill, a bad number or a method that is not a wallet or bank, and a
// token from one clinic is nothing at another.
func TestREG_PORTAL_PAY_007_OnlyOwnBillsAndRealMethods(t *testing.T) {
	w := portalPayWorld(t, true)
	// The desk raises the bill for visit 1: it now shows as waiting for payment.
	w.doc.Do("POST", "/dental/patients/"+w.patient.ID+"/sessions/"+w.plan.Sessions[0].ID+"/collect", nil).Expect(t, 204, "collect visit 1")
	o, _ := w.options(t)
	var billed *payItem
	for i := range o.Items {
		if strings.HasPrefix(o.Items[i].Key, "c:") {
			billed = &o.Items[i]
		}
	}
	if billed == nil || !billed.Payable || billed.Amount != "1500.00" {
		t.Fatalf("billed item missing: %+v", o.Items)
	}
	// Another patient's item is refused.
	other := createPatient(t, srv.As(t, w.c, "receptionist"), "Hana", "Girma")
	op := createPlan(t, w.doc, other.ID, "3000", 2, "")
	var otherSession string
	one(t, `SELECT 's:' || id FROM treatment_sessions WHERE tenant_id=(SELECT id FROM tenants WHERE slug=$1) AND patient_id = (SELECT id FROM patients WHERE mrn=$2 AND tenant_id=(SELECT id FROM tenants WHERE slug=$1)) ORDER BY seq LIMIT 1`, &otherSession, w.c.Slug, other.MRN)
	_ = op
	if _, r := w.pay(t, ref("OK1500-"), otherSession); r.Status != 409 || r.Code != "PORTAL_ITEM_GONE" {
		t.Fatalf("another patient's visit = %d %s", r.Status, r.Code)
	}
	if _, r := w.pay(t, "12", billed.Key); r.Status != 400 {
		t.Fatalf("short transaction number = %d", r.Status)
	}
	if _, r := w.pay(t, ref("OK1500-")); r.Status != 400 {
		t.Fatalf("nothing chosen = %d", r.Status)
	}
	// A cash method is not a way to pay from a phone.
	var cash struct{ ID string }
	srv.As(t, w.c, "owner").Do("POST", "/org/payment-rails", map[string]any{"label": "Cash box", "kind": "cash"}).Expect(t, 201, "cash").Decode(t, &cash)
	cl := w.as(t, w.token)
	if r := cl.Do("POST", "/portal/"+w.c.Slug+"/pay", map[string]any{"items": []string{billed.Key}, "rail_id": cash.ID, "reference": ref("OK1500-")}); r.Status != 400 {
		t.Fatalf("cash rail = %d", r.Status)
	}
	// And the real bill, paid.
	st, r := w.pay(t, ref("OK1500-"), billed.Key)
	r.Expect(t, 200, "pay the bill")
	if st.State != "paid" {
		t.Fatalf("status = %+v", st)
	}
	// Another clinic's page does not accept this patient's token.
	b := newClinic(t)
	portalOn(t, b, map[string]any{"allow_pay": true})
	if r := w.as(t, w.token).Do("GET", "/portal/"+b.Slug+"/pay/options", nil); r.Status != 401 {
		t.Fatalf("token at another clinic = %d", r.Status)
	}
}

// REG_PORTAL_PAY_008: only the cashier's side can list, confirm or refuse; a doctor cannot.
func TestREG_PORTAL_PAY_008_CashierPermissionsApply(t *testing.T) {
	w := portalPayWorld(t, true)
	if r := w.doc.Do("GET", "/portal-payments", nil); r.Status != 403 {
		t.Fatalf("doctor lists home payments = %d", r.Status)
	}
	if r := w.doc.Do("POST", "/portal-payments/ppy_x/confirm", nil); r.Status != 403 {
		t.Fatalf("doctor confirms = %d", r.Status)
	}
	if r := w.doc.Do("POST", "/portal-payments/ppy_x/reject", nil); r.Status != 403 {
		t.Fatalf("doctor refuses = %d", r.Status)
	}
	if r := w.cashier.Do("POST", "/portal-payments/ppy_x/confirm", nil); r.Status != 404 {
		t.Fatalf("a made-up id = %d", r.Status)
	}
}

// REG_PORTAL_PAY_009: treatment the patient has had and not paid for (no bill raised, often a
// promise to pay later) is owed — so it can be paid from home, listed first, and paying it
// raises the bill and settles it in one go.
func TestREG_PORTAL_PAY_009_DoneButUnbilledTreatmentCanBePaid(t *testing.T) {
	w := portalPayWorld(t, true)
	w.doc.Do("PUT", "/dental/patients/"+w.patient.ID+"/sessions/"+w.plan.Sessions[0].ID, map[string]any{"status": "done"}).Expect(t, 204, "visit 1 done")
	o, r := w.options(t)
	r.Expect(t, 200, "options")
	if len(o.Items) < 2 || !strings.Contains(o.Items[0].Label, "visit 1") || !o.Items[0].Payable || o.Items[0].Upcoming || o.Items[0].Amount != "1500.00" {
		t.Fatalf("the done visit is not first and payable: %+v", o.Items)
	}
	me, _ := portalMeOf(t, w.c.Slug, w.token)
	if me.Money == nil || me.Money.Unbilled == nil || *me.Money.Unbilled != "1500.00" {
		t.Fatalf("before: %+v", me.Money)
	}
	st, r := w.pay(t, ref("OK1500-"), o.Items[0].Key)
	r.Expect(t, 200, "pay the done visit")
	if st.State != "paid" || st.ReceiptNo == nil {
		t.Fatalf("status = %+v", st)
	}
	me, _ = portalMeOf(t, w.c.Slug, w.token)
	if me.Money.Paid != "1500.00" || *me.Money.Unbilled != "0.00" {
		t.Fatalf("after: paid %s, still unbilled %s", me.Money.Paid, *me.Money.Unbilled)
	}
}
