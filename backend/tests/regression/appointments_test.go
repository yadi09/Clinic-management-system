package regression

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Appointments, the queue and the front desk. Every appointment test runs in its own
// clinic: the provider-overlap constraint is per doctor, and sharing clinic A's doctor
// with other tests would make slot conflicts depend on what else is running.

// ---- helpers (prefixed appt) --------------------------------------------

// apptAddis is the clinic's day. A fixed zone, so the test does not depend on the
// machine having tzdata (Ethiopia has no DST).
var apptAddis = time.FixedZone("EAT", 3*3600)

// apptTomorrowAt is hh:mm tomorrow, clinic time — always in the future, never today.
func apptTomorrowAt(hh, mm int) time.Time {
	n := time.Now().In(apptAddis).AddDate(0, 0, 1)
	return time.Date(n.Year(), n.Month(), n.Day(), hh, mm, 0, 0, apptAddis)
}

type apptEnv struct {
	c      *testkit.Clinic
	desk   *testkit.Client // receptionist: appointment.manage + queue.manage
	doc    *testkit.Client
	branch string
	dept   string
	docID  string
}

func apptNewEnv(t *testing.T) *apptEnv {
	t.Helper()
	c := newClinic(t)
	return &apptEnv{
		c: c, desk: srv.As(t, c, "receptionist"), doc: srv.As(t, c, "doctor"),
		branch: id.Encode(id.PrefixBranch, c.BranchID), dept: id.Encode(id.PrefixDepartment, c.DeptID),
		docID: id.Encode(id.PrefixUser, c.Staff["doctor"].ID),
	}
}

type apptRef struct {
	ID         string    `json:"id"`
	PatientID  string    `json:"patient_id"`
	ProviderID string    `json:"provider_id"`
	StartsAt   time.Time `json:"starts_at"`
	EndsAt     time.Time `json:"ends_at"`
	Status     string    `json:"status"`
	IsFollowup bool      `json:"is_followup"`
}

func (e *apptEnv) bookBody(patientID string, at time.Time, dur int) map[string]any {
	return map[string]any{
		"branch_id": e.branch, "patient_id": patientID, "provider_id": e.docID, "department_id": e.dept,
		"starts_at": at.Format(time.RFC3339), "duration_min": dur, "reason": "check-up",
	}
}

func (e *apptEnv) book(t *testing.T, patientID string, at time.Time, dur int) apptRef {
	t.Helper()
	r := e.desk.Do("POST", "/appointments", e.bookBody(patientID, at, dur)).Expect(t, 201, "book appointment")
	var a apptRef
	r.Decode(t, &a)
	if a.ID == "" {
		t.Fatalf("book returned no id: %s", r.Raw)
	}
	return a
}

func (e *apptEnv) patient(t *testing.T) patientRef {
	t.Helper()
	return createPatient(t, e.desk, uniq("Appt"), "Patient")
}

func apptUUID(t *testing.T, ext string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(id.PrefixAppointment, ext)
	if err != nil {
		t.Fatalf("decode %q: %v", ext, err)
	}
	return u
}

// apptQueueCount is how many live queue entries the database holds for an appointment.
func apptQueueCount(t *testing.T, apptID string) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM queue_entries WHERE appointment_id = $1 AND deleted_at IS NULL`, &n, apptUUID(t, apptID))
	return n
}

func apptStatus(t *testing.T, apptID string) string {
	t.Helper()
	var s string
	one(t, `SELECT status FROM appointments WHERE id = $1`, &s, apptUUID(t, apptID))
	return s
}

// checkIn posts a plain check-in (no routing overrides) as the desk.
func (e *apptEnv) checkIn(t *testing.T, apptID string) testkit.Resp {
	t.Helper()
	return e.desk.Do("POST", "/appointments/"+apptID+"/check-in", map[string]any{})
}

type apptReception struct {
	Expected []struct {
		PatientID     string `json:"patient_id"`
		AppointmentID string `json:"appointment_id"`
		Name          string `json:"name"`
	} `json:"expected"`
	Waiting []struct {
		PatientID string `json:"patient_id"`
	} `json:"waiting"`
}

func (e *apptEnv) reception(t *testing.T) apptReception {
	t.Helper()
	r := e.desk.Do("GET", "/reception/today", nil).Expect(t, 200, "reception today")
	var out apptReception
	r.Decode(t, &out)
	return out
}

// ---- tests --------------------------------------------------------------

// TestREG_APPT_001_BookThenListReturnsIt: Given a patient and a doctor, When the desk
// books tomorrow 10:00 for 30 minutes, Then the API answers 201 status "booked", the
// day's list for the branch returns it, and the row holds branch, department,
// provider and the 30-minute window.
func TestREG_APPT_001_BookThenListReturnsIt(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	at := apptTomorrowAt(10, 0)
	a := e.book(t, p.ID, at, 30)
	if a.Status != "booked" || !a.StartsAt.Equal(at) || !a.EndsAt.Equal(at.Add(30*time.Minute)) || a.PatientID != p.ID || a.ProviderID != e.docID {
		t.Fatalf("booking response wrong: %+v", a)
	}
	from := time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, apptAddis)
	q := "/appointments?branch=" + e.branch + "&from=" + url.QueryEscape(from.Format(time.RFC3339)) +
		"&to=" + url.QueryEscape(from.Add(24*time.Hour).Format(time.RFC3339))
	r := e.desk.Do("GET", q, nil).Expect(t, 200, "list appointments")
	var list []apptRef
	r.Decode(t, &list)
	if len(list) != 1 || list[0].ID != a.ID {
		t.Fatalf("list for the day: want exactly the booked appointment, got %+v", list)
	}
	var branch, dept, prov uuid.UUID
	var mins float64
	aid := apptUUID(t, a.ID)
	one(t, `SELECT branch_id FROM appointments WHERE id = $1`, &branch, aid)
	one(t, `SELECT department_id FROM appointments WHERE id = $1`, &dept, aid)
	one(t, `SELECT provider_id FROM appointments WHERE id = $1`, &prov, aid)
	one(t, `SELECT extract(epoch FROM ends_at - starts_at)/60 FROM appointments WHERE id = $1`, &mins, aid)
	if branch != e.c.BranchID || dept != e.c.DeptID || prov != e.c.Staff["doctor"].ID || mins != 30 {
		t.Fatalf("stored appointment wrong: branch=%v dept=%v provider=%v minutes=%v", branch, dept, prov, mins)
	}
}

// TestREG_APPT_002_BookingWithoutDepartmentIsRefused: Given a booking with no
// department, When it is posted, Then 400 and no appointment row is written (the desk
// could not receive it).
func TestREG_APPT_002_BookingWithoutDepartmentIsRefused(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	body := e.bookBody(p.ID, apptTomorrowAt(9, 0), 30)
	delete(body, "department_id")
	if r := e.desk.Do("POST", "/appointments", body); r.Status != 400 {
		t.Fatalf("booking without department: want 400, got %d %s", r.Status, trimBody(r.Raw))
	}
	var n int
	one(t, `SELECT count(*) FROM appointments WHERE tenant_id = $1`, &n, e.c.TenantID)
	if n != 0 {
		t.Fatalf("refused booking wrote %d appointment rows", n)
	}
}

// TestREG_APPT_003_OverlappingBookingForSameDoctorConflicts: Given the doctor is
// booked 10:00–10:30, When another patient is booked 10:15 with the same doctor,
// Then 409 APPOINTMENT_CONFLICT and only one appointment exists; a booking starting
// exactly at 10:30 (back to back) is accepted.
func TestREG_APPT_003_OverlappingBookingForSameDoctorConflicts(t *testing.T) {
	e := apptNewEnv(t)
	e.book(t, e.patient(t).ID, apptTomorrowAt(10, 0), 30)
	p2 := e.patient(t)
	r := e.desk.Do("POST", "/appointments", e.bookBody(p2.ID, apptTomorrowAt(10, 15), 30))
	if r.Status != 409 || r.Code != "APPOINTMENT_CONFLICT" {
		t.Fatalf("overlap: want 409 APPOINTMENT_CONFLICT, got %d %s", r.Status, trimBody(r.Raw))
	}
	var n int
	one(t, `SELECT count(*) FROM appointments WHERE tenant_id = $1`, &n, e.c.TenantID)
	if n != 1 {
		t.Fatalf("after a refused overlap: %d appointments, want 1", n)
	}
	e.book(t, p2.ID, apptTomorrowAt(10, 30), 30)
}

// TestREG_APPT_004_CancelFreesTheSlot: Given a booked slot, When it is cancelled with
// a reason, Then the row reads cancelled (reason kept) and the same doctor can be
// booked into that exact time again.
func TestREG_APPT_004_CancelFreesTheSlot(t *testing.T) {
	e := apptNewEnv(t)
	at := apptTomorrowAt(11, 0)
	a := e.book(t, e.patient(t).ID, at, 30)
	e.desk.Do("POST", "/appointments/"+a.ID+"/status", map[string]any{"status": "cancelled", "cancel_reason": "patient travelling"}).
		Expect(t, 204, "cancel")
	var reason string
	one(t, `SELECT coalesce(cancel_reason,'') FROM appointments WHERE id = $1`, &reason, apptUUID(t, a.ID))
	if st := apptStatus(t, a.ID); st != "cancelled" || reason != "patient travelling" {
		t.Fatalf("cancel not stored: status=%s reason=%q", st, reason)
	}
	e.book(t, e.patient(t).ID, at, 30)
}

// TestREG_APPT_005_RescheduleIntoAConflictIsRefused: Given two appointments for the
// doctor at 10:00 and 12:00, When the 12:00 one is moved to 10:10, Then 409
// APPOINTMENT_CONFLICT and it stays at 12:00 in the database.
func TestREG_APPT_005_RescheduleIntoAConflictIsRefused(t *testing.T) {
	e := apptNewEnv(t)
	e.book(t, e.patient(t).ID, apptTomorrowAt(10, 0), 30)
	noon := apptTomorrowAt(12, 0)
	b := e.book(t, e.patient(t).ID, noon, 30)
	r := e.desk.Do("PUT", "/appointments/"+b.ID, map[string]any{
		"starts_at": apptTomorrowAt(10, 10).Format(time.RFC3339), "duration_min": 30,
		"provider_id": e.docID, "department_id": e.dept,
	})
	if r.Status != 409 || r.Code != "APPOINTMENT_CONFLICT" {
		t.Fatalf("reschedule into conflict: want 409 APPOINTMENT_CONFLICT, got %d %s", r.Status, trimBody(r.Raw))
	}
	var starts time.Time
	one(t, `SELECT starts_at FROM appointments WHERE id = $1`, &starts, apptUUID(t, b.ID))
	if !starts.Equal(noon) {
		t.Fatalf("refused reschedule still moved the appointment to %v", starts)
	}
}

// TestREG_APPT_006_RescheduleMovesTheAppointment: Given an appointment at 10:00, When
// it is moved to 15:00 for 45 minutes, Then the response and the row carry the new
// window, and the old slot is free for another patient.
func TestREG_APPT_006_RescheduleMovesTheAppointment(t *testing.T) {
	e := apptNewEnv(t)
	old := apptTomorrowAt(10, 0)
	a := e.book(t, e.patient(t).ID, old, 30)
	to := apptTomorrowAt(15, 0)
	r := e.desk.Do("PUT", "/appointments/"+a.ID, map[string]any{
		"starts_at": to.Format(time.RFC3339), "duration_min": 45, "provider_id": e.docID, "department_id": e.dept,
	}).Expect(t, 200, "reschedule")
	var moved apptRef
	r.Decode(t, &moved)
	if !moved.StartsAt.Equal(to) || !moved.EndsAt.Equal(to.Add(45*time.Minute)) {
		t.Fatalf("reschedule response: %+v", moved)
	}
	var starts, ends time.Time
	one(t, `SELECT starts_at FROM appointments WHERE id = $1`, &starts, apptUUID(t, a.ID))
	one(t, `SELECT ends_at FROM appointments WHERE id = $1`, &ends, apptUUID(t, a.ID))
	if !starts.Equal(to) || !ends.Equal(to.Add(45*time.Minute)) {
		t.Fatalf("stored window %v–%v, want %v +45m", starts, ends, to)
	}
	e.book(t, e.patient(t).ID, old, 30)
}

// TestREG_APPT_007_CheckInCreatesExactlyOneQueueEntry: Given a booked appointment
// (no default fee in the clinic), When the desk checks it in, Then the appointment
// reads checked_in and exactly one queue entry exists for it, for that patient,
// department and branch, waiting.
func TestREG_APPT_007_CheckInCreatesExactlyOneQueueEntry(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	a := e.book(t, p.ID, time.Now().Add(-time.Minute), 30)
	r := e.checkIn(t, a.ID).Expect(t, 200, "check in")
	var res struct {
		Gated bool `json:"gated"`
	}
	r.Decode(t, &res)
	if res.Gated {
		t.Fatalf("check-in was fee-gated in a clinic with no default fee: %s", r.Raw)
	}
	if st := apptStatus(t, a.ID); st != "checked_in" {
		t.Fatalf("appointment status after check-in: %s", st)
	}
	if n := apptQueueCount(t, a.ID); n != 1 {
		t.Fatalf("queue entries for the appointment: %d, want 1", n)
	}
	var pid, dept, branch uuid.UUID
	var state string
	aid := apptUUID(t, a.ID)
	one(t, `SELECT patient_id FROM queue_entries WHERE appointment_id = $1`, &pid, aid)
	one(t, `SELECT department_id FROM queue_entries WHERE appointment_id = $1`, &dept, aid)
	one(t, `SELECT branch_id FROM queue_entries WHERE appointment_id = $1`, &branch, aid)
	one(t, `SELECT state FROM queue_entries WHERE appointment_id = $1`, &state, aid)
	pu, _ := id.Decode(id.PrefixPatient, p.ID)
	if pid != pu || dept != e.c.DeptID || branch != e.c.BranchID || state != "waiting" {
		t.Fatalf("queue entry wrong: patient=%v dept=%v branch=%v state=%s", pid, dept, branch, state)
	}
}

// TestREG_APPT_008_CheckingInTwiceDoesNotQueueTwice: Given a checked-in appointment,
// When check-in is pressed again, Then there is still exactly one queue entry for it
// (a second press is the desk repeating itself, not a second arrival).
func TestREG_APPT_008_CheckingInTwiceDoesNotQueueTwice(t *testing.T) {
	e := apptNewEnv(t)
	a := e.book(t, e.patient(t).ID, time.Now().Add(-time.Minute), 30)
	e.checkIn(t, a.ID).Expect(t, 200, "first check-in")
	second := e.checkIn(t, a.ID)
	n := apptQueueCount(t, a.ID)
	testkit.KnownBug(t, "APT-4", n != 1, fmt.Sprintf(
		"second check-in answered %d and the appointment now has %d queue entries — CheckIn never checks the "+
			"appointment's status or an existing entry (scheduling/service/service.go CheckIn)", second.Status, n))
}

// TestREG_APPT_009_CancelledAppointmentCannotBeCheckedIn: Given a cancelled
// appointment, When the desk checks it in, Then the API refuses (4xx), the
// appointment stays cancelled and no queue entry is created.
func TestREG_APPT_009_CancelledAppointmentCannotBeCheckedIn(t *testing.T) {
	e := apptNewEnv(t)
	a := e.book(t, e.patient(t).ID, time.Now().Add(-time.Minute), 30)
	e.desk.Do("POST", "/appointments/"+a.ID+"/status", map[string]any{"status": "cancelled"}).Expect(t, 204, "cancel")
	r := e.checkIn(t, a.ID)
	st, n := apptStatus(t, a.ID), apptQueueCount(t, a.ID)
	accepted := r.Status < 400 || st != "cancelled" || n != 0
	testkit.KnownBug(t, "APT-4", accepted, fmt.Sprintf(
		"check-in of a CANCELLED appointment answered %d; status is now %q and it has %d queue entries",
		r.Status, st, n))
}

// TestREG_APPT_010_CompletedAppointmentCannotBeReopened: Given a completed
// appointment, When its status is set back to confirmed, Then the API refuses and
// it stays completed. ("booked" is not even an accepted target: 400.)
func TestREG_APPT_010_CompletedAppointmentCannotBeReopened(t *testing.T) {
	e := apptNewEnv(t)
	a := e.book(t, e.patient(t).ID, apptTomorrowAt(9, 0), 30)
	e.desk.Do("POST", "/appointments/"+a.ID+"/status", map[string]any{"status": "completed"}).Expect(t, 204, "complete")
	if r := e.desk.Do("POST", "/appointments/"+a.ID+"/status", map[string]any{"status": "booked"}); r.Status != 400 {
		t.Fatalf("status booked: want 400 (not a settable status), got %d", r.Status)
	}
	if st := apptStatus(t, a.ID); st != "completed" {
		t.Fatalf("refused 'booked' still changed the status to %s", st)
	}
	r := e.desk.Do("POST", "/appointments/"+a.ID+"/status", map[string]any{"status": "confirmed"})
	st := apptStatus(t, a.ID)
	testkit.KnownBug(t, "APT-6", r.Status < 400 || st != "completed", fmt.Sprintf(
		"completed → confirmed answered %d and the appointment now reads %q — SetStatus has no transition rules",
		r.Status, st))
}

// TestREG_APPT_011_StatusOfUnknownAppointmentIs404: Given an appointment id that does
// not exist, When its status is set, Then 404 APPOINTMENT_NOT_FOUND.
func TestREG_APPT_011_StatusOfUnknownAppointmentIs404(t *testing.T) {
	e := apptNewEnv(t)
	r := e.desk.Do("POST", "/appointments/"+id.Encode(id.PrefixAppointment, uuid.New())+"/status", map[string]any{"status": "cancelled"})
	if r.Status != 404 {
		t.Fatalf("status of unknown appointment: want 404, got %d %s", r.Status, trimBody(r.Raw))
	}
}

// TestREG_APPT_012_WalkInForAPatientAlreadyQueuedAddsNoSecondEntry: Given a patient
// received as a walk-in today, When the desk walks them in again, Then they still
// have exactly one live queue entry today. (The API answers the repeat with 201
// "queued" — idempotent, not a 409 — which is its documented contract.)
func TestREG_APPT_012_WalkInForAPatientAlreadyQueuedAddsNoSecondEntry(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	body := map[string]any{"branch_id": e.branch, "department_id": e.dept, "patient_id": p.ID}
	r := e.desk.Do("POST", "/queue/walk-in", body).Expect(t, 201, "walk-in")
	var res struct {
		Gated bool `json:"gated"`
	}
	r.Decode(t, &res)
	if res.Gated {
		t.Fatalf("walk-in fee-gated in a clinic with no default fee: %s", r.Raw)
	}
	again := e.desk.Do("POST", "/queue/walk-in", body)
	if again.Status >= 500 {
		t.Fatalf("repeat walk-in: %d %s", again.Status, trimBody(again.Raw))
	}
	pu, _ := id.Decode(id.PrefixPatient, p.ID)
	var n int
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id = $1 AND deleted_at IS NULL AND state NOT IN ('done','no_show')`, &n, pu)
	if n != 1 {
		t.Fatalf("patient walked in twice has %d live queue entries, want 1", n)
	}
}

// TestREG_APPT_013_ReceptionExpectedListsTodaysBookingThenWaiting: Given an
// appointment booked for today, When the desk opens "Expected today", Then it is
// listed; When the patient is checked in, Then it leaves Expected and the patient is
// in Waiting.
func TestREG_APPT_013_ReceptionExpectedListsTodaysBookingThenWaiting(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	a := e.book(t, p.ID, time.Now().Add(-time.Minute), 30)
	tomorrow := e.book(t, e.patient(t).ID, apptTomorrowAt(10, 0), 30)
	rt := e.reception(t)
	var found, foundTomorrow bool
	for _, x := range rt.Expected {
		found = found || x.AppointmentID == a.ID
		foundTomorrow = foundTomorrow || x.AppointmentID == tomorrow.ID
	}
	if !found {
		t.Fatalf("today's booking not in Expected: %+v", rt.Expected)
	}
	if foundTomorrow {
		t.Fatalf("tomorrow's booking listed as expected today")
	}
	e.checkIn(t, a.ID).Expect(t, 200, "check in")
	rt = e.reception(t)
	for _, x := range rt.Expected {
		if x.AppointmentID == a.ID {
			t.Fatalf("checked-in appointment still in Expected")
		}
	}
	waiting := false
	for _, w := range rt.Waiting {
		waiting = waiting || w.PatientID == p.ID
	}
	if !waiting {
		t.Fatalf("checked-in patient not in Waiting: %+v", rt.Waiting)
	}
}

// TestREG_APPT_014_ReceptionExpectedListsTodaysDentalVisit: Given a dental treatment
// whose first visit is planned for today, When the desk opens "Expected today", Then
// that patient is listed — they are coming in today just as much as a booked one.
func TestREG_APPT_014_ReceptionExpectedListsTodaysDentalVisit(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	plan := createPlan(t, e.doc, p.ID, "3000", 2, "")
	var today bool
	pu, _ := id.Decode(id.PrefixPatient, p.ID)
	one(t, `SELECT EXISTS (SELECT 1 FROM treatment_sessions WHERE patient_id = $1 AND kind = 'visit'
	          AND scheduled_date = (now() AT TIME ZONE 'Africa/Addis_Ababa')::date AND status = 'planned')`, &today, pu)
	if !today {
		t.Fatalf("fixture: the plan has no visit planned for today (sessions %+v)", plan.Sessions)
	}
	rt := e.reception(t)
	listed := false
	for _, x := range rt.Expected {
		listed = listed || x.PatientID == p.ID
	}
	testkit.KnownBug(t, "APT-1", !listed,
		"reception 'Expected today' reads only appointments; a dental visit planned for today (treatment_sessions) is not listed")
}

// TestREG_APPT_015_FollowupsListIncludesFollowup: Given a follow-up booked by the
// doctor and an ordinary appointment, When the follow-ups lens is read for the
// branch, Then it contains the follow-up (ordered by the doctor) and not the
// ordinary one.
func TestREG_APPT_015_FollowupsListIncludesFollowup(t *testing.T) {
	e := apptNewEnv(t)
	body := e.bookBody(e.patient(t).ID, apptTomorrowAt(14, 0), 30)
	body["is_followup"] = true
	body["free_until"] = time.Now().AddDate(0, 0, 14).Format(time.RFC3339)
	r := e.doc.Do("POST", "/appointments", body).Expect(t, 201, "book follow-up")
	var fu apptRef
	r.Decode(t, &fu)
	plain := e.book(t, e.patient(t).ID, apptTomorrowAt(15, 0), 30)

	lr := e.desk.Do("GET", "/appointments/followups?branch="+e.branch, nil).Expect(t, 200, "followups")
	var list []struct {
		ID         string  `json:"id"`
		IsFollowup bool    `json:"is_followup"`
		OrderedBy  *string `json:"ordered_by"`
	}
	lr.Decode(t, &list)
	var got, gotPlain bool
	for _, x := range list {
		if x.ID == fu.ID {
			got = true
			if !x.IsFollowup || x.OrderedBy == nil || *x.OrderedBy != e.docID {
				t.Errorf("follow-up row: is_followup=%v ordered_by=%v, want true / the doctor", x.IsFollowup, x.OrderedBy)
			}
		}
		gotPlain = gotPlain || x.ID == plain.ID
	}
	if !got {
		raw, _ := json.Marshal(list)
		t.Fatalf("follow-up not in the follow-ups list: %s", raw)
	}
	if gotPlain {
		t.Fatalf("an ordinary appointment is listed as a follow-up")
	}
}
