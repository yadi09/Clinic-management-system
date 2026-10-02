package regression

import (
	"fmt"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The shared clinical catalogues a dental clinic uses (REG_CAT): the allergen library,
// the drug library with each drug's allergen tags, and how a dental prescription is
// checked against the patient's recorded allergies using them. Catalogue writes run in
// a private clinic so names never collide with other tests.

// ---- helpers (prefixed op) ---------------------------------------------------

type opAllergen struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	IsActive        bool   `json:"is_active"`
	DefaultReaction string `json:"default_reaction"`
	DefaultSeverity string `json:"default_severity"`
}

type opDrug struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	DefaultDose string   `json:"default_dose"`
	IsActive    bool     `json:"is_active"`
	Allergens   []string `json:"allergens"`
}

func opAllergens(t *testing.T, c *testkit.Client, query string) map[string]opAllergen {
	t.Helper()
	var list []opAllergen
	c.Do("GET", "/allergens"+query, nil).Expect(t, 200, "allergens").Decode(t, &list)
	out := map[string]opAllergen{}
	for _, a := range list {
		out[a.ID] = a
	}
	return out
}

func opDrugs(t *testing.T, c *testkit.Client, query string) map[string]opDrug {
	t.Helper()
	var list []opDrug
	c.Do("GET", "/drugs"+query, nil).Expect(t, 200, "drugs").Decode(t, &list)
	out := map[string]opDrug{}
	for _, d := range list {
		out[d.ID] = d
	}
	return out
}

func opNewAllergen(t *testing.T, c *testkit.Client, name string) opAllergen {
	t.Helper()
	var a opAllergen
	c.Do("POST", "/allergens", map[string]any{"name": name}).Expect(t, 201, "create allergen "+name).Decode(t, &a)
	return a
}

func opNewDrug(t *testing.T, c *testkit.Client, name string, allergenIDs ...string) opDrug {
	t.Helper()
	var d opDrug
	c.Do("POST", "/drugs", map[string]any{"name": name, "default_dose": "500mg", "allergen_ids": allergenIDs}).Expect(t, 201, "create drug "+name).Decode(t, &d)
	return d
}

// ---- allergens -----------------------------------------------------------------

// TestREG_CAT_001_AllergenLibraryCreateSearchUpdateDelete: Given a clinic, When the
// dentist adds Penicillin with a default reaction and severity, Then it is listed and
// searchable; a duplicate in any case is 409, a blank name or unknown severity 400; the
// desk (patient.update) may add one but not edit; When it is switched off, Then it is
// hidden unless all=1; When deleted, Then it is gone and the name can be reused.
func TestREG_CAT_001_AllergenLibraryCreateSearchUpdateDelete(t *testing.T) {
	c := newClinic(t)
	doc, desk := srv.As(t, c, "doctor"), srv.As(t, c, "receptionist")
	var pen opAllergen
	doc.Do("POST", "/allergens", map[string]any{"name": "  Penicillin ", "default_reaction": " rash ", "default_severity": "severe"}).
		Expect(t, 201, "create allergen").Decode(t, &pen)
	if pen.Name != "Penicillin" || pen.DefaultReaction != "rash" || pen.DefaultSeverity != "severe" || !pen.IsActive {
		t.Fatalf("created allergen %+v", pen)
	}
	if r := doc.Do("POST", "/allergens", map[string]any{"name": "PENICILLIN"}); r.Status != 409 || r.Code != "ALLERGEN_EXISTS" {
		t.Fatalf("duplicate allergen: %d %s", r.Status, r.Code)
	}
	doc.Do("POST", "/allergens", map[string]any{"name": "  "}).Expect(t, 400, "blank allergen")
	doc.Do("POST", "/allergens", map[string]any{"name": "Latex", "default_severity": "deadly"}).Expect(t, 400, "unknown severity")
	doc.Do("POST", "/allergens", "latex").Expect(t, 400, "malformed body")
	latex := opNewAllergen(t, desk, "Latex")
	srv.As(t, c, "cashier").Do("POST", "/allergens", map[string]any{"name": "Iodine"}).Expect(t, 403, "cashier adds allergen")

	if l := opAllergens(t, srv.As(t, c, "cashier"), ""); len(l) != 2 || l[pen.ID].Name != "Penicillin" {
		t.Fatalf("allergen list %+v", l)
	}
	if l := opAllergens(t, doc, "?search="+url.QueryEscape("cill")); len(l) != 1 || l[pen.ID].ID == "" {
		t.Fatalf("search 'cill' %+v", l)
	}

	desk.Do("PUT", "/allergens/"+pen.ID, map[string]any{"name": "Penicillins"}).Expect(t, 403, "desk edits allergen")
	doc.Do("PUT", "/allergens/"+pen.ID, map[string]any{"name": ""}).Expect(t, 400, "edit to blank")
	doc.Do("PUT", "/allergens/"+pen.ID, map[string]any{"name": "Penicillin", "default_severity": "awful"}).Expect(t, 400, "edit to bad severity")
	if r := doc.Do("PUT", "/allergens/"+pen.ID, map[string]any{"name": "latex"}); r.Status != 409 {
		t.Fatalf("rename onto another allergen: %d", r.Status)
	}
	doc.Do("PUT", "/allergens/aln_bad", map[string]any{"name": "X"}).Expect(t, 400, "edit malformed id")
	off := false
	doc.Do("PUT", "/allergens/"+pen.ID, map[string]any{"name": "Penicillins", "is_active": off, "default_severity": "moderate"}).Expect(t, 204, "edit allergen")
	if l := opAllergens(t, doc, ""); l[pen.ID].ID != "" {
		t.Fatalf("switched-off allergen still listed by default")
	}
	got := opAllergens(t, doc, "?all=1")[pen.ID]
	if got.Name != "Penicillins" || got.IsActive || got.DefaultSeverity != "moderate" || got.DefaultReaction != "" {
		t.Fatalf("edited allergen %+v (edit is a full replace)", got)
	}

	desk.Do("DELETE", "/allergens/"+latex.ID, nil).Expect(t, 403, "desk deletes allergen")
	doc.Do("DELETE", "/allergens/"+latex.ID, nil).Expect(t, 204, "delete allergen")
	if l := opAllergens(t, doc, "?all=1"); l[latex.ID].ID != "" {
		t.Fatalf("deleted allergen still listed")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM allergen_catalog WHERE id = $1`, &deleted, opUUID(t, id.PrefixAllergen, latex.ID))
	if !deleted {
		t.Fatalf("allergen not soft-deleted")
	}
	opNewAllergen(t, doc, "Latex") // a deleted name is free again
	doc.Do("DELETE", "/allergens/x", nil).Expect(t, 400, "delete malformed id")
}

// ---- drugs ------------------------------------------------------------------------

// TestREG_CAT_002_DrugLibraryWithAllergenTags: Given Penicillin in the allergen library,
// When the dentist adds Amoxicillin tagged with it, Then the drug lists the tag; a
// duplicate name is 409, a blank name or a malformed allergen id 400; When edited, Then
// the tag set is replaced and an inactive drug is hidden unless all=1; When deleted,
// Then it is gone; any staff may read the library, the desk may not write it.
func TestREG_CAT_002_DrugLibraryWithAllergenTags(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	pen := opNewAllergen(t, doc, "Penicillin")
	sulfa := opNewAllergen(t, doc, "Sulfa")
	amox := opNewDrug(t, doc, "Amoxicillin 500mg", pen.ID)
	if amox.Name != "Amoxicillin 500mg" || amox.DefaultDose != "500mg" || !amox.IsActive {
		t.Fatalf("created drug %+v", amox)
	}
	if d := opDrugs(t, srv.As(t, c, "cashier"), "")[amox.ID]; len(d.Allergens) != 1 || d.Allergens[0] != "Penicillin" {
		t.Fatalf("drug tags %+v", d)
	}
	if r := doc.Do("POST", "/drugs", map[string]any{"name": "amoxicillin 500MG"}); r.Status != 409 || r.Code != "DRUG_EXISTS" {
		t.Fatalf("duplicate drug: %d %s", r.Status, r.Code)
	}
	doc.Do("POST", "/drugs", map[string]any{"name": " "}).Expect(t, 400, "blank drug")
	doc.Do("POST", "/drugs", map[string]any{"name": "Ibuprofen", "allergen_ids": []string{"aln_bad"}}).Expect(t, 400, "malformed allergen id")
	doc.Do("POST", "/drugs", map[string]any{"name": "Ibuprofen", "allergen_ids": "x"}).Expect(t, 400, "malformed body")
	srv.As(t, c, "receptionist").Do("POST", "/drugs", map[string]any{"name": "Ibuprofen"}).Expect(t, 403, "desk adds drug")
	ibu := opNewDrug(t, srv.As(t, c, "owner"), "Ibuprofen 400mg")

	off := false
	doc.Do("PUT", "/drugs/"+amox.ID, map[string]any{"name": "Amoxicillin 250mg", "allergen_ids": []string{sulfa.ID}}).Expect(t, 204, "retag drug")
	if d := opDrugs(t, doc, "?search=amox")[amox.ID]; d.Name != "Amoxicillin 250mg" || len(d.Allergens) != 1 || d.Allergens[0] != "Sulfa" {
		t.Fatalf("retagged drug %+v", d)
	}
	doc.Do("PUT", "/drugs/"+amox.ID, map[string]any{"name": ""}).Expect(t, 400, "edit to blank")
	doc.Do("PUT", "/drugs/"+amox.ID, map[string]any{"name": "Amox", "allergen_ids": []string{"bad"}}).Expect(t, 400, "edit with malformed tag")
	doc.Do("PUT", "/drugs/"+amox.ID, 7).Expect(t, 400, "edit malformed body")
	if r := doc.Do("PUT", "/drugs/"+amox.ID, map[string]any{"name": "ibuprofen 400MG"}); r.Status != 409 {
		t.Fatalf("rename onto another drug: %d", r.Status)
	}
	doc.Do("PUT", "/drugs/drg_bad", map[string]any{"name": "X"}).Expect(t, 400, "edit malformed id")
	doc.Do("PUT", "/drugs/"+ibu.ID, map[string]any{"name": "Ibuprofen 400mg", "is_active": off}).Expect(t, 204, "switch drug off")
	if _, ok := opDrugs(t, doc, "")[ibu.ID]; ok {
		t.Fatalf("inactive drug listed by default")
	}
	if d, ok := opDrugs(t, doc, "?all=1")[ibu.ID]; !ok || d.IsActive {
		t.Fatalf("inactive drug with all=1: %+v ok=%v", d, ok)
	}
	srv.As(t, c, "receptionist").Do("DELETE", "/drugs/"+ibu.ID, nil).Expect(t, 403, "desk deletes drug")
	doc.Do("DELETE", "/drugs/"+ibu.ID, nil).Expect(t, 204, "delete drug")
	if _, ok := opDrugs(t, doc, "?all=1")[ibu.ID]; ok {
		t.Fatalf("deleted drug still listed")
	}
	doc.Do("DELETE", "/drugs/x", nil).Expect(t, 400, "delete malformed id")

	// Deleting an allergen drops it from every drug's tags.
	doc.Do("DELETE", "/allergens/"+sulfa.ID, nil).Expect(t, 204, "delete tagged allergen")
	if d := opDrugs(t, doc, "")[amox.ID]; len(d.Allergens) != 0 {
		t.Fatalf("deleted allergen still tags the drug: %+v", d)
	}
}

// TestREG_CAT_003_CataloguesAreClinicScoped: Given clinic A's allergen and drug, When
// clinic B lists, edits or deletes them, Then B sees neither and A's entries are
// unchanged and live.
func TestREG_CAT_003_CataloguesAreClinicScoped(t *testing.T) {
	a := newClinic(t)
	docA := srv.As(t, a, "doctor")
	al := opNewAllergen(t, docA, "Chlorhexidine")
	dr := opNewDrug(t, docA, "Metronidazole", al.ID)
	ob := srv.As(t, clinicB, "owner")
	if _, ok := opAllergens(t, ob, "?all=1")[al.ID]; ok {
		t.Fatalf("CROSS-CLINIC READ: clinic B lists clinic A's allergen")
	}
	if _, ok := opDrugs(t, ob, "?all=1")[dr.ID]; ok {
		t.Fatalf("CROSS-CLINIC READ: clinic B lists clinic A's drug")
	}
	ob.Do("PUT", "/allergens/"+al.ID, map[string]any{"name": "Stolen"})
	ob.Do("PUT", "/drugs/"+dr.ID, map[string]any{"name": "Stolen"})
	ob.Do("DELETE", "/allergens/"+al.ID, nil)
	ob.Do("DELETE", "/drugs/"+dr.ID, nil)
	if got := opAllergens(t, docA, "")[al.ID]; got.Name != "Chlorhexidine" {
		t.Fatalf("CROSS-CLINIC WRITE: A's allergen is now %+v", got)
	}
	if got := opDrugs(t, docA, "")[dr.ID]; got.Name != "Metronidazole" || len(got.Allergens) != 1 {
		t.Fatalf("CROSS-CLINIC WRITE: A's drug is now %+v", got)
	}
}

// TestREG_CAT_004_EditingAnUnknownCatalogueEntryIs404: Given ids that do not exist, When
// an allergen or a drug is edited or deleted, Then 404. Today every one answers 204:
// the updates and deletes never check that a row was affected.
func TestREG_CAT_004_EditingAnUnknownCatalogueEntryIs404(t *testing.T) {
	doc := srv.As(t, clinicA, "doctor")
	codes := []int{
		doc.Do("PUT", "/allergens/"+id.Encode(id.PrefixAllergen, uuid.New()), map[string]any{"name": "Ghost"}).Status,
		doc.Do("DELETE", "/allergens/"+id.Encode(id.PrefixAllergen, uuid.New()), nil).Status,
		doc.Do("PUT", "/drugs/"+id.Encode(id.PrefixDrug, uuid.New()), map[string]any{"name": "Ghost"}).Status,
		doc.Do("DELETE", "/drugs/"+id.Encode(id.PrefixDrug, uuid.New()), nil).Status,
	}
	bad := false
	for _, s := range codes {
		if s >= 500 {
			t.Fatalf("unknown catalogue ids: %v", codes)
		}
		bad = bad || s != 404
	}
	testkit.KnownBug(t, "NEW-CAT-1", bad, fmt.Sprintf(
		"edit/delete of a nonexistent allergen or drug answers %v (want 404): clinical/service/drug_library.go never checks rows affected", codes))
}

// TestREG_CAT_005_DrugTaggedWithAnotherClinicsAllergenIsRefused: Given clinic B's
// allergen id, When clinic A tags a drug with it, Then the API refuses (4xx). Today the
// tag row is stored (the foreign key ignores row-level security), and it silently never
// matches anything in A (TENANT-FK-1 class).
func TestREG_CAT_005_DrugTaggedWithAnotherClinicsAllergenIsRefused(t *testing.T) {
	b := newClinic(t)
	foreign := opNewAllergen(t, srv.As(t, b, "doctor"), "Foreign "+uuid.NewString()[:4])
	a := newClinic(t)
	r := srv.As(t, a, "doctor").Do("POST", "/drugs", map[string]any{"name": "Clindamycin", "allergen_ids": []string{foreign.ID}})
	var stray int
	one(t, `SELECT count(*) FROM drug_allergens WHERE tenant_id = $1 AND allergen_id = $2`, &stray, a.TenantID, opUUID(t, id.PrefixAllergen, foreign.ID))
	testkit.KnownBug(t, "TENANT-FK-1", r.Status < 400 || stray != 0, fmt.Sprintf(
		"a drug tagged with another clinic's allergen is accepted (HTTP %d, %d tag row(s) stored)", r.Status, stray))
}

// ---- the allergy check on a dental prescription ----------------------------------------

// TestREG_CAT_006_DentalPrescriptionIsCheckedAgainstAllergies: Given a patient allergic
// to Penicillin and Amoxil tagged Penicillin in the drug library, When the dentist
// prescribes Amoxil (picked from the library, or typed by name), Then 409
// ALLERGY_CONFLICT naming Penicillin and nothing is stored; with an override reason it
// is written and the reason is kept on the item; an untagged drug passes without one.
func TestREG_CAT_006_DentalPrescriptionIsCheckedAgainstAllergies(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	pen := opNewAllergen(t, doc, "Penicillin")
	amox := opNewDrug(t, doc, "Amoxil", pen.ID)
	para := opNewDrug(t, doc, "Paracetamol")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Allergic"), "Patient")
	srv.As(t, c, "receptionist").Do("POST", "/patients/"+p.ID+"/allergies", map[string]any{"substance": "Penicillin", "severity": "severe"}).Expect(t, 201, "record allergy")
	plan := createPlan(t, doc, p.ID, "2000", 2, "")
	path := "/dental/patients/" + p.ID + "/sessions/" + plan.Sessions[0].ID + "/prescriptions"
	countRx := func() int {
		var n int
		one(t, `SELECT count(*) FROM dental_prescriptions WHERE patient_id = $1`, &n, opUUID(t, id.PrefixPatient, p.ID))
		return n
	}

	for name, item := range map[string]map[string]any{
		"picked from the library": {"drug_name": "Amoxil", "drug_id": amox.ID, "dose": "500mg"},
		"typed by name":           {"drug_name": "amoxil", "dose": "500mg"},
	} {
		r := doc.Do("POST", path, map[string]any{"items": []any{item}})
		if r.Status != 409 || r.Code != "ALLERGY_CONFLICT" || !strings.Contains(r.Message, "Penicillin") {
			t.Fatalf("%s: %d %s %q", name, r.Status, r.Code, r.Message)
		}
	}
	if n := countRx(); n != 0 {
		t.Fatalf("a refused prescription was stored (%d)", n)
	}
	doc.Do("POST", path, map[string]any{"items": []any{map[string]any{"drug_name": "Amoxil", "drug_id": "drg_bad"}}}).Expect(t, 400, "malformed drug id")

	var rx struct {
		ID string `json:"id"`
	}
	doc.Do("POST", path, map[string]any{
		"items":           []any{map[string]any{"drug_name": "Amoxil", "drug_id": amox.ID, "dose": "500mg"}},
		"override_reason": "  tolerated before, mild rash only ",
	}).Expect(t, 201, "prescribe with override").Decode(t, &rx)
	var override string
	var drug uuid.UUID
	one(t, `SELECT coalesce(allergy_override,'') FROM dental_prescription_items WHERE prescription_id = $1`, &override, opUUID(t, id.PrefixDentalRx, rx.ID))
	one(t, `SELECT drug_id FROM dental_prescription_items WHERE prescription_id = $1`, &drug, opUUID(t, id.PrefixDentalRx, rx.ID))
	if override != "tolerated before, mild rash only" || drug != opUUID(t, id.PrefixDrug, amox.ID) {
		t.Fatalf("stored item override=%q drug=%v", override, drug)
	}
	doc.Do("POST", path, map[string]any{"items": []any{map[string]any{"drug_name": "Paracetamol", "drug_id": para.ID}}}).Expect(t, 201, "untagged drug")
	if n := countRx(); n != 2 {
		t.Fatalf("prescriptions stored %d, want 2", n)
	}
}
