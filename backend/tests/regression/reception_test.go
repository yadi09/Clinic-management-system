package regression

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/testkit"
)

// The reception patient card and "pay earlier bills at the desk" (FEAT-RECEP-1).
//
// The receptionist sees one patient's day on one screen and may tick earlier unpaid
// bills the patient agrees to pay. Those bills hold the patient at the cashier exactly
// as the registration fee does, and once the cashier has cleared them the patient goes
// to the dentist the receptionist chose.

type rcvKit struct {
	c                       *testkit.Clinic
	recp, cashier, mgr, doc *testkit.Client
	docID                   string
}

func rcvNewKit(t *testing.T) rcvKit {
	t.Helper()
	c := payClinic(t)
	return rcvKit{
		c: c, recp: srv.As(t, c, "receptionist"), cashier: srv.As(t, c, "cashier"),
		mgr: srv.As(t, c, "branch_manager"), doc: srv.As(t, c, "doctor"),
		docID: blUser(c.Staff["doctor"]),
	}
}

// oldBill raises an unpaid charge and moves it `days` back, so it reads as an earlier
// visit's bill.
func (k rcvKit) oldBill(t *testing.T, p patientRef, amount float64, days int) string {
	t.Helper()
	ch := payRaise(t, k.recp, k.c, p.ID, amount)
	blExec(t, `UPDATE charges SET created_at = now() - make_interval(days => $2) WHERE id = $1`,
		payChargeUUID(t, k.c, ch), days)
	return ch
}

type rcvArrival struct {
	Gated     bool     `json:"gated"`
	ChargeIDs []string `json:"charge_ids"`
}

func (k rcvKit) walkIn(t *testing.T, p patientRef, selected ...string) (testkit.Resp, rcvArrival) {
	t.Helper()
	body := map[string]any{
		"patient_id": p.ID, "department_id": blDept(k.c), "branch_id": payBranch(t, k.c), "provider_id": k.docID,
	}
	if len(selected) > 0 {
		body["select_charge_ids"] = selected
	}
	r := k.recp.Do("POST", "/queue/walk-in", body)
	var a rcvArrival
	if r.Status == 201 {
		r.Decode(t, &a)
	}
	return r, a
}

// queued says how many live queue entries the patient has today and who they go to.
func rcvQueued(t *testing.T, p patientRef) (n int, provider *uuid.UUID) {
	t.Helper()
	pu := blPatientUUID(t, p)
	one(t, `SELECT count(*)::int FROM queue_entries WHERE patient_id = $1 AND deleted_at IS NULL`, &n, pu)
	if n > 0 {
		one(t, `SELECT assigned_provider_id FROM queue_entries WHERE patient_id = $1 AND deleted_at IS NULL LIMIT 1`, &provider, pu)
	}
	return n, provider
}

type rcvCard struct {
	Appointment *struct {
		AppointmentID string `json:"appointment_id"`
		Title         string `json:"title"`
		ProviderName  string `json:"provider_name"`
	} `json:"appointment"`
	Session *struct {
		Title string `json:"title"`
	} `json:"session"`
	Missed []struct {
		Kind  string `json:"kind"`
		When  string `json:"when"`
		Title string `json:"title"`
	} `json:"missed"`
	Next *struct {
		Kind string `json:"kind"`
		When string `json:"when"`
	} `json:"next"`
	Bills []struct {
		ID         string `json:"id"`
		Amount     string `json:"amount"`
		AgeDays    int    `json:"age_days"`
		AtCashier  bool   `json:"at_cashier"`
		Agreed     bool   `json:"agreed"`
		AgreedWhy  string `json:"agreed_why"`
		DeskPicked bool   `json:"desk_picked"`
	} `json:"bills"`
	OwedTotal         string `json:"owed_total"`
	UnbilledTotal     string `json:"unbilled_total"`
	UsualProviderName string `json:"usual_provider_name"`
	InQueue           bool   `json:"in_queue"`
}

func (k rcvKit) card(t *testing.T, p patientRef) rcvCard {
	t.Helper()
	var c rcvCard
	k.recp.Do("GET", "/reception/patients/"+p.ID+"/card", nil).Expect(t, 200, "reception card").Decode(t, &c)
	return c
}

// TestREG_RECEP_001_CardShowsTodayMissedNextAndBills: Given a patient with a booking
// today, a missed visit last week, a visit booked next week and two earlier unpaid
// bills, When the desk opens the card, Then every one of those is on it, itemised,
// oldest bill first, and the total equals the sum.
func TestREG_RECEP_001_CardShowsTodayMissedNextAndBills(t *testing.T) {
	k := rcvNewKit(t)
	e := &apptEnv{c: k.c, desk: k.recp, doc: k.doc, branch: payBranch(t, k.c), dept: blDept(k.c), docID: k.docID}
	p := e.patient(t)

	today := e.book(t, p.ID, time.Now().Add(2*time.Hour), 30)
	missed := e.book(t, p.ID, apptTomorrowAt(9, 0), 30)
	blExec(t, `UPDATE appointments SET starts_at = now() - interval '6 days', ends_at = now() - interval '6 days' + interval '30 minutes',
	           status = 'no_show' WHERE id = $1`, apptUUID(t, missed.ID))
	e.book(t, p.ID, apptTomorrowAt(10, 0).AddDate(0, 0, 6), 30)
	k.oldBill(t, p, 1200, 38)
	k.oldBill(t, p, 800, 5)

	c := k.card(t, p)
	if c.Appointment == nil || c.Appointment.AppointmentID != today.ID {
		t.Fatalf("today's booking missing from the card: %+v", c.Appointment)
	}
	if len(c.Missed) != 1 || c.Missed[0].Kind != "appointment" {
		t.Fatalf("missed visits = %+v, want the one no-show", c.Missed)
	}
	if c.Next == nil || c.Next.Kind != "appointment" {
		t.Fatalf("next visit missing: %+v", c.Next)
	}
	if len(c.Bills) != 2 || c.Bills[0].Amount != "1200.00" || c.Bills[0].AgeDays != 38 || c.Bills[1].Amount != "800.00" {
		t.Fatalf("bills = %+v, want 1200 (38 days) then 800", c.Bills)
	}
	if c.OwedTotal != "2000.00" {
		t.Fatalf("owed total = %q, want 2000.00 (the Finance definition)", c.OwedTotal)
	}
	if c.InQueue {
		t.Fatal("a patient not yet received is shown as in the queue")
	}
}

// TestREG_RECEP_002_CardShowsTodaysTreatmentSession: Given a treatment whose visit is
// planned today, When the desk opens the card, Then it names the treatment and the
// visit ("..., visit 1 of 2").
func TestREG_RECEP_002_CardShowsTodaysTreatmentSession(t *testing.T) {
	k := rcvNewKit(t)
	p := createPatient(t, k.recp, uniq("Sess"), "Patient")
	createPlan(t, k.doc, p.ID, "3000", 2, "")
	c := k.card(t, p)
	if c.Session == nil || c.Session.Title == "" {
		t.Fatalf("today's planned session missing from the card: %+v", c.Session)
	}
	if c.UnbilledTotal == "" {
		t.Fatal("unbilled total missing")
	}
}

// TestREG_RECEP_003_CardRefusesAnotherClinicAndUnknown: Given a patient of another
// clinic, When this clinic's desk opens their card, Then it is a 404 — nothing about
// them is reachable; and a malformed id is a 400.
func TestREG_RECEP_003_CardRefusesAnotherClinicAndUnknown(t *testing.T) {
	k := rcvNewKit(t)
	other := payClinic(t)
	theirs := createPatient(t, srv.As(t, other, "receptionist"), uniq("Other"), "Clinic")
	k.recp.Do("GET", "/reception/patients/"+theirs.ID+"/card", nil).Expect(t, 404, "another clinic's patient")
	k.recp.Do("GET", "/reception/patients/not-an-id/card", nil).Expect(t, 400, "malformed id")
	nobody := blCustomUser(t, k.c)
	nobody.Do("GET", "/reception/patients/"+theirs.ID+"/card", nil).Expect(t, 403, "no queue.manage")
}

// TestREG_RECEP_004_TickedBillHoldsPatientThenGoesToChosenDentist: Given a patient
// whose visit is free but who owes an earlier bill and agrees to pay it, When the desk
// receives them with that bill ticked, Then they are NOT in the queue; When the
// cashier collects the bill, Then they are in the queue of the dentist the desk chose,
// exactly once.
func TestREG_RECEP_004_TickedBillHoldsPatientThenGoesToChosenDentist(t *testing.T) {
	k := rcvNewKit(t)
	p := createPatient(t, k.recp, uniq("Tick"), "Patient")
	bill := k.oldBill(t, p, 1200, 38)

	r, a := k.walkIn(t, p, bill)
	r.Expect(t, 201, "walk-in with a ticked bill")
	if !a.Gated || len(a.ChargeIDs) != 1 || a.ChargeIDs[0] != bill {
		t.Fatalf("arrival = %+v, want gated on exactly the ticked bill", a)
	}
	if n, _ := rcvQueued(t, p); n != 0 {
		t.Fatalf("patient queued before paying the ticked bill (%d entries)", n)
	}
	// Pressing again is the desk being impatient, not a second arrival.
	r2, a2 := k.walkIn(t, p, bill)
	r2.Expect(t, 201, "second press")
	if !a2.Gated {
		t.Fatalf("second press = %+v, want still gated", a2)
	}

	k.cashier.Do("POST", "/billing/checkout", map[string]any{
		"patient_id": p.ID, "method": "cash", "charge_ids": []string{bill},
	}).Expect(t, 200, "cashier collects the ticked bill")

	n, prov := rcvQueued(t, p)
	if n != 1 {
		t.Fatalf("patient has %d queue entries after paying, want exactly 1", n)
	}
	if prov == nil || *prov != k.c.Staff["doctor"].ID {
		t.Fatalf("patient went to provider %v, want the dentist the desk chose", prov)
	}
	var left int
	one(t, `SELECT count(*)::int FROM reception_routes WHERE patient_id = $1`, &left, blPatientUUID(t, p))
	if left != 0 {
		t.Fatal("the route row was not consumed once the patient was queued")
	}
}

// TestREG_RECEP_005_ChosenDentistWinsOverOrderOfPayment: Given today's registration
// fee at the cashier AND a ticked earlier bill, When the cashier collects the earlier
// bill first and the fee second (and then in the other order for another patient),
// Then both go to the chosen dentist, only after the last payment.
func TestREG_RECEP_005_ChosenDentistWinsOverOrderOfPayment(t *testing.T) {
	k := rcvNewKit(t)
	reg := blService(t, k.mgr, "Registration", "general", 100, "")
	k.mgr.Do("PUT", "/billing/services/"+reg+"/default", map[string]any{"is_default": true}).Expect(t, 204, "arrival fee")

	for _, oldFirst := range []bool{true, false} {
		p := createPatient(t, k.recp, uniq("Order"), "Patient")
		bill := k.oldBill(t, p, 500, 20)
		r, a := k.walkIn(t, p, bill)
		r.Expect(t, 201, "walk-in")
		if len(a.ChargeIDs) != 2 {
			t.Fatalf("arrival %+v, want today's fee and the ticked bill", a)
		}
		fee := a.ChargeIDs[0]
		if fee == bill {
			fee = a.ChargeIDs[1]
		}
		first, second := bill, fee
		if !oldFirst {
			first, second = fee, bill
		}
		paySettle(k.cashier, first).Expect(t, 204, "first payment")
		if n, _ := rcvQueued(t, p); n != 0 {
			t.Fatalf("queued after only one of two payments (old bill first=%v)", oldFirst)
		}
		paySettle(k.cashier, second).Expect(t, 204, "second payment")
		n, prov := rcvQueued(t, p)
		if n != 1 || prov == nil || *prov != k.c.Staff["doctor"].ID {
			t.Fatalf("old first=%v: queued %d to %v, want 1 to the chosen dentist", oldFirst, n, prov)
		}
	}
}

// TestREG_RECEP_006_StaleSelectionIsRefusedWhole: Given a bill that was paid while the
// desk was talking to the patient, When the desk receives them with it ticked, Then
// the whole arrival is refused (409) and nothing is recorded: not checked in, no route,
// no half-selection.
func TestREG_RECEP_006_StaleSelectionIsRefusedWhole(t *testing.T) {
	k := rcvNewKit(t)
	p := createPatient(t, k.recp, uniq("Stale"), "Patient")
	paid := k.oldBill(t, p, 300, 10)
	live := k.oldBill(t, p, 400, 9)
	paySettle(k.cashier, paid).Expect(t, 204, "someone else paid it")

	r, _ := k.walkIn(t, p, live, paid)
	if r.Status != 409 {
		t.Fatalf("status = %d (%s), want 409 BILLS_CHANGED", r.Status, r.Raw)
	}
	var selected, routes int
	one(t, `SELECT count(*)::int FROM charges WHERE patient_id = $1 AND desk_selected_at IS NOT NULL`, &selected, blPatientUUID(t, p))
	one(t, `SELECT count(*)::int FROM reception_routes WHERE patient_id = $1`, &routes, blPatientUUID(t, p))
	if selected != 0 || routes != 0 {
		t.Fatalf("a refused arrival left %d selected bills and %d routes behind", selected, routes)
	}
	if n, _ := rcvQueued(t, p); n != 0 {
		t.Fatal("a refused arrival still queued the patient")
	}
	// Another patient's bill cannot be ticked for this patient either.
	q := createPatient(t, k.recp, uniq("Other"), "Patient")
	theirs := k.oldBill(t, q, 100, 3)
	r, _ = k.walkIn(t, p, theirs)
	if r.Status != 409 {
		t.Fatalf("ticking another patient's bill: status %d, want 409", r.Status)
	}
	rBad := k.recp.Do("POST", "/queue/walk-in", map[string]any{
		"patient_id": p.ID, "department_id": blDept(k.c), "select_charge_ids": []string{"nonsense"},
	})
	rBad.Expect(t, 400, "malformed bill id")
}

// TestREG_RECEP_007_CashierSeesWhatWasTicked: Given a ticked bill, When the cashier
// opens the worklist, Then the bill is marked as picked at the desk, by whom, and who
// the patient goes to; an unticked bill is not.
func TestREG_RECEP_007_CashierSeesWhatWasTicked(t *testing.T) {
	k := rcvNewKit(t)
	p := createPatient(t, k.recp, uniq("Work"), "Patient")
	ticked := k.oldBill(t, p, 700, 12)
	plain := k.oldBill(t, p, 250, 3)
	k.walkIn(t, p, ticked)

	var list []struct {
		ID             string `json:"id"`
		DeskSelected   bool   `json:"desk_selected"`
		DeskSelectedBy string `json:"desk_selected_by"`
		GoesTo         string `json:"goes_to"`
	}
	k.cashier.Do("GET", "/billing/charges/pending", nil).Expect(t, 200, "worklist").Decode(t, &list)
	seen := 0
	for _, x := range list {
		switch x.ID {
		case ticked:
			seen++
			if !x.DeskSelected || x.DeskSelectedBy == "" || x.GoesTo == "" {
				t.Fatalf("ticked bill on the worklist = %+v, want picked, by whom, goes to", x)
			}
		case plain:
			seen++
			if x.DeskSelected {
				t.Fatalf("an unticked bill is marked as picked at the desk: %+v", x)
			}
		}
	}
	if seen != 2 {
		t.Fatalf("worklist showed %d of the 2 bills", seen)
	}
}

// TestREG_RECEP_008_PayLaterReleasesATickedBill: Given a ticked bill holding the
// patient, When the cashier uses Pay later with a reason, Then the patient goes
// through to the chosen dentist and the bill is still owed.
func TestREG_RECEP_008_PayLaterReleasesATickedBill(t *testing.T) {
	k := rcvNewKit(t)
	p := createPatient(t, k.recp, uniq("Later"), "Patient")
	bill := k.oldBill(t, p, 900, 30)
	k.walkIn(t, p, bill)
	if n, _ := rcvQueued(t, p); n != 0 {
		t.Fatal("queued before the cashier decided")
	}
	k.cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "Cannot pay today"}).
		Expect(t, 200, "pay later")
	n, prov := rcvQueued(t, p)
	if n != 1 || prov == nil || *prov != k.c.Staff["doctor"].ID {
		t.Fatalf("after Pay later: queued %d to %v, want 1 to the chosen dentist", n, prov)
	}
	var status string
	var sel *time.Time
	one(t, `SELECT status FROM charges WHERE id = $1`, &status, payChargeUUID(t, k.c, bill))
	one(t, `SELECT desk_selected_at FROM charges WHERE id = $1`, &sel, payChargeUUID(t, k.c, bill))
	if status != "pending" || sel != nil {
		t.Fatalf("bill after Pay later: status %q selected %v, want still owed and no longer holding", status, sel)
	}
}

// TestREG_RECEP_009_AgreedBillCanBeTickedAndHoldsAgain: Given a bill the clinic had
// agreed to wait for, When the patient decides to pay it now and the desk ticks it,
// Then it holds the patient until paid; the card shows it as agreed, with the reason.
func TestREG_RECEP_009_AgreedBillCanBeTickedAndHoldsAgain(t *testing.T) {
	k := rcvNewKit(t)
	p := createPatient(t, k.recp, uniq("Agreed"), "Patient")
	bill := k.oldBill(t, p, 600, 15)
	k.cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "Staff dependent", "charge_ids": []string{bill}}).
		Expect(t, 200, "agree to wait")

	c0 := k.card(t, p)
	if len(c0.Bills) != 1 || !c0.Bills[0].Agreed || c0.Bills[0].AgreedWhy != "Staff dependent" {
		t.Fatalf("card bills = %+v, want one agreed bill with its reason", c0.Bills)
	}
	r, a := k.walkIn(t, p, bill)
	r.Expect(t, 201, "tick an agreed bill")
	if !a.Gated {
		t.Fatalf("arrival = %+v, want the patient held for the bill they chose to pay", a)
	}
	if n, _ := rcvQueued(t, p); n != 0 {
		t.Fatal("patient queued although they chose to pay the agreed bill first")
	}
	if got := k.card(t, p).Bills; len(got) != 1 || !got[0].DeskPicked {
		t.Fatalf("card after ticking = %+v, want the bill marked picked", got)
	}
}

// TestREG_RECEP_010_AppointmentCheckInTakesTickedBills: Given a patient with a booking
// today and an earlier bill, When the desk checks them in with the bill ticked, Then
// the booking is checked in, the patient waits at the cashier and, once paid, goes to
// the booking's dentist.
func TestREG_RECEP_010_AppointmentCheckInTakesTickedBills(t *testing.T) {
	k := rcvNewKit(t)
	e := &apptEnv{c: k.c, desk: k.recp, doc: k.doc, branch: payBranch(t, k.c), dept: blDept(k.c), docID: k.docID}
	p := e.patient(t)
	appt := e.book(t, p.ID, time.Now().Add(time.Hour), 30)
	bill := k.oldBill(t, p, 450, 21)

	var res rcvArrival
	k.recp.Do("POST", "/appointments/"+appt.ID+"/check-in", map[string]any{"select_charge_ids": []string{bill}}).
		Expect(t, 200, "check in with a ticked bill").Decode(t, &res)
	if !res.Gated || len(res.ChargeIDs) != 1 {
		t.Fatalf("check-in = %+v, want gated on the ticked bill", res)
	}
	if apptStatus(t, appt.ID) != "checked_in" {
		t.Fatalf("appointment status %q, want checked_in", apptStatus(t, appt.ID))
	}
	if n, _ := rcvQueued(t, p); n != 0 {
		t.Fatal("queued before paying the ticked bill")
	}
	paySettle(k.cashier, bill).Expect(t, 204, "pay")
	if n, prov := rcvQueued(t, p); n != 1 || prov == nil || *prov != k.c.Staff["doctor"].ID {
		t.Fatalf("after paying: %d entries to %v, want 1 to the booked dentist", n, prov)
	}
	if got := k.card(t, p); !got.InQueue {
		t.Fatal("card does not say the patient is in the queue")
	}
}

// TestREG_RECEP_011_VoidingATickedBillReleasesNoOne: Given a ticked bill that is then
// voided, When the patient has no other holding bill, Then they can still be received
// normally afterwards (the stale route does not trap them).
func TestREG_RECEP_011_VoidingATickedBillDoesNotTrapThePatient(t *testing.T) {
	k := rcvNewKit(t)
	p := createPatient(t, k.recp, uniq("Void"), "Patient")
	bill := k.oldBill(t, p, 350, 8)
	k.walkIn(t, p, bill)
	k.cashier.Do("POST", "/billing/charges/"+bill+"/void", map[string]any{"reason": "Keying error"}).Expect(t, 204, "void")
	r, a := k.walkIn(t, p)
	r.Expect(t, 201, "receive again with nothing ticked")
	if a.Gated {
		t.Fatalf("arrival = %+v, want a free visit with nothing holding", a)
	}
	if n, _ := rcvQueued(t, p); n != 1 {
		t.Fatalf("queue entries = %d, want 1", n)
	}
}

// TestREG_RECEP_012_EmptyDayGuidesTheDesk: Given nobody booked today, a patient
// finished on an earlier day and a booking next week, When the desk opens Reception,
// Then the lists are empty, the returning patient is offered, and the next booking day
// is given with how many are booked that day.
func TestREG_RECEP_012_EmptyDayGuidesTheDesk(t *testing.T) {
	k := rcvNewKit(t)
	e := &apptEnv{c: k.c, desk: k.recp, doc: k.doc, branch: payBranch(t, k.c), dept: blDept(k.c), docID: k.docID}

	var none struct {
		Expected []any `json:"expected"`
		Recent   []struct {
			PatientID string `json:"patient_id"`
			Name      string `json:"name"`
		} `json:"recent"`
		NextBooking *struct {
			StartsAt string `json:"starts_at"`
			Count    int    `json:"count"`
		} `json:"next_booking"`
	}
	k.recp.Do("GET", "/reception/today", nil).Expect(t, 200, "empty day").Decode(t, &none)
	if len(none.Recent) != 0 || none.NextBooking != nil {
		t.Fatalf("brand-new clinic: recent %+v, next booking %+v, want neither", none.Recent, none.NextBooking)
	}

	p := e.patient(t)
	pu := blPatientUUID(t, p)
	wr, _ := k.walkIn(t, p)
	wr.Expect(t, 201, "walk-in")
	blExec(t, `UPDATE queue_entries SET state = 'done', enqueued_at = now() - interval '3 days' WHERE patient_id = $1`, pu)
	day := apptTomorrowAt(9, 0).AddDate(0, 0, 5)
	e.book(t, e.patient(t).ID, day, 30)
	e.book(t, e.patient(t).ID, day.Add(time.Hour), 30)
	e.book(t, e.patient(t).ID, day.AddDate(0, 0, 3), 30)

	k.recp.Do("GET", "/reception/today", nil).Expect(t, 200, "day with history").Decode(t, &none)
	if len(none.Expected) != 0 {
		t.Fatalf("expected list = %d, want an empty day", len(none.Expected))
	}
	if len(none.Recent) != 1 || none.Recent[0].PatientID != p.ID {
		t.Fatalf("recent = %+v, want the one returning patient", none.Recent)
	}
	if none.NextBooking == nil || none.NextBooking.Count != 2 {
		t.Fatalf("next booking = %+v, want the first booked day with 2 bookings", none.NextBooking)
	}
}
