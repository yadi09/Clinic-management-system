package regression

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The dental module, third part: extras, prescriptions and the allergy check, images,
// examinations, the clinic-wide reports (outstanding, unbilled, calendar, chair list)
// and the remaining refusal branches of the course and visit routes.

// ---- helpers (dn2 prefix, shared with dental2_test.go) ----------------------------

type dn2UnbilledRow struct {
	SessionID     string `json:"session_id"`
	PatientID     string `json:"patient_id"`
	PlanTitle     string `json:"plan_title"`
	Procedure     string `json:"procedure"`
	Tooth         string `json:"tooth"`
	Kind          string `json:"kind"`
	Lane          string `json:"lane"`
	Amount        string `json:"amount"`
	Clinician     string `json:"clinician"`
	TreatmentDate string `json:"treatment_date"`
	DaysUnbilled  int    `json:"days_unbilled"`
	ServiceName   string `json:"service_name"`
}

type dn2Unbilled struct {
	Rows          []dn2UnbilledRow `json:"rows"`
	Total         string           `json:"total"`
	Count         int              `json:"count"`
	HasMore       bool             `json:"has_more"`
	PromisedTotal string           `json:"promised_total"`
	PromisedCount int              `json:"promised_count"`
}

func dn2GetUnbilled(t *testing.T, cl *testkit.Client, query string) dn2Unbilled {
	t.Helper()
	var u dn2Unbilled
	cl.Do("GET", "/dental/unbilled"+query, nil).Expect(t, 200, "unbilled "+query).Decode(t, &u)
	return u
}

func dn2Row(rows []dn2UnbilledRow, sid string) *dn2UnbilledRow {
	for i := range rows {
		if rows[i].SessionID == sid {
			return &rows[i]
		}
	}
	return nil
}

// dn2Allergy records an allergy on the patient's chart (patient.update: the desk).
func dn2Allergy(t *testing.T, c *testkit.Clinic, patientID, substance, severity string) {
	t.Helper()
	srv.As(t, c, "receptionist").Do("POST", "/patients/"+patientID+"/allergies",
		map[string]any{"substance": substance, "severity": severity}).Expect(t, 201, "record allergy")
}

func dn2Rx(drug string) map[string]any {
	return map[string]any{"note": "post-op", "items": []map[string]any{{"drug_name": drug, "dose": "1 tab", "frequency": "BD"}}}
}

func dn2Image(t *testing.T, doc *testkit.Client, c *testkit.Clinic, patientID, sessionID string) string {
	t.Helper()
	body := map[string]any{"storage_key": c.TenantID.String() + "/dental/" + denUUID(t, id.PrefixPatient, patientID).String() + "/" + uuid.NewString() + ".jpg",
		"filename": "bw.jpg", "mime_type": "image/jpeg", "size_bytes": 1000, "category": "xray"}
	if sessionID != "" {
		body["session_id"] = sessionID
	}
	var im struct {
		ID string `json:"id"`
	}
	doc.Do("POST", "/dental/patients/"+patientID+"/images", body).Expect(t, 201, "record image").Decode(t, &im)
	return im.ID
}

func dn2ImageIDs(t *testing.T, doc *testkit.Client, patientID, query string) []string {
	t.Helper()
	var out []struct {
		ID string `json:"id"`
	}
	doc.Do("GET", "/dental/patients/"+patientID+"/images"+query, nil).Expect(t, 200, "list images").Decode(t, &out)
	ids := []string{}
	for _, o := range out {
		ids = append(ids, o.ID)
	}
	return ids
}

func dn2Has(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// ---- extras ----------------------------------------------------------------------------

// TestREG_DENTAL_200_AddExtraPricesFromTheList: When an X-ray (list price 500) is
// added to a planned visit with no amount, Then it costs 500; an amount of "0" is
// kept as 0 ("included", a decision); an amount of 250 overrides the list. Every
// extra is planned (its visit is not given yet) and the course total includes them.
func TestREG_DENTAL_200_AddExtraPricesFromTheList(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	svc := denDentalService(t, k.doc, 500)
	add := func(sid string, amount any) {
		body := map[string]any{"service_id": svc}
		if amount != nil {
			body["amount"] = amount
		}
		k.doc.Do("POST", k.path("/sessions/"+sid+"/extras"), body).Expect(t, 204, "add extra")
	}
	add(k.sid(0), nil)
	add(k.sid(1), "0")
	add(k.sid(2), "250")
	pl := denPlanByID(t, k.doc, k.p.ID, k.plan.ID)
	for i, want := range []float64{500, 0, 250} {
		s := denSessionByID(t, pl, k.sid(i))
		if len(s.Extras) != 1 || denMoney(t, s.Extras[0].AmountDue) != want || s.Extras[0].Status != "planned" || s.Extras[0].ServiceName == "" {
			t.Fatalf("visit %d extras %+v, want one planned at %.2f", i+1, s.Extras, want)
		}
	}
	if _, total := dn2Plan(t, k.plan.ID); total != 3750 {
		t.Fatalf("course total with extras %.2f, want 3750", total)
	}
	// The desk sees extras: they are money the patient is asked to pay.
	var desk []denPlan
	srv.As(t, k.c, "receptionist").Do("GET", k.path("/plans"), nil).Expect(t, 200, "desk plans").Decode(t, &desk)
	if s := denSessionByID(t, desk[0], k.sid(0)); len(s.Extras) != 1 || denMoney(t, s.Extras[0].AmountDue) != 500 {
		t.Fatalf("desk does not see the extra: %+v", s.Extras)
	}
}

// TestREG_DENTAL_201_AddExtraRefusals: an extra must name a service on the clinic's
// list by a valid id, with a plain non-negative amount; it attaches to a visit (not
// a down payment or another extra) that is not cancelled. Each refusal adds nothing.
func TestREG_DENTAL_201_AddExtraRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "300")
	svc := denDentalService(t, k.doc, 500)
	ex := func(sid string, body any) testkit.Resp {
		return k.doc.Do("POST", k.path("/sessions/"+sid+"/extras"), body)
	}
	dn2Code(t, ex(k.sid(0), map[string]any{}), 400, "VALIDATION_FAILED", "no service")
	dn2Code(t, ex(k.sid(0), map[string]any{"service_id": "x-ray"}), 400, "VALIDATION_FAILED", "malformed service id")
	ex(k.sid(0), "x").Expect(t, 400, "malformed body")
	dn2Code(t, ex(k.sid(0), map[string]any{"service_id": id.Encode(id.PrefixServiceItem, uuid.Nil)}), 400, "VALIDATION_FAILED", "the zero service id")
	dn2Code(t, ex(k.sid(0), map[string]any{"service_id": svc, "amount": "abc"}), 400, "VALIDATION_FAILED", "amount abc")
	dn2Code(t, ex(k.sid(0), map[string]any{"service_id": svc, "amount": "-5"}), 400, "VALIDATION_FAILED", "negative amount")
	if r := ex(k.sid(0), map[string]any{"service_id": id.Encode(id.PrefixServiceItem, uuid.New())}); r.Status < 400 || r.Status >= 500 {
		t.Fatalf("unknown service: HTTP %d %s, want a 4xx refusal", r.Status, r.Code)
	}
	dn2Code(t, ex(k.plan.Deposit.ID, map[string]any{"service_id": svc}), 400, "VALIDATION_FAILED", "extra on the deposit")
	dn2Code(t, ex(id.Encode(id.PrefixTreatmentSession, uuid.New()), map[string]any{"service_id": svc}), 404, "SESSION_NOT_FOUND", "unknown visit")
	ex("zz", map[string]any{"service_id": svc}).Expect(t, 400, "malformed visit id")
	srv.As(t, k.c, "receptionist").Do("POST", k.path("/sessions/"+k.sid(0)+"/extras"), map[string]any{"service_id": svc}).Expect(t, 403, "desk adds extra")

	ex(k.sid(0), map[string]any{"service_id": svc}).Expect(t, 204, "a real extra")
	var extraID string
	{
		s := denSessionByID(t, denPlanByID(t, k.doc, k.p.ID, k.plan.ID), k.sid(0))
		extraID = s.Extras[0].ID
	}
	dn2Code(t, ex(extraID, map[string]any{"service_id": svc}), 400, "VALIDATION_FAILED", "extra on an extra")
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(1)), map[string]any{"status": "cancelled"}).Expect(t, 204, "cancel visit 2")
	dn2Code(t, ex(k.sid(1), map[string]any{"service_id": svc}), 409, "SESSION_CANCELLED", "extra on a cancelled visit")
	var n int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE plan_id = $1 AND kind = 'extra'`, &n, dn2PlanUUID(t, k.plan.ID))
	if n != 1 {
		t.Fatalf("%d extras stored, want 1", n)
	}
}

// TestREG_DENTAL_202_ExtraFollowsItsVisit: Given a 400 extra on a planned visit,
// When the visit is recorded, Then the extra is done and owed with it (due 1,400);
// When the dentist undoes the visit (with a reason), Then the extra is planned again
// and nothing is due (audit D25).
func TestREG_DENTAL_202_ExtraFollowsItsVisit(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	svc := denDentalService(t, k.doc, 400)
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/extras"), map[string]any{"service_id": svc}).Expect(t, 204, "add extra")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	s := denSessionByID(t, denPlanByID(t, k.doc, k.p.ID, k.plan.ID), k.sid(0))
	if len(s.Extras) != 1 || s.Extras[0].Status != "done" {
		t.Fatalf("extra after recording the visit: %+v", s.Extras)
	}
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 1400 {
		t.Fatalf("due after recording = %s, want 1400", b.Due)
	}
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(0)), map[string]any{"status": "planned", "reason": "wrong visit"}).Expect(t, 204, "undo")
	s = denSessionByID(t, denPlanByID(t, k.doc, k.p.ID, k.plan.ID), k.sid(0))
	if s.Extras[0].Status != "planned" {
		t.Fatalf("extra after undoing the visit: %+v", s.Extras)
	}
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 0 {
		t.Fatalf("due after undo = %s, want 0", b.Due)
	}
}

// TestREG_DENTAL_203_FreeVisitWithAnOwedExtraIsGuarded: Given a visit priced 0 with
// a 600 extra, both given by dentist A, When dentist B undoes the visit, Then it is
// refused 403 VISIT_OWED — the extra's 600 rides on the visit (D25).
func TestREG_DENTAL_203_FreeVisitWithAnOwedExtraIsGuarded(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	docB, _ := denSecondDentist(t, k.c)
	svc := denDentalService(t, k.doc, 600)
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(0)), map[string]any{"amount_due": "0"}).Expect(t, 204, "free visit")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/extras"), map[string]any{"service_id": svc}).Expect(t, 204, "add extra")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	dn2Code(t, docB.Do("PUT", k.path("/sessions/"+k.sid(0)), map[string]any{"status": "planned", "reason": "x"}), 403, "VISIT_OWED", "colleague undoes")
	if st, _ := dn2Sess(t, k.sid(0)); st != "done" {
		t.Fatalf("refused undo left the visit %s", st)
	}
}

// TestREG_DENTAL_204_RemoveExtraRefusals: a visit id is not an extra (400); a billed
// extra must be voided at the cashier (409 EXTRA_BILLED); an unknown one is 404
// EXTRA_NOT_FOUND; the desk and another clinic cannot remove one.
func TestREG_DENTAL_204_RemoveExtraRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	svc := denDentalService(t, k.doc, 500)
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/extras"), map[string]any{"service_id": svc}).Expect(t, 204, "add extra")
	exID := denSessionByID(t, denPlanByID(t, k.doc, k.p.ID, k.plan.ID), k.sid(0)).Extras[0].ID
	rm := func(cl *testkit.Client, eid string) testkit.Resp { return cl.Do("DELETE", k.path("/extras/"+eid), nil) }

	dn2Code(t, rm(k.doc, k.sid(1)), 400, "VALIDATION_FAILED", "remove a visit")
	dn2Code(t, rm(k.doc, id.Encode(id.PrefixTreatmentSession, uuid.New())), 404, "EXTRA_NOT_FOUND", "unknown")
	rm(k.doc, "zz").Expect(t, 400, "malformed id")
	rm(srv.As(t, k.c, "receptionist"), exID).Expect(t, 403, "desk removes")
	dn2Code(t, rm(srv.As(t, clinicB, "doctor"), exID), 404, "EXTRA_NOT_FOUND", "clinic B removes")

	k.doc.Do("POST", k.path("/sessions/"+exID+"/collect"), nil).Expect(t, 204, "bill the extra on its own")
	dn2Code(t, rm(k.doc, exID), 409, "EXTRA_BILLED", "remove a billed extra")
	if st, _ := dn2Sess(t, k.sid(1)); st != "planned" {
		t.Fatalf("visit 2 is %s after a refused remove", st)
	}
	var n int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE id = $1`, &n, dn2SessUUID(t, exID))
	if n != 1 {
		t.Fatalf("billed extra was removed")
	}
}

// TestREG_DENTAL_205_ExtraIsBilledAsItsOwnProcedure: When an extra is billed, Then
// its charge carries the extra's own service (so the report can count X-rays) and
// is described as "<course> — <service> at visit N"; the visit's charge carries none.
func TestREG_DENTAL_205_ExtraIsBilledAsItsOwnProcedure(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	svc := denDentalService(t, k.doc, 350)
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/extras"), map[string]any{"service_id": svc}).Expect(t, 204, "add extra")
	ex := denSessionByID(t, denPlanByID(t, k.doc, k.p.ID, k.plan.ID), k.sid(0)).Extras[0]
	var out struct {
		Billed int    `json:"billed"`
		Total  string `json:"total"`
	}
	k.doc.Do("POST", k.path("/collect-sessions"), map[string]any{"session_ids": []string{k.sid(0), ex.ID}}).Expect(t, 200, "bill both").Decode(t, &out)
	if out.Billed != 2 || denMoney(t, out.Total) != 1350 {
		t.Fatalf("billed %+v, want 2 for 1350", out)
	}
	var exSvc *uuid.UUID
	var exDesc string
	q := `SELECT c.%s FROM charges c JOIN treatment_sessions se ON se.charge_id = c.id WHERE se.id = $1`
	one(t, strings.Replace(q, "%s", "service_item_id", 1), &exSvc, dn2SessUUID(t, ex.ID))
	one(t, strings.Replace(q, "%s", "description", 1), &exDesc, dn2SessUUID(t, ex.ID))
	if exSvc == nil || *exSvc != denUUID(t, id.PrefixServiceItem, svc) || !strings.Contains(exDesc, " at visit 1") {
		t.Fatalf("extra's charge: service %v, description %q", exSvc, exDesc)
	}
	var visitSvc *uuid.UUID
	var visitDesc string
	one(t, strings.Replace(q, "%s", "service_item_id", 1), &visitSvc, dn2SessUUID(t, k.sid(0)))
	one(t, strings.Replace(q, "%s", "description", 1), &visitDesc, dn2SessUUID(t, k.sid(0)))
	if visitSvc != nil || visitDesc != "Root canal — session 1/2" {
		t.Fatalf("visit's charge: service %v, description %q", visitSvc, visitDesc)
	}
}

// ---- prescriptions and the allergy check ---------------------------------------------

// TestREG_DENTAL_210_AllergyBlocksAFreeTypedDrug: Given a patient allergic to
// penicillin, When the dentist prescribes "Penicillin V 500mg" (typed, not from the
// library), Then it is refused 409 ALLERGY_CONFLICT naming the allergy and nothing
// is stored; When they send it again with an override reason, Then it is stored and
// the clashing line carries the reason (the other line does not).
func TestREG_DENTAL_210_AllergyBlocksAFreeTypedDrug(t *testing.T) {
	k := dn2NewCourse(t, 1, "")
	dn2Allergy(t, k.c, k.p.ID, "Penicillin", "severe")
	path := k.path("/sessions/" + k.sid(0) + "/prescriptions")
	body := map[string]any{"items": []map[string]any{{"drug_name": "Penicillin V 500mg"}, {"drug_name": "Paracetamol 1g"}}}

	r := k.doc.Do("POST", path, body)
	dn2Code(t, r, 409, "ALLERGY_CONFLICT", "prescribe over an allergy")
	if !strings.Contains(r.Message, "Penicillin") {
		t.Fatalf("conflict message does not name the allergy: %q", r.Message)
	}
	var n int
	one(t, `SELECT count(*) FROM dental_prescriptions WHERE patient_id = $1`, &n, denUUID(t, id.PrefixPatient, k.p.ID))
	if n != 0 {
		t.Fatalf("a refused prescription was stored")
	}
	body["override_reason"] = "  tolerated amoxicillin last year  "
	var rx struct {
		ID    string `json:"id"`
		Items []struct {
			DrugName        string `json:"drug_name"`
			AllergyOverride string `json:"allergy_override"`
		} `json:"items"`
	}
	k.doc.Do("POST", path, body).Expect(t, 201, "prescribe with override").Decode(t, &rx)
	if len(rx.Items) != 2 || rx.Items[0].AllergyOverride != "tolerated amoxicillin last year" || rx.Items[1].AllergyOverride != "" {
		t.Fatalf("override not recorded on the clashing line only: %+v", rx.Items)
	}
	var stored string
	one(t, `SELECT coalesce(allergy_override,'') FROM dental_prescription_items WHERE prescription_id = $1 AND seq = 1`, &stored, denUUID(t, id.PrefixDentalRx, rx.ID))
	if stored != "tolerated amoxicillin last year" {
		t.Fatalf("stored override %q", stored)
	}
}

// TestREG_DENTAL_211_AllergyBlocksALibraryDrugByItsTags: Given the library drug
// "Bactrim DS" tagged with the allergen Sulfonamide and a patient allergic to
// Sulfonamide, When it is prescribed by id — or typed by name without the id — Then
// both are refused 409 ALLERGY_CONFLICT (the name gives no hint; the tag does); with
// an override, the line reads back with its allergen tag wherever it is shown.
func TestREG_DENTAL_211_AllergyBlocksALibraryDrugByItsTags(t *testing.T) {
	k := dn2NewCourse(t, 1, "")
	allergenName := uniq("Sulfonamide")
	var al struct {
		ID string `json:"id"`
	}
	k.doc.Do("POST", "/allergens", map[string]any{"name": allergenName}).Expect(t, 201, "create allergen").Decode(t, &al)
	drugName := uniq("Bactrim DS ")
	var drug struct {
		ID string `json:"id"`
	}
	k.doc.Do("POST", "/drugs", map[string]any{"name": drugName, "allergen_ids": []string{al.ID}}).Expect(t, 201, "create drug").Decode(t, &drug)
	dn2Allergy(t, k.c, k.p.ID, allergenName, "moderate")
	path := k.path("/sessions/" + k.sid(0) + "/prescriptions")

	byID := map[string]any{"items": []map[string]any{{"drug_name": drugName, "drug_id": drug.ID}}}
	dn2Code(t, k.doc.Do("POST", path, byID), 409, "ALLERGY_CONFLICT", "library drug by id")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"items": []map[string]any{{"drug_name": strings.ToLower(drugName)}}}),
		409, "ALLERGY_CONFLICT", "library drug typed by name")

	byID["override_reason"] = "desensitised"
	var rx struct {
		Items []struct {
			Allergens       []string `json:"allergens"`
			AllergyOverride string   `json:"allergy_override"`
		} `json:"items"`
	}
	k.doc.Do("POST", path, byID).Expect(t, 201, "override").Decode(t, &rx)
	if len(rx.Items) != 1 || len(rx.Items[0].Allergens) != 1 || rx.Items[0].Allergens[0] != allergenName || rx.Items[0].AllergyOverride != "desensitised" {
		t.Fatalf("prescribed line %+v", rx.Items)
	}
	r := k.doc.Do("GET", k.path("/plans"), nil).Expect(t, 200, "plans")
	if !strings.Contains(r.Raw, allergenName) || !strings.Contains(r.Raw, "desensitised") {
		t.Fatalf("the plan does not show the prescription's allergen and override")
	}
}

// TestREG_DENTAL_212_PrescriptionRefusals: a prescription needs at least one named
// medication; a malformed drug id is refused (not silently unlinked); a down payment
// or a cancelled visit cannot carry one; an unknown visit is 404; the desk cannot
// prescribe; a mild-allergy-free patient is not blocked.
func TestREG_DENTAL_212_PrescriptionRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "200")
	rx := func(sid string, body any) testkit.Resp {
		return k.doc.Do("POST", k.path("/sessions/"+sid+"/prescriptions"), body)
	}
	dn2Code(t, rx(k.sid(0), map[string]any{"items": []map[string]any{}}), 400, "VALIDATION_FAILED", "no items")
	dn2Code(t, rx(k.sid(0), map[string]any{"items": []map[string]any{{"drug_name": "", "dose": "1"}}}), 400, "VALIDATION_FAILED", "blank drug")
	dn2Code(t, rx(k.sid(0), map[string]any{"items": []map[string]any{{"drug_name": "Ibuprofen", "drug_id": "bogus"}}}), 400, "VALIDATION_FAILED", "bad drug id")
	rx(k.sid(0), "x").Expect(t, 400, "malformed body")
	dn2Code(t, rx(k.plan.Deposit.ID, dn2Rx("Ibuprofen")), 400, "VALIDATION_FAILED", "on the deposit")
	dn2Code(t, rx(id.Encode(id.PrefixTreatmentSession, uuid.New()), dn2Rx("Ibuprofen")), 404, "SESSION_NOT_FOUND", "unknown visit")
	rx("zz", dn2Rx("Ibuprofen")).Expect(t, 400, "malformed visit id")
	other := createPlan(t, k.doc, denPatient(t, k.c).ID, "1000", 1, "")
	dn2Code(t, rx(other.Sessions[0].ID, dn2Rx("Ibuprofen")), 404, "SESSION_NOT_FOUND", "another patient's visit")
	srv.As(t, k.c, "receptionist").Do("POST", k.path("/sessions/"+k.sid(0)+"/prescriptions"), dn2Rx("Ibuprofen")).Expect(t, 403, "desk prescribes")
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(1)), map[string]any{"status": "cancelled"}).Expect(t, 204, "cancel visit 2")
	dn2Code(t, rx(k.sid(1), dn2Rx("Ibuprofen")), 409, "SESSION_CANCELLED", "on a cancelled visit")
	dn2Allergy(t, k.c, k.p.ID, "Latex", "mild")
	rx(k.sid(0), dn2Rx("Ibuprofen 400mg")).Expect(t, 201, "unrelated allergy does not block")
	var n int
	one(t, `SELECT count(*) FROM dental_prescriptions WHERE patient_id = $1`, &n, denUUID(t, id.PrefixPatient, k.p.ID))
	if n != 1 {
		t.Fatalf("%d prescriptions stored, want 1", n)
	}
}

// TestREG_DENTAL_213_VoidPrescriptionRefusalsAndIsolation: a prescription is voided
// once (a second void is 404 PRESCRIPTION_NOT_FOUND); unknown or malformed ids are
// refused; the desk cannot void; clinic B can neither add a prescription to clinic
// A's visit nor void A's prescription.
func TestREG_DENTAL_213_VoidPrescriptionRefusalsAndIsolation(t *testing.T) {
	k := dn2NewCourse(t, 1, "")
	var rx struct {
		ID string `json:"id"`
	}
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/prescriptions"), dn2Rx("Metronidazole 400mg")).Expect(t, 201, "prescribe").Decode(t, &rx)
	path := k.path("/prescriptions/" + rx.ID)
	docB := srv.As(t, clinicB, "doctor")
	dn2Code(t, docB.Do("DELETE", path, map[string]any{"reason": "B"}), 404, "PRESCRIPTION_NOT_FOUND", "B voids A's")
	dn2Code(t, docB.Do("POST", k.path("/sessions/"+k.sid(0)+"/prescriptions"), dn2Rx("x")), 404, "SESSION_NOT_FOUND", "B prescribes on A's visit")
	srv.As(t, k.c, "receptionist").Do("DELETE", path, map[string]any{"reason": "desk"}).Expect(t, 403, "desk voids")
	var voided bool
	one(t, `SELECT voided_at IS NOT NULL FROM dental_prescriptions WHERE id = $1`, &voided, denUUID(t, id.PrefixDentalRx, rx.ID))
	if voided {
		t.Fatalf("a refused void voided the prescription")
	}
	var kept struct {
		ID string `json:"id"`
	}
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/prescriptions"), dn2Rx("Amoxicillin 500mg")).Expect(t, 201, "second prescription").Decode(t, &kept)
	k.doc.Do("DELETE", path, map[string]any{"reason": "dose wrong"}).Expect(t, 204, "void")
	s := denSessionByID(t, denPlanByID(t, k.doc, k.p.ID, k.plan.ID), k.sid(0))
	if len(s.Prescriptions) != 1 || s.Prescriptions[0].ID != kept.ID || len(s.Prescriptions[0].Items) != 1 ||
		s.Prescriptions[0].Items[0].DrugName != "Amoxicillin 500mg" {
		t.Fatalf("visit's prescriptions after voiding one: %+v", s.Prescriptions)
	}
	dn2Code(t, k.doc.Do("DELETE", path, map[string]any{"reason": "again"}), 404, "PRESCRIPTION_NOT_FOUND", "void twice")
	dn2Code(t, k.doc.Do("DELETE", k.path("/prescriptions/"+id.Encode(id.PrefixDentalRx, uuid.New())), map[string]any{"reason": "x"}),
		404, "PRESCRIPTION_NOT_FOUND", "unknown")
	k.doc.Do("DELETE", k.path("/prescriptions/zz"), map[string]any{"reason": "x"}).Expect(t, 400, "malformed id")
	if n := dn2Events(t, k.c.TenantID, "dental.prescription.voided", denUUID(t, id.PrefixDentalRx, rx.ID).String()); n != 1 {
		t.Fatalf("prescription.voided events = %d, want 1", n)
	}
}

// ---- images ---------------------------------------------------------------------------

// TestREG_DENTAL_220_RecordImageDefaultsAndPlacement: an image needs a storage key
// (400 without); with no file name or type it is stored as "image"/image/jpeg; an
// unknown category is dropped; one filed against a visit shows on that visit and in
// the visit's list, not in the patient's general list.
func TestREG_DENTAL_220_RecordImageDefaultsAndPlacement(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	path := k.path("/images")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"filename": "a.jpg"}), 400, "VALIDATION_FAILED", "no storage key")
	k.doc.Do("POST", path, "x").Expect(t, 400, "malformed body")
	k.doc.Do("POST", path, map[string]any{"storage_key": "k", "session_id": "zz"}).Expect(t, 400, "malformed session id")

	var im struct {
		ID       string `json:"id"`
		Filename string `json:"filename"`
		MimeType string `json:"mime_type"`
		Category string `json:"category"`
	}
	key := k.c.TenantID.String() + "/dental/" + denUUID(t, id.PrefixPatient, k.p.ID).String() + "/" + uuid.NewString()
	k.doc.Do("POST", path, map[string]any{"storage_key": key, "category": "selfie", "size_bytes": 4096}).Expect(t, 201, "record bare").Decode(t, &im)
	if im.Filename != "image" || im.MimeType != "image/jpeg" || im.Category != "" {
		t.Fatalf("defaults: %+v", im)
	}
	var cat *string
	var size int64
	one(t, `SELECT image_category FROM attachments WHERE id = $1`, &cat, denUUID(t, id.PrefixAttachment, im.ID))
	one(t, `SELECT size_bytes FROM attachments WHERE id = $1`, &size, denUUID(t, id.PrefixAttachment, im.ID))
	if cat != nil || size != 4096 {
		t.Fatalf("stored category %v size %d", cat, size)
	}
	onVisit := dn2Image(t, k.doc, k.c, k.p.ID, k.sid(1))

	general := dn2ImageIDs(t, k.doc, k.p.ID, "")
	visit := dn2ImageIDs(t, k.doc, k.p.ID, "?session="+k.sid(1))
	if !dn2Has(general, im.ID) || dn2Has(general, onVisit) || !dn2Has(visit, onVisit) || dn2Has(visit, im.ID) {
		t.Fatalf("general list %v, visit list %v", general, visit)
	}
	k.doc.Do("GET", path+"?session=zz", nil).Expect(t, 400, "list with malformed session")
	r := k.doc.Do("GET", k.path("/plans"), nil).Expect(t, 200, "plans")
	if !strings.Contains(r.Raw, onVisit) {
		t.Fatalf("the visit's image is not on the visit in the plan")
	}
	srv.As(t, k.c, "receptionist").Do("POST", path, map[string]any{"storage_key": "k"}).Expect(t, 403, "desk records image")
}

// TestREG_DENTAL_221_RecordImageTrustsTheClientsKeyAndSession: When an image is
// recorded with a storage key outside this clinic's "<tenant>/dental/<patient>/"
// folder (e.g. another clinic's object), or filed against another patient's visit or
// a down payment, Then it must be refused. SEC-1/D24: RecordImage stores whatever key
// and session the client sends.
func TestREG_DENTAL_221_RecordImageTrustsTheClientsKeyAndSession(t *testing.T) {
	k := dn2NewCourse(t, 1, "100")
	other := createPlan(t, k.doc, denPatient(t, k.c).ID, "1000", 1, "")
	path := k.path("/images")
	foreignKey := k.doc.Do("POST", path, map[string]any{"storage_key": clinicB.TenantID.String() + "/dental/" + uuid.NewString() + "/xray.jpg"})
	own := k.c.TenantID.String() + "/dental/" + denUUID(t, id.PrefixPatient, k.p.ID).String() + "/"
	otherVisit := k.doc.Do("POST", path, map[string]any{"storage_key": own + "x.jpg", "session_id": other.Sessions[0].ID})
	deposit := k.doc.Do("POST", path, map[string]any{"storage_key": own + "y.jpg", "session_id": k.plan.Deposit.ID})
	// (SEC-1, fixed 2026-10-03: the key must sit in this clinic's folder for this
	// patient, and the visit must be one of this patient's treatment visits.)
	for _, r := range []testkit.Resp{foreignKey, otherVisit, deposit} {
		r.Expect(t, 400, "untrusted image")
	}
}

// TestREG_DENTAL_222_DeleteImage: When the dentist deletes an image, Then it leaves
// the list and its row is soft-deleted; a second delete or an unknown image is 404
// IMAGE_NOT_FOUND; the desk and another clinic cannot delete one.
func TestREG_DENTAL_222_DeleteImage(t *testing.T) {
	k := dn2NewCourse(t, 1, "")
	img := dn2Image(t, k.doc, k.c, k.p.ID, "")
	path := k.path("/images/" + img)
	srv.As(t, k.c, "receptionist").Do("DELETE", path, nil).Expect(t, 403, "desk deletes")
	dn2Code(t, srv.As(t, clinicB, "doctor").Do("DELETE", path, nil), 404, "IMAGE_NOT_FOUND", "clinic B deletes")
	if !dn2Has(dn2ImageIDs(t, k.doc, k.p.ID, ""), img) {
		t.Fatalf("a refused delete removed the image")
	}
	k.doc.Do("DELETE", path, nil).Expect(t, 204, "delete")
	if dn2Has(dn2ImageIDs(t, k.doc, k.p.ID, ""), img) {
		t.Fatalf("deleted image still listed")
	}
	var gone bool
	one(t, `SELECT deleted_at IS NOT NULL FROM attachments WHERE id = $1`, &gone, denUUID(t, id.PrefixAttachment, img))
	if !gone {
		t.Fatalf("image row not soft-deleted")
	}
	dn2Code(t, k.doc.Do("DELETE", path, nil), 404, "IMAGE_NOT_FOUND", "delete twice")
	dn2Code(t, k.doc.Do("DELETE", k.path("/images/"+id.Encode(id.PrefixAttachment, uuid.New())), nil), 404, "IMAGE_NOT_FOUND", "unknown")
	k.doc.Do("DELETE", k.path("/images/zz"), nil).Expect(t, 400, "malformed id")

	// A visit whose only image was deleted is no longer "a course with records".
	onVisit := dn2Image(t, k.doc, k.c, k.p.ID, k.sid(0))
	dn2Code(t, k.doc.Do("DELETE", k.path("/plans/"+k.plan.ID), nil), 409, "PLAN_HAS_RECORDS", "delete a course with an image")
	k.doc.Do("DELETE", k.path("/images/"+onVisit), nil).Expect(t, 204, "delete the visit's image")
	k.doc.Do("DELETE", k.path("/plans/"+k.plan.ID), nil).Expect(t, 204, "delete the course")
}

// TestREG_DENTAL_223_SignImageUploadChecksTheCapFirst: Given a clinic on a plan that
// allows 8 images per patient, When a patient has 8, Then signing a 9th upload is
// refused 403 IMAGE_LIMIT_REACHED and the summary reports the cap; below the cap the
// request gets past the limits to the storage provider (the test API has none
// configured, so the provider itself answers 500 — not a limit refusal). The desk
// cannot sign uploads.
func TestREG_DENTAL_223_SignImageUploadChecksTheCapFirst(t *testing.T) {
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-basic"})
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	sign := "/dental/patients/" + p.ID + "/images/sign"
	body := map[string]any{"filename": "pa.jpg", "mime_type": "image/jpeg"}

	if r := doc.Do("POST", sign, body); r.Code == "IMAGE_LIMIT_REACHED" || (r.Status >= 200 && r.Status < 300) {
		t.Fatalf("below the cap: HTTP %d %s (want the no-op provider's refusal, not a limit)", r.Status, r.Code)
	}
	srv.As(t, c, "receptionist").Do("POST", sign, body).Expect(t, 403, "desk signs")
	doc.Do("POST", "/dental/patients/zz/images/sign", body).Expect(t, 400, "malformed patient")
	for i := 0; i < 8; i++ {
		dn2Image(t, doc, c, p.ID, "")
	}
	dn2Code(t, doc.Do("POST", sign, body), 403, "IMAGE_LIMIT_REACHED", "sign the 9th")
	var lim int
	sm := summary(t, doc, p.ID)
	if err := json.Unmarshal(sm["image_limit"], &lim); err != nil || lim != 8 {
		t.Fatalf("summary image_limit = %s, want 8", sm["image_limit"])
	}
	// On an unlimited plan the summary says -1.
	if sm := summary(t, srv.As(t, clinicA, "doctor"), denPatient(t, clinicA).ID); string(sm["image_limit"]) != "-1" {
		t.Fatalf("unlimited plan image_limit = %s, want -1", sm["image_limit"])
	}
}

// TestREG_DENTAL_224_RecordImageRespectsTheCap: Given a patient at the plan's 8-image
// cap, When a 9th image is recorded (the key reused, or uploaded without signing),
// Then it must be refused like the signature is. NEW-DEN-5: the cap is checked only in
// SignImageUpload; RecordImage (service.go:2856) never checks it.
func TestREG_DENTAL_224_RecordImageRespectsTheCap(t *testing.T) {
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-basic"})
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	for i := 0; i < 8; i++ {
		dn2Image(t, doc, c, p.ID, "")
	}
	r := doc.Do("POST", "/dental/patients/"+p.ID+"/images", map[string]any{
		"storage_key": c.TenantID.String() + "/dental/" + denUUID(t, id.PrefixPatient, p.ID).String() + "/" + uuid.NewString(), "filename": "ninth.jpg"})
	var n int
	one(t, `SELECT count(*) FROM attachments WHERE patient_id = $1 AND deleted_at IS NULL`, &n, denUUID(t, id.PrefixPatient, p.ID))
	if r.Status == 201 || n > 8 {
		testkit.KnownBug(t, "NEW-DEN-5", true, "a 9th image was recorded on an 8-image plan (HTTP "+itoa(r.Status)+", "+itoa(n)+" images)")
	}
	dn2Code(t, r, 403, "IMAGE_LIMIT_REACHED", "record the 9th")
}

// TestREG_DENTAL_225_OtherClinicCannotSeeOrFileImages: clinic B's dentist lists none
// of clinic A's patient's images, and recording an image against A's patient must be
// refused as not found (NEW-DEN-2: attachments reference patients(id) alone).
func TestREG_DENTAL_225_OtherClinicCannotSeeOrFileImages(t *testing.T) {
	k := dn2NewCourse(t, 1, "")
	img := dn2Image(t, k.doc, k.c, k.p.ID, "")
	docB := srv.As(t, clinicB, "doctor")
	if ids := dn2ImageIDs(t, docB, k.p.ID, ""); dn2Has(ids, img) {
		t.Fatalf("clinic B lists clinic A's image")
	}
	r := docB.Do("POST", k.path("/images"), map[string]any{"storage_key": clinicB.TenantID.String() + "/dental/x"})
	var stray int
	one(t, `SELECT count(*) FROM attachments WHERE tenant_id = $1 AND patient_id = $2`, &stray, clinicB.TenantID, denUUID(t, id.PrefixPatient, k.p.ID))
	if r.Status != 404 || stray != 0 {
		testkit.KnownBug(t, "NEW-DEN-2", true, "clinic B recorded an image against clinic A's patient (HTTP "+itoa(r.Status)+", "+itoa(stray)+" row)")
	}
}

// ---- examinations ------------------------------------------------------------------------

// TestREG_DENTAL_230_ExamValidationAndShape: an exam's date must be a real
// YYYY-MM-DD; a session it is filed against must be a visit of this patient (not a
// malformed id, another patient's visit, or the down payment). Blank checkbox values
// and untouched blank procedure rows are dropped; a linked visit is echoed back.
func TestREG_DENTAL_230_ExamValidationAndShape(t *testing.T) {
	k := dn2NewCourse(t, 1, "100")
	other := createPlan(t, k.doc, denPatient(t, k.c).ID, "1000", 1, "")
	path := k.path("/exams")
	with := func(extra map[string]any) map[string]any {
		m := map[string]any{"visit_date": denToday()}
		for kk, v := range extra {
			m[kk] = v
		}
		return m
	}
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"visit_date": "2026-02-30"}), 400, "VALIDATION_FAILED", "impossible date")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"visit_date": "  "}), 400, "VALIDATION_FAILED", "blank date")
	dn2Code(t, k.doc.Do("POST", path, with(map[string]any{"session_id": "zz"})), 400, "VALIDATION_FAILED", "malformed session")
	dn2Code(t, k.doc.Do("POST", path, with(map[string]any{"session_id": other.Sessions[0].ID})), 400, "VALIDATION_FAILED", "another patient's visit")
	dn2Code(t, k.doc.Do("POST", path, with(map[string]any{"session_id": k.plan.Deposit.ID})), 400, "VALIDATION_FAILED", "the deposit")
	k.doc.Do("POST", path, "x").Expect(t, 400, "malformed body")

	var ex struct {
		ID         string   `json:"id"`
		SessionID  string   `json:"session_id"`
		Extraoral  []string `json:"extraoral"`
		Intraoral  []string `json:"intraoral"`
		Procedures []struct {
			Tooth     string `json:"tooth"`
			Procedure string `json:"procedure"`
		} `json:"procedures"`
		RecordedBy string `json:"recorded_by"`
	}
	k.doc.Do("POST", path, with(map[string]any{
		"session_id": k.sid(0), "extraoral": []string{"swelling", "", "  "}, "intraoral": nil,
		"procedures": []map[string]any{{"tooth": " LL6 ", "procedure": "RCT"}, {"tooth": " ", "procedure": "", "notes": " "}},
	})).Expect(t, 201, "exam on a visit").Decode(t, &ex)
	if ex.SessionID != k.sid(0) || len(ex.Extraoral) != 1 || ex.Extraoral[0] != "swelling" || ex.Intraoral == nil ||
		len(ex.Procedures) != 1 || ex.Procedures[0].Tooth != "LL6" || !strings.HasPrefix(ex.RecordedBy, "Doctor ") {
		t.Fatalf("exam read back %+v", ex)
	}
	upd := k.path("/exams/" + ex.ID)
	dn2Code(t, k.doc.Do("PUT", upd, map[string]any{"visit_date": "yesterday"}), 400, "VALIDATION_FAILED", "update bad date")
	dn2Code(t, k.doc.Do("PUT", upd, with(map[string]any{"session_id": "zz"})), 400, "VALIDATION_FAILED", "update malformed session")
	dn2Code(t, k.doc.Do("PUT", upd, with(map[string]any{"session_id": other.Sessions[0].ID})), 400, "VALIDATION_FAILED", "update to another patient's visit")
	k.doc.Do("PUT", upd, "x").Expect(t, 400, "update malformed body")
	var linked *uuid.UUID
	one(t, `SELECT session_id FROM dental_visits WHERE id = $1`, &linked, denUUID(t, id.PrefixDentalVisit, ex.ID))
	if linked == nil || *linked != dn2SessUUID(t, k.sid(0)) {
		t.Fatalf("refused updates changed the exam's visit to %v", linked)
	}
}

// TestREG_DENTAL_231_ExamNotFoundAndIsolation: updating or deleting an unknown exam
// is 404 EXAM_NOT_FOUND, a malformed id 400; clinic B can neither read, change nor
// delete clinic A's exam.
func TestREG_DENTAL_231_ExamNotFoundAndIsolation(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	ex := denCreateExam(t, doc, p.ID, uniq("Dx "))
	ghost := "/dental/patients/" + p.ID + "/exams/" + id.Encode(id.PrefixDentalVisit, uuid.New())
	dn2Code(t, doc.Do("PUT", ghost, map[string]any{"visit_date": denToday()}), 404, "EXAM_NOT_FOUND", "update unknown")
	dn2Code(t, doc.Do("DELETE", ghost, nil), 404, "EXAM_NOT_FOUND", "delete unknown")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/exams/zz", map[string]any{"visit_date": denToday()}).Expect(t, 400, "malformed exam id")
	doc.Do("DELETE", "/dental/patients/"+p.ID+"/exams/zz", nil).Expect(t, 400, "malformed exam id")

	docB := srv.As(t, clinicB, "doctor")
	path := "/dental/patients/" + p.ID + "/exams/" + ex.ID
	if r := docB.Do("GET", "/dental/patients/"+p.ID+"/exams", nil); strings.Contains(r.Raw, ex.ID) {
		t.Fatalf("clinic B lists clinic A's exam")
	}
	dn2Code(t, docB.Do("PUT", path, map[string]any{"visit_date": denToday(), "diagnosis": "B"}), 404, "EXAM_NOT_FOUND", "B updates")
	dn2Code(t, docB.Do("DELETE", path, nil), 404, "EXAM_NOT_FOUND", "B deletes")
	var dx string
	one(t, `SELECT coalesce(diagnosis,'') FROM dental_visits WHERE id = $1`, &dx, denUUID(t, id.PrefixDentalVisit, ex.ID))
	if dx != ex.Diagnosis {
		t.Fatalf("clinic B changed clinic A's exam diagnosis to %q", dx)
	}
}

// ---- the clinic-wide reports ---------------------------------------------------------------

// TestREG_DENTAL_240_OutstandingListsExactlyWhatIsDue: In one clinic, Given patient P1
// with a given unbilled 1,000 visit, P2 with an unpaid 500 down payment only, P3 with
// only planned visits, P4 whose given visit is at the cashier, P5 whose given visit is
// paid and P6 whose course was cancelled, When the desk opens the outstanding list,
// Then exactly P1 (1,000) then P2 (500) are on it, each matching their balance's due.
func TestREG_DENTAL_240_OutstandingListsExactlyWhatIsDue(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	cashier := srv.As(t, c, "cashier")
	mk := func() patientRef { return denPatient(t, c) }
	p1, p2, p3, p4, p5, p6 := mk(), mk(), mk(), mk(), mk(), mk()
	pl1 := createPlan(t, doc, p1.ID, "2000", 2, "")
	denRecord(t, doc, p1.ID, pl1.Sessions[0].ID, "given")
	createPlan(t, doc, p2.ID, "1500", 1, "500")
	createPlan(t, doc, p3.ID, "1000", 2, "")
	pl4 := createPlan(t, doc, p4.ID, "1000", 1, "")
	denRecord(t, doc, p4.ID, pl4.Sessions[0].ID, "given")
	doc.Do("POST", "/dental/patients/"+p4.ID+"/sessions/"+pl4.Sessions[0].ID+"/collect", nil).Expect(t, 204, "P4 at cashier")
	pl5 := createPlan(t, doc, p5.ID, "1000", 1, "")
	denRecord(t, doc, p5.ID, pl5.Sessions[0].ID, "given")
	doc.Do("POST", "/dental/patients/"+p5.ID+"/sessions/"+pl5.Sessions[0].ID+"/collect", nil).Expect(t, 204, "P5 collect")
	paySettle(cashier, dn2PendingCharge(t, c, p5.ID)).Expect(t, 204, "P5 paid")
	pl6 := createPlan(t, doc, p6.ID, "1000", 1, "")
	doc.Do("POST", "/dental/patients/"+p6.ID+"/plans/"+pl6.ID+"/cancel", map[string]any{"reason": "moved"}).Expect(t, 200, "P6 cancelled")

	var rows []struct {
		PatientID   string `json:"patient_id"`
		PatientName string `json:"patient_name"`
		MRN         string `json:"mrn"`
		Balance     string `json:"balance"`
	}
	srv.As(t, c, "receptionist").Do("GET", "/dental/outstanding", nil).Expect(t, 200, "outstanding").Decode(t, &rows)
	if len(rows) != 2 || rows[0].PatientID != p1.ID || rows[1].PatientID != p2.ID ||
		rows[0].Balance != "1000.00" || rows[1].Balance != "500.00" || rows[0].MRN != p1.MRN || !strings.Contains(rows[0].PatientName, p1.FirstName) {
		t.Fatalf("outstanding = %+v, want P1 1000.00 then P2 500.00", rows)
	}
	for _, r := range rows {
		if b := payBalance(t, doc, r.PatientID); b.Due != r.Balance {
			t.Fatalf("outstanding says %s for %s, balance due says %s", r.Balance, r.PatientID, b.Due)
		}
	}
	srv.As(t, c, "nurse").Do("GET", "/dental/outstanding", nil).Expect(t, 403, "nurse")
}

// TestREG_DENTAL_243_UnbilledRowsAndLanes: In one clinic, Given a given visit nobody
// billed, an unpaid down payment, a given visit whose bill was pulled back, and a
// given visit paid then refunded, When the report is read, Then there are four rows
// in three lanes (never_billed ×2, bill_withdrawn, refunded) totalling 3,500, each
// with the clinician who gave it; the cashier's copy has the procedure and tooth
// sealed, the dentist's has them. A nurse cannot read it.
func TestREG_DENTAL_243_UnbilledRowsAndLanes(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	cashier := srv.As(t, c, "cashier")
	p := denPatient(t, c)
	pl := createPlan(t, doc, p.ID, "3500", 3, "500")
	s := func(i int) string { return pl.Sessions[i].ID }
	for i := 0; i < 3; i++ {
		denRecord(t, doc, p.ID, s(i), "given")
	}
	// The cashier voids visit 2's bill at the till (the bill stays linked, voided):
	// that is the bill_withdrawn lane. (The dentist's uncollect unlinks it instead,
	// which reads as never billed — covered in 180.)
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+s(1)+"/collect", nil).Expect(t, 204, "collect 2")
	cashier.Do("POST", "/billing/charges/"+dn2PendingCharge(t, c, p.ID)+"/void", map[string]any{"reason": "patient left"}).Expect(t, 204, "cashier voids 2")
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+s(2)+"/collect", nil).Expect(t, 204, "collect 3")
	ch := dn2PendingCharge(t, c, p.ID)
	paySettle(cashier, ch).Expect(t, 204, "settle 3")
	if r := srv.As(t, c, "branch_manager").Do("POST", "/billing/charges/"+ch+"/refund", map[string]any{"reason": "redo"}); r.Status >= 300 {
		t.Fatalf("refund: HTTP %d %s", r.Status, r.Code)
	}

	u := dn2GetUnbilled(t, doc, "")
	if u.Count != 4 || denMoney(t, u.Total) != 3500 || len(u.Rows) != 4 || u.HasMore {
		t.Fatalf("unbilled: count=%d total=%s rows=%d has_more=%v", u.Count, u.Total, len(u.Rows), u.HasMore)
	}
	want := map[string]string{s(0): "never_billed", pl.Deposit.ID: "never_billed", s(1): "bill_withdrawn", s(2): "refunded"}
	for sid, lane := range want {
		r := dn2Row(u.Rows, sid)
		if r == nil || r.Lane != lane {
			t.Fatalf("row for %s = %+v, want lane %s", sid, r, lane)
		}
	}
	v := dn2Row(u.Rows, s(0))
	if v.Kind != "visit" || v.Procedure != "Access opening" || v.Tooth != "UR5" || !strings.HasPrefix(v.Clinician, "Doctor ") ||
		v.PlanTitle != "Root canal" || denMoney(t, v.Amount) != 1000 {
		t.Fatalf("visit row %+v", v)
	}
	if v.TreatmentDate != payAddisToday() || v.DaysUnbilled != 0 {
		t.Fatalf("a visit given today reads treated %s, %d day(s) unbilled", v.TreatmentDate, v.DaysUnbilled)
	}
	if d := dn2Row(u.Rows, pl.Deposit.ID); d.Kind != "deposit" || denMoney(t, d.Amount) != 500 {
		t.Fatalf("deposit row %+v", d)
	}
	for _, r := range dn2GetUnbilled(t, cashier, "").Rows {
		if r.Procedure != "" || r.Tooth != "" {
			t.Fatalf("cashier's unbilled row carries clinical fields: %+v", r)
		}
	}
	srv.As(t, c, "receptionist").Do("GET", "/dental/unbilled", nil).Expect(t, 200, "desk (payment.charge) reads")
	srv.As(t, c, "nurse").Do("GET", "/dental/unbilled", nil).Expect(t, 403, "nurse")
}

// TestREG_DENTAL_244_UnbilledPagingAndDates: the totals cover the whole set while
// rows are paged (limit/offset, has_more); from/to filter by the day the money became
// owed.
func TestREG_DENTAL_244_UnbilledPagingAndDates(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	for i := 0; i < 3; i++ {
		denRecord(t, k.doc, k.p.ID, k.sid(i), "given")
	}
	page := dn2GetUnbilled(t, k.doc, "?limit=2")
	if len(page.Rows) != 2 || !page.HasMore || page.Count != 3 || denMoney(t, page.Total) != 3000 {
		t.Fatalf("page 1: rows=%d has_more=%v count=%d total=%s", len(page.Rows), page.HasMore, page.Count, page.Total)
	}
	last := dn2GetUnbilled(t, k.doc, "?limit=2&offset=2")
	if len(last.Rows) != 1 || last.HasMore || dn2Row(page.Rows, last.Rows[0].SessionID) != nil {
		t.Fatalf("page 2: %+v", last)
	}
	today, tomorrow, yesterday := payAddisToday(), denDay(2), denDay(-2)
	if u := dn2GetUnbilled(t, k.doc, "?from="+today+"&to="+today); u.Count != 3 {
		t.Fatalf("today..today count %d, want 3", u.Count)
	}
	if u := dn2GetUnbilled(t, k.doc, "?from="+tomorrow); u.Count != 0 || len(u.Rows) != 0 || denMoney(t, u.Total) != 0 {
		t.Fatalf("from the future: %+v", u)
	}
	if u := dn2GetUnbilled(t, k.doc, "?to="+yesterday); u.Count != 0 || len(u.Rows) != 0 {
		t.Fatalf("until the past: %+v", u)
	}
	if u := dn2GetUnbilled(t, k.doc, "?limit=-5&offset=-1"); len(u.Rows) != 3 {
		t.Fatalf("nonsense paging should fall back to defaults, got %d rows", len(u.Rows))
	}
}

// TestREG_DENTAL_245_ReportDatesAreValidated: a date filter that is not YYYY-MM-DD
// is the caller's mistake (400), not a server error. NEW-DEN-6: /dental/sessions and
// /dental/unbilled pass the strings straight into ::date casts, so Postgres rejects
// them and the API answers 500.
func TestREG_DENTAL_245_ReportDatesAreValidated(t *testing.T) {
	doc := srv.As(t, clinicA, "doctor")
	cal := doc.Do("GET", "/dental/sessions?from=next-week&to="+denToday(), nil)
	ub := doc.Do("GET", "/dental/unbilled?from=13/10/2026", nil)
	if cal.Status == 500 || ub.Status == 500 {
		testkit.KnownBug(t, "NEW-DEN-6", true, "malformed report dates give HTTP 500: calendar "+itoa(cal.Status)+", unbilled "+itoa(ub.Status)+
			" (service.go:2805, 2678 cast unvalidated strings)")
	}
	cal.Expect(t, 400, "calendar with a malformed date")
	ub.Expect(t, 400, "unbilled with a malformed date")
}

// TestREG_DENTAL_250_SessionsCalendar: from and to are required (400). For a
// fortnightly 3-visit course starting today with a down payment, the next 14 days
// show the deposit and visits 1–2, not visit 3; a cancelled visit and a cancelled
// course do not show. The dentist sees a recorded visit's procedure and tooth, the
// desk does not; clinic B's calendar has none of it; a nurse cannot read it.
func TestREG_DENTAL_250_SessionsCalendar(t *testing.T) {
	k := dn2NewCourse(t, 3, "300")
	desk := srv.As(t, k.c, "receptionist")
	k.doc.Do("GET", "/dental/sessions?from="+denToday(), nil).Expect(t, 400, "no to")
	k.doc.Do("GET", "/dental/sessions?to="+denToday(), nil).Expect(t, 400, "no from")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	dropped := createPlan(t, k.doc, k.p.ID, "1000", 1, "")
	k.doc.Do("POST", k.path("/plans/"+dropped.ID+"/cancel"), map[string]any{"reason": "dup"}).Expect(t, 200, "cancel the duplicate")
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(1)), map[string]any{"status": "cancelled"}).Expect(t, 204, "cancel visit 2")

	type item struct {
		SessionID    string `json:"session_id"`
		PlanID       string `json:"plan_id"`
		PatientID    string `json:"patient_id"`
		PatientName  string `json:"patient_name"`
		Seq          int    `json:"seq"`
		SessionCount int    `json:"session_count"`
		Title        string `json:"title"`
		Procedure    string `json:"procedure"`
		Tooth        string `json:"tooth"`
		Status       string `json:"status"`
		Kind         string `json:"kind"`
	}
	get := func(cl *testkit.Client, from, to string) map[string]item {
		var items []item
		cl.Do("GET", "/dental/sessions?from="+from+"&to="+to, nil).Expect(t, 200, "calendar").Decode(t, &items)
		m := map[string]item{}
		for _, it := range items {
			m[it.SessionID] = it
		}
		return m
	}
	m := get(k.doc, denToday(), denDay(14))
	v1 := m[k.sid(0)]
	_, okDep := m[k.plan.Deposit.ID]
	_, has2 := m[k.sid(1)]
	_, has3 := m[k.sid(2)]
	_, hasDropped := m[dropped.Sessions[0].ID]
	if v1.Status != "done" || v1.Procedure != "Access opening" || v1.Tooth != "UR5" || v1.Kind != "visit" || v1.SessionCount != 3 ||
		v1.PatientID != k.p.ID || v1.PlanID != k.plan.ID || !okDep || has2 || has3 || hasDropped {
		t.Fatalf("calendar: visit1=%+v deposit=%v visit2=%v visit3=%v dropped=%v", v1, okDep, has2, has3, hasDropped)
	}
	if _, in := get(k.doc, denDay(28), denDay(28))[k.sid(2)]; !in {
		t.Fatalf("visit 3 not on its own day")
	}
	if d := get(desk, denToday(), denDay(14))[k.sid(0)]; d.Procedure != "" || d.Tooth != "" || d.Title != "Root canal" {
		t.Fatalf("desk's calendar item %+v, want the title and no clinical fields", d)
	}
	if _, leak := get(srv.As(t, clinicB, "doctor"), denToday(), denDay(14))[k.sid(0)]; leak {
		t.Fatalf("clinic B's calendar shows clinic A's visit")
	}
	srv.As(t, k.c, "nurse").Do("GET", "/dental/sessions?from="+denToday()+"&to="+denToday(), nil).Expect(t, 403, "nurse")
}

// TestREG_DENTAL_255_ChairsideFiltersAndCard: Given a walk-in with a severe and a mild
// allergy and a given, unbilled 1,000 visit, When the dentist opens the chair list,
// Then the card names the severe allergy only, shows 1,000 unbilled and the running
// course. An unassigned arrival appears for every provider filter; once assigned to
// another dentist it appears only for them (and "all"). A malformed provider is 400;
// a window that ends before the arrival, or starts after it, excludes it.
func TestREG_DENTAL_255_ChairsideFiltersAndCard(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	doc := srv.As(t, c, "doctor")
	_, docBID := denSecondDentist(t, c)
	desk := srv.As(t, c, "receptionist")
	dn2Allergy(t, c, p.ID, "Lidocaine", "severe")
	dn2Allergy(t, c, p.ID, "Latex", "mild")
	plan := createPlan(t, doc, p.ID, "2000", 2, "")
	w := desk.Do("POST", "/queue/walk-in", map[string]any{"department_id": id.Encode(id.PrefixDepartment, c.DeptID), "patient_id": p.ID})
	if w.Status != 200 && w.Status != 201 {
		t.Skipf("could not arrange a walk-in (HTTP %d %s %s) — chairside filters not tested", w.Status, w.Code, w.Message)
	}
	denRecord(t, doc, p.ID, plan.Sessions[0].ID, "given")

	type card struct {
		PatientID  string `json:"patient_id"`
		Allergies  string `json:"allergies"`
		Unbilled   string `json:"unbilled"`
		PlanTitle  string `json:"plan_title"`
		PlanDone   int    `json:"plan_done"`
		PlanTotal  int    `json:"plan_total"`
		Recorded   int    `json:"recorded_this_visit"`
		ProviderID string `json:"provider_id"`
	}
	find := func(cl *testkit.Client, q string) *card {
		var rows []card
		cl.Do("GET", "/dental/chairside"+q, nil).Expect(t, 200, "chairside "+q).Decode(t, &rows)
		for i := range rows {
			if rows[i].PatientID == p.ID {
				return &rows[i]
			}
		}
		return nil
	}
	me := id.Encode(id.PrefixUser, c.Staff["doctor"].ID)
	other := id.Encode(id.PrefixUser, docBID)
	cd := find(doc, "")
	if cd == nil || cd.Allergies != "Lidocaine" || denMoney(t, cd.Unbilled) != 1000 || cd.PlanTitle != "Root canal" ||
		cd.PlanDone != 1 || cd.PlanTotal != 2 || cd.Recorded < 1 {
		t.Fatalf("chair card %+v", cd)
	}
	if find(doc, "?provider="+me) == nil || find(doc, "?provider="+other) == nil || find(desk, "?provider=all") == nil {
		t.Fatalf("an unassigned arrival must show for every provider")
	}
	if _, err := super.Pool.Exec(t.Context(), `UPDATE queue_entries SET assigned_provider_id = $2 WHERE tenant_id = $1 AND patient_id = $3`,
		c.TenantID, docBID, denUUID(t, id.PrefixPatient, p.ID)); err != nil {
		t.Fatal(err)
	}
	if find(doc, "?provider="+me) != nil {
		t.Fatalf("another dentist's patient shows on my chair")
	}
	if got := find(doc, "?provider="+other); got == nil || got.ProviderID != other {
		t.Fatalf("assigned patient missing from their dentist's chair: %+v", got)
	}
	if _, err := super.Pool.Exec(t.Context(), `UPDATE queue_entries SET state = 'done', started_at = now() - interval '20 minutes', ended_at = now()
	                                             WHERE tenant_id = $1 AND patient_id = $2`, c.TenantID, denUUID(t, id.PrefixPatient, p.ID)); err != nil {
		t.Fatal(err)
	}
	var seen struct {
		Rows []map[string]any
	}
	doc.Do("GET", "/dental/chairside?provider=all", nil).Expect(t, 200, "chairside").Decode(t, &seen.Rows)
	for _, row := range seen.Rows {
		if row["patient_id"] == p.ID && (row["started_at"] == nil || row["ended_at"] == nil || row["state"] != "done") {
			t.Fatalf("a seen patient's card lacks its times: %v", row)
		}
	}
	// Signed into the clinic's branch, the chair list is that branch's.
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	doc.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": id.Encode(id.PrefixBranch, c.BranchID)}).Expect(t, 200, "switch branch").Decode(t, &tok)
	inBranch := srv.As(t, c, "doctor")
	inBranch.Token = tok.AccessToken
	if find(inBranch, "?provider=all") == nil {
		t.Fatalf("the patient queued in this branch is missing from the branch's chair list")
	}
	doc.Do("GET", "/dental/chairside?provider=nobody", nil).Expect(t, 400, "malformed provider")
	past := time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339)
	future := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	if find(doc, "?from="+past+"&to="+time.Now().Add(-47*time.Hour).UTC().Format(time.RFC3339)) != nil {
		t.Fatalf("a window ending before the arrival still lists it")
	}
	if find(doc, "?from="+future) != nil {
		t.Fatalf("a window starting after the arrival still lists it")
	}
	if find(doc, "?from="+past) == nil {
		t.Fatalf("a window covering the arrival does not list it")
	}
	srv.As(t, c, "nurse").Do("GET", "/dental/chairside", nil).Expect(t, 403, "nurse")
}

// ---- the remaining refusals on a visit and a course ---------------------------------------

// TestREG_DENTAL_260_UpdateSessionRefusals: a status outside planned/done/cancelled,
// a date or fee that does not parse, recording the down payment as treatment, and an
// unknown visit are refused; a visit whose bill is at the cashier cannot leave done,
// be cancelled or change fee (409 SESSION_HAS_BILL). A planned visit can be redated
// through the record form, and every real change is an audit event with its reason.
func TestREG_DENTAL_260_UpdateSessionRefusals(t *testing.T) {
	k := dn2NewCourse(t, 3, "400")
	u := func(sid string, body any) testkit.Resp { return k.doc.Do("PUT", k.path("/sessions/"+sid), body) }
	dn2Code(t, u(k.sid(0), map[string]any{"status": "finished"}), 400, "VALIDATION_FAILED", "unknown status")
	dn2Code(t, u(k.sid(0), map[string]any{"scheduled_date": "tomorrow"}), 400, "VALIDATION_FAILED", "bad date")
	dn2Code(t, u(k.sid(0), map[string]any{"amount_due": "1500 ETB"}), 400, "VALIDATION_FAILED", "bad fee")
	u(k.sid(0), "x").Expect(t, 400, "malformed body")
	dn2Code(t, u(k.plan.Deposit.ID, map[string]any{"status": "done"}), 400, "VALIDATION_FAILED", "record the deposit")
	dn2Code(t, u(k.plan.Deposit.ID, map[string]any{"notes": "x"}), 400, "VALIDATION_FAILED", "notes on the deposit")
	dn2Code(t, u(id.Encode(id.PrefixTreatmentSession, uuid.New()), map[string]any{"notes": "x"}), 404, "SESSION_NOT_FOUND", "unknown")
	u("zz", map[string]any{"notes": "x"}).Expect(t, 400, "malformed id")
	dn2Code(t, u(id.Encode(id.PrefixTreatmentSession, uuid.New()), map[string]any{"amount_due": "5"}), 404, "SESSION_NOT_FOUND", "unknown (fee only)")
	other := createPlan(t, k.doc, denPatient(t, k.c).ID, "1000", 1, "")
	dn2Code(t, u(other.Sessions[0].ID, map[string]any{"notes": "wrong chart"}), 404, "SESSION_NOT_FOUND", "another patient's visit")
	if s, _ := dn2Sess(t, other.Sessions[0].ID); s != "planned" {
		t.Fatalf("another patient's visit changed")
	}

	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/collect"), nil).Expect(t, 204, "collect")
	for what, body := range map[string]map[string]any{
		"undo":   {"status": "planned", "reason": "x"},
		"cancel": {"status": "cancelled", "reason": "x"},
		"refee":  {"amount_due": "1200", "reason": "x"},
	} {
		dn2Code(t, u(k.sid(0), body), 409, "SESSION_HAS_BILL", what+" a billed visit")
	}
	u(k.sid(0), map[string]any{"status": "done", "notes": "addendum"}).Expect(t, 204, "a note on a billed visit is fine")
	if st, a := dn2Sess(t, k.sid(0)); st != "done" || a != 1000 {
		t.Fatalf("billed visit after refusals: %s %.2f", st, a)
	}

	u(k.sid(1), map[string]any{"scheduled_date": denDay(5), "reason": "patient travelling"}).Expect(t, 204, "redate planned")
	var date string
	one(t, `SELECT scheduled_date::text FROM treatment_sessions WHERE id = $1`, &date, dn2SessUUID(t, k.sid(1)))
	if date != denDay(5) {
		t.Fatalf("redated visit on %s", date)
	}
	if n := dn2Events(t, k.c.TenantID, "dental.session.updated", "patient travelling"); n != 1 {
		t.Fatalf("session.updated events carrying the reason = %d, want 1", n)
	}
	before := dn2Events(t, k.c.TenantID, "dental.session.updated", dn2SessUUID(t, k.sid(1)).String())
	u(k.sid(1), map[string]any{"scheduled_date": denDay(5)}).Expect(t, 204, "same date again")
	if after := dn2Events(t, k.c.TenantID, "dental.session.updated", dn2SessUUID(t, k.sid(1)).String()); after != before {
		t.Fatalf("a re-save that changed nothing wrote an event")
	}
}

// TestREG_DENTAL_261_RescheduleRefusals: the date is required and must be
// YYYY-MM-DD; an unknown visit is 404; a cancelled visit cannot be moved; moving a
// visit to the date it already has writes no event.
func TestREG_DENTAL_261_RescheduleRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	desk := srv.As(t, k.c, "receptionist")
	r := func(sid string, body any) testkit.Resp {
		return desk.Do("POST", k.path("/sessions/"+sid+"/reschedule"), body)
	}
	dn2Code(t, r(k.sid(0), map[string]any{}), 400, "VALIDATION_FAILED", "no date")
	dn2Code(t, r(k.sid(0), map[string]any{"scheduled_date": "2026/11/01"}), 400, "VALIDATION_FAILED", "bad date")
	r(k.sid(0), "x").Expect(t, 400, "malformed body")
	dn2Code(t, r(id.Encode(id.PrefixTreatmentSession, uuid.New()), map[string]any{"scheduled_date": denToday()}), 404, "SESSION_NOT_FOUND", "unknown")
	r("zz", map[string]any{"scheduled_date": denToday()}).Expect(t, 400, "malformed id")
	srv.As(t, k.c, "nurse").Do("POST", k.path("/sessions/"+k.sid(0)+"/reschedule"), map[string]any{"scheduled_date": denToday()}).Expect(t, 403, "nurse")

	r(k.sid(0), map[string]any{"scheduled_date": k.plan.Sessions[0].ScheduledDate}).Expect(t, 204, "same date")
	if n := dn2Events(t, k.c.TenantID, "dental.session.rescheduled", dn2SessUUID(t, k.sid(0)).String()); n != 0 {
		t.Fatalf("a no-op reschedule wrote %d events", n)
	}
	r(k.sid(0), map[string]any{"scheduled_date": denDay(3)}).Expect(t, 204, "move")
	if n := dn2Events(t, k.c.TenantID, "dental.session.rescheduled", dn2SessUUID(t, k.sid(0)).String()); n != 1 {
		t.Fatalf("reschedule events = %d, want 1", n)
	}
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(1)), map[string]any{"status": "cancelled"}).Expect(t, 204, "cancel visit 2")
	dn2Code(t, r(k.sid(1), map[string]any{"scheduled_date": denDay(9)}), 400, "VALIDATION_FAILED", "move a cancelled visit")
}

// TestREG_DENTAL_262_CancelPlanRefusals: a course with treatment given and owed is
// 409 PLAN_HAS_DEBT; cancelling twice is 409 PLAN_CANCELLED; an unknown course is
// 404. Cancelling a course that never started cancels its unpaid down payment too
// (contrast finishing, which keeps it owed).
func TestREG_DENTAL_262_CancelPlanRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	cancel := func(pid string, body any) testkit.Resp {
		return k.doc.Do("POST", k.path("/plans/"+pid+"/cancel"), body)
	}
	r := cancel(k.plan.ID, map[string]any{"reason": "patient left"})
	dn2Code(t, r, 409, "PLAN_HAS_DEBT", "cancel with given, owed treatment")
	if !strings.Contains(r.Message, "1000.00") {
		t.Fatalf("debt refusal does not say how much: %q", r.Message)
	}
	cancel(k.plan.ID, "x").Expect(t, 400, "malformed body")
	dn2Code(t, cancel(id.Encode(id.PrefixTreatmentPlan, uuid.New()), map[string]any{"reason": "x"}), 404, "PLAN_NOT_FOUND", "unknown")
	cancel("zz", map[string]any{"reason": "x"}).Expect(t, 400, "malformed id")

	dep := createPlan(t, k.doc, k.p.ID, "3000", 2, "1000")
	var out struct {
		N int `json:"sessions_cancelled"`
	}
	cancel(dep.ID, map[string]any{"reason": "changed mind"}).Expect(t, 200, "cancel untouched course").Decode(t, &out)
	if st, _ := dn2Sess(t, dep.Deposit.ID); st != "cancelled" || out.N != 3 {
		t.Fatalf("cancelled course: deposit %s, %d cancelled (want deposit cancelled, 3)", st, out.N)
	}
	dn2Code(t, cancel(dep.ID, map[string]any{"reason": "again"}), 409, "PLAN_CANCELLED", "cancel twice")
	if n := dn2Events(t, k.c.TenantID, "dental.plan.cancelled", "changed mind"); n != 1 {
		t.Fatalf("plan.cancelled events = %d", n)
	}
}

// TestREG_DENTAL_263_DeletePlanRefusals: a course with a bill at the cashier is 409
// PLAN_HAS_CHARGES even before any visit is given; one with a prescription is 409
// PLAN_HAS_RECORDS; an unknown course is 404; the desk cannot delete one.
func TestREG_DENTAL_263_DeletePlanRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	del := func(pid string) testkit.Resp { return k.doc.Do("DELETE", k.path("/plans/"+pid), nil) }
	srv.As(t, k.c, "receptionist").Do("DELETE", k.path("/plans/"+k.plan.ID), nil).Expect(t, 403, "desk deletes")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(1)+"/collect"), nil).Expect(t, 204, "prepay visit 2")
	dn2Code(t, del(k.plan.ID), 409, "PLAN_HAS_CHARGES", "delete with a bill")

	rxPlan := createPlan(t, k.doc, k.p.ID, "1000", 1, "")
	k.doc.Do("POST", k.path("/sessions/"+rxPlan.Sessions[0].ID+"/prescriptions"), dn2Rx("Chlorhexidine mouthwash")).Expect(t, 201, "prescribe")
	dn2Code(t, del(rxPlan.ID), 409, "PLAN_HAS_RECORDS", "delete with a prescription")
	dn2Code(t, del(id.Encode(id.PrefixTreatmentPlan, uuid.New())), 404, "PLAN_NOT_FOUND", "unknown")
	del("zz").Expect(t, 400, "malformed id")
	var n int
	one(t, `SELECT count(*) FROM treatment_plans WHERE patient_id = $1`, &n, denUUID(t, id.PrefixPatient, k.p.ID))
	if n != 2 {
		t.Fatalf("%d plans after refused deletes, want 2", n)
	}
}

// TestREG_DENTAL_264_CreatePlanValidation: a course needs a name and a real start
// date; money fields must be plain numbers; sessions sent by the preview must have
// real dates and fees; a malformed service id is refused rather than dropped.
func TestREG_DENTAL_264_CreatePlanValidation(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	path := "/dental/patients/" + p.ID + "/plans"
	base := func(extra map[string]any) map[string]any {
		m := map[string]any{"title": "Bridge", "start_date": denToday(), "total_amount": "3000", "session_count": 2}
		for kk, v := range extra {
			m[kk] = v
		}
		return m
	}
	cases := map[string]map[string]any{
		"no title":            base(map[string]any{"title": ""}),
		"bad start date":      base(map[string]any{"start_date": "01-10-2026"}),
		"deposit not number":  base(map[string]any{"deposit": "half"}),
		"total with comma":    base(map[string]any{"total_amount": "3,000"}),
		"negative total":      base(map[string]any{"total_amount": "-3000"}),
		"session bad date":    base(map[string]any{"sessions": []map[string]any{{"scheduled_date": "soon", "amount_due": "10"}}}),
		"session bad fee":     base(map[string]any{"sessions": []map[string]any{{"scheduled_date": denToday(), "amount_due": "ten"}}}),
		"malformed service":   base(map[string]any{"service_id": "crown"}),
		"session_count as st": {"title": "x", "start_date": denToday(), "session_count": "two"},
	}
	for what, body := range cases {
		doc.Do("POST", path, body).Expect(t, 400, what)
	}
	if n := len(denPlans(t, doc, p.ID)); n != 0 {
		t.Fatalf("refused creates stored %d plans", n)
	}
}

// TestREG_DENTAL_265_CreatePlanSchedulesAndPrices: the schedule follows the unit (day,
// month; anything else is monthly) and a count below 1 is one visit; sessions sent by
// the preview are kept as sent, with the course total their sum plus the deposit; a
// course linked to the catalogue snapshots the list price at that moment.
func TestREG_DENTAL_265_CreatePlanSchedulesAndPrices(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	path := "/dental/patients/" + p.ID + "/plans"
	start := time.Now().In(addisLoc()) // the clinic's day, as denToday
	mk := func(body map[string]any) denPlan {
		var pl denPlan
		doc.Do("POST", path, body).Expect(t, 201, "create").Decode(t, &pl)
		return pl
	}
	days := mk(map[string]any{"title": "Ortho check", "start_date": denToday(), "total_amount": "300", "interval_unit": "day", "interval_count": 3, "session_count": 3})
	months := mk(map[string]any{"title": "Implant", "start_date": denToday(), "total_amount": "1000", "interval_unit": "fortnight", "session_count": 2})
	single := mk(map[string]any{"title": "Consult", "start_date": denToday(), "total_amount": "500", "session_count": 0})
	if days.Sessions[1].ScheduledDate != denDay(3) || days.Sessions[2].ScheduledDate != denDay(6) {
		t.Fatalf("day schedule %+v", days.Sessions)
	}
	if months.Sessions[1].ScheduledDate != start.AddDate(0, 1, 0).Format("2006-01-02") {
		t.Fatalf("unknown unit should be monthly: %+v", months.Sessions)
	}
	if len(single.Sessions) != 1 || denMoney(t, single.Sessions[0].AmountDue) != 500 {
		t.Fatalf("session_count 0: %+v", single.Sessions)
	}
	// Uneven totals round each visit to a payable unit and put the rest on the last:
	// 3,500/3 in hundreds, 250/3 in tens, 25/3 in single birr.
	for total, want := range map[string][]float64{"3500": {1100, 1100, 1300}, "250": {80, 80, 90}, "25": {8, 8, 9}} {
		pl := mk(map[string]any{"title": "Split " + total, "start_date": denToday(), "total_amount": total, "session_count": 3})
		for i, w := range want {
			if got := denMoney(t, pl.Sessions[i].AmountDue); got != w {
				t.Fatalf("%s over 3 visits: visit %d = %.2f, want %.2f", total, i+1, got, w)
			}
		}
	}
	preview := mk(map[string]any{"title": "Crowns", "start_date": denToday(), "total_amount": "9999", "deposit": "200",
		"sessions": []map[string]any{{"scheduled_date": denDay(1), "amount_due": "700"}, {"scheduled_date": denDay(9), "amount_due": "1300"}}})
	if len(preview.Sessions) != 2 || denMoney(t, preview.Sessions[1].AmountDue) != 1300 || preview.Sessions[1].ScheduledDate != denDay(9) ||
		denMoney(t, preview.TotalAmount) != 2200 || preview.Deposit == nil || denMoney(t, preview.Deposit.AmountDue) != 200 {
		t.Fatalf("preview course %+v", preview)
	}

	svc := denDentalService(t, doc, 4200)
	var linked struct {
		ServiceID   string `json:"service_id"`
		ServiceName string `json:"service_name"`
		ListPrice   string `json:"list_price"`
	}
	doc.Do("POST", path, map[string]any{"title": "Listed crown", "start_date": denToday(), "total_amount": "4000", "session_count": 1, "service_id": svc}).
		Expect(t, 201, "linked course").Decode(t, &linked)
	if linked.ServiceID != svc || denMoney(t, linked.ListPrice) != 4200 || linked.ServiceName == "" {
		t.Fatalf("catalogue link %+v", linked)
	}
	if r := doc.Do("POST", path, map[string]any{"title": "x", "start_date": denToday(), "session_count": 1,
		"service_id": id.Encode(id.PrefixServiceItem, uuid.New())}); r.Status < 400 {
		t.Fatalf("an unknown catalogue service was accepted: HTTP %d", r.Status)
	}
}

// TestREG_DENTAL_266_SaveChartBodyAndHistory: a save must name teeth (400 for an
// empty body); a page loaded before the merge change may still send "teeth", and it
// is merged, not replaced; a save that changes nothing writes no history event.
func TestREG_DENTAL_266_SaveChartBodyAndHistory(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	denSeedConditions(t, doc)
	p := denPatient(t, c)
	path := "/dental/patients/" + p.ID + "/chart"
	pu := denUUID(t, id.PrefixPatient, p.ID).String()
	dn2Code(t, doc.Do("PUT", path, map[string]any{}), 400, "VALIDATION_FAILED", "empty body")
	doc.Do("PUT", path, "x").Expect(t, 400, "malformed body")
	doc.Do("PUT", "/dental/patients/zz/chart", map[string]any{"changes": map[string]string{}}).Expect(t, 400, "malformed patient")

	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR1": "filled"}}).Expect(t, 200, "save")
	doc.Do("PUT", path, map[string]any{"teeth": map[string]string{"LL8": "extracted"}}).Expect(t, 200, "legacy whole-mouth save")
	ch := denChart(t, doc, p.ID)
	if ch["UR1"] != "filled" || ch["LL8"] != "extracted" {
		t.Fatalf("legacy save replaced instead of merging: %v", ch)
	}
	before := dn2Events(t, c.TenantID, "dental.chart.saved", pu)
	doc.Do("PUT", path, map[string]any{"changes": map[string]string{"UR1": "filled"}}).Expect(t, 200, "unchanged save")
	if after := dn2Events(t, c.TenantID, "dental.chart.saved", pu); after != before || before != 2 {
		t.Fatalf("chart.saved events: %d before, %d after an unchanged save (want 2 and 2)", before, after)
	}
}

// TestREG_DENTAL_267_DentalRoutesNeedTheDentalModule: a general clinic (dental off)
// gets no dental routes, even for a doctor whose role carries dental.manage — the
// list is not seeded and nothing is written.
func TestREG_DENTAL_267_DentalRoutesNeedTheDentalModule(t *testing.T) {
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{ClinicType: "general"})
	doc := srv.As(t, c, "doctor")
	for _, rq := range []struct{ m, p string }{
		{"GET", "/dental/procedures"}, {"POST", "/dental/procedures"}, {"GET", "/dental/tooth-statuses"},
		{"GET", "/dental/sessions?from=" + denToday() + "&to=" + denToday()}, {"GET", "/dental/outstanding"},
	} {
		if r := doc.Do(rq.m, rq.p, map[string]any{"name": "x"}); r.Status != 403 && r.Status != 404 {
			t.Fatalf("%s %s in a clinic without dental: HTTP %d %s", rq.m, rq.p, r.Status, r.Code)
		}
	}
	var n int
	one(t, `SELECT count(*) FROM dental_procedures WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 0 {
		t.Fatalf("a non-dental clinic got %d procedures", n)
	}
}

// TestREG_DENTAL_268_ReadRoutesRefuseMalformedPatientIDs: every per-patient read
// refuses an id that is not a patient id (400), rather than answering for nobody.
func TestREG_DENTAL_268_ReadRoutesRefuseMalformedPatientIDs(t *testing.T) {
	doc := srv.As(t, clinicA, "doctor")
	for _, rest := range []string{"/summary", "/chart", "/plans", "/images", "/exams", "/medical-history"} {
		doc.Do("GET", "/dental/patients/usr_123"+rest, nil).Expect(t, 400, rest)
	}
	for _, rest := range []string{"/plans", "/collect-sessions", "/images", "/images/sign", "/exams"} {
		doc.Do("POST", "/dental/patients/zz"+rest, map[string]any{}).Expect(t, 400, "POST "+rest)
	}
}

// TestREG_DENTAL_269_WriteRoutesRefuseMalformedIDs: every per-patient write refuses a
// patient, course, visit or record id that is not of its kind (400) before touching
// anything.
func TestREG_DENTAL_269_WriteRoutesRefuseMalformedIDs(t *testing.T) {
	k := dn2NewCourse(t, 1, "")
	doc, cashier := k.doc, srv.As(t, k.c, "cashier")
	sid, pid := k.sid(0), k.plan.ID
	bad := "/dental/patients/usr_1"
	body := map[string]any{"reason": "x", "amount": "1", "mode": "total", "scheduled_date": denToday(), "on": true, "visit_date": denToday()}
	for _, rq := range []struct {
		cl   *testkit.Client
		m, p string
	}{
		{doc, "POST", bad + "/sessions/" + sid + "/reprice"}, {doc, "POST", bad + "/sessions/" + sid + "/extras"},
		{doc, "DELETE", bad + "/extras/" + sid}, {doc, "DELETE", bad + "/plans/" + pid}, {doc, "PUT", bad + "/sessions/" + sid},
		{doc, "POST", bad + "/sessions/" + sid + "/reschedule"}, {doc, "POST", bad + "/sessions/" + sid + "/collect"},
		{doc, "POST", k.path("/sessions/zz/collect")}, {doc, "POST", bad + "/sessions/" + sid + "/uncollect"},
		{doc, "POST", bad + "/sessions/" + sid + "/pay-later"}, {doc, "POST", k.path("/sessions/zz/pay-later")},
		{doc, "PUT", bad + "/medical-history"}, {doc, "POST", bad + "/sessions/" + sid + "/prescriptions"},
		{doc, "DELETE", bad + "/prescriptions/drx_1"}, {doc, "DELETE", bad + "/images/att_1"},
		{doc, "PUT", bad + "/exams/dvz_1"}, {doc, "DELETE", bad + "/exams/dvz_1"},
		{cashier, "POST", bad + "/sessions/" + sid + "/write-off"}, {cashier, "POST", k.path("/sessions/zz/write-off")},
		{cashier, "POST", bad + "/sessions/" + sid + "/undo-write-off"}, {doc, "POST", bad + "/plans/" + pid + "/sessions"},
		{doc, "POST", bad + "/plans/" + pid + "/cancel"}, {doc, "POST", bad + "/plans/" + pid + "/finish"},
	} {
		rq.cl.Do(rq.m, rq.p, body).Expect(t, 400, rq.m+" "+rq.p)
	}
	if st, _ := dn2Sess(t, sid); st != "planned" || dn2Charge(t, sid) != "" {
		t.Fatalf("a refused request changed the visit")
	}
}

// TestREG_DENTAL_270_DepositIsCollectedAsADownPayment: an unpaid down payment is owed
// from the day the course is agreed; collecting it raises one charge described as the
// course's down payment, booked to the clinic, and it cannot be recorded as
// treatment (400) — only billed, paid or written off.
func TestREG_DENTAL_270_DepositIsCollectedAsADownPayment(t *testing.T) {
	k := dn2NewCourse(t, 2, "800")
	dep := k.plan.Deposit.ID
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 800 {
		t.Fatalf("an agreed deposit is not due: %s", b.Due)
	}
	dn2Code(t, k.doc.Do("POST", k.path("/sessions/"+dep+"/reprice"), map[string]any{"amount": "1", "mode": "total"}), 400, "VALIDATION_FAILED", "reprice the deposit")
	srv.As(t, k.c, "receptionist").Do("POST", k.path("/sessions/"+dep+"/collect"), nil).Expect(t, 204, "desk collects the deposit")
	var desc string
	one(t, `SELECT c.description FROM charges c JOIN treatment_sessions se ON se.charge_id = c.id WHERE se.id = $1`, &desc, dn2SessUUID(t, dep))
	if desc != "Root canal — down payment" {
		t.Fatalf("deposit charge described %q", desc)
	}
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 0 || denMoney(t, b.AtCashier) != 800 {
		t.Fatalf("after collecting the deposit: due %s at cashier %s", b.Due, b.AtCashier)
	}
}

// TestREG_DENTAL_276_UnbilledDatesAreTheClinicDay: Given a visit given at 00:30 Addis
// this morning and not yet billed, When the unbilled report is read, Then it was
// treated today, has waited 0 days, and a today..today filter finds it. NEW-DAY-3
// (fixed 2026-10-04) dated it by owed_since::date, a UTC cast, filing a visit given
// between midnight and 03:00 Addis under yesterday. 00:30 Addis is yesterday in UTC
// at every hour, so this test catches that mistake whenever it runs.
func TestREG_DENTAL_276_UnbilledDatesAreTheClinicDay(t *testing.T) {
	if time.Now().In(addisLoc()).Before(addisAt(0, 0, 31)) {
		t.Skip("00:30 Addis today has not happened yet")
	}
	k := dn2NewCourse(t, 1, "")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	blExec(t, `UPDATE treatment_sessions SET completed_at = $1 WHERE id = $2`,
		addisAt(0, 0, 30), denUUID(t, id.PrefixTreatmentSession, k.sid(0)))
	today := payAddisToday()
	row := dn2Row(dn2GetUnbilled(t, k.doc, "").Rows, k.sid(0))
	if row == nil {
		t.Fatalf("the visit is not on the unbilled report")
	}
	filtered := dn2GetUnbilled(t, k.doc, "?from="+today+"&to="+today)
	// (NEW-DAY-3, fixed 2026-10-04.)
	if row.TreatmentDate != today || row.DaysUnbilled != 0 || dn2Row(filtered.Rows, k.sid(0)) == nil {
		t.Fatalf("a visit given at 00:30 Addis today reads treated %s, %d day(s) unbilled, in today's filter=%t",
			row.TreatmentDate, row.DaysUnbilled, dn2Row(filtered.Rows, k.sid(0)) != nil)
	}
}
