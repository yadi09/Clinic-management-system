package regression

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// The desk's "Expected today" is who is coming: booked appointments AND the visits of
// treatment courses planned for today. These pin the rules that keep one person on
// the list once, and off it once they are here.

func expectedRow(t *testing.T, rt apptReception, patientID string) (found int, treatment bool, appointmentID string) {
	t.Helper()
	for _, x := range rt.Expected {
		if x.PatientID == patientID {
			found++
			treatment, appointmentID = x.TreatmentVisit, x.AppointmentID
		}
	}
	return
}

// TestREG_APPT_016_ABookedPatientWithAVisitTodayIsListedOnceAsTheBooking: Given a
// patient with an appointment today AND a treatment visit planned for today, When the
// desk opens Expected, Then they appear once, as the booking.
func TestREG_APPT_016_ABookedPatientWithAVisitTodayIsListedOnceAsTheBooking(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	createPlan(t, e.doc, p.ID, "3000", 2, "")
	a := e.book(t, p.ID, time.Now().Add(-time.Minute), 15) // today, already due
	n, treatment, appt := expectedRow(t, e.reception(t), p.ID)
	if n != 1 || treatment || appt != a.ID {
		t.Fatalf("listed %d times (treatment=%v appointment=%q), want once as the booking %s", n, treatment, appt, a.ID)
	}
}

// TestREG_APPT_017_ReceivingATreatmentVisitMovesThemToWaiting: Given a patient listed
// as a treatment visit, When the desk receives them, Then they leave Expected and are
// in Waiting — exactly what happens to a booked patient.
func TestREG_APPT_017_ReceivingATreatmentVisitMovesThemToWaiting(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	createPlan(t, e.doc, p.ID, "3000", 2, "")
	if n, _, _ := expectedRow(t, e.reception(t), p.ID); n != 1 {
		t.Fatalf("before receiving: listed %d times, want 1", n)
	}
	e.desk.Do("POST", "/queue/walk-in", map[string]any{
		"patient_id": p.ID, "department_id": e.dept, "branch_id": e.branch, "provider_id": e.docID,
	}).Expect(t, 201, "receive")
	rt := e.reception(t)
	if n, _, _ := expectedRow(t, rt, p.ID); n != 0 {
		t.Fatalf("a received patient is still in Expected (%d rows)", n)
	}
	waiting := false
	for _, w := range rt.Waiting {
		waiting = waiting || w.PatientID == p.ID
	}
	if !waiting {
		t.Fatalf("a received patient is not in Waiting")
	}
}

// TestREG_APPT_018_OnlyVisitsActuallyDueTodayAreListed: A visit planned for tomorrow,
// one already done, a cancelled course and a course already completed are not coming
// in today, and must not clutter the list.
func TestREG_APPT_018_OnlyVisitsActuallyDueTodayAreListed(t *testing.T) {
	e := apptNewEnv(t)
	tomorrow, done, cancelled, completed := e.patient(t), e.patient(t), e.patient(t), e.patient(t)
	p1 := createPlan(t, e.doc, tomorrow.ID, "3000", 2, "")
	p2 := createPlan(t, e.doc, done.ID, "3000", 2, "")
	p3 := createPlan(t, e.doc, cancelled.ID, "3000", 2, "")
	p4 := createPlan(t, e.doc, completed.ID, "3000", 2, "")
	pid := func(s string) uuid.UUID { return denUUID(t, "tpl", s) }
	sid := func(s string) uuid.UUID { return denUUID(t, "tss", s) }
	blExec(t, `UPDATE treatment_sessions SET scheduled_date = scheduled_date + 1 WHERE id = $1`, sid(p1.Sessions[0].ID))
	blExec(t, `UPDATE treatment_sessions SET status = 'done' WHERE id = $1`, sid(p2.Sessions[0].ID))
	blExec(t, `UPDATE treatment_plans SET status = 'cancelled' WHERE id = $1`, pid(p3.ID))
	blExec(t, `UPDATE treatment_plans SET status = 'completed' WHERE id = $1`, pid(p4.ID))
	rt := e.reception(t)
	for name, p := range map[string]patientRef{"planned for tomorrow": tomorrow, "already done": done, "cancelled course": cancelled, "completed course": completed} {
		if n, _, _ := expectedRow(t, rt, p.ID); n != 0 {
			t.Errorf("%s: listed %d times in Expected, want not at all", name, n)
		}
	}
}

// TestREG_APPT_019_TwoVisitsTodayAreOneRowAndAnotherBranchIsNotListed: Given a patient
// with two courses each with a visit today, Then one row; Given a visit that belongs
// to another branch, Then this branch's desk does not list it; a visit with no branch
// is listed.
func TestREG_APPT_019_TwoVisitsTodayAreOneRowAndAnotherBranchIsNotListed(t *testing.T) {
	e := apptNewEnv(t)
	two, other, open := e.patient(t), e.patient(t), e.patient(t)
	createPlan(t, e.doc, two.ID, "3000", 2, "")
	createPlan(t, e.doc, two.ID, "1000", 1, "")
	po := createPlan(t, e.doc, other.ID, "3000", 2, "")
	pn := createPlan(t, e.doc, open.ID, "3000", 2, "")

	var otherBranch uuid.UUID
	one(t, `INSERT INTO branches (tenant_id, clinic_id, name, code)
	        SELECT tenant_id, id, 'Other branch', 'OTH' FROM clinics WHERE tenant_id = $1 RETURNING id`, &otherBranch, e.c.TenantID)
	blExec(t, `UPDATE treatment_sessions SET branch_id = $2 WHERE id = $1`, denUUID(t, "tss", po.Sessions[0].ID), otherBranch)
	blExec(t, `UPDATE treatment_sessions SET branch_id = NULL WHERE id = $1`, denUUID(t, "tss", pn.Sessions[0].ID))

	rt := e.reception(t)
	if n, _, _ := expectedRow(t, rt, two.ID); n != 1 {
		t.Errorf("two visits today: listed %d times, want once", n)
	}
	if n, _, _ := expectedRow(t, rt, other.ID); n != 0 {
		t.Errorf("another branch's visit: listed %d times, want not at all", n)
	}
	if n, _, _ := expectedRow(t, rt, open.ID); n != 1 {
		t.Errorf("a visit with no branch: listed %d times, want once", n)
	}
}
