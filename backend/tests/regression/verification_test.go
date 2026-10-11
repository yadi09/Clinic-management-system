package regression

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// A printed prescription carries a QR that opens the clinic's own record. These tests
// pin what that record says and, as important, what it must not: no phone, no card
// number, and nothing at all about a paper that was withdrawn or replaced.

type vfResult struct {
	Status     string `json:"status"`
	Ref        string `json:"ref"`
	Clinic     string `json:"clinic"`
	Slug       string `json:"slug"`
	HasLogo    bool   `json:"has_logo"`
	WrittenAt  string `json:"written_at"`
	DaysAgo    int    `json:"days_ago"`
	ValidUntil string `json:"valid_until"`
	Prescriber string `json:"prescriber"`
	Note       string `json:"note"`
	Patient    *struct {
		Name   string `json:"name"`
		Age    int    `json:"age"`
		Gender string `json:"gender"`
	} `json:"patient"`
	Medicines []struct {
		Name      string `json:"name"`
		Dose      string `json:"dose"`
		Frequency string `json:"frequency"`
		Duration  string `json:"duration"`
	} `json:"medicines"`
	Checks struct {
		Before  int    `json:"before"`
		FirstAt string `json:"first_at"`
	} `json:"checks"`
}

type vfIssued struct {
	Token string `json:"token"`
	Slug  string `json:"slug"`
	Path  string `json:"path"`
	Code  string `json:"code"`
	Ref   string `json:"ref"`
}

// vfRx writes a dental prescription of two medicines and returns the prefixed id.
func vfRx(t *testing.T, c *testkit.Clinic, doc *testkit.Client, patientID string) string {
	t.Helper()
	plan := createPlan(t, doc, patientID, "3000", 3, "")
	var rx denRx
	doc.Do("POST", "/dental/patients/"+patientID+"/sessions/"+plan.Sessions[0].ID+"/prescriptions", map[string]any{
		"note": "after extraction", "items": []map[string]any{
			{"drug_name": "Amoxicillin 500 mg", "dose": "1 capsule", "frequency": "3 times a day", "duration": "7 days"},
			{"drug_name": "Ibuprofen 400 mg", "dose": "1 tablet", "frequency": "3 times a day", "duration": "3 days"},
		},
	}).Expect(t, 201, "prescribe").Decode(t, &rx)
	return rx.ID
}

func vfIssue(t *testing.T, cl *testkit.Client, kind, rxID string) vfIssued {
	t.Helper()
	var out vfIssued
	cl.Do("POST", "/verify/issue", map[string]any{"kind": kind, "id": rxID}).Expect(t, 200, "issue").Decode(t, &out)
	return out
}

func vfCheck(t *testing.T, slug, token string) vfResult {
	t.Helper()
	var out vfResult
	srv.Anon(t).Do("GET", "/verify/t/"+slug+"/"+token, nil).Expect(t, 200, "check").Decode(t, &out)
	return out
}

// TestREG_VERIFY_001_AGenuinePaperShowsWhatTheClinicIssued: Given a printed
// prescription, When anyone opens its link, Then they see the clinic, the medicines
// and the doctor — and the patient only as a first name and initial, with age and sex.
func TestREG_VERIFY_001_AGenuinePaperShowsWhatTheClinicIssued(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), "Abebe", "Kebede")
	rx := vfRx(t, c, doc, p.ID)

	iss := vfIssue(t, doc, "dental_rx", rx)
	if iss.Slug != c.Slug || iss.Path != "/v/"+c.Slug+"/"+iss.Token || len(iss.Token) != 26 {
		t.Fatalf("issued %+v", iss)
	}
	if iss.Ref != "Rx "+rx[len(rx)-6:] {
		t.Fatalf("reference %q must match the one the screen prints (Rx %s)", iss.Ref, rx[len(rx)-6:])
	}
	if len(iss.Code) != 9 || iss.Code[4] != '-' {
		t.Fatalf("short code %q, want two groups of four", iss.Code)
	}

	r := vfCheck(t, c.Slug, iss.Token)
	if r.Status != "genuine" || r.Ref != iss.Ref || r.Slug != c.Slug {
		t.Fatalf("check %+v", r)
	}
	if len(r.Medicines) != 2 || r.Medicines[0].Name != "Amoxicillin 500 mg" || r.Medicines[0].Duration != "7 days" || r.Medicines[1].Name != "Ibuprofen 400 mg" {
		t.Fatalf("medicines %+v", r.Medicines)
	}
	if r.Patient == nil || r.Patient.Name != "Abebe K." || r.Patient.Age < 0 {
		t.Fatalf("patient %+v, want first name and initial", r.Patient)
	}
	if r.Prescriber == "" || r.Note != "after extraction" || r.Clinic == "" {
		t.Fatalf("prescriber %q note %q clinic %q", r.Prescriber, r.Note, r.Clinic)
	}
	// Nothing a stranger could use: no phone, no card number, no surname.
	for _, leak := range []string{p.MRN, "Kebede", "phone", "mrn", "national"} {
		if leak != "" && strings.Contains(strings.ToLower(srvRaw(t, c.Slug, iss.Token)), strings.ToLower(leak)) {
			t.Fatalf("the public answer carries %q", leak)
		}
	}
}

func srvRaw(t *testing.T, slug, token string) string {
	t.Helper()
	return srv.Anon(t).Do("GET", "/verify/t/"+slug+"/"+token, nil).Raw
}

// TestREG_VERIFY_002_TheSamePaperPrintedAgainIsTheSameCheck: Given a prescription that
// was issued, When it is issued again (a reprint), Then the token and the code are
// the same; a different prescription gets a different one.
func TestREG_VERIFY_002_TheSamePaperPrintedAgainIsTheSameCheck(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Rep"), "Print")
	a := vfRx(t, c, doc, p.ID)
	b := vfRx(t, c, doc, p.ID)
	first, again, other := vfIssue(t, doc, "dental_rx", a), vfIssue(t, doc, "dental_rx", a), vfIssue(t, doc, "dental_rx", b)
	if first.Token != again.Token || first.Code != again.Code {
		t.Fatalf("a reprint got a new check: %+v vs %+v", first, again)
	}
	if first.Token == other.Token || first.Code == other.Code {
		t.Fatalf("two prescriptions share a check: %+v / %+v", first, other)
	}
	var rows int
	one(t, `SELECT count(*) FROM paper_verifications WHERE tenant_id = $1`, &rows, c.TenantID)
	if rows != 2 {
		t.Fatalf("%d verification rows, want 2", rows)
	}
}

// TestREG_VERIFY_003_AnUnknownOrForeignPaperIsJustNotFound: Given tokens that were
// never issued, malformed, or another clinic's, When they are opened, Then every one
// answers 404 — nothing tells which of them exist.
func TestREG_VERIFY_003_AnUnknownOrForeignPaperIsJustNotFound(t *testing.T) {
	a, b := newClinic(t), newClinic(t)
	docA := srv.As(t, a, "doctor")
	pa := createPatient(t, srv.As(t, a, "receptionist"), uniq("Own"), "Paper")
	issA := vfIssue(t, docA, "dental_rx", vfRx(t, a, docA, pa.ID))

	anon := srv.Anon(t)
	for name, path := range map[string]string{
		"never issued":      "/verify/t/" + a.Slug + "/" + strings.Repeat("a", 26),
		"malformed token":   "/verify/t/" + a.Slug + "/not-a-token",
		"unknown clinic":    "/verify/t/no-such-clinic/" + issA.Token,
		"another clinic's":  "/verify/t/" + b.Slug + "/" + issA.Token,
		"bad slug":          "/verify/t/UPPER_case!/" + issA.Token,
		"code never issued": "/verify/c/" + a.Slug + "/ABCD-EFGH",
		"code wrong clinic": "/verify/c/" + b.Slug + "/" + issA.Code,
	} {
		r := anon.Do("GET", path, nil)
		if r.Status != 404 || r.Code != "PAPER_NOT_FOUND" {
			t.Errorf("%s: %d %s, want 404 PAPER_NOT_FOUND", name, r.Status, r.Code)
		}
	}
}

// TestREG_VERIFY_004_AWithdrawnPaperSaysSoAndShowsNoMedicines: Given an issued
// prescription, When the doctor withdraws it, Then the same link says cancelled and
// carries no medicines — a dead prescription must not be readable off a screen.
func TestREG_VERIFY_004_AWithdrawnPaperSaysSoAndShowsNoMedicines(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Void"), "Paper")
	rx := vfRx(t, c, doc, p.ID)
	iss := vfIssue(t, doc, "dental_rx", rx)
	if r := vfCheck(t, c.Slug, iss.Token); r.Status != "genuine" {
		t.Fatalf("before withdrawal: %s", r.Status)
	}
	doc.Do("DELETE", "/dental/patients/"+p.ID+"/prescriptions/"+rx, map[string]any{"reason": "wrong drug"}).Expect(t, 204, "withdraw")
	r := vfCheck(t, c.Slug, iss.Token)
	if r.Status != "cancelled" || len(r.Medicines) != 0 || r.Patient != nil || r.Prescriber != "" {
		t.Fatalf("after withdrawal: %+v", r)
	}
	if r.Ref != iss.Ref || r.Clinic == "" {
		t.Fatalf("a cancelled paper still says whose it was: %+v", r)
	}
}

// TestREG_VERIFY_005_EveryLookIsCounted: Given an issued paper, When it is checked
// twice, Then the first look sees none before it and the second sees one, with when.
func TestREG_VERIFY_005_EveryLookIsCounted(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Cnt"), "Paper")
	iss := vfIssue(t, doc, "dental_rx", vfRx(t, c, doc, p.ID))
	first := vfCheck(t, c.Slug, iss.Token)
	second := vfCheck(t, c.Slug, iss.Token)
	third := vfCheck(t, c.Slug, iss.Token)
	if first.Checks.Before != 0 || first.Checks.FirstAt != "" {
		t.Fatalf("first look %+v", first.Checks)
	}
	if second.Checks.Before != 1 || second.Checks.FirstAt == "" || third.Checks.Before != 2 {
		t.Fatalf("looks %+v / %+v", second.Checks, third.Checks)
	}
}

func vfPrintSettings(t *testing.T, owner *testkit.Client, settings map[string]any) {
	t.Helper()
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": settings}).Expect(t, 200, "print settings")
}

// TestREG_VERIFY_006_TheDoctorsNameFollowsThePrintingChoice: Given a clinic that
// switched "Doctor's name" off (several doctors share one account), When the paper is
// printed, Then the page does not name a doctor either; a paper-level choice wins.
func TestREG_VERIFY_006_TheDoctorsNameFollowsThePrintingChoice(t *testing.T) {
	c := newClinic(t)
	doc, owner := srv.As(t, c, "doctor"), srv.As(t, c, "owner")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Dr"), "Name")
	rx := vfRx(t, c, doc, p.ID)

	vfPrintSettings(t, owner, map[string]any{"signature": map[string]any{"showName": false}})
	iss := vfIssue(t, doc, "dental_rx", rx)
	if r := vfCheck(t, c.Slug, iss.Token); r.Prescriber != "" || r.Status != "genuine" {
		t.Fatalf("switch off: prescriber %q status %s", r.Prescriber, r.Status)
	}

	// The paper's own choice overrides the clinic-wide one, and a reprint picks it up.
	vfPrintSettings(t, owner, map[string]any{
		"signature": map[string]any{"showName": false},
		"docs":      map[string]any{"prescription": map[string]any{"show": map[string]any{"signerName": true}}},
	})
	again := vfIssue(t, doc, "dental_rx", rx)
	if again.Token != iss.Token {
		t.Fatalf("a changed printing choice must not change the token")
	}
	if r := vfCheck(t, c.Slug, again.Token); r.Prescriber == "" {
		t.Fatalf("the paper switched the name back on, the page still hides it")
	}
}

// TestREG_VERIFY_007_APaperPastItsValidityIsAmberNotGenuine: Given a clinic that
// says prescriptions are valid for 3 days, When a 5-day-old one is checked, Then it
// is "expired" (medicines still shown, so a pharmacist can see what it was) and says
// until when; a fresh one is genuine with the date.
func TestREG_VERIFY_007_APaperPastItsValidityIsAmberNotGenuine(t *testing.T) {
	c := newClinic(t)
	doc, owner := srv.As(t, c, "doctor"), srv.As(t, c, "owner")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Val"), "Days")
	vfPrintSettings(t, owner, map[string]any{
		"docs": map[string]any{"prescription": map[string]any{"text": map[string]any{"validDays": "3"}}},
	})
	fresh := vfRx(t, c, doc, p.ID)
	old := vfRx(t, c, doc, p.ID)
	blExec(t, `UPDATE dental_prescriptions SET created_at = now() - interval '5 days' WHERE id = $1`, blUUID(t, id.PrefixDentalRx, old))

	r := vfCheck(t, c.Slug, vfIssue(t, doc, "dental_rx", fresh).Token)
	if r.Status != "genuine" || r.ValidUntil == "" || r.DaysAgo != 0 {
		t.Fatalf("fresh: %+v", r)
	}
	r = vfCheck(t, c.Slug, vfIssue(t, doc, "dental_rx", old).Token)
	if r.Status != "expired" || r.DaysAgo != 5 || len(r.Medicines) != 2 || r.ValidUntil == "" {
		t.Fatalf("old: %+v", r)
	}
}

// vfEncounter seeds a consultation with the given medicines (the clinical module's
// own screens are outside this suite's scope, so the rows are written directly).
func vfEncounter(t *testing.T, c *testkit.Clinic, p patientRef, meds ...string) (encID, rxID uuid.UUID) {
	t.Helper()
	encID, rxID = uuid.New(), uuid.New()
	blExec(t, `INSERT INTO encounters (id, tenant_id, branch_id, department_id, patient_id, provider_id, status, started_at)
	           VALUES ($1, $2, $3, $4, $5, $6, 'open', now())`,
		encID, c.TenantID, c.BranchID, c.DeptID, blPatientUUID(t, p), c.Staff["doctor"].ID)
	blExec(t, `INSERT INTO prescriptions (id, tenant_id, encounter_id, patient_id, status) VALUES ($1, $2, $3, $4, 'active')`,
		rxID, c.TenantID, encID, blPatientUUID(t, p))
	for i, m := range meds {
		blExec(t, `INSERT INTO prescription_items (tenant_id, prescription_id, drug_name, dose, frequency, duration, created_at)
		           VALUES ($1, $2, $3, '1 tablet', 'twice a day', '5 days', now() + make_interval(secs => $4))`,
			c.TenantID, rxID, m, i)
	}
	return encID, rxID
}

// TestREG_VERIFY_008_AChangedConsultationPrescriptionSaysANewerVersionExists: Given
// a consultation's prescription that was printed, When a medicine is added afterwards,
// Then the old paper's link says superseded and shows no medicines; printing again
// gives a new link that is genuine. When every medicine is removed it says cancelled.
func TestREG_VERIFY_008_AChangedConsultationPrescriptionSaysANewerVersionExists(t *testing.T) {
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{ClinicType: "general"})
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Enc"), "Counter")
	encID, rxID := vfEncounter(t, c, p, "Paracetamol 500 mg")
	encRef := id.Encode(id.PrefixEncounter, encID)

	old := vfIssue(t, doc, "encounter_rx", encRef)
	if r := vfCheck(t, c.Slug, old.Token); r.Status != "genuine" || len(r.Medicines) != 1 || r.Ref != "Rx "+encRef[len(encRef)-6:] {
		t.Fatalf("first print: %+v", r)
	}

	blExec(t, `INSERT INTO prescription_items (tenant_id, prescription_id, drug_name) VALUES ($1, $2, 'Amoxicillin 500 mg')`, c.TenantID, rxID)
	r := vfCheck(t, c.Slug, old.Token)
	if r.Status != "superseded" || len(r.Medicines) != 0 {
		t.Fatalf("after a medicine was added: %+v", r)
	}
	fresh := vfIssue(t, doc, "encounter_rx", encRef)
	if fresh.Token == old.Token {
		t.Fatalf("a changed prescription must get a new token")
	}
	if r := vfCheck(t, c.Slug, fresh.Token); r.Status != "genuine" || len(r.Medicines) != 2 {
		t.Fatalf("new print: %+v", r)
	}

	blExec(t, `DELETE FROM prescription_items WHERE prescription_id = $1`, rxID)
	if r := vfCheck(t, c.Slug, fresh.Token); r.Status != "cancelled" {
		t.Fatalf("with every medicine removed: %+v", r)
	}
	// An empty prescription has nothing to verify.
	doc.Do("POST", "/verify/issue", map[string]any{"kind": "encounter_rx", "id": encRef}).Expect(t, 400, "issue empty")
}

// TestREG_VERIFY_009_TheShortCodeWorksAndGuessingIsLimited: Given a printed short
// code, When it is typed as printed or lower-case, Then the same paper opens; When a
// stranger keeps guessing, Then they are slowed down.
func TestREG_VERIFY_009_TheShortCodeWorksAndGuessingIsLimited(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Code"), "Typed")
	iss := vfIssue(t, doc, "dental_rx", vfRx(t, c, doc, p.ID))

	anon := srv.Anon(t)
	var r vfResult
	anon.Do("GET", "/verify/c/"+c.Slug+"/"+strings.ToLower(iss.Code), nil).Expect(t, 200, "typed lower case").Decode(t, &r)
	if r.Status != "genuine" || r.Ref != iss.Ref {
		t.Fatalf("by code: %+v", r)
	}
	limited := false
	for i := 0; i < 20 && !limited; i++ {
		limited = anon.Do("GET", "/verify/c/"+c.Slug+"/ZZZZ-ZZZZ", nil).Status == 429
	}
	if !limited {
		t.Fatalf("twenty wrong guesses in a row were never slowed down")
	}
}

// TestREG_VERIFY_010_OnlyTheClinicsOwnStaffCanIssueAndOnlyForTheirOwnPapers: Given the
// issue endpoint, When it is called signed out, by the front desk, or for another
// clinic's prescription, Then it is refused (401, 403, 404).
func TestREG_VERIFY_010_OnlyTheClinicsOwnStaffCanIssueAndOnlyForTheirOwnPapers(t *testing.T) {
	a, b := newClinic(t), newClinic(t)
	docA := srv.As(t, a, "doctor")
	p := createPatient(t, srv.As(t, a, "receptionist"), uniq("Iss"), "Perm")
	rx := vfRx(t, a, docA, p.ID)

	body := map[string]any{"kind": "dental_rx", "id": rx}
	srv.Anon(t).Do("POST", "/verify/issue", body).Expect(t, 401, "signed out")
	srv.As(t, a, "receptionist").Do("POST", "/verify/issue", body).Expect(t, 403, "front desk")
	srv.As(t, b, "doctor").Do("POST", "/verify/issue", body).Expect(t, 404, "another clinic's prescription")
	docA.Do("POST", "/verify/issue", map[string]any{"kind": "lab_report", "id": rx}).Expect(t, 400, "unsupported kind")
	docA.Do("POST", "/verify/issue", map[string]any{"kind": "dental_rx", "id": "garbage"}).Expect(t, 400, "bad id")
}

// TestREG_VERIFY_011_TheCheckPageGetsTheClinicsLogoAndIsNeverCachedOrIndexed: Given a
// clinic with a logo, When its check page asks for it, Then the image comes back as
// an image; a public answer is marked no-store and noindex.
func TestREG_VERIFY_011_TheCheckPageGetsTheClinicsLogoAndIsNeverCachedOrIndexed(t *testing.T) {
	c := newClinic(t)
	doc, owner := srv.As(t, c, "doctor"), srv.As(t, c, "owner")
	anon := srv.Anon(t)
	anon.Do("GET", "/verify/logo/"+c.Slug, nil).Expect(t, 404, "no logo yet")

	owner.Do("PUT", "/org/print-settings", map[string]any{
		"settings": map[string]any{"version": 1}, "logo": "data:image/png;base64," + tinyPNG,
	}).Expect(t, 200, "logo")
	r := anon.Do("GET", "/verify/logo/"+c.Slug, nil).Expect(t, 200, "logo")
	want, _ := base64.StdEncoding.DecodeString(tinyPNG)
	if r.Raw != string(want) || r.Header.Get("Content-Type") != "image/png" || r.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("logo served as %q (%d bytes)", r.Header.Get("Content-Type"), len(r.Raw))
	}

	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Hdr"), "Paper")
	iss := vfIssue(t, doc, "dental_rx", vfRx(t, c, doc, p.ID))
	chk := anon.Do("GET", "/verify/t/"+c.Slug+"/"+iss.Token, nil).Expect(t, 200, "check")
	if !strings.Contains(chk.Header.Get("Cache-Control"), "no-store") || !strings.Contains(chk.Header.Get("X-Robots-Tag"), "noindex") {
		t.Fatalf("headers %v", chk.Header)
	}
	var res vfResult
	chk.Decode(t, &res)
	if !res.HasLogo {
		t.Fatalf("the page is not told the clinic has a logo")
	}
}
