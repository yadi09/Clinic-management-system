package regression

import (
	"fmt"
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The registration fee rule (FEAT-REG-1): each clinic chooses, in its settings, how
// often a patient pays registration: every visit (the old behaviour), once in their
// life, or again after a number of days, weeks or months. Other arrival fees (a
// consultation) keep charging every visit.

type rgPolicy struct {
	ServiceID               *string `json:"service_id"`
	Rule                    string  `json:"rule"`
	EveryCount              *int    `json:"every_count"`
	EveryUnit               string  `json:"every_unit"`
	PaperPatientsRegistered bool    `json:"paper_patients_registered"`
}

type rgStatus struct {
	ServiceID    *string `json:"service_id"`
	Rule         string  `json:"rule"`
	Due          bool    `json:"due"`
	Reason       string  `json:"reason"`
	RegisteredOn string  `json:"registered_on"`
	ValidUntil   string  `json:"valid_until"`
}

// rgKit is a clinic with two arrival fees: Registration (100) and Consultation (300).
type rgKit struct {
	c                  *testkit.Clinic
	recp, cashier, mgr *testkit.Client
	reg, consult       string
}

func rgNewKit(t *testing.T) rgKit {
	t.Helper()
	c := payClinic(t)
	k := rgKit{c: c, recp: srv.As(t, c, "receptionist"), cashier: srv.As(t, c, "cashier"), mgr: srv.As(t, c, "branch_manager")}
	k.reg = blService(t, k.mgr, "Registration", "general", 100, "")
	k.consult = blService(t, k.mgr, "Consultation", "general", 300, "")
	for _, s := range []string{k.reg, k.consult} {
		k.mgr.Do("PUT", "/billing/services/"+s+"/default", map[string]any{"is_default": true}).Expect(t, 204, "make arrival fee")
	}
	return k
}

func (k rgKit) setPolicy(t *testing.T, rule string, count int, unit string) {
	t.Helper()
	body := map[string]any{"service_id": k.reg, "rule": rule, "paper_patients_registered": true}
	if rule == "every" {
		body["every_count"], body["every_unit"] = count, unit
	}
	k.mgr.Do("PUT", "/billing/registration-policy", body).Expect(t, 200, "save policy "+rule)
}

// arrive receives the patient as a walk-in and returns the services charged.
func (k rgKit) arrive(t *testing.T, p patientRef) []string {
	t.Helper()
	var a struct {
		ChargeIDs []string `json:"charge_ids"`
	}
	k.recp.Do("POST", "/queue/walk-in", map[string]any{"patient_id": p.ID, "department_id": blDept(k.c), "branch_id": payBranch(t, k.c)}).
		Expect(t, 201, "walk-in").Decode(t, &a)
	out := []string{}
	for _, ch := range a.ChargeIDs {
		var name string
		one(t, `SELECT description FROM charges WHERE id = $1`, &name, blUUID(t, id.PrefixCharge, ch))
		out = append(out, name)
	}
	return out
}

// pastVisit records a finished, paid visit on an earlier Addis day: arrive, settle
// every fee, take the patient out of today's queue, and move it all back in time.
func (k rgKit) pastVisit(t *testing.T, p patientRef, at time.Time) {
	t.Helper()
	k.arrive(t, p)
	for _, ch := range k.pending(t, p) {
		paySettle(k.cashier, ch).Expect(t, 204, "settle")
	}
	// Only this visit's rows (made in the last hour): earlier past visits keep their dates.
	blExec(t, `UPDATE charges SET created_at = $2, settled_at = $2 WHERE patient_id = $1 AND created_at > now() - interval '1 hour'`, blPatientUUID(t, p), at)
	blExec(t, `UPDATE queue_entries SET state = 'done', enqueued_at = $2 WHERE patient_id = $1 AND enqueued_at > now() - interval '1 hour'`, blPatientUUID(t, p), at)
}

func (k rgKit) pending(t *testing.T, p patientRef) []string {
	t.Helper()
	rows, err := super.Pool.Query(t.Context(),
		`SELECT id FROM charges WHERE patient_id = $1 AND status = 'pending' AND deleted_at IS NULL ORDER BY created_at`, blPatientUUID(t, p))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var u [16]byte
		if err := rows.Scan(&u); err != nil {
			t.Fatal(err)
		}
		out = append(out, id.Encode(id.PrefixCharge, u))
	}
	return out
}

func (k rgKit) status(t *testing.T, p patientRef) rgStatus {
	t.Helper()
	var s rgStatus
	k.recp.Do("GET", "/billing/registration-status?patient="+p.ID, nil).Expect(t, 200, "registration status").Decode(t, &s)
	return s
}

func rgHas(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

func rgExpect(t *testing.T, got []string, reg bool, what string) {
	t.Helper()
	if rgHas(got, "Registration") != reg || !rgHas(got, "Consultation") {
		t.Fatalf("%s: charged %v, want registration=%v and consultation", what, got, reg)
	}
}

// TestREG_REGFEE_001_NoRuleChargesEveryVisit: Given a clinic that never chose a rule,
// When a patient who paid registration last week arrives again, Then registration is
// charged again (the behaviour before the setting existed), and the policy reads as
// "every visit" with no fee named.
func TestREG_REGFEE_001_NoRuleChargesEveryVisit(t *testing.T) {
	k := rgNewKit(t)
	var pol rgPolicy
	k.recp.Do("GET", "/billing/registration-policy", nil).Expect(t, 200, "policy").Decode(t, &pol)
	if pol.Rule != "every_visit" || pol.ServiceID != nil || !pol.PaperPatientsRegistered {
		t.Fatalf("default policy %+v, want every_visit, no service, paper patients registered", pol)
	}
	p := createPatient(t, k.recp, uniq("Every"), "Visit")
	k.pastVisit(t, p, addisAt(-7, 10, 0))
	rgExpect(t, k.arrive(t, p), true, "a week later with no rule")
	if s := k.status(t, p); !s.Due || s.Reason != "no_policy" {
		t.Fatalf("status %+v, want due (no_policy)", s)
	}
}

// TestREG_REGFEE_002_OneTimeRegistration: Given registration set to "one time only",
// When a patient arrives the first time, Then registration and consultation are
// charged; When they return 40 days later (and a year later), Then only the
// consultation is charged, and the desk sees "registered on <first day>".
func TestREG_REGFEE_002_OneTimeRegistration(t *testing.T) {
	k := rgNewKit(t)
	k.setPolicy(t, "once", 0, "")
	p := createPatient(t, k.recp, uniq("Once"), "Only")
	if s := k.status(t, p); !s.Due || s.Reason != "never_registered" {
		t.Fatalf("new patient %+v, want due (never_registered)", s)
	}
	first := addisAt(-400, 10, 0)
	k.pastVisit(t, p, first)               // registered over a year ago
	k.pastVisit(t, p, addisAt(-40, 10, 0)) // came back 40 days ago
	rgExpect(t, k.arrive(t, p), false, "returning today")
	s := k.status(t, p)
	if s.Due || s.Reason != "registered" || s.RegisteredOn != first.Format("2006-01-02") || s.ValidUntil != "" {
		t.Fatalf("status %+v, want registered on %s, never expiring", s, first.Format("2006-01-02"))
	}
	var regs, consults int
	one(t, `SELECT count(*) FILTER (WHERE description = 'Registration')::int FROM charges WHERE patient_id = $1`, &regs, blPatientUUID(t, p))
	one(t, `SELECT count(*) FILTER (WHERE description = 'Consultation')::int FROM charges WHERE patient_id = $1`, &consults, blPatientUUID(t, p))
	if regs != 1 || consults != 3 {
		t.Fatalf("three visits: %d registration and %d consultation fees, want 1 and 3", regs, consults)
	}
}

// TestREG_REGFEE_003_RenewAfterDays: Given registration valid for 30 days, When the
// last registration was 29 days ago, Then it is not charged (valid until tomorrow);
// When it was 30 days ago, Then it is charged again.
func TestREG_REGFEE_003_RenewAfterDays(t *testing.T) {
	k := rgNewKit(t)
	k.setPolicy(t, "every", 30, "day")
	for _, c := range []struct {
		ago int
		due bool
	}{{29, false}, {30, true}, {31, true}} {
		p := createPatient(t, k.recp, uniq("Days"), fmt.Sprint(c.ago))
		k.pastVisit(t, p, addisAt(-c.ago, 10, 0))
		s := k.status(t, p)
		wantUntil := addisAt(-c.ago+30, 0, 0).Format("2006-01-02")
		if s.Due != c.due || s.ValidUntil != wantUntil {
			t.Fatalf("paid %d days ago: %+v, want due=%v valid until %s", c.ago, s, c.due, wantUntil)
		}
		rgExpect(t, k.arrive(t, p), c.due, fmt.Sprintf("paid %d days ago", c.ago))
	}
}

// TestREG_REGFEE_004_RenewAfterWeeksAndMonths: a week means 7 days; two months means
// the same date two months on (and the month's end when there is no such date).
func TestREG_REGFEE_004_RenewAfterWeeksAndMonths(t *testing.T) {
	k := rgNewKit(t)
	k.setPolicy(t, "every", 1, "week")
	p := createPatient(t, k.recp, uniq("Week"), "Six")
	k.pastVisit(t, p, addisAt(-6, 10, 0))
	rgExpect(t, k.arrive(t, p), false, "6 days into a weekly registration")
	q := createPatient(t, k.recp, uniq("Week"), "Seven")
	k.pastVisit(t, q, addisAt(-7, 10, 0))
	rgExpect(t, k.arrive(t, q), true, "7 days into a weekly registration")

	k.setPolicy(t, "every", 2, "month")
	today := time.Now().In(addisLoc())
	twoAgo := time.Date(today.Year(), today.Month()-2, today.Day(), 10, 0, 0, 0, addisLoc())
	if twoAgo.Day() != today.Day() {
		t.Skip("today has no same date two months back; the month-end rule is covered by the unit test")
	}
	m := createPatient(t, k.recp, uniq("Month"), "Two")
	k.pastVisit(t, m, twoAgo)
	rgExpect(t, k.arrive(t, m), true, "exactly two months later")
	n := createPatient(t, k.recp, uniq("Month"), "Short")
	k.pastVisit(t, n, twoAgo.AddDate(0, 0, 1))
	rgExpect(t, k.arrive(t, n), false, "a day short of two months")
}

// TestREG_REGFEE_005_WhatCountsAsRegistered: under "one time only", a waived fee and
// a fee agreed to be paid later count as registered; a voided fee and a refunded fee
// do not; an unpaid fee from an earlier day is still owed, so no second one is added.
func TestREG_REGFEE_005_WhatCountsAsRegistered(t *testing.T) {
	k := rgNewKit(t)
	k.setPolicy(t, "once", 0, "")
	old := addisAt(-10, 10, 0)
	regOf := func(p patientRef) string {
		var cid [16]byte
		one(t, `SELECT id FROM charges WHERE patient_id = $1 AND description = 'Registration' ORDER BY created_at DESC LIMIT 1`, &cid, blPatientUUID(t, p))
		return id.Encode(id.PrefixCharge, cid)
	}
	backdate := func(p patientRef) {
		blExec(t, `UPDATE charges SET created_at = $2 WHERE patient_id = $1`, blPatientUUID(t, p), old)
		blExec(t, `UPDATE queue_entries SET state = 'done', enqueued_at = $2 WHERE patient_id = $1`, blPatientUUID(t, p), old)
	}

	waived := createPatient(t, k.recp, uniq("Waived"), "Fee")
	k.arrive(t, waived)
	k.cashier.Do("POST", "/billing/charges/"+regOf(waived)+"/waive", map[string]any{"reason": "Staff / dependent"}).Expect(t, 204, "waive")
	backdate(waived)
	rgExpect(t, k.arrive(t, waived), false, "registration waived last week")

	voided := createPatient(t, k.recp, uniq("Voided"), "Fee")
	k.arrive(t, voided)
	k.cashier.Do("POST", "/billing/charges/"+regOf(voided)+"/void", map[string]any{"reason": "keyed twice"}).Expect(t, 204, "void")
	backdate(voided)
	rgExpect(t, k.arrive(t, voided), true, "registration voided last week")

	refunded := createPatient(t, k.recp, uniq("Refunded"), "Fee")
	k.arrive(t, refunded)
	ch := regOf(refunded)
	paySettle(k.cashier, ch).Expect(t, 204, "settle")
	k.mgr.Do("POST", "/billing/charges/"+ch+"/refund", map[string]any{"reason": "registered twice"}).Expect(t, 204, "refund")
	backdate(refunded)
	rgExpect(t, k.arrive(t, refunded), true, "registration refunded last week")

	owed := createPatient(t, k.recp, uniq("Owed"), "Fee")
	k.arrive(t, owed) // never paid: still pending
	backdate(owed)
	s := k.status(t, owed)
	if s.Due || s.Reason != "owed" {
		t.Fatalf("unpaid registration from last week: %+v, want not due (owed)", s)
	}
	rgExpect(t, k.arrive(t, owed), false, "registration still owed from last week")
	var regs int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1 AND description = 'Registration'`, &regs, blPatientUUID(t, owed))
	if regs != 1 {
		t.Fatalf("%d registration fees for a patient who still owes one, want 1", regs)
	}
}

// TestREG_REGFEE_006_PaperRegisterPatients: Given "one time only" and a patient
// brought over from the paper register, Then they are registered (reason "paper")
// and not charged; When the clinic switches that off, Then they are charged.
func TestREG_REGFEE_006_PaperRegisterPatients(t *testing.T) {
	k := rgNewKit(t)
	k.setPolicy(t, "once", 0, "")
	p := createPatient(t, k.recp, uniq("Paper"), "Card")
	blExec(t, `UPDATE patients SET first_visit_date = '2019-05-01' WHERE id = $1`, blPatientUUID(t, p))
	if s := k.status(t, p); s.Due || s.Reason != "paper" || s.RegisteredOn == "" {
		t.Fatalf("paper-register patient %+v, want registered (paper)", s)
	}
	rgExpect(t, k.arrive(t, p), false, "paper-register patient")

	k.mgr.Do("PUT", "/billing/registration-policy", map[string]any{
		"service_id": k.reg, "rule": "once", "paper_patients_registered": false,
	}).Expect(t, 200, "switch paper off")
	q := createPatient(t, k.recp, uniq("Paper"), "Off")
	blExec(t, `UPDATE patients SET first_visit_date = '2019-05-01' WHERE id = $1`, blPatientUUID(t, q))
	rgExpect(t, k.arrive(t, q), true, "paper-register patient with the switch off")
}

// TestREG_REGFEE_007_DatesAreTheClinicDay: Given registration valid for 1 day, When
// it was paid at 23:30 Addis yesterday, Then it is due today; When it was paid at
// 00:30 Addis today, Then it is not (both are the same UTC day at some hours).
func TestREG_REGFEE_007_DatesAreTheClinicDay(t *testing.T) {
	if time.Now().In(addisLoc()).Before(addisAt(0, 0, 31)) {
		t.Skip("00:30 Addis today has not happened yet")
	}
	k := rgNewKit(t)
	k.setPolicy(t, "every", 1, "day")
	late := createPatient(t, k.recp, uniq("Late"), "Night")
	k.pastVisit(t, late, addisAt(-1, 23, 30))
	if s := k.status(t, late); !s.Due || s.RegisteredOn != addisAt(-1, 0, 0).Format("2006-01-02") {
		t.Fatalf("paid 23:30 Addis yesterday: %+v, want due, registered yesterday", s)
	}
	early := createPatient(t, k.recp, uniq("Early"), "Morning")
	k.pastVisit(t, early, addisAt(0, 0, 30))
	if s := k.status(t, early); s.Due || s.RegisteredOn != payAddisToday() {
		t.Fatalf("paid 00:30 Addis today: %+v, want registered today, not due", s)
	}
}

// TestREG_REGFEE_008_SettingTheRule: only billing managers set the rule; it must
// name one of the clinic's arrival fees; "every" needs a number of days, weeks or
// months; every staff member can read it; each clinic has its own.
func TestREG_REGFEE_008_SettingTheRule(t *testing.T) {
	k := rgNewKit(t)
	k.recp.Do("PUT", "/billing/registration-policy", map[string]any{"service_id": k.reg, "rule": "once"}).Expect(t, 403, "reception sets the rule")
	plain := blService(t, k.mgr, "X-ray", "general", 500, "")
	for _, c := range []struct {
		body map[string]any
		what string
	}{
		{map[string]any{"service_id": k.reg, "rule": "every"}, "every with no period"},
		{map[string]any{"service_id": k.reg, "rule": "every", "every_count": 0, "every_unit": "day"}, "every 0 days"},
		{map[string]any{"service_id": k.reg, "rule": "every", "every_count": 2, "every_unit": "year"}, "every 2 years"},
		{map[string]any{"service_id": k.reg, "rule": "sometimes"}, "unknown rule"},
		{map[string]any{"rule": "once"}, "once with no fee named"},
		{map[string]any{"service_id": plain, "rule": "once"}, "a fee not charged at arrival"},
		{map[string]any{"service_id": "svc_nope", "rule": "once"}, "a malformed fee id"},
		{map[string]any{"service_id": k.reg, "rule": 5}, "a rule that is not text"},
	} {
		k.mgr.Do("PUT", "/billing/registration-policy", c.body).Expect(t, 400, c.what)
	}
	var pol rgPolicy
	k.mgr.Do("PUT", "/billing/registration-policy", map[string]any{
		"service_id": k.reg, "rule": "every", "every_count": 2, "every_unit": "month", "paper_patients_registered": false,
	}).Expect(t, 200, "save").Decode(t, &pol)
	if pol.Rule != "every" || pol.EveryCount == nil || *pol.EveryCount != 2 || pol.EveryUnit != "month" ||
		pol.PaperPatientsRegistered || pol.ServiceID == nil || *pol.ServiceID != k.reg {
		t.Fatalf("saved policy %+v", pol)
	}
	k.recp.Do("GET", "/billing/registration-policy", nil).Expect(t, 200, "reception reads").Decode(t, &pol)
	if pol.Rule != "every" {
		t.Fatalf("reception reads %+v", pol)
	}
	// Switching back to every visit drops the period.
	k.mgr.Do("PUT", "/billing/registration-policy", map[string]any{"service_id": k.reg, "rule": "every_visit"}).Expect(t, 200, "every visit").Decode(t, &pol)
	if pol.Rule != "every_visit" || pol.EveryCount != nil || pol.EveryUnit != "" {
		t.Fatalf("every-visit policy kept a period: %+v", pol)
	}
	// Another clinic still has its own default.
	var other rgPolicy
	srv.As(t, clinicB, "owner").Do("GET", "/billing/registration-policy", nil).Expect(t, 200, "clinic B").Decode(t, &other)
	if other.ServiceID != nil && *other.ServiceID == k.reg {
		t.Fatalf("clinic B sees clinic A's registration fee")
	}
	k.recp.Do("GET", "/billing/registration-status?patient=pat_nope", nil).Expect(t, 400, "malformed patient")
	k.recp.Do("GET", "/billing/registration-status?patient="+id.Encode(id.PrefixPatient, [16]byte{1}), nil).Expect(t, 404, "unknown patient")
	srv.As(t, k.c, "doctor").Do("GET", "/billing/registration-status?patient="+createPatient(t, k.recp, uniq("Doc"), "View").ID, nil).
		Expect(t, 403, "a dentist without payment rights")
	var saved string
	one(t, `SELECT count(*)::text FROM event_outbox WHERE tenant_id = $1 AND event_type = 'billing.registration_policy.saved'`, &saved, k.c.TenantID)
	if saved == "0" {
		t.Fatalf("saving the rule left no record")
	}
}

// TestREG_REGFEE_009_TwoDesksOneFirstRegistration: Given "one time only" and a
// brand-new patient, When four desks receive them at the same moment, Then exactly
// one registration fee and one consultation fee are raised.
func TestREG_REGFEE_009_TwoDesksOneFirstRegistration(t *testing.T) {
	k := rgNewKit(t)
	k.setPolicy(t, "once", 0, "")
	p := createPatient(t, k.recp, uniq("Race"), "New")
	desks := []*testkit.Client{k.recp, srv.As(t, k.c, "receptionist"), srv.As(t, k.c, "branch_manager"), srv.As(t, k.c, "owner")}
	done := make(chan struct{})
	for _, d := range desks {
		go func(d *testkit.Client) {
			defer func() { done <- struct{}{} }()
			d.Do("POST", "/queue/walk-in", map[string]any{"patient_id": p.ID, "department_id": blDept(k.c), "branch_id": payBranch(t, k.c)})
		}(d)
	}
	for range desks {
		<-done
	}
	var reg, consult int
	one(t, `SELECT count(*) FILTER (WHERE description = 'Registration')::int FROM charges WHERE patient_id = $1`, &reg, blPatientUUID(t, p))
	one(t, `SELECT count(*) FILTER (WHERE description = 'Consultation')::int FROM charges WHERE patient_id = $1`, &consult, blPatientUUID(t, p))
	if reg != 1 || consult != 1 {
		t.Fatalf("four desks at once: %d registration and %d consultation fees, want 1 each", reg, consult)
	}
}
