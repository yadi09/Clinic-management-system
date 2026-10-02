package regression

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The dental module through the API, as the dentist and the front desk use it: the
// tooth chart, a course of treatment, recording and correcting a visit, the rules
// that stop given treatment (and the money owed for it) from quietly disappearing,
// prescriptions, examinations, extras and the seal between clinical record and desk.
// The money projection itself (D1–D13) is covered at service level in
// internal/dental/service/money_integration_test.go and is not repeated here.

// ---- helpers (prefixed den: other files share this package) -----------------

type denRx struct {
	ID    string `json:"id"`
	Note  string `json:"note"`
	Items []struct {
		DrugName string `json:"drug_name"`
	} `json:"items"`
}

type denExtra struct {
	ID          string `json:"id"`
	AmountDue   string `json:"amount_due"`
	Status      string `json:"status"`
	Payment     string `json:"payment"`
	ServiceName string `json:"service_name"`
}

type denSession struct {
	ID            string     `json:"id"`
	Seq           int        `json:"seq"`
	Status        string     `json:"status"`
	ScheduledDate string     `json:"scheduled_date"`
	AmountDue     string     `json:"amount_due"`
	Payment       string     `json:"payment"`
	Procedure     string     `json:"procedure"`
	Tooth         string     `json:"tooth"`
	Notes         string     `json:"notes"`
	Prescriptions []denRx    `json:"prescriptions"`
	Extras        []denExtra `json:"extras"`
}

type denPlan struct {
	ID          string       `json:"id"`
	Status      string       `json:"status"`
	TotalAmount string       `json:"total_amount"`
	Sessions    []denSession `json:"sessions"`
	Deposit     *struct {
		ID            string `json:"id"`
		AmountDue     string `json:"amount_due"`
		ScheduledDate string `json:"scheduled_date"`
	} `json:"deposit"`
}

func denToday() string { return time.Now().Format("2006-01-02") }

func denDay(offset int) string { return time.Now().AddDate(0, 0, offset).Format("2006-01-02") }

func denMoney(t *testing.T, s string) float64 {
	t.Helper()
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("not a money value: %q", s)
	}
	return f
}

// denUUID turns a prefixed API id into the raw uuid, for asserting DB state.
func denUUID(t *testing.T, prefix, s string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(prefix, s)
	if err != nil {
		t.Fatalf("decode %s id %q: %v", prefix, s, err)
	}
	return u
}

// denPatient registers a patient at the front desk.
func denPatient(t *testing.T, c *testkit.Clinic) patientRef {
	t.Helper()
	return createPatient(t, srv.As(t, c, "receptionist"), uniq("Den"), "Patient")
}

// denPlans reads a patient's courses as the given user.
func denPlans(t *testing.T, cl *testkit.Client, patientID string) []denPlan {
	t.Helper()
	var out []denPlan
	cl.Do("GET", "/dental/patients/"+patientID+"/plans", nil).Expect(t, 200, "list plans").Decode(t, &out)
	return out
}

func denPlanByID(t *testing.T, cl *testkit.Client, patientID, planID string) denPlan {
	t.Helper()
	for _, p := range denPlans(t, cl, patientID) {
		if p.ID == planID {
			return p
		}
	}
	t.Fatalf("plan %s not in the patient's plans", planID)
	return denPlan{}
}

func denSessionByID(t *testing.T, p denPlan, sid string) denSession {
	t.Helper()
	for _, s := range p.Sessions {
		if s.ID == sid {
			return s
		}
	}
	t.Fatalf("session %s not in plan %s", sid, p.ID)
	return denSession{}
}

// denChart reads the tooth chart.
func denChart(t *testing.T, cl *testkit.Client, patientID string) map[string]string {
	t.Helper()
	var ch struct {
		Teeth map[string]string `json:"teeth"`
	}
	cl.Do("GET", "/dental/patients/"+patientID+"/chart", nil).Expect(t, 200, "get chart").Decode(t, &ch)
	if ch.Teeth == nil {
		ch.Teeth = map[string]string{}
	}
	return ch.Teeth
}

// denSeedConditions loads the clinic's tooth conditions, which also seeds the
// defaults on a clinic that has never charted (the workspace does this on open).
func denSeedConditions(t *testing.T, cl *testkit.Client) {
	t.Helper()
	cl.Do("GET", "/dental/tooth-statuses", nil).Expect(t, 200, "list tooth statuses")
}

// denRecord marks a visit done the way the record form does.
func denRecord(t *testing.T, cl *testkit.Client, patientID, sid, notes string) {
	t.Helper()
	cl.Do("PUT", "/dental/patients/"+patientID+"/sessions/"+sid, map[string]any{
		"status": "done", "procedure": "Access opening", "tooth": "UR5", "notes": notes,
	}).Expect(t, 204, "record visit")
}

// denSecondDentist adds another dentist (same doctor role, so no payment.waive) to a
// clinic and signs them in.
func denSecondDentist(t *testing.T, c *testkit.Clinic) (*testkit.Client, uuid.UUID) {
	t.Helper()
	doc := c.Staff["doctor"]
	email := "doctor2-" + uuid.NewString()[:6] + "@" + c.Slug + ".test"
	var uid uuid.UUID
	err := super.Pool.QueryRow(t.Context(),
		`INSERT INTO users (tenant_id, email, password_hash, full_name, status)
		 SELECT tenant_id, $2, password_hash, 'Second Dentist', 'active' FROM users WHERE id = $1
		 RETURNING id`, doc.ID, email).Scan(&uid)
	if err != nil {
		t.Fatalf("add second dentist: %v", err)
	}
	if _, err := super.Pool.Exec(t.Context(),
		`INSERT INTO user_role_scopes (tenant_id, user_id, role_id)
		 SELECT tenant_id, $2, role_id FROM user_role_scopes WHERE user_id = $1`, doc.ID, uid); err != nil {
		t.Fatalf("grant second dentist the doctor role: %v", err)
	}
	return srv.Login(t, c.Slug, email), uid
}

// denDentalService puts a priced procedure on the clinic's dental list (the
// dentist may maintain that list) and returns its id.
func denDentalService(t *testing.T, doc *testkit.Client, price float64) string {
	t.Helper()
	r := doc.Do("POST", "/billing/services", map[string]any{
		"code": uniq("XR"), "name": uniq("Periapical X-ray "), "category": "dental",
		"price": price, "assignable_by": "either",
	}).Expect(t, 201, "create dental service")
	var s struct {
		ID string `json:"id"`
	}
	r.Decode(t, &s)
	if s.ID == "" {
		t.Fatalf("service has no id: %s", r.Raw)
	}
	return s.ID
}

// ---- chart --------------------------------------------------------------------

// TestREG_DENTAL_001_ChartSavePersists: Given a patient, When the dentist marks UR1
// decayed, Then a fresh read of the chart (a page refresh) shows it and the
// database row holds it.
func TestREG_DENTAL_001_ChartSavePersists(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	denSeedConditions(t, doc)

	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR1": "decayed"}}).
		Expect(t, 200, "save chart")

	again := srv.As(t, clinicA, "doctor") // a new session: nothing cached client-side
	if got := denChart(t, again, p.ID)["UR1"]; got != "decayed" {
		t.Fatalf("UR1 after refresh = %q, want decayed", got)
	}
	var stored string
	one(t, `SELECT coalesce(teeth->>'UR1','') FROM dental_charts WHERE patient_id = $1`, &stored,
		denUUID(t, id.PrefixPatient, p.ID))
	if stored != "decayed" {
		t.Fatalf("database holds UR1=%q, want decayed", stored)
	}
}

// TestREG_DENTAL_002_ChartSavesOnDifferentTeethBothSurvive: Given two clinicians
// charting the same patient, When one saves UR1 and the other then saves LL6 (each
// sending only its own change), Then both teeth are on the chart — the server
// merges, the second save does not erase the first (audit D18).
func TestREG_DENTAL_002_ChartSavesOnDifferentTeethBothSurvive(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	owner := srv.As(t, clinicA, "owner")
	denSeedConditions(t, doc)

	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR1": "decayed"}}).
		Expect(t, 200, "first save")
	owner.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"LL6": "filled"}}).
		Expect(t, 200, "second save")

	ch := denChart(t, doc, p.ID)
	if ch["UR1"] != "decayed" || ch["LL6"] != "filled" {
		t.Fatalf("chart after two saves = %v, want UR1=decayed and LL6=filled", ch)
	}
}

// TestREG_DENTAL_003_ChartRejectsUnknownToothOrCondition: When a save names a tooth
// that is not one of the 32 Palmer teeth, or a condition the clinic does not have,
// Then it is refused with 400 and nothing in that save is stored — not even the
// valid tooth sent alongside.
func TestREG_DENTAL_003_ChartRejectsUnknownToothOrCondition(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	denSeedConditions(t, doc)
	path := "/dental/patients/" + p.ID + "/chart"

	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR9": "decayed"}}).Expect(t, 400, "tooth UR9")
	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR2": "sparkly"}}).Expect(t, 400, "unknown condition")
	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR3": "filled", "XX1": "filled"}}).
		Expect(t, 400, "valid tooth with an invalid one")
	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR3": "filled", "UR4": "glitter"}}).
		Expect(t, 400, "valid tooth with an invalid condition")

	if ch := denChart(t, doc, p.ID); len(ch) != 0 {
		t.Fatalf("a refused save left teeth on the chart: %v", ch)
	}
	var rows int
	one(t, `SELECT count(*) FROM dental_charts WHERE patient_id = $1 AND teeth <> '{}'::jsonb`, &rows,
		denUUID(t, id.PrefixPatient, p.ID))
	if rows != 0 {
		t.Fatalf("database holds a non-empty chart after only refused saves")
	}
}

// TestREG_DENTAL_004_ChartClearsAToothWithEmptyCondition: Given UR4 crowned and UL1
// healthy, When the dentist saves {UR4: ""}, Then UR4 is gone and UL1 untouched.
func TestREG_DENTAL_004_ChartClearsAToothWithEmptyCondition(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	denSeedConditions(t, doc)
	path := "/dental/patients/" + p.ID + "/chart"

	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR4": "crown", "UL1": "healthy"}}).Expect(t, 200, "mark")
	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR4": ""}}).Expect(t, 200, "clear UR4")

	ch := denChart(t, doc, p.ID)
	if _, still := ch["UR4"]; still {
		t.Fatalf("UR4 still charted after clearing: %v", ch)
	}
	if ch["UL1"] != "healthy" {
		t.Fatalf("clearing UR4 disturbed UL1: %v", ch)
	}
}

// TestREG_DENTAL_005_FreshClinicCanChartBeforeOpeningConditionList: Given a dental
// clinic just provisioned, When its dentist's first ever request is a chart save
// with a default condition (decayed), Then it is accepted. The conditions are only
// seeded as a side effect of GET /dental/tooth-statuses, so a save that arrives
// first (another client, an integration, a page that loads the chart before the
// palette) is refused as "unknown condition".
func TestREG_DENTAL_005_FreshClinicCanChartBeforeOpeningConditionList(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	doc := srv.As(t, c, "doctor")
	r := doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR1": "decayed"}})
	if r.Status == 400 && strings.Contains(r.Message, "unknown condition") {
		testkit.KnownBug(t, "NEW-DEN-1", true,
			"a new clinic has no tooth conditions until someone lists them; SaveChart refuses 'decayed' ("+r.Message+")")
	}
	r.Expect(t, 200, "first chart save in a new clinic")
}

// TestREG_DENTAL_006_FrontDeskCannotReadOrWriteChart: the tooth chart is clinical.
// The receptionist (dental.read) reads an empty chart and cannot save one.
func TestREG_DENTAL_006_FrontDeskCannotReadOrWriteChart(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	denSeedConditions(t, doc)
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"LR7": "extracted"}}).
		Expect(t, 200, "dentist saves")

	desk := srv.As(t, clinicA, "receptionist")
	if ch := denChart(t, desk, p.ID); len(ch) != 0 {
		t.Fatalf("front desk can read the tooth chart: %v", ch)
	}
	desk.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"LR7": "healthy"}}).
		Expect(t, 403, "front desk saves chart")
	if denChart(t, doc, p.ID)["LR7"] != "extracted" {
		t.Fatalf("the desk's refused save changed the chart")
	}
}

// ---- plans --------------------------------------------------------------------

// TestREG_DENTAL_010_PlanSplitsTotalAcrossVisits: When a 3,000 ETB course of 3
// visits every 2 weeks is created, Then it has 3 visits of 1,000 each (summing to
// 3,000), dated start, +14 and +28 days, and it appears in the patient's summary.
func TestREG_DENTAL_010_PlanSplitsTotalAcrossVisits(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")

	if len(plan.Sessions) != 3 {
		t.Fatalf("want 3 visits, got %d", len(plan.Sessions))
	}
	if plan.Deposit != nil {
		t.Fatalf("a plan without a down payment returned one: %+v", plan.Deposit)
	}
	sum := 0.0
	for i, s := range plan.Sessions {
		sum += denMoney(t, s.AmountDue)
		if want := denDay(14 * i); s.ScheduledDate != want {
			t.Fatalf("visit %d dated %s, want %s", i+1, s.ScheduledDate, want)
		}
		if s.Status != "planned" {
			t.Fatalf("new visit %d is %q, want planned", i+1, s.Status)
		}
	}
	if sum != 3000 {
		t.Fatalf("visits sum to %.2f, want 3000", sum)
	}
	sm := summary(t, doc, p.ID)
	if !strings.Contains(string(sm["plans"]), plan.ID) {
		t.Fatalf("plan %s missing from the summary", plan.ID)
	}
	var visits int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE plan_id = $1 AND kind = 'visit'`, &visits,
		denUUID(t, id.PrefixTreatmentPlan, plan.ID))
	if visits != 3 {
		t.Fatalf("database holds %d visit rows, want 3", visits)
	}
}

// TestREG_DENTAL_011_PlanDepositComesOffTheTop: When a 3,000 ETB course of 3 visits
// is created with a 1,000 down payment, Then there is one deposit row of 1,000 (kind
// deposit, seq 0), the 3 visits share the remaining 2,000, and the course total
// stays 3,000.
func TestREG_DENTAL_011_PlanDepositComesOffTheTop(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "1000")

	if plan.Deposit == nil || denMoney(t, plan.Deposit.AmountDue) != 1000 {
		t.Fatalf("deposit = %+v, want 1000", plan.Deposit)
	}
	sum := 0.0
	for _, s := range plan.Sessions {
		sum += denMoney(t, s.AmountDue)
	}
	if len(plan.Sessions) != 3 || sum != 2000 {
		t.Fatalf("visits = %d summing %.2f, want 3 summing 2000", len(plan.Sessions), sum)
	}
	pid := denUUID(t, id.PrefixTreatmentPlan, plan.ID)
	var deposits, seq int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE plan_id = $1 AND kind = 'deposit'`, &deposits, pid)
	one(t, `SELECT coalesce(max(seq), -1) FROM treatment_sessions WHERE plan_id = $1 AND kind = 'deposit'`, &seq, pid)
	if deposits != 1 || seq != 0 {
		t.Fatalf("deposit rows = %d (seq %d), want exactly one at seq 0", deposits, seq)
	}
	var total string
	one(t, `SELECT total_amount::text FROM treatment_plans WHERE id = $1`, &total, pid)
	if denMoney(t, total) != 3000 {
		t.Fatalf("course total = %s, want 3000", total)
	}
}

// TestREG_DENTAL_012_PlanDepositAboveTotalRefused: a down payment larger than the
// course is refused and no course is created.
func TestREG_DENTAL_012_PlanDepositAboveTotalRefused(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	doc.Do("POST", "/dental/patients/"+p.ID+"/plans", map[string]any{
		"title": "Crown", "total_amount": "1000", "deposit": "1500", "start_date": denToday(),
		"interval_unit": "week", "interval_count": 1, "session_count": 2,
	}).Expect(t, 400, "deposit above total")
	if n := len(denPlans(t, doc, p.ID)); n != 0 {
		t.Fatalf("refused course was created anyway (%d plans)", n)
	}
}

// ---- recording a visit ----------------------------------------------------------

// TestREG_DENTAL_020_RecordVisitPersists: When the dentist records visit 1 as done
// with procedure, tooth and notes, Then it reads back done with those fields, and
// the database stamps completed_at and completed_by (the dentist).
func TestREG_DENTAL_020_RecordVisitPersists(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	notes := uniq("Canals located, dressed with CaOH ")
	denRecord(t, doc, p.ID, sid, notes)

	s := denSessionByID(t, denPlanByID(t, doc, p.ID, plan.ID), sid)
	if s.Status != "done" || s.Notes != notes || s.Procedure != "Access opening" || s.Tooth != "UR5" {
		t.Fatalf("recorded visit reads back %+v", s)
	}
	var completed bool
	var by uuid.UUID
	one(t, `SELECT completed_at IS NOT NULL FROM treatment_sessions WHERE id = $1`, &completed, denUUID(t, id.PrefixTreatmentSession, sid))
	one(t, `SELECT completed_by FROM treatment_sessions WHERE id = $1`, &by, denUUID(t, id.PrefixTreatmentSession, sid))
	if !completed || by != clinicA.Staff["doctor"].ID {
		t.Fatalf("completed_at set=%v completed_by=%s, want set and the dentist", completed, by)
	}
}

// TestREG_DENTAL_021_RecordingAMissedVisitMovesItToToday: Given visit 1 was planned
// for ten days ago and never recorded, When the dentist records it done today with
// scheduled_date=today in the same request (the visit-card flow), Then it is done
// and dated today.
func TestREG_DENTAL_021_RecordingAMissedVisitMovesItToToday(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	suid := denUUID(t, id.PrefixTreatmentSession, sid)
	if _, err := super.Pool.Exec(t.Context(),
		`UPDATE treatment_sessions SET scheduled_date = $2::date WHERE id = $1`, suid, denDay(-10)); err != nil {
		t.Fatal(err)
	}

	doc.Do("PUT", "/dental/patients/"+p.ID+"/sessions/"+sid, map[string]any{
		"status": "done", "scheduled_date": denToday(), "procedure": "Cleaning", "notes": "seen late",
	}).Expect(t, 204, "record missed visit as today")

	var date, status string
	one(t, `SELECT scheduled_date::text FROM treatment_sessions WHERE id = $1`, &date, suid)
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &status, suid)
	if date != denToday() || status != "done" {
		t.Fatalf("missed visit is %s on %s, want done on %s", status, date, denToday())
	}
}

// TestREG_DENTAL_022_DoneVisitCannotBeRedated: Given a visit recorded done, When
// anyone tries to move its date (through the record form or the reschedule
// endpoint), Then it is refused and the date is unchanged — redating given
// treatment rewrites the clinical record and the age of its debt.
func TestREG_DENTAL_022_DoneVisitCannotBeRedated(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	denRecord(t, doc, p.ID, sid, "done")

	doc.Do("PUT", "/dental/patients/"+p.ID+"/sessions/"+sid, map[string]any{"scheduled_date": denDay(3)}).
		Expect(t, 400, "redate a done visit")
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/reschedule", map[string]any{"scheduled_date": denDay(3)}).
		Expect(t, 400, "reschedule a done visit")

	var date string
	one(t, `SELECT scheduled_date::text FROM treatment_sessions WHERE id = $1`, &date, denUUID(t, id.PrefixTreatmentSession, sid))
	if date != denToday() {
		t.Fatalf("done visit moved to %s", date)
	}
}

// TestREG_DENTAL_023_FrontDeskReschedulesButCannotRecord: the receptionist may move
// a planned visit (appointment.manage) but not record or edit it clinically.
func TestREG_DENTAL_023_FrontDeskReschedulesButCannotRecord(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	desk := srv.As(t, clinicA, "receptionist")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[1].ID

	desk.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/reschedule", map[string]any{"scheduled_date": denDay(20)}).
		Expect(t, 204, "desk reschedules planned visit")
	var date string
	one(t, `SELECT scheduled_date::text FROM treatment_sessions WHERE id = $1`, &date, denUUID(t, id.PrefixTreatmentSession, sid))
	if date != denDay(20) {
		t.Fatalf("rescheduled visit is on %s, want %s", date, denDay(20))
	}
	desk.Do("PUT", "/dental/patients/"+p.ID+"/sessions/"+sid, map[string]any{"status": "done", "notes": "desk"}).
		Expect(t, 403, "desk records a visit")
	var status string
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &status, denUUID(t, id.PrefixTreatmentSession, sid))
	if status != "planned" {
		t.Fatalf("desk's refused record changed the visit to %s", status)
	}
}

// ---- undoing / correcting a visit -------------------------------------------------

// TestREG_DENTAL_030_AuthorMayUndoOwnVisitSameDayWithReason: Given a 1,000 ETB visit
// the dentist recorded today and nobody billed, When they undo it without a reason,
// Then 400 and it stays done; With a reason, Then it goes back to planned and its
// completion stamp is cleared.
func TestREG_DENTAL_030_AuthorMayUndoOwnVisitSameDayWithReason(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	suid := denUUID(t, id.PrefixTreatmentSession, sid)
	denRecord(t, doc, p.ID, sid, "wrong patient's visit")
	path := "/dental/patients/" + p.ID + "/sessions/" + sid

	doc.Do("PUT", path, map[string]any{"status": "planned"}).Expect(t, 400, "undo without a reason")
	var status string
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &status, suid)
	if status != "done" {
		t.Fatalf("reasonless undo changed the visit to %s", status)
	}

	doc.Do("PUT", path, map[string]any{"status": "planned", "reason": "recorded on the wrong visit"}).
		Expect(t, 204, "author undoes own visit with a reason")
	var cleared bool
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &status, suid)
	one(t, `SELECT completed_at IS NULL AND completed_by IS NULL FROM treatment_sessions WHERE id = $1`, &cleared, suid)
	if status != "planned" || !cleared {
		t.Fatalf("after undo: status=%s stamp cleared=%v", status, cleared)
	}
}

// TestREG_DENTAL_031_OtherDentistCannotForgiveAnOwedVisit: Given a 1,000 ETB visit
// dentist A recorded and nobody billed, When dentist B (no payment.waive) undoes it
// or lowers its fee, even with a reason, Then 403 VISIT_OWED and nothing changes;
// the owner (payment.waive) may undo it.
func TestREG_DENTAL_031_OtherDentistCannotForgiveAnOwedVisit(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	docA := srv.As(t, c, "doctor")
	docB, _ := denSecondDentist(t, c)
	plan := createPlan(t, docA, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	suid := denUUID(t, id.PrefixTreatmentSession, sid)
	denRecord(t, docA, p.ID, sid, "given")
	path := "/dental/patients/" + p.ID + "/sessions/" + sid

	r := docB.Do("PUT", path, map[string]any{"status": "planned", "reason": "tidying up"}).Expect(t, 403, "colleague undoes")
	if r.Code != "VISIT_OWED" {
		t.Fatalf("colleague undo refused with %q, want VISIT_OWED", r.Code)
	}
	r = docB.Do("PUT", path, map[string]any{"amount_due": "100", "reason": "discount"}).Expect(t, 403, "colleague lowers fee")
	if r.Code != "VISIT_OWED" {
		t.Fatalf("colleague fee cut refused with %q, want VISIT_OWED", r.Code)
	}
	var status, amt string
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &status, suid)
	one(t, `SELECT amount_due::text FROM treatment_sessions WHERE id = $1`, &amt, suid)
	if status != "done" || denMoney(t, amt) != 1000 {
		t.Fatalf("refused corrections changed the visit: status=%s fee=%s", status, amt)
	}

	srv.As(t, c, "owner").Do("PUT", path, map[string]any{"status": "planned", "reason": "owner correction"}).
		Expect(t, 204, "owner (payment.waive) undoes")
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &status, suid)
	if status != "planned" {
		t.Fatalf("owner undo left the visit %s", status)
	}
}

// ---- ending a course -------------------------------------------------------------

// TestREG_DENTAL_040_CancelPlanNeedsAReason: cancelling without a reason is 400 and
// the course stays active; with one, every planned visit is cancelled.
func TestREG_DENTAL_040_CancelPlanNeedsAReason(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	path := "/dental/patients/" + p.ID + "/plans/" + plan.ID + "/cancel"
	puid := denUUID(t, id.PrefixTreatmentPlan, plan.ID)

	doc.Do("POST", path, map[string]any{}).Expect(t, 400, "cancel without reason")
	doc.Do("POST", path, map[string]any{"reason": "   "}).Expect(t, 400, "cancel with blank reason")
	var st string
	one(t, `SELECT status FROM treatment_plans WHERE id = $1`, &st, puid)
	if st != "active" {
		t.Fatalf("refused cancel left the plan %s", st)
	}

	var out struct {
		N int `json:"sessions_cancelled"`
	}
	doc.Do("POST", path, map[string]any{"reason": "patient moved abroad"}).Expect(t, 200, "cancel").Decode(t, &out)
	one(t, `SELECT status FROM treatment_plans WHERE id = $1`, &st, puid)
	var planned int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE plan_id = $1 AND status <> 'cancelled'`, &planned, puid)
	if out.N != 3 || st != "cancelled" || planned != 0 {
		t.Fatalf("cancel: reported %d, plan %s, %d sessions not cancelled", out.N, st, planned)
	}
}

// TestREG_DENTAL_041_CancelPlanRefusedWhileABillIsAtTheCashier: Given visit 1's fee
// sent to the cashier, When the dentist cancels the course, Then 409 PLAN_HAS_BILLS
// and the course stays active.
func TestREG_DENTAL_041_CancelPlanRefusedWhileABillIsAtTheCashier(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/collect", nil).Expect(t, 204, "collect visit 1")
	var billed bool
	one(t, `SELECT charge_id IS NOT NULL FROM treatment_sessions WHERE id = $1`, &billed, denUUID(t, id.PrefixTreatmentSession, sid))
	if !billed {
		t.Fatalf("collect returned 204 but the visit has no charge")
	}

	r := doc.Do("POST", "/dental/patients/"+p.ID+"/plans/"+plan.ID+"/cancel", map[string]any{"reason": "changed mind"}).
		Expect(t, 409, "cancel with a live bill")
	if r.Code != "PLAN_HAS_BILLS" {
		t.Fatalf("refused with %q, want PLAN_HAS_BILLS", r.Code)
	}
	var st string
	one(t, `SELECT status FROM treatment_plans WHERE id = $1`, &st, denUUID(t, id.PrefixTreatmentPlan, plan.ID))
	if st != "active" {
		t.Fatalf("refused cancel left the plan %s", st)
	}
}

// TestREG_DENTAL_042_DeletePlanOnlyBeforeAnythingHappened: a course entered by
// mistake can be deleted; once a visit is done, delete is 409 PLAN_HAS_RECORDS and
// the course and its visits stay.
func TestREG_DENTAL_042_DeletePlanOnlyBeforeAnythingHappened(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")

	mistake := createPlan(t, doc, p.ID, "1000", 1, "")
	doc.Do("DELETE", "/dental/patients/"+p.ID+"/plans/"+mistake.ID, nil).Expect(t, 204, "delete untouched plan")
	var n int
	one(t, `SELECT count(*) FROM treatment_plans WHERE id = $1`, &n, denUUID(t, id.PrefixTreatmentPlan, mistake.ID))
	if n != 0 {
		t.Fatalf("deleted plan still in the database")
	}

	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	denRecord(t, doc, p.ID, plan.Sessions[0].ID, "given")
	r := doc.Do("DELETE", "/dental/patients/"+p.ID+"/plans/"+plan.ID, nil).Expect(t, 409, "delete plan with a done visit")
	if r.Code != "PLAN_HAS_RECORDS" {
		t.Fatalf("refused with %q, want PLAN_HAS_RECORDS", r.Code)
	}
	one(t, `SELECT count(*) FROM treatment_sessions WHERE plan_id = $1`, &n, denUUID(t, id.PrefixTreatmentPlan, plan.ID))
	if n != 3 {
		t.Fatalf("plan's visits after refused delete: %d, want 3", n)
	}
}

// ---- prescriptions ----------------------------------------------------------------

// TestREG_DENTAL_050_PrescriptionDeleteIsAVoid: Given a prescription on a visit, When
// it is withdrawn without a reason, Then 400; With a reason, Then it leaves the visit
// but the row is kept with who, when and why (a printed one may be at a pharmacy).
func TestREG_DENTAL_050_PrescriptionDeleteIsAVoid(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID

	var rx denRx
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/prescriptions", map[string]any{
		"note": "after extraction", "items": []map[string]any{
			{"drug_name": "Amoxicillin 500mg", "dose": "1 cap", "frequency": "TDS", "duration": "5 days"},
		},
	}).Expect(t, 201, "add prescription").Decode(t, &rx)
	if rx.ID == "" || len(rx.Items) != 1 {
		t.Fatalf("prescription response %+v", rx)
	}
	if s := denSessionByID(t, denPlanByID(t, doc, p.ID, plan.ID), sid); len(s.Prescriptions) != 1 || s.Prescriptions[0].ID != rx.ID {
		t.Fatalf("visit lists prescriptions %+v, want the new one", s.Prescriptions)
	}

	path := "/dental/patients/" + p.ID + "/prescriptions/" + rx.ID
	doc.Do("DELETE", path, nil).Expect(t, 400, "withdraw without reason")
	doc.Do("DELETE", path, map[string]any{"reason": "wrong drug"}).Expect(t, 204, "withdraw with reason")

	if s := denSessionByID(t, denPlanByID(t, doc, p.ID, plan.ID), sid); len(s.Prescriptions) != 0 {
		t.Fatalf("voided prescription still listed on the visit: %+v", s.Prescriptions)
	}
	ruid := denUUID(t, id.PrefixDentalRx, rx.ID)
	var kept int
	var reason string
	var by uuid.UUID
	one(t, `SELECT count(*) FROM dental_prescriptions WHERE id = $1 AND voided_at IS NOT NULL`, &kept, ruid)
	one(t, `SELECT coalesce(void_reason,'') FROM dental_prescriptions WHERE id = $1`, &reason, ruid)
	one(t, `SELECT voided_by FROM dental_prescriptions WHERE id = $1`, &by, ruid)
	if kept != 1 || reason != "wrong drug" || by != clinicA.Staff["doctor"].ID {
		t.Fatalf("void not kept: rows=%d reason=%q by=%s", kept, reason, by)
	}
	var items int
	one(t, `SELECT count(*) FROM dental_prescription_items WHERE prescription_id = $1`, &items, ruid)
	if items != 1 {
		t.Fatalf("voided prescription lost its items (%d)", items)
	}
}

// ---- examinations ------------------------------------------------------------------

type denExam struct {
	ID             string `json:"id"`
	VisitDate      string `json:"visit_date"`
	ChiefComplaint string `json:"chief_complaint"`
	Diagnosis      string `json:"diagnosis"`
}

func denCreateExam(t *testing.T, doc *testkit.Client, patientID, diagnosis string) denExam {
	t.Helper()
	var ex denExam
	doc.Do("POST", "/dental/patients/"+patientID+"/exams", map[string]any{
		"visit_date": denToday(), "chief_complaint": "pain lower left", "diagnosis": diagnosis,
	}).Expect(t, 201, "create exam").Decode(t, &ex)
	if ex.ID == "" {
		t.Fatalf("exam has no id")
	}
	return ex
}

// TestREG_DENTAL_060_ExamCreateAndUpdatePersist: an examination is created, its
// diagnosis corrected, and the list shows the correction; one without a visit date
// is refused.
func TestREG_DENTAL_060_ExamCreateAndUpdatePersist(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	doc.Do("POST", "/dental/patients/"+p.ID+"/exams", map[string]any{"diagnosis": "x"}).Expect(t, 400, "exam without date")

	ex := denCreateExam(t, doc, p.ID, "Irreversible pulpitis LL6")
	var upd denExam
	doc.Do("PUT", "/dental/patients/"+p.ID+"/exams/"+ex.ID, map[string]any{
		"visit_date": denToday(), "chief_complaint": "pain lower left", "diagnosis": "Apical periodontitis LL6",
	}).Expect(t, 200, "update exam").Decode(t, &upd)

	var list struct {
		Items []denExam `json:"items"`
	}
	doc.Do("GET", "/dental/patients/"+p.ID+"/exams", nil).Expect(t, 200, "list exams").Decode(t, &list)
	if len(list.Items) != 1 || list.Items[0].Diagnosis != "Apical periodontitis LL6" || upd.Diagnosis != list.Items[0].Diagnosis {
		t.Fatalf("exam list after update: %+v", list.Items)
	}
	// The front desk never reaches the clinical assessment.
	srv.As(t, clinicA, "receptionist").Do("GET", "/dental/patients/"+p.ID+"/exams", nil).Expect(t, 403, "desk reads exams")
}

// TestREG_DENTAL_061_ExamDeleteKeepsTheRecord: When an examination is deleted, Then
// it leaves the list but the row is kept (soft-deleted, with who and when), so a
// deleted diagnosis can still be shown. DEN-1: it is a hard DELETE.
func TestREG_DENTAL_061_ExamDeleteKeepsTheRecord(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	ex := denCreateExam(t, doc, p.ID, uniq("Dx-"))
	doc.Do("DELETE", "/dental/patients/"+p.ID+"/exams/"+ex.ID, nil).Expect(t, 204, "delete exam")

	var list struct {
		Items []denExam `json:"items"`
	}
	doc.Do("GET", "/dental/patients/"+p.ID+"/exams", nil).Expect(t, 200, "list exams").Decode(t, &list)
	if len(list.Items) != 0 {
		t.Fatalf("deleted exam still listed")
	}
	var rows int
	one(t, `SELECT count(*) FROM dental_visits WHERE id = $1`, &rows, denUUID(t, id.PrefixDentalVisit, ex.ID))
	if rows == 0 {
		testkit.KnownBug(t, "DEN-1", true, "DeleteExam hard-deletes dental_visits (service.go:2608); the examination is gone")
	}
	testkit.KnownBug(t, "DEN-1", false, "the deleted exam row is kept")
}

// TestREG_DENTAL_062_ExamUpdateKeepsThePreviousVersion: When a colleague changes an
// exam's diagnosis, Then what it said before is still recoverable somewhere (a
// revision or the audit event). DEN-1: the update overwrites in place and the event
// carries only the visit date.
func TestREG_DENTAL_062_ExamUpdateKeepsThePreviousVersion(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	orig := uniq("Original-diagnosis-")
	ex := denCreateExam(t, doc, p.ID, orig)
	doc.Do("PUT", "/dental/patients/"+p.ID+"/exams/"+ex.ID, map[string]any{
		"visit_date": denToday(), "diagnosis": "rewritten",
	}).Expect(t, 200, "update exam")

	var inRow, inEvents int
	one(t, `SELECT count(*) FROM dental_visits WHERE id = $1 AND diagnosis = $2`, &inRow, denUUID(t, id.PrefixDentalVisit, ex.ID), orig)
	one(t, `SELECT count(*) FROM event_outbox WHERE tenant_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
		&inEvents, clinicA.TenantID, orig)
	if inRow == 0 && inEvents == 0 {
		testkit.KnownBug(t, "DEN-1", true, "UpdateExam overwrites every field and keeps no revision (service.go:2561-2600)")
	}
	testkit.KnownBug(t, "DEN-1", false, "the previous diagnosis is recoverable after an update")
}

// ---- extras --------------------------------------------------------------------------

// TestREG_DENTAL_070_PlannedExtraCanBeTakenOff: an extra added to a visit not yet
// given is not owed and can be removed (204), and the course total follows.
func TestREG_DENTAL_070_PlannedExtraCanBeTakenOff(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	doc := srv.As(t, c, "doctor")
	svc := denDentalService(t, doc, 500)
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID

	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/extras", map[string]any{"service_id": svc}).
		Expect(t, 204, "add extra")
	s := denSessionByID(t, denPlanByID(t, doc, p.ID, plan.ID), sid)
	if len(s.Extras) != 1 || s.Extras[0].Status != "planned" || denMoney(t, s.Extras[0].AmountDue) != 500 {
		t.Fatalf("extras on a planned visit: %+v", s.Extras)
	}
	doc.Do("DELETE", "/dental/patients/"+p.ID+"/extras/"+s.Extras[0].ID, nil).Expect(t, 204, "remove planned extra")
	var total string
	one(t, `SELECT total_amount::text FROM treatment_plans WHERE id = $1`, &total, denUUID(t, id.PrefixTreatmentPlan, plan.ID))
	if denMoney(t, total) != 3000 {
		t.Fatalf("course total after removing the extra = %s, want 3000", total)
	}
}

// TestREG_DENTAL_071_RemovingAGivenExtraNeedsForgiveness: Given an X-ray extra on a
// visit dentist A recorded (so the extra is done and owed, unbilled), When dentist B
// (no payment.waive) removes it with no reason, Then it is refused like any other
// forgiveness of owed treatment (mayForgive) and the extra stays. DEN-3: the only
// guard is "not billed yet", so the debt and the procedure vanish.
func TestREG_DENTAL_071_RemovingAGivenExtraNeedsForgiveness(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	doc := srv.As(t, c, "doctor")
	docB, _ := denSecondDentist(t, c)
	svc := denDentalService(t, doc, 2000)
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	sid := plan.Sessions[0].ID
	denRecord(t, doc, p.ID, sid, "extraction done")
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+sid+"/extras", map[string]any{"service_id": svc}).
		Expect(t, 204, "add extra to a done visit")
	s := denSessionByID(t, denPlanByID(t, doc, p.ID, plan.ID), sid)
	if len(s.Extras) != 1 || s.Extras[0].Status != "done" {
		t.Fatalf("extra on a done visit: %+v (want one, done)", s.Extras)
	}
	exID := s.Extras[0].ID

	r := docB.Do("DELETE", "/dental/patients/"+p.ID+"/extras/"+exID, nil)
	var rows int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE id = $1 AND status = 'done'`, &rows, denUUID(t, id.PrefixTreatmentSession, exID))
	if r.Status == 204 || rows == 0 {
		testkit.KnownBug(t, "DEN-3", true, "a colleague removed a done, unbilled 2,000 ETB extra with no reason (service.go:986-1016)")
	}
	if r.Status != 403 && r.Status != 400 {
		t.Fatalf("removing a given extra: want 403/400, got %d %s", r.Status, r.Code)
	}
	testkit.KnownBug(t, "DEN-3", false, "removing a given extra is guarded")
}

// ---- images and the desk's seal --------------------------------------------------

func denRecordImage(t *testing.T, doc *testkit.Client, c *testkit.Clinic, patientID string) string {
	t.Helper()
	var im struct {
		ID string `json:"id"`
	}
	key := c.TenantID.String() + "/dental/" + uuid.NewString() + ".jpg"
	doc.Do("POST", "/dental/patients/"+patientID+"/images", map[string]any{
		"storage_key": key, "filename": "pa-ll6.jpg", "mime_type": "image/jpeg", "size_bytes": 2048, "category": "xray",
	}).Expect(t, 201, "record image").Decode(t, &im)
	if im.ID == "" {
		t.Fatalf("image has no id")
	}
	return im.ID
}

// TestREG_DENTAL_080_FrontDeskReceivesNoImages: Given an X-ray on a patient, When
// the receptionist lists the patient's images, Then no image (id, link or file
// name) is in the response; the dentist sees it.
func TestREG_DENTAL_080_FrontDeskReceivesNoImages(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	imgID := denRecordImage(t, doc, clinicA, p.ID)

	mine := doc.Do("GET", "/dental/patients/"+p.ID+"/images", nil).Expect(t, 200, "dentist lists images")
	if !strings.Contains(mine.Raw, imgID) {
		t.Fatalf("dentist cannot see the X-ray (test inconclusive): %s", trimBody(mine.Raw))
	}
	desk := srv.As(t, clinicA, "receptionist").Do("GET", "/dental/patients/"+p.ID+"/images", nil)
	if strings.Contains(desk.Raw, imgID) || strings.Contains(desk.Raw, "pa-ll6.jpg") {
		t.Fatalf("front desk received the X-ray: %s", trimBody(desk.Raw))
	}
}

// TestREG_DENTAL_081_FrontDeskImageListIsForbidden: the image list is clinical
// record, so the receptionist should be told 403, not given an empty 200 that looks
// like "no images". SEC-6/D19 (as catalogued: reception and cashier hold dental.read,
// which the route accepts).
func TestREG_DENTAL_081_FrontDeskImageListIsForbidden(t *testing.T) {
	p := denPatient(t, clinicA)
	for _, role := range []string{"receptionist", "cashier"} {
		r := srv.As(t, clinicA, role).Do("GET", "/dental/patients/"+p.ID+"/images", nil)
		if r.Status == 200 {
			testkit.KnownBug(t, "SEC-6", true, role+" gets HTTP 200 on /dental/patients/:id/images (sealed to [] in the handler, not 403)")
		}
		r.Expect(t, 403, role+" lists images")
	}
}

// TestREG_DENTAL_082_FrontDeskSummaryIsSealed: Given a recorded visit with clinical
// notes, When the receptionist reads the dental summary, Then the schedule and money
// are there but the notes, procedure and tooth are not.
func TestREG_DENTAL_082_FrontDeskSummaryIsSealed(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	secret := uniq("Patient-disclosed-HIV-status-")
	denRecord(t, doc, p.ID, plan.Sessions[0].ID, secret)

	desk := srv.As(t, clinicA, "receptionist")
	r := desk.Do("GET", "/dental/patients/"+p.ID+"/summary", nil).Expect(t, 200, "desk summary")
	if !strings.Contains(r.Raw, plan.ID) {
		t.Fatalf("desk summary lacks the plan (test inconclusive)")
	}
	if strings.Contains(r.Raw, secret) || strings.Contains(r.Raw, "Access opening") {
		t.Fatalf("desk summary carries clinical notes/procedure: %s", trimBody(r.Raw))
	}
	var sm struct {
		Plans []denPlan `json:"plans"`
	}
	r.Decode(t, &sm)
	for _, pl := range sm.Plans {
		for _, s := range pl.Sessions {
			if s.Tooth != "" || s.Notes != "" || s.Procedure != "" {
				t.Fatalf("desk summary session carries clinical fields: %+v", s)
			}
		}
	}
}

// ---- chairside and isolation -------------------------------------------------------

// TestREG_DENTAL_090_ChairsideShowsACheckedInPatient: Given a patient put in the
// queue as a walk-in, When the dentist opens the chair list, Then the patient is on it.
func TestREG_DENTAL_090_ChairsideShowsACheckedInPatient(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	desk := srv.As(t, c, "receptionist")
	w := desk.Do("POST", "/queue/walk-in", map[string]any{
		"department_id": id.Encode(id.PrefixDepartment, c.DeptID), "patient_id": p.ID,
	})
	if w.Status != 200 && w.Status != 201 {
		t.Skipf("could not arrange a walk-in (HTTP %d %s %s) — chairside not tested", w.Status, w.Code, w.Message)
	}
	r := srv.As(t, c, "doctor").Do("GET", "/dental/chairside", nil).Expect(t, 200, "chairside")
	var rows []struct {
		PatientID string `json:"patient_id"`
	}
	r.Decode(t, &rows)
	for _, row := range rows {
		if row.PatientID == p.ID {
			return
		}
	}
	t.Fatalf("walk-in patient %s not on the chair list: %s", p.ID, trimBody(r.Raw))
}

// TestREG_DENTAL_100_OtherClinicCannotTouchChartOrPlans: clinic B's dentist cannot
// read or change clinic A's patient's chart or record their visit.
func TestREG_DENTAL_100_OtherClinicCannotTouchChartOrPlans(t *testing.T) {
	p := denPatient(t, clinicA)
	docA := srv.As(t, clinicA, "doctor")
	denSeedConditions(t, docA)
	docA.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR6": "filled"}}).
		Expect(t, 200, "A charts")
	plan := createPlan(t, docA, p.ID, "3000", 3, "")

	docB := srv.As(t, clinicB, "doctor")
	denSeedConditions(t, docB)
	if r := docB.Do("GET", "/dental/patients/"+p.ID+"/chart", nil); strings.Contains(r.Raw, "UR6") {
		t.Fatalf("clinic B read clinic A's chart: %s", trimBody(r.Raw))
	}
	docB.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR6": "extracted"}})
	if r := docB.Do("PUT", "/dental/patients/"+p.ID+"/sessions/"+plan.Sessions[0].ID,
		map[string]any{"status": "done", "notes": "B"}); r.Status == 204 || r.Status == 200 {
		t.Fatalf("clinic B recorded clinic A's visit: HTTP %d", r.Status)
	}
	if denChart(t, docA, p.ID)["UR6"] != "filled" {
		t.Fatalf("clinic B changed clinic A's chart")
	}
	var st string
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &st, denUUID(t, id.PrefixTreatmentSession, plan.Sessions[0].ID))
	if st != "planned" {
		t.Fatalf("clinic A's visit is %s after clinic B's attempt", st)
	}
}

// TestREG_DENTAL_101_OtherClinicCannotFileRecordsAgainstForeignPatient: When clinic
// B's dentist saves a chart or creates a course naming clinic A's patient id, Then
// it is refused as "not found" (as for a random id) and nothing is stored in either
// clinic. The dental tables reference patients(id) alone, and the FK check is not
// subject to RLS, so B can create rows under its own tenant pointing at A's patient,
// and the different answers for a real A id and a random id reveal that the id exists.
func TestREG_DENTAL_101_OtherClinicCannotFileRecordsAgainstForeignPatient(t *testing.T) {
	p := denPatient(t, clinicA)
	pu := denUUID(t, id.PrefixPatient, p.ID)
	random := id.Encode(id.PrefixPatient, uuid.New())
	docB := srv.As(t, clinicB, "doctor")
	denSeedConditions(t, docB)
	planBody := map[string]any{"title": "Foreign", "total_amount": "1000", "start_date": denToday(),
		"interval_unit": "week", "interval_count": 1, "session_count": 1}

	chartA := docB.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR6": "extracted"}})
	chartR := docB.Do("PUT", "/dental/patients/"+random+"/chart", map[string]any{"changes": map[string]string{"UR6": "extracted"}})
	planA := docB.Do("POST", "/dental/patients/"+p.ID+"/plans", planBody)
	planR := docB.Do("POST", "/dental/patients/"+random+"/plans", planBody)

	var charts, plans int
	one(t, `SELECT count(*) FROM dental_charts WHERE tenant_id = $1 AND patient_id = $2`, &charts, clinicB.TenantID, pu)
	one(t, `SELECT count(*) FROM treatment_plans WHERE tenant_id = $1 AND patient_id = $2`, &plans, clinicB.TenantID, pu)
	if charts != 0 || plans != 0 || chartA.Status != chartR.Status || planA.Status != planR.Status {
		testkit.KnownBug(t, "NEW-DEN-2", true, fmt.Sprintf(
			"clinic B wrote %d chart / %d plan rows against clinic A's patient; chart: A-id HTTP %d vs random-id HTTP %d; plan: A-id HTTP %d vs random-id HTTP %d",
			charts, plans, chartA.Status, chartR.Status, planA.Status, planR.Status))
	}
	if chartA.Status != 404 || planA.Status != 404 {
		t.Fatalf("foreign patient: chart HTTP %d, plan HTTP %d, want 404", chartA.Status, planA.Status)
	}
}
