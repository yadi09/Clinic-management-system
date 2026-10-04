package regression

import (
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Multi-branch (REG_BRANCH): a dental clinic that opens a second branch. Staff can be
// pinned to one branch (user_role_scopes.branch_id); the owner works across all of
// them and picks an active branch (/auth/switch-branch). These tests pin down, surface
// by surface, what a branch-A member of staff sees of branch B and what they can do to
// it. Reads are mostly scoped by the session's active branch; writes are not checked
// against the user's branches at all (CanAccessBranch has no callers: SEC-5 / FIN-7),
// so each write gap is recorded as a known bug on the exact route.
//
// Every test builds its own two-branch clinic (xcTwoBranchClinic) on the Practice plan
// with the branch cap lifted, so counts and money are exact.

// ---- helpers (prefixed xc: shared by the cross-cutting files) -------------------

// xcExec runs a statement as the superuser — only to arrange what the API cannot.
func xcExec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := super.Pool.Exec(t.Context(), q, args...); err != nil {
		t.Fatalf("%v\n%s", err, q)
	}
}

// xcID decodes a prefixed API id.
func xcID(t *testing.T, prefix, ext string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(prefix, ext)
	if err != nil {
		t.Fatalf("decode %q as %s: %v", ext, prefix, err)
	}
	return u
}

// xcBranches is a clinic with two branches, each with its own department.
type xcBranches struct {
	c            *testkit.Clinic
	owner        *testkit.Client
	brA, brB     string // external ids
	brAID, brBID uuid.UUID
	deptA, deptB string
}

// xcTwoBranchClinic is a private dental clinic on the Practice plan (finance and aged
// debt included) whose branch cap is lifted, with a second branch B and a department
// in it. Branch A is the main branch the clinic was provisioned with.
func xcTwoBranchClinic(t *testing.T) *xcBranches {
	t.Helper()
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-practice"})
	xcExec(t, `UPDATE tenants SET branch_limit_override = -1, user_limit_override = -1 WHERE id = $1`, c.TenantID)
	owner := srv.As(t, c, "owner")
	b := opNewBranch(t, owner, "Branch B", "BRB")
	var d opDeptRef
	owner.Do("POST", "/org/departments", map[string]any{"branch_id": b.ID, "name": "Dental B"}).
		Expect(t, 201, "department in branch B").Decode(t, &d)
	return &xcBranches{
		c: c, owner: owner,
		brA: id.Encode(id.PrefixBranch, c.BranchID), brAID: c.BranchID,
		brB: b.ID, brBID: xcID(t, id.PrefixBranch, b.ID),
		deptA: id.Encode(id.PrefixDepartment, c.DeptID), deptB: d.ID,
	}
}

// scoped adds a member of staff in `role` pinned to one branch and signs them in.
func (x *xcBranches) scoped(t *testing.T, role string, branch uuid.UUID) (*testkit.Client, uuid.UUID) {
	t.Helper()
	email := fmt.Sprintf("%s-%s@%s.test", role, uuid.NewString()[:6], x.c.Slug)
	var uid uuid.UUID
	if err := super.Pool.QueryRow(t.Context(),
		`INSERT INTO users (tenant_id, email, password_hash, full_name, status)
		 SELECT tenant_id, $2, password_hash, $3, 'active' FROM users WHERE id = $1 RETURNING id`,
		x.c.Owner.ID, email, "Scoped "+role).Scan(&uid); err != nil {
		t.Fatalf("add scoped %s: %v", role, err)
	}
	tag, err := super.Pool.Exec(t.Context(),
		`INSERT INTO user_role_scopes (tenant_id, user_id, role_id, branch_id)
		 SELECT $1, $2, id, $4 FROM roles WHERE tenant_id = $1 AND code = $3`,
		x.c.TenantID, uid, role, branch)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("scope %s to branch: %v (rows %d)", role, err, tag.RowsAffected())
	}
	return srv.Login(t, x.c.Slug, email), uid
}

// xcWalkIn receives a patient into a department, naming the branch.
func xcWalkIn(c *testkit.Client, branch, dept, patientID string) testkit.Resp {
	return c.Do("POST", "/queue/walk-in", map[string]any{"branch_id": branch, "department_id": dept, "patient_id": patientID})
}

// xcRaise puts a plain charge for a branch on the cashier's queue (payment.charge).
func xcRaise(t *testing.T, c *testkit.Client, patientID, branch string, amount float64) string {
	t.Helper()
	var out struct {
		ID string `json:"id"`
	}
	c.Do("POST", "/billing/charges", map[string]any{
		"patient_id": patientID, "source": "service", "description": uniq("Scaling "), "amount": amount, "branch_id": branch,
	}).Expect(t, 201, "raise charge").Decode(t, &out)
	return out.ID
}

func xcChargeStatus(t *testing.T, chargeID string) string {
	t.Helper()
	var s string
	one(t, `SELECT status FROM charges WHERE id = $1`, &s, xcID(t, id.PrefixCharge, chargeID))
	return s
}

func xcHasPatient(ids []string, pid string) bool {
	for _, x := range ids {
		if x == pid {
			return true
		}
	}
	return false
}

// xcQueuePatients is who is on a department's board as this user sees it.
func xcQueuePatients(t *testing.T, c *testkit.Client, dept string) []string {
	t.Helper()
	var out []opQueueEntry
	c.Do("GET", "/queue?department="+dept, nil).Expect(t, 200, "queue").Decode(t, &out)
	ids := []string{}
	for _, q := range out {
		ids = append(ids, q.PatientID)
	}
	return ids
}

// xcReceptionPatients is everyone on the desk's screen today (expected + waiting).
func xcReceptionPatients(t *testing.T, c *testkit.Client) []string {
	t.Helper()
	var r apptReception
	c.Do("GET", "/reception/today", nil).Expect(t, 200, "reception today").Decode(t, &r)
	ids := []string{}
	for _, e := range r.Expected {
		ids = append(ids, e.PatientID)
	}
	for _, w := range r.Waiting {
		ids = append(ids, w.PatientID)
	}
	return ids
}

// xcSwitch re-issues the owner's token for a branch ("all" for every branch).
func xcSwitch(t *testing.T, c *testkit.Client, branch string) *testkit.Client {
	t.Helper()
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	c.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": branch}).Expect(t, 200, "switch to "+branch).Decode(t, &tok)
	return authBearer(t, tok.AccessToken)
}

// ---- who lands where ---------------------------------------------------------------

// TestREG_BRANCH_001_ScopedStaffLandOnTheirOwnBranch: Given a receptionist pinned to
// branch B, When she signs in, Then her session's active branch is B, B is the only
// branch she may use, and switching to A or to "all branches" is 403 BRANCH_DENIED;
// Given the owner (every branch), Then they land on the main branch A, may switch to
// B, and the switch is what the token now says.
func TestREG_BRANCH_001_ScopedStaffLandOnTheirOwnBranch(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	me := opWhoAmI(t, deskB)
	if me.AllBranches || len(me.Branches) != 1 || me.Branches[0].ID != x.brB || me.ActiveBranchID == nil || *me.ActiveBranchID != x.brB {
		t.Fatalf("branch-B receptionist: %+v", me)
	}
	for _, target := range []string{x.brA, "all"} {
		if r := deskB.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": target}); r.Status != 403 || r.Code != "BRANCH_DENIED" {
			t.Fatalf("branch-B receptionist switches to %s: %d %s", target, r.Status, r.Code)
		}
	}
	om := opWhoAmI(t, x.owner)
	if !om.AllBranches || len(om.Branches) != 2 || om.ActiveBranchID == nil || *om.ActiveBranchID != x.brA {
		t.Fatalf("owner lands on %+v, want all branches with A active", om)
	}
	if m := opWhoAmI(t, xcSwitch(t, x.owner, x.brB)); m.ActiveBranchID == nil || *m.ActiveBranchID != x.brB {
		t.Fatalf("owner after switching to B: %+v", m.ActiveBranchID)
	}
}

// ---- front desk and queue (reads) -----------------------------------------------------

// TestREG_BRANCH_002_ReceptionAndQueueShowOnlyTheBranchYouAreIn: Given a walk-in at
// branch A and one at branch B, When the branch-A desk reads reception today and the
// queue board (even asking for B's department), Then only A's patient is there; the
// branch-B desk sees only B's; the owner sees A's (their active branch) until they
// switch to B.
func TestREG_BRANCH_002_ReceptionAndQueueShowOnlyTheBranchYouAreIn(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	pA := createPatient(t, deskA, uniq("WalkA"), "Branch")
	pB := createPatient(t, deskB, uniq("WalkB"), "Branch")
	xcWalkIn(deskA, x.brA, x.deptA, pA.ID).Expect(t, 201, "walk-in at A")
	xcWalkIn(deskB, x.brB, x.deptB, pB.ID).Expect(t, 201, "walk-in at B")

	if ids := xcReceptionPatients(t, deskA); !xcHasPatient(ids, pA.ID) || xcHasPatient(ids, pB.ID) {
		t.Fatalf("branch-A reception: has A=%v B=%v, want only A", xcHasPatient(ids, pA.ID), xcHasPatient(ids, pB.ID))
	}
	if ids := xcReceptionPatients(t, deskB); !xcHasPatient(ids, pB.ID) || xcHasPatient(ids, pA.ID) {
		t.Fatalf("branch-B reception: has B=%v A=%v, want only B", xcHasPatient(ids, pB.ID), xcHasPatient(ids, pA.ID))
	}
	if ids := xcQueuePatients(t, deskA, x.deptB); xcHasPatient(ids, pB.ID) {
		t.Fatalf("BRANCH LEAK: branch-A desk reads B's department board and sees B's patient")
	}
	if ids := xcQueuePatients(t, deskB, x.deptB); !xcHasPatient(ids, pB.ID) {
		t.Fatalf("branch-B desk does not see its own walk-in on its board")
	}
	if ids := xcReceptionPatients(t, x.owner); !xcHasPatient(ids, pA.ID) || xcHasPatient(ids, pB.ID) {
		t.Fatalf("owner on branch A: reception has A=%v B=%v", xcHasPatient(ids, pA.ID), xcHasPatient(ids, pB.ID))
	}
	if ids := xcReceptionPatients(t, xcSwitch(t, x.owner, x.brB)); !xcHasPatient(ids, pB.ID) || xcHasPatient(ids, pA.ID) {
		t.Fatalf("owner switched to B: reception has B=%v A=%v", xcHasPatient(ids, pB.ID), xcHasPatient(ids, pA.ID))
	}
}

// TestREG_BRANCH_003_ScopedDeskCannotWorkAnotherBranchsQueue: Given a desk pinned to
// branch A, When it receives a walk-in into branch B (naming B), or moves a patient
// on B's queue, Then it must be refused (403) and B's queue left alone. Today both
// succeed: the walk-in takes branch_id from the request, Transition takes any id of
// the clinic, and nothing compares them with the user's branches (SEC-5).
func TestREG_BRANCH_003_ScopedDeskCannotWorkAnotherBranchsQueue(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)

	t.Run("walk-in into B", func(t *testing.T) {
		p := createPatient(t, deskA, uniq("Intrude"), "Walk")
		r := xcWalkIn(deskA, x.brB, x.deptB, p.ID)
		var n int
		one(t, `SELECT count(*) FROM queue_entries WHERE patient_id = $1 AND branch_id = $2 AND deleted_at IS NULL`,
			&n, xcID(t, id.PrefixPatient, p.ID), x.brBID)
		testkit.KnownBug(t, "SEC-5", r.Status < 300 || n > 0, fmt.Sprintf(
			"POST /queue/walk-in with branch_id=B by a branch-A-only receptionist answers %d and queued %d entries in B: "+
				"EnqueueWalkIn uses the requested branch without CanAccessBranch (scheduling/service/service.go EnqueueWalkIn)", r.Status, n))
	})
	t.Run("move B's patient", func(t *testing.T) {
		p := createPatient(t, deskB, uniq("BQueue"), "Walk")
		xcWalkIn(deskB, x.brB, x.deptB, p.ID).Expect(t, 201, "walk-in at B")
		var qid uuid.UUID
		one(t, `SELECT id FROM queue_entries WHERE patient_id = $1`, &qid, xcID(t, id.PrefixPatient, p.ID))
		r := deskA.Do("POST", "/queue/"+id.Encode(id.PrefixQueueEntry, qid)+"/transition", map[string]any{"state": "called"})
		var state string
		one(t, `SELECT state FROM queue_entries WHERE id = $1`, &state, qid)
		testkit.KnownBug(t, "SEC-5", r.Status < 300 || state != "waiting", fmt.Sprintf(
			"POST /queue/:id/transition on a branch-B entry by a branch-A-only receptionist answers %d, entry now %q "+
				"(scheduling Transition never checks the entry's branch)", r.Status, state))
	})
}

// ---- appointments ------------------------------------------------------------------

// TestREG_BRANCH_004_AppointmentListsAreBranchScoped: Given a booking and a follow-up
// at branch B tomorrow, When the branch-A desk lists appointments or follow-ups asking
// for branch B, Then it gets its own branch's (none of B's) — the service overrides
// the requested branch with the session's; the branch-B desk sees both.
func TestREG_BRANCH_004_AppointmentListsAreBranchScoped(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	doc := id.Encode(id.PrefixUser, x.c.Staff["doctor"].ID)
	p := createPatient(t, deskB, uniq("ApptB"), "Branch")
	book := func(at time.Time, followup bool) string {
		var a apptRef
		deskB.Do("POST", "/appointments", map[string]any{
			"branch_id": x.brB, "patient_id": p.ID, "provider_id": doc, "department_id": x.deptB,
			"starts_at": at.Format(time.RFC3339), "duration_min": 30, "is_followup": followup,
		}).Expect(t, 201, "book at B").Decode(t, &a)
		return a.ID
	}
	plain := book(apptTomorrowAt(9, 0), false)
	fu := book(apptTomorrowAt(11, 0), true)

	from := time.Now().UTC().Format(time.RFC3339)
	to := time.Now().UTC().Add(72 * time.Hour).Format(time.RFC3339)
	list := func(c *testkit.Client, path string) []string {
		var rows []struct {
			ID string `json:"id"`
		}
		c.Do("GET", path, nil).Expect(t, 200, path).Decode(t, &rows)
		ids := []string{}
		for _, r := range rows {
			ids = append(ids, r.ID)
		}
		return ids
	}
	q := "?branch=" + x.brB + "&from=" + from + "&to=" + to
	if got := list(deskA, "/appointments"+q); xcHasPatient(got, plain) || xcHasPatient(got, fu) {
		t.Fatalf("BRANCH LEAK: branch-A desk lists branch-B appointments %v", got)
	}
	if got := list(deskA, "/appointments/followups"+q); xcHasPatient(got, fu) {
		t.Fatalf("BRANCH LEAK: branch-A desk lists branch-B follow-ups %v", got)
	}
	if got := list(deskB, "/appointments"+q); !xcHasPatient(got, plain) || !xcHasPatient(got, fu) {
		t.Fatalf("branch-B desk does not see its own bookings: %v", got)
	}
	if got := list(deskB, "/appointments/followups"+q); !xcHasPatient(got, fu) {
		t.Fatalf("branch-B desk does not see its own follow-up: %v", got)
	}
}

// TestREG_BRANCH_005_ScopedDeskCannotBookIntoAnotherBranch: Given a desk pinned to
// branch A, When it books an appointment at branch B, Then it must be refused (403)
// and nothing lands in B's diary. Today it is 201 (SEC-5): Book stores the request's
// branch_id with no check against the user's branches.
func TestREG_BRANCH_005_ScopedDeskCannotBookIntoAnotherBranch(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	p := createPatient(t, deskA, uniq("BookB"), "Branch")
	r := deskA.Do("POST", "/appointments", map[string]any{
		"branch_id": x.brB, "patient_id": p.ID, "provider_id": id.Encode(id.PrefixUser, x.c.Staff["doctor"].ID),
		"department_id": x.deptB, "starts_at": apptTomorrowAt(10, 0).Format(time.RFC3339), "duration_min": 30,
	})
	var n int
	one(t, `SELECT count(*) FROM appointments WHERE patient_id = $1 AND branch_id = $2`, &n, xcID(t, id.PrefixPatient, p.ID), x.brBID)
	testkit.KnownBug(t, "SEC-5", r.Status < 300 || n > 0, fmt.Sprintf(
		"POST /appointments with branch_id=B by a branch-A-only receptionist answers %d and stored %d bookings in B "+
			"(scheduling/service/service.go Book: branch never checked)", r.Status, n))
}

// ---- dental --------------------------------------------------------------------------

// TestREG_BRANCH_006_ChairsideIsBranchScoped: Given a patient waiting at branch B,
// When a dentist pinned to branch A opens the chair list, Then the patient is not on
// it; a dentist pinned to B sees them.
func TestREG_BRANCH_006_ChairsideIsBranchScoped(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	docA, _ := x.scoped(t, "doctor", x.brAID)
	docB, _ := x.scoped(t, "doctor", x.brBID)
	p := createPatient(t, deskB, uniq("ChairB"), "Branch")
	xcWalkIn(deskB, x.brB, x.deptB, p.ID).Expect(t, 201, "walk-in at B")
	chair := func(c *testkit.Client) []string {
		var rows []struct {
			PatientID string `json:"patient_id"`
		}
		c.Do("GET", "/dental/chairside", nil).Expect(t, 200, "chairside").Decode(t, &rows)
		ids := []string{}
		for _, r := range rows {
			ids = append(ids, r.PatientID)
		}
		return ids
	}
	if xcHasPatient(chair(docA), p.ID) {
		t.Fatalf("BRANCH LEAK: branch-A dentist's chair list shows a patient waiting at branch B")
	}
	if !xcHasPatient(chair(docB), p.ID) {
		t.Fatalf("branch-B dentist does not see the patient waiting at B")
	}
}

// TestREG_BRANCH_007_DentalCalendarOfAnotherBranch: Given a dental visit delivered at
// branch B today (the session carries branch_id B), When the branch-A desk reads the
// dental sessions calendar, Then B's delivered visit should not be on it — the
// appointment diary next to it is strictly per branch. Today GET /dental/sessions has
// no branch filter at all (dental/service/service.go SessionsInRange). Planned visits
// have no branch (treatment plans are clinic-wide), so only delivered ones are judged.
func TestREG_BRANCH_007_DentalCalendarOfAnotherBranch(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	docB, _ := x.scoped(t, "doctor", x.brBID)
	p := createPatient(t, docB, uniq("CalB"), "Branch")
	plan := createPlan(t, docB, p.ID, "2000", 2, "")
	sid := plan.Sessions[0].ID
	denRecord(t, docB, p.ID, sid, "given at B")
	var br *uuid.UUID
	one(t, `SELECT branch_id FROM treatment_sessions WHERE id = $1`, &br, xcID(t, id.PrefixTreatmentSession, sid))
	if br == nil || *br != x.brBID {
		t.Fatalf("delivered visit stamped branch %v, want B", br)
	}
	var rows []struct {
		SessionID string `json:"session_id"`
	}
	d := payAddisToday()
	deskA.Do("GET", "/dental/sessions?from="+d+"&to="+d, nil).Expect(t, 200, "calendar").Decode(t, &rows)
	seen := false
	for _, r := range rows {
		seen = seen || r.SessionID == sid
	}
	testkit.KnownBug(t, "NEW-BRANCH-1", seen,
		"GET /dental/sessions shows a branch-A-only desk a visit delivered at branch B: SessionsInRange never filters by "+
			"the session's branch (dental/service/service.go SessionsInRange), unlike /appointments")
}

// ---- money -----------------------------------------------------------------------------

// TestREG_BRANCH_008_CashierWorklistIsBranchScoped: Given a charge raised at branch B,
// When a cashier pinned to branch A opens the worklist, Then B's charge is not on it.
// Today it is (FIN-7): ListPendingCharges filters by clinic only.
func TestREG_BRANCH_008_CashierWorklistIsBranchScoped(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	cashA, _ := x.scoped(t, "cashier", x.brAID)
	cashB, _ := x.scoped(t, "cashier", x.brBID)
	p := createPatient(t, deskB, uniq("OwesB"), "Branch")
	xcRaise(t, deskB, p.ID, x.brB, 400)
	if len(payPendingFor(t, cashB, p.ID)) != 1 {
		t.Fatalf("branch-B cashier does not see branch B's charge")
	}
	n := len(payPendingFor(t, cashA, p.ID))
	testkit.KnownBug(t, "FIN-7", n != 0, fmt.Sprintf(
		"GET /billing/charges/pending shows a branch-A-only cashier %d charge(s) raised at branch B "+
			"(billing ListPendingCharges: WHERE tenant_id only)", n))
}

// TestREG_BRANCH_009_MoneyWritesOnAnotherBranchsCharge: Given charges raised and paid
// at branch B, When staff pinned to branch A raise a B charge, settle it, void it,
// waive it or refund it, Then each must be refused and the charge left as it was.
// Today every one succeeds (SEC-5 / FIN-7): the billing service never compares the
// charge's branch with the caller's branches — CanAccessBranch has no callers.
func TestREG_BRANCH_009_MoneyWritesOnAnotherBranchsCharge(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	cashA, _ := x.scoped(t, "cashier", x.brAID)
	cashB, _ := x.scoped(t, "cashier", x.brBID)
	mgrA, _ := x.scoped(t, "branch_manager", x.brAID)
	p := createPatient(t, deskB, uniq("MoneyB"), "Branch")

	t.Run("raise at B", func(t *testing.T) {
		r := deskA.Do("POST", "/billing/charges", map[string]any{
			"patient_id": p.ID, "source": "service", "description": "intruder", "amount": 50, "branch_id": x.brB})
		testkit.KnownBug(t, "SEC-5", r.Status < 300, fmt.Sprintf(
			"POST /billing/charges with branch_id=B by a branch-A-only receptionist answers %d (RaiseCharge: branch unchecked)", r.Status))
	})
	t.Run("settle", func(t *testing.T) {
		ch := xcRaise(t, deskB, p.ID, x.brB, 100)
		r := paySettle(cashA, ch)
		st := xcChargeStatus(t, ch)
		testkit.KnownBug(t, "FIN-7", r.Status < 300 || st != "pending", fmt.Sprintf(
			"POST /billing/charges/:id/settle on a branch-B charge by a branch-A-only cashier answers %d, charge now %q "+
				"(billing SettleCharge: tenant + id only)", r.Status, st))
	})
	t.Run("void", func(t *testing.T) {
		ch := xcRaise(t, deskB, p.ID, x.brB, 110)
		r := cashA.Do("POST", "/billing/charges/"+ch+"/void", map[string]any{"reason": "not ours"})
		st := xcChargeStatus(t, ch)
		testkit.KnownBug(t, "FIN-7", r.Status < 300 || st != "pending", fmt.Sprintf(
			"POST /billing/charges/:id/void on a branch-B charge by a branch-A-only cashier answers %d, charge now %q", r.Status, st))
	})
	t.Run("waive", func(t *testing.T) {
		ch := xcRaise(t, deskB, p.ID, x.brB, 120)
		r := cashA.Do("POST", "/billing/charges/"+ch+"/waive", map[string]any{"reason": "staff family"})
		st := xcChargeStatus(t, ch)
		testkit.KnownBug(t, "FIN-7", r.Status < 300 || st != "pending", fmt.Sprintf(
			"POST /billing/charges/:id/waive on a branch-B charge by a branch-A-only cashier answers %d, charge now %q", r.Status, st))
	})
	t.Run("refund", func(t *testing.T) {
		ch := xcRaise(t, deskB, p.ID, x.brB, 130)
		paySettle(cashB, ch).Expect(t, 204, "branch-B cashier settles")
		r := mgrA.Do("POST", "/billing/charges/"+ch+"/refund", map[string]any{"reason": "not ours"})
		var n int
		one(t, `SELECT count(*) FROM charges WHERE reverses_charge_id = $1`, &n, xcID(t, id.PrefixCharge, ch))
		testkit.KnownBug(t, "FIN-7", r.Status < 300 || n != 0, fmt.Sprintf(
			"POST /billing/charges/:id/refund on a branch-B receipt by a branch-A-only manager answers %d, %d reversal(s) posted", r.Status, n))
	})
}

// TestREG_BRANCH_010_FinanceBranchFilter: Given 300 collected at branch A and 500 at
// branch B today, When the owner reads the finance overview, Then ?branch=A says 300,
// ?branch=B 500 and no filter 800. When a manager pinned to branch A asks for
// ?branch=B, or for no branch, Then they must not see B's money (403, or their own
// branch's 300). Today the filter is whatever the client sends (FIN-7).
func TestREG_BRANCH_010_FinanceBranchFilter(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	cashA, _ := x.scoped(t, "cashier", x.brAID)
	cashB, _ := x.scoped(t, "cashier", x.brBID)
	mgrA, _ := x.scoped(t, "branch_manager", x.brAID)
	pA := createPatient(t, deskA, uniq("FinA"), "Branch")
	pB := createPatient(t, deskB, uniq("FinB"), "Branch")
	paySettle(cashA, xcRaise(t, deskA, pA.ID, x.brA, 300)).Expect(t, 204, "settle at A")
	paySettle(cashB, xcRaise(t, deskB, pB.ID, x.brB, 500)).Expect(t, 204, "settle at B")
	xcRaise(t, deskB, pB.ID, x.brB, 70) // owed at B, at the cashier

	for q, want := range map[string]float64{"?branch=" + x.brA: 300, "?branch=" + x.brB: 500, "": 800} {
		if got := payNum(t, payGetOverview(t, x.owner, q).Collected); !payEq(got, want) {
			t.Fatalf("owner overview%s collected %.2f, want %.2f", q, got, want)
		}
	}

	leakB := payNum(t, payGetOverview(t, mgrA, "?branch="+x.brB).Collected)
	leakAll := payNum(t, payGetOverview(t, mgrA, "").Collected)
	rec := payGetReceivables(t, mgrA)
	recLeak := payOwedIn(rec, pB.ID) != ""
	testkit.KnownBug(t, "FIN-7", leakB > 0 || leakAll > 300 || recLeak, fmt.Sprintf(
		"a branch-A-only manager reads branch B's money: /finance/overview?branch=B collected %.2f, unfiltered %.2f, "+
			"/finance/receivables lists B's debtor=%v — finance filterFrom trusts ?branch= and defaults to the whole clinic",
		leakB, leakAll, recLeak))
}

// TestREG_BRANCH_011_DashboardFollowsTheActiveBranch: Given one patient waiting at A
// and two at B, with 300 collected at A and 500 at B, When the owner reads the home
// page on branch A, on B and on "all", Then waiting is 1 / 2 / 3 and collected today
// 300 / 500 / 800; a desk pinned to B sees B's 2.
func TestREG_BRANCH_011_DashboardFollowsTheActiveBranch(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	cashA, _ := x.scoped(t, "cashier", x.brAID)
	cashB, _ := x.scoped(t, "cashier", x.brBID)
	for i, w := range []struct {
		desk         *testkit.Client
		branch, dept string
	}{{deskA, x.brA, x.deptA}, {deskB, x.brB, x.deptB}, {deskB, x.brB, x.deptB}} {
		p := createPatient(t, w.desk, uniq(fmt.Sprintf("Dash%d", i)), "Branch")
		xcWalkIn(w.desk, w.branch, w.dept, p.ID).Expect(t, 201, "walk-in")
	}
	pA := createPatient(t, deskA, uniq("DashPayA"), "Branch")
	pB := createPatient(t, deskB, uniq("DashPayB"), "Branch")
	paySettle(cashA, xcRaise(t, deskA, pA.ID, x.brA, 300)).Expect(t, 204, "settle at A")
	paySettle(cashB, xcRaise(t, deskB, pB.ID, x.brB, 500)).Expect(t, 204, "settle at B")

	type dash struct {
		Flow *struct {
			Waiting int `json:"waiting"`
		} `json:"flow"`
		Money *struct {
			CollectedToday string `json:"collected_today"`
		} `json:"money"`
		BranchName string `json:"branch_name"`
	}
	read := func(c *testkit.Client) dash {
		var d dash
		c.Do("GET", "/dashboard/today", nil).Expect(t, 200, "dashboard").Decode(t, &d)
		if d.Flow == nil {
			t.Fatalf("dashboard has no flow section")
		}
		return d
	}
	for _, v := range []struct {
		name    string
		c       *testkit.Client
		waiting int
		money   float64
	}{
		{"owner on A", x.owner, 1, 300},
		{"owner on B", xcSwitch(t, x.owner, x.brB), 2, 500},
		{"owner on all", xcSwitch(t, x.owner, "all"), 3, 800},
	} {
		d := read(v.c)
		if d.Flow.Waiting != v.waiting || d.Money == nil || !payEq(payNum(t, d.Money.CollectedToday), v.money) {
			got := "<none>"
			if d.Money != nil {
				got = d.Money.CollectedToday
			}
			t.Fatalf("%s: waiting %d collected %s, want %d / %.2f", v.name, d.Flow.Waiting, got, v.waiting, v.money)
		}
	}
	if d := read(deskB); d.Flow.Waiting != 2 || d.Money != nil {
		t.Fatalf("branch-B desk dashboard: waiting %d money %v, want 2 and no money section", d.Flow.Waiting, d.Money != nil)
	}
}

// TestREG_BRANCH_012_PatientsAreClinicWide: Given a patient registered by the branch-B
// desk, When the branch-A desk searches for and opens them, Then they are found — a
// patient's record belongs to the clinic, not to a branch (by design: one chart across
// branches). Another clinic still cannot see them.
func TestREG_BRANCH_012_PatientsAreClinicWide(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	name := uniq("Shared")
	p := createPatient(t, deskB, name, "Branch")
	deskA.Do("GET", "/patients/"+p.ID, nil).Expect(t, 200, "branch-A desk opens a branch-B patient")
	if !patContains(patSearchIDs(t, deskA, name), p.ID) {
		t.Fatalf("branch-A desk cannot find a patient registered at branch B")
	}
	srv.As(t, clinicB, "receptionist").Do("GET", "/patients/"+p.ID, nil).Expect(t, 404, "another clinic opens the patient")
}

// TestREG_BRANCH_013_ModulesArePerBranch: Given dental switched off for branch B only,
// When a dentist pinned to B opens the dental workspace, Then 403 MODULE_DISABLED and
// /auth/me says dental is off; a dentist pinned to A still works; the owner switching
// to B gets B's modules (refused) and back on A gets dental again.
func TestREG_BRANCH_013_ModulesArePerBranch(t *testing.T) {
	x := xcTwoBranchClinic(t)
	x.owner.Do("PUT", "/org/branches/"+x.brB+"/modules", map[string]any{"dental": false}).Expect(t, 200, "dental off at B")
	docA, _ := x.scoped(t, "doctor", x.brAID)
	docB, _ := x.scoped(t, "doctor", x.brBID)
	docA.Do("GET", "/dental/procedures", nil).Expect(t, 200, "branch-A dentist")
	if r := docB.Do("GET", "/dental/procedures", nil); r.Status != 403 || r.Code != "MODULE_DISABLED" {
		t.Fatalf("branch-B dentist with dental off at B: %d %s", r.Status, r.Code)
	}
	var me struct {
		Flags map[string]bool `json:"flags"`
	}
	docB.Do("GET", "/auth/me", nil).Expect(t, 200, "me").Decode(t, &me)
	if me.Flags["dental"] {
		t.Fatalf("branch-B dentist's flags still have dental on")
	}
	onB := xcSwitch(t, x.owner, x.brB)
	if r := onB.Do("GET", "/dental/procedures", nil); r.Code != "MODULE_DISABLED" {
		t.Fatalf("owner switched to B: dental %d %s, want MODULE_DISABLED", r.Status, r.Code)
	}
	xcSwitch(t, onB, x.brA).Do("GET", "/dental/procedures", nil).Expect(t, 200, "owner back on A")
}
