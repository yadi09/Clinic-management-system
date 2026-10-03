package regression

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/audit"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The audit trail end to end (REG_AUDIT). The API writes a domain event into
// event_outbox in the same transaction as the change; the worker (cmd/worker) relays
// each event to audit.Writer.EventHandler, which appends an audit_logs row naming who
// did what to which record. The API under test runs without a worker, so these tests
// play the worker's part: they hand every pending outbox row of THEIR OWN clinic to
// the very handler the worker registers (audit.NewWriter(db).EventHandler(), over a
// clinic_app connection, i.e. under RLS as in production) and mark it dispatched, as
// events.Relay does. Draining only one clinic keeps the run fast and never touches
// another test's events. Then they assert the audit_logs row: tenant, actor, action,
// target. An action that leaves no row is a known bug (PAT-1, DEN-10, NEW-AUDIT-n).

// ---- helpers (prefixed xc) ------------------------------------------------------

var (
	xcAppOnce sync.Once
	xcAppDB   *kerneldb.DB
	xcAppErr  error
)

// xcAuditDB is a clinic_app (RLS-enforced) pool, the connection the worker uses.
func xcAuditDB(t *testing.T) *kerneldb.DB {
	t.Helper()
	xcAppOnce.Do(func() {
		xcAppDB, xcAppErr = kerneldb.Connect(context.Background(), testkit.AppDSNFrom(superDSN))
	})
	if xcAppErr != nil {
		t.Fatalf("connect as clinic_app: %v", xcAppErr)
	}
	return xcAppDB
}

// xcDrainAudit runs the worker's audit handler over the clinic's pending outbox rows,
// in outbox order, and marks each one dispatched — events.Relay.processOne, narrowed
// to one tenant.
func xcDrainAudit(t *testing.T, tenant uuid.UUID) {
	t.Helper()
	ctx := t.Context()
	rows, err := super.Pool.Query(ctx,
		`SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, actor_id, branch_id
		   FROM event_outbox
		  WHERE tenant_id = $1 AND dispatched_at IS NULL AND dead_lettered = false
		  ORDER BY sequence`, tenant)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	evs, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (events.Event, error) {
		var e events.Event
		err := r.Scan(&e.ID, &e.TenantID, &e.AggregateType, &e.AggregateID, &e.EventType, &e.Payload, &e.ActorID, &e.BranchID)
		return e, err
	})
	if err != nil {
		t.Fatalf("scan outbox: %v", err)
	}
	h := audit.NewWriter(xcAuditDB(t)).EventHandler()
	for _, e := range evs {
		if err := h(ctx, e); err != nil {
			t.Fatalf("audit handler on %s (%s): %v", e.EventType, e.ID, err)
		}
		xcExec(t, `UPDATE event_outbox SET dispatched_at = now() WHERE id = $1`, e.ID)
	}
}

type xcAuditRow struct {
	Actor   *uuid.UUID
	Branch  *uuid.UUID
	Type    string
	Payload string
}

// xcAuditFor is every audit row of the clinic with this action on this target.
func xcAuditFor(t *testing.T, tenant uuid.UUID, action string, target uuid.UUID) []xcAuditRow {
	t.Helper()
	rows, err := super.Pool.Query(t.Context(),
		`SELECT actor_id, branch_id, target_type, coalesce(payload::text, '')
		   FROM audit_logs WHERE tenant_id = $1 AND action = $2 AND target_id = $3 ORDER BY created_at`,
		tenant, action, target)
	if err != nil {
		t.Fatalf("read audit_logs: %v", err)
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (xcAuditRow, error) {
		var a xcAuditRow
		err := r.Scan(&a.Actor, &a.Branch, &a.Type, &a.Payload)
		return a, err
	})
	if err != nil {
		t.Fatalf("scan audit_logs: %v", err)
	}
	return out
}

// xcExpectAudit asserts exactly `n` rows for (action, target), each naming the actor.
func xcExpectAudit(t *testing.T, tenant uuid.UUID, action string, target, actor uuid.UUID, n int) []xcAuditRow {
	t.Helper()
	rows := xcAuditFor(t, tenant, action, target)
	if len(rows) != n {
		t.Fatalf("audit %s on %s: %d rows, want %d", action, target, len(rows), n)
	}
	for _, r := range rows {
		if r.Actor == nil || *r.Actor != actor {
			t.Fatalf("audit %s on %s: actor %v, want %v", action, target, r.Actor, actor)
		}
	}
	return rows
}

// xcAuditCount is how many audit rows the clinic has on a target, any action.
func xcAuditCount(t *testing.T, tenant, target uuid.UUID) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND target_id = $2`, &n, tenant, target)
	return n
}

// xcAuditMark is how many audit rows the clinic has so far.
func xcAuditMark(t *testing.T, tenant uuid.UUID) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1`, &n, tenant)
	return n
}

// ---- sign-in and patients -------------------------------------------------------------

// TestREG_AUDIT_001_SignInIsAudited: Given a receptionist, When she signs in and the
// worker runs, Then the clinic's audit trail holds an auth.user.logged_in entry for
// her account (target = the user; the actor, when recorded, is her), in her clinic only.
func TestREG_AUDIT_001_SignInIsAudited(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	srv.As(t, c, "receptionist")
	xcDrainAudit(t, c.TenantID)
	rows := xcAuditFor(t, c.TenantID, "auth.user.logged_in", st.ID)
	if len(rows) < 1 {
		t.Fatalf("no auth.user.logged_in audit entry for the receptionist")
	}
	for _, r := range rows {
		if r.Actor != nil && *r.Actor != st.ID {
			t.Fatalf("login audit names actor %v, want the user herself or none", r.Actor)
		}
		if r.Type != "user" {
			t.Fatalf("login audit target type %q", r.Type)
		}
	}
	var other int
	one(t, `SELECT count(*) FROM audit_logs WHERE target_id = $1 AND tenant_id <> $2`, &other, st.ID, c.TenantID)
	if other != 0 {
		t.Fatalf("login audit written under another clinic (%d rows)", other)
	}
}

// TestREG_AUDIT_002_PatientRegistrationIsAuditedButEditsAreNot: Given the desk
// registers a patient, When the worker runs, Then patient.patient.registered is on the
// trail with the desk as actor and the active branch; When the desk then changes the
// patient's name and phone, Then that change must be on the trail too. PAT-1: an edit
// publishes nothing, so the trail has only the registration.
func TestREG_AUDIT_002_PatientRegistrationIsAuditedButEditsAreNot(t *testing.T) {
	c := newClinic(t)
	desk := srv.As(t, c, "receptionist")
	p := createPatient(t, desk, uniq("Aud"), "Patient")
	pid := xcID(t, id.PrefixPatient, p.ID)
	xcDrainAudit(t, c.TenantID)
	rows := xcExpectAudit(t, c.TenantID, "patient.patient.registered", pid, c.Staff["receptionist"].ID, 1)
	if rows[0].Branch == nil || *rows[0].Branch != c.BranchID || rows[0].Type != "patient" {
		t.Fatalf("registration audit branch=%v type=%q", rows[0].Branch, rows[0].Type)
	}

	desk.Do("PUT", "/patients/"+p.ID, map[string]any{"first_name": uniq("Renamed"), "phone": patPhone()}).Expect(t, 200, "edit patient")
	xcDrainAudit(t, c.TenantID)
	n := xcAuditCount(t, c.TenantID, pid)
	testkit.KnownBug(t, "PAT-1", n == 1, fmt.Sprintf(
		"PUT /patients/:id leaves no audit entry (the patient has %d, the registration only): UpdatePatient publishes no event", n))
}

// ---- dental clinical record -------------------------------------------------------------

// TestREG_AUDIT_003_TreatmentCourseLifecycleIsAudited: Given a dentist, When they
// create a course, record visit 1, undo it with a reason, and cancel the course with
// a reason, Then the trail holds dental.plan.created and dental.plan.cancelled on the
// course and two dental.session.updated on the visit, all naming the dentist; the
// cancel and the undo carry their reasons.
func TestREG_AUDIT_003_TreatmentCourseLifecycleIsAudited(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	me := c.Staff["doctor"].ID
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Course"), "Audit")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	denRecord(t, doc, p.ID, sid, "access opened")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/sessions/"+sid, map[string]any{"status": "planned", "reason": "wrong chair"}).Expect(t, 204, "undo")
	doc.Do("POST", "/dental/patients/"+p.ID+"/plans/"+plan.ID+"/cancel", map[string]any{"reason": "moved to Adama"}).Expect(t, 200, "cancel")
	xcDrainAudit(t, c.TenantID)

	planID := xcID(t, id.PrefixTreatmentPlan, plan.ID)
	xcExpectAudit(t, c.TenantID, "dental.plan.created", planID, me, 1)
	cancel := xcExpectAudit(t, c.TenantID, "dental.plan.cancelled", planID, me, 1)
	if !strings.Contains(cancel[0].Payload, "moved to Adama") {
		t.Fatalf("cancel audit payload lacks the reason: %s", cancel[0].Payload)
	}
	upd := xcExpectAudit(t, c.TenantID, "dental.session.updated", xcID(t, id.PrefixTreatmentSession, sid), me, 2)
	if !strings.Contains(upd[1].Payload, "wrong chair") {
		t.Fatalf("undo audit payload lacks the reason: %s", upd[1].Payload)
	}
}

// TestREG_AUDIT_004_ChartExamsAndPrescriptionsAreAudited: Given a dentist, When they
// save the chart, create, correct and delete an examination, and void a prescription
// with a reason, Then each is on the trail under the dentist. DEN-1: the exam entries
// are filed against the patient with only a visit date — the deleted exam cannot be
// identified from its audit entry.
func TestREG_AUDIT_004_ChartExamsAndPrescriptionsAreAudited(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	me := c.Staff["doctor"].ID
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Chart"), "Audit")
	pid := xcID(t, id.PrefixPatient, p.ID)
	denSeedConditions(t, doc)
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR1": "decayed"}}).Expect(t, 200, "save chart")
	ex := denCreateExam(t, doc, p.ID, "Pulpitis UR1")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/exams/"+ex.ID, map[string]any{"visit_date": denToday(), "diagnosis": "Apical periodontitis"}).Expect(t, 200, "update exam")
	doc.Do("DELETE", "/dental/patients/"+p.ID+"/exams/"+ex.ID, nil).Expect(t, 204, "delete exam")
	plan := createPlan(t, doc, p.ID, "1000", 1, "")
	var rx struct {
		ID string `json:"id"`
	}
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+plan.Sessions[0].ID+"/prescriptions", map[string]any{
		"items": []map[string]any{{"drug_name": "Ibuprofen 400mg", "dose": "1 tab", "frequency": "TDS"}},
	}).Expect(t, 201, "prescribe").Decode(t, &rx)
	doc.Do("DELETE", "/dental/patients/"+p.ID+"/prescriptions/"+rx.ID, map[string]any{"reason": "wrong drug"}).Expect(t, 204, "void rx")
	xcDrainAudit(t, c.TenantID)

	chart := xcExpectAudit(t, c.TenantID, "dental.chart.saved", pid, me, 1)
	if !strings.Contains(chart[0].Payload, "UR1") {
		t.Fatalf("chart audit payload lacks the tooth: %s", chart[0].Payload)
	}
	xcExpectAudit(t, c.TenantID, "dental.examination.recorded", pid, me, 1)
	xcExpectAudit(t, c.TenantID, "dental.examination.updated", pid, me, 1)
	del := xcExpectAudit(t, c.TenantID, "dental.examination.deleted", pid, me, 1)
	vx := xcExpectAudit(t, c.TenantID, "dental.prescription.voided", xcID(t, id.PrefixDentalRx, rx.ID), me, 1)
	if !strings.Contains(vx[0].Payload, "wrong drug") {
		t.Fatalf("prescription void audit lacks the reason: %s", vx[0].Payload)
	}
	exUUID := xcID(t, id.PrefixDentalVisit, ex.ID).String()
	testkit.KnownBug(t, "DEN-1", !strings.Contains(del[0].Payload, exUUID), fmt.Sprintf(
		"the dental.examination.deleted audit entry does not say which examination was deleted (payload %s); "+
			"with the row hard-deleted, nothing records what it said", del[0].Payload))
}

// TestREG_AUDIT_005_RepriceAndPayLaterLeaveTheirReasons: Given a delivered course,
// When the dentist reprices a visit giving a reason, and marks another visit "pay
// later" with a note, Then the trail must hold both decisions with their words.
// DEN-10: dental.session.repriced carries from/to/mode but not the reason, and
// pay-later publishes no event at all.
func TestREG_AUDIT_005_RepriceAndPayLaterLeaveTheirReasons(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Price"), "Audit")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	s0, s1 := plan.Sessions[0].ID, plan.Sessions[1].ID
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+s0+"/reprice",
		map[string]any{"amount": "1500", "mode": "total", "reason": "extra canal found"}).Expect(t, 204, "reprice")
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+s1+"/pay-later", map[string]any{"note": "salary on the 30th"}).Expect(t, 204, "pay later")
	xcDrainAudit(t, c.TenantID)

	rep := xcExpectAudit(t, c.TenantID, "dental.session.repriced", xcID(t, id.PrefixTreatmentSession, s0), c.Staff["doctor"].ID, 1)
	t.Run("reprice reason", func(t *testing.T) {
		testkit.KnownBug(t, "DEN-10", !strings.Contains(rep[0].Payload, "extra canal found"), fmt.Sprintf(
			"the reprice audit entry omits the dentist's reason (payload %s; dental/service/service.go RepriceSession Publish)", rep[0].Payload))
	})
	t.Run("pay later", func(t *testing.T) {
		n := xcAuditCount(t, c.TenantID, xcID(t, id.PrefixTreatmentSession, s1))
		testkit.KnownBug(t, "DEN-10", n == 0,
			"POST /dental/.../pay-later leaves no audit entry: SetPayLater publishes no event")
	})
}

// ---- money ---------------------------------------------------------------------------

// TestREG_AUDIT_006_EveryMoneyDecisionIsAudited: Given a Practice clinic, When the
// dentist sends a visit to the cashier, the cashier settles it, the manager refunds
// it, the cashier voids one plain charge and waives another, and writes a delivered
// visit off, Then each lands on the trail under the person who did it, against the
// charge (or the refund row), with its reason where one was given.
func TestREG_AUDIT_006_EveryMoneyDecisionIsAudited(t *testing.T) {
	c := payClinic(t)
	doc, cashier, mgr := srv.As(t, c, "doctor"), srv.As(t, c, "cashier"), srv.As(t, c, "branch_manager")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Money"), "Audit")
	plan := createPlan(t, doc, p.ID, "2000", 2, "")
	payDone(t, doc, p.ID, plan.Sessions[0].ID)
	payCollect(t, doc, p.ID, plan.Sessions[0].ID)
	ch := payOnePending(t, cashier, p.ID, 1000)
	paySettle(cashier, ch.ID).Expect(t, 204, "settle")
	mgr.Do("POST", "/billing/charges/"+ch.ID+"/refund", map[string]any{"reason": "redo at no cost"}).Expect(t, 204, "refund")
	voidID := payRaise(t, cashier, c, p.ID, 300)
	cashier.Do("POST", "/billing/charges/"+voidID+"/void", map[string]any{"reason": "keyed twice"}).Expect(t, 204, "void")
	waiveID := payRaise(t, cashier, c, p.ID, 200)
	cashier.Do("POST", "/billing/charges/"+waiveID+"/waive", map[string]any{"reason": "staff family"}).Expect(t, 204, "waive")
	payDone(t, doc, p.ID, plan.Sessions[1].ID)
	cashier.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+plan.Sessions[1].ID+"/write-off", map[string]any{"reason": "goodwill"}).Expect(t, 204, "write off")
	xcDrainAudit(t, c.TenantID)

	chID := xcID(t, id.PrefixCharge, ch.ID)
	xcExpectAudit(t, c.TenantID, "dental.charge.raised", chID, c.Staff["doctor"].ID, 1)
	xcExpectAudit(t, c.TenantID, "billing.charge.paid", chID, c.Staff["cashier"].ID, 1)
	var refundID uuid.UUID
	one(t, `SELECT id FROM charges WHERE reverses_charge_id = $1`, &refundID, chID)
	if r := xcExpectAudit(t, c.TenantID, "billing.charge.refunded", refundID, c.Staff["branch_manager"].ID, 1); !strings.Contains(r[0].Payload, "redo at no cost") {
		t.Fatalf("refund audit lacks the reason: %s", r[0].Payload)
	}
	if r := xcExpectAudit(t, c.TenantID, "billing.charge.voided", xcID(t, id.PrefixCharge, voidID), c.Staff["cashier"].ID, 1); !strings.Contains(r[0].Payload, "keyed twice") {
		t.Fatalf("void audit lacks the reason: %s", r[0].Payload)
	}
	if r := xcExpectAudit(t, c.TenantID, "billing.charge.waived", xcID(t, id.PrefixCharge, waiveID), c.Staff["cashier"].ID, 1); !strings.Contains(r[0].Payload, "staff family") {
		t.Fatalf("waive audit lacks the reason: %s", r[0].Payload)
	}
	var woCharge uuid.UUID
	one(t, `SELECT charge_id FROM treatment_sessions WHERE id = $1`, &woCharge, xcID(t, id.PrefixTreatmentSession, plan.Sessions[1].ID))
	if r := xcExpectAudit(t, c.TenantID, "dental.session.written_off", woCharge, c.Staff["cashier"].ID, 1); !strings.Contains(r[0].Payload, "goodwill") {
		t.Fatalf("write-off audit lacks the reason: %s", r[0].Payload)
	}
}

// ---- administration ------------------------------------------------------------------

// TestREG_AUDIT_007_StaffAdministrationIsAudited: Given the owner, When they invite a
// member of staff, suspend a nurse and change a receptionist's role, Then each change
// to who may act in the clinic must be on the trail. NEW-AUDIT-1: none of the three
// publishes an event (identity/service/user_service.go), so the trail is silent about
// who granted or removed access.
func TestREG_AUDIT_007_StaffAdministrationIsAudited(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	inv := opInviteUser(t, owner, "aud-"+uuid.NewString()[:6]+"@"+c.Slug+".test", []string{"nurse"}, nil)
	authSetStatus(t, owner, c.Staff["nurse"].ID, "suspended")
	owner.Do("PUT", "/users/"+id.Encode(id.PrefixUser, c.Staff["receptionist"].ID)+"/roles",
		map[string]any{"roles": []string{"cashier"}}).Expect(t, 204, "change role")
	xcDrainAudit(t, c.TenantID)
	for name, target := range map[string]uuid.UUID{
		"invite":        xcID(t, id.PrefixUser, inv.ID),
		"status change": c.Staff["nurse"].ID,
		"role change":   c.Staff["receptionist"].ID,
	} {
		t.Run(name, func(t *testing.T) {
			var n int
			one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND target_id = $2 AND action NOT LIKE 'auth.user.%'`,
				&n, c.TenantID, target)
			testkit.KnownBug(t, "NEW-AUDIT-1", n == 0, "the owner's "+name+" leaves no audit entry: user administration publishes no event")
		})
	}
}

// TestREG_AUDIT_008_ClinicConfigurationIsAudited: Given the owner of a Practice
// clinic, When they open a branch, add a payment rail and change the SMS settings,
// Then each must be on the trail. NEW-AUDIT-2: org and messaging configuration
// publish no events, so "who added this bank account the money now goes to?" has no
// answer.
func TestREG_AUDIT_008_ClinicConfigurationIsAudited(t *testing.T) {
	c := payClinic(t)
	xcExec(t, `UPDATE tenants SET branch_limit_override = -1 WHERE id = $1`, c.TenantID)
	owner := srv.As(t, c, "owner")
	mark := xcAuditMark(t, c.TenantID)
	b := opNewBranch(t, owner, "Audited", "AUD")
	var rail opRail
	owner.Do("POST", "/org/payment-rails", map[string]any{"label": uniq("Telebirr "), "kind": "wallet", "bank_key": "telebirr"}).
		Expect(t, 201, "add rail").Decode(t, &rail)
	msgOn(t, c, "en")
	xcDrainAudit(t, c.TenantID)
	var others int
	one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action NOT LIKE 'auth.user.%'`, &others, c.TenantID)
	for name, target := range map[string]uuid.UUID{
		"branch create": xcID(t, id.PrefixBranch, b.ID),
		"payment rail":  xcID(t, id.PrefixPaymentRail, rail.ID),
	} {
		t.Run(name, func(t *testing.T) {
			testkit.KnownBug(t, "NEW-AUDIT-2", xcAuditCount(t, c.TenantID, target) == 0,
				"the owner's "+name+" leaves no audit entry: org configuration publishes no event")
		})
	}
	t.Run("messaging settings", func(t *testing.T) {
		var n int
		one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'messaging.%'`, &n, c.TenantID)
		testkit.KnownBug(t, "NEW-AUDIT-2", n == 0, fmt.Sprintf(
			"PUT /messaging/settings leaves no audit entry (clinic trail grew from %d to %d rows, %d non-sign-in)", mark, xcAuditMark(t, c.TenantID), others))
	})
}

// ---- isolation ------------------------------------------------------------------------

// TestREG_AUDIT_009_TheTrailIsPerClinic: Given audit entries in clinic A and in clinic
// B, When a session scoped to clinic A (the clinic_app role with A's tenant set, as
// every API request runs) reads audit_logs, Then it sees only A's entries — none of
// B's, even asking for B by id — and it cannot write an entry into B's trail; the
// audit worker files each event under that event's own clinic.
func TestREG_AUDIT_009_TheTrailIsPerClinic(t *testing.T) {
	a, b := newClinic(t), newClinic(t)
	pa := createPatient(t, srv.As(t, a, "receptionist"), uniq("IsoA"), "Audit")
	pb := createPatient(t, srv.As(t, b, "receptionist"), uniq("IsoB"), "Audit")
	xcDrainAudit(t, a.TenantID)
	xcDrainAudit(t, b.TenantID)
	if len(xcAuditFor(t, b.TenantID, "patient.patient.registered", xcID(t, id.PrefixPatient, pb.ID))) != 1 {
		t.Fatalf("clinic B's registration is not on B's trail")
	}
	var wrong int
	one(t, `SELECT count(*) FROM audit_logs WHERE target_id = $1 AND tenant_id <> $2`, &wrong, xcID(t, id.PrefixPatient, pa.ID), a.TenantID)
	if wrong != 0 {
		t.Fatalf("clinic A's event filed under another clinic (%d rows)", wrong)
	}

	var seenB, seenA, total int
	err := xcAuditDB(t).WithTenantTx(t.Context(), a.TenantID, func(tx pgx.Tx) error {
		if e := tx.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE tenant_id = $1`, b.TenantID).Scan(&seenB); e != nil {
			return e
		}
		if e := tx.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE target_id = $1`, xcID(t, id.PrefixPatient, pb.ID)).Scan(&total); e != nil {
			return e
		}
		return tx.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs WHERE tenant_id = $1`, a.TenantID).Scan(&seenA)
	})
	if err != nil {
		t.Fatalf("read as clinic A: %v", err)
	}
	if seenB != 0 || total != 0 {
		t.Fatalf("CROSS-CLINIC READ: clinic A's session sees %d of B's audit rows (%d by B's patient id)", seenB, total)
	}
	if seenA == 0 {
		t.Fatalf("clinic A's session sees none of its own audit rows — the check above proves nothing")
	}
	err = xcAuditDB(t).WithTenantTx(t.Context(), a.TenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(t.Context(), `INSERT INTO audit_logs (tenant_id, action, target_type) VALUES ($1, 'forged', 'x')`, b.TenantID)
		return e
	})
	if err == nil {
		t.Fatalf("CROSS-CLINIC WRITE: clinic A's session wrote an entry into clinic B's audit trail")
	}
	var forged int
	one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'forged'`, &forged, b.TenantID)
	if forged != 0 {
		t.Fatalf("forged audit row present in clinic B")
	}
}
