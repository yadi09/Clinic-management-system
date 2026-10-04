package regression

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Patients, the rest of the record (REG_PATIENT_020..): conditions, guardians,
// attachments, the legacy register import (CSV rows), the old-history import,
// medical certificates and the clinical read-outs a dental clinic reaches. Every
// write is checked twice: the answer, and what the database holds.

// ---- helpers (prefixed op) -----------------------------------------------------

type opProfile struct {
	ID         string `json:"id"`
	MRN        string `json:"mrn"`
	Conditions []struct {
		ID          string `json:"id"`
		ICDCode     string `json:"icd_code"`
		Description string `json:"description"`
		Status      string `json:"status"`
		OnsetDate   string `json:"onset_date"`
	} `json:"conditions"`
	Guardians []struct {
		ID           string `json:"id"`
		Relationship string `json:"relationship"`
	} `json:"guardians"`
	Attachments []struct {
		ID        string `json:"id"`
		Type      string `json:"type"`
		URL       string `json:"url"`
		Filename  string `json:"filename"`
		MimeType  string `json:"mime_type"`
		SizeBytes int64  `json:"size_bytes"`
	} `json:"attachments"`
}

func opProfileOf(t *testing.T, c *testkit.Client, pid string) opProfile {
	t.Helper()
	var p opProfile
	c.Do("GET", "/patients/"+pid, nil).Expect(t, 200, "get patient").Decode(t, &p)
	return p
}

// opPatient registers a fresh patient as the desk of clinic c.
func opPatient(t *testing.T, c *testkit.Clinic) patientRef {
	t.Helper()
	return createPatient(t, srv.As(t, c, "receptionist"), uniq("Op"), "Patient")
}

type opImportReport struct {
	Total         int  `json:"total"`
	Imported      int  `json:"imported"`
	Updated       int  `json:"updated"`
	Duplicates    int  `json:"duplicates"`
	Failed        int  `json:"failed"`
	MissingPhone  int  `json:"missing_phone"`
	MissingGender int  `json:"missing_gender"`
	EstimatedDOB  int  `json:"estimated_dob"`
	DryRun        bool `json:"dry_run"`
	Rows          []struct {
		RowNumber int    `json:"row_number"`
		Outcome   string `json:"outcome"`
		Reason    string `json:"reason"`
		MRN       string `json:"mrn"`
		Warning   string `json:"warning"`
	} `json:"rows"`
}

// opImport posts a legacy register batch (expects 200).
func opImport(t *testing.T, c *testkit.Client, body map[string]any) opImportReport {
	t.Helper()
	var rep opImportReport
	c.Do("POST", "/patients/import", body).Expect(t, 200, "import").Decode(t, &rep)
	return rep
}

func opRow(n int, name, phone, gender, age, visit string) map[string]any {
	return map[string]any{"row_number": n, "name": name, "phone": phone, "gender": gender, "age": age, "visit_date": visit}
}

func opPatientCount(t *testing.T, c *testkit.Clinic) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL`, &n, c.TenantID)
	return n
}

type opImported struct {
	First, Middle, Last, Gender, Phone, DOB, FirstVisit string
	DOBEstimated                                        bool
}

func opImportedByMRN(t *testing.T, c *testkit.Clinic, mrn string) opImported {
	t.Helper()
	var p opImported
	if err := super.Pool.QueryRow(t.Context(),
		`SELECT first_name, coalesce(middle_name,''), coalesce(last_name,''), gender, coalesce(phone,''),
		        to_char(dob,'YYYY-MM-DD'), coalesce(to_char(first_visit_date,'YYYY-MM-DD'),''), dob_estimated
		   FROM patients WHERE tenant_id = $1 AND mrn = $2`, c.TenantID, mrn).
		Scan(&p.First, &p.Middle, &p.Last, &p.Gender, &p.Phone, &p.DOB, &p.FirstVisit, &p.DOBEstimated); err != nil {
		t.Fatalf("imported patient %s: %v", mrn, err)
	}
	return p
}

// ---- conditions ---------------------------------------------------------------

// TestREG_PATIENT_020_ConditionsAddListRemove: Given a patient, When the desk records a
// resolved condition with an ICD code and onset date, Then the profile lists it as
// sent; a missing description or a bad date is 400; When it is removed, Then it leaves
// the profile and the row is kept soft-deleted; staff without patient.update cannot
// add one.
func TestREG_PATIENT_020_ConditionsAddListRemove(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := opPatient(t, clinicA)
	path := "/patients/" + p.ID + "/conditions"
	srv.As(t, clinicA, "cashier").Do("POST", path, map[string]any{"description": "Diabetes"}).Expect(t, 403, "cashier adds condition")
	rc.Do("POST", path, map[string]any{"icd_code": "E11"}).Expect(t, 400, "condition without description")
	rc.Do("POST", path, map[string]any{"description": "Diabetes", "onset_date": "13/06/2017"}).Expect(t, 400, "bad onset date")
	rc.Do("POST", path, map[string]any{"description": "Diabetes", "onset_date": time.Now().AddDate(1, 0, 0).Format("2006-01-02")}).Expect(t, 400, "future onset date")

	var cnd struct {
		ID string `json:"id"`
	}
	rc.Do("POST", path, map[string]any{"icd_code": "E11", "description": "Type 2 diabetes", "status": "resolved", "onset_date": "2019-04-01"}).
		Expect(t, 201, "add condition").Decode(t, &cnd)
	rc.Do("POST", path, map[string]any{"description": "Hypertension"}).Expect(t, 201, "add second condition")
	got := opProfileOf(t, rc, p.ID)
	if len(got.Conditions) != 2 {
		t.Fatalf("conditions listed %+v, want 2", got.Conditions)
	}
	for _, x := range got.Conditions {
		switch x.ID {
		case cnd.ID:
			if x.ICDCode != "E11" || x.Description != "Type 2 diabetes" || x.Status != "resolved" || x.OnsetDate != "2019-04-01" {
				t.Fatalf("condition listed %+v", x)
			}
		default:
			if x.Status != "active" {
				t.Fatalf("condition without a status should be active: %+v", x)
			}
		}
	}
	srv.As(t, clinicA, "cashier").Do("DELETE", path+"/"+cnd.ID, nil).Expect(t, 403, "cashier removes condition")
	rc.Do("DELETE", path+"/"+cnd.ID, nil).Expect(t, 204, "remove condition")
	if got := opProfileOf(t, rc, p.ID); len(got.Conditions) != 1 || got.Conditions[0].ID == cnd.ID {
		t.Fatalf("removed condition still listed: %+v", got.Conditions)
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM conditions WHERE id = $1`, &deleted, opUUID(t, id.PrefixCondition, cnd.ID))
	if !deleted {
		t.Fatalf("condition row not soft-deleted")
	}
	rc.Do("DELETE", path+"/cnd_bad", nil).Expect(t, 404, "remove malformed condition id")
}

// TestREG_PATIENT_021_RemoveUnknownConditionIs404: Given a patient, When the desk
// removes a condition id that does not exist, Then 404 — not a silent 204
// (RemoveCondition is :exec with no row check, like NEW-PAT-3 for allergies).
func TestREG_PATIENT_021_RemoveUnknownConditionIs404(t *testing.T) {
	p := opPatient(t, clinicA)
	r := srv.As(t, clinicA, "receptionist").Do("DELETE", "/patients/"+p.ID+"/conditions/"+id.Encode(id.PrefixCondition, uuid.New()), nil)
	opStatus(t, r, "remove unknown condition", 404, 204)
	testkit.KnownBug(t, "NEW-PAT-4", r.Status == 204,
		"DELETE /patients/:id/conditions/<nonexistent> answers 204: RemoveCondition is :exec with no row-count check")
}

// ---- guardians ------------------------------------------------------------------

// TestREG_PATIENT_022_GuardianLinksAPatient: Given a child and a parent registered in
// the same clinic, When the desk links the parent as guardian, Then the child's profile
// lists the relationship and the row points at the parent; a missing relationship or a
// malformed guardian id is 400; a guardian without a patient record is allowed.
func TestREG_PATIENT_022_GuardianLinksAPatient(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	child, parent := opPatient(t, clinicA), opPatient(t, clinicA)
	path := "/patients/" + child.ID + "/guardians"
	rc.Do("POST", path, map[string]any{"guardian_patient_id": parent.ID}).Expect(t, 400, "guardian without relationship")
	rc.Do("POST", path, map[string]any{"guardian_patient_id": "pat_bad", "relationship": "mother"}).Expect(t, 400, "malformed guardian id")
	srv.As(t, clinicA, "nurse").Do("POST", path, map[string]any{"relationship": "mother"}).Expect(t, 403, "nurse adds guardian")

	var g struct {
		ID string `json:"id"`
	}
	rc.Do("POST", path, map[string]any{"guardian_patient_id": parent.ID, "relationship": "mother"}).Expect(t, 201, "add guardian").Decode(t, &g)
	rc.Do("POST", path, map[string]any{"relationship": "uncle"}).Expect(t, 201, "guardian without a record")
	prof := opProfileOf(t, rc, child.ID)
	rels := []string{}
	for _, x := range prof.Guardians {
		rels = append(rels, x.Relationship)
	}
	if len(prof.Guardians) != 2 || !opHas(rels, "mother") || !opHas(rels, "uncle") {
		t.Fatalf("guardians listed %+v", prof.Guardians)
	}
	var linked uuid.UUID
	one(t, `SELECT guardian_patient_id FROM guardian_links WHERE id = $1`, &linked, opUUID(t, id.PrefixGuardian, g.ID))
	if linked != opUUID(t, id.PrefixPatient, parent.ID) {
		t.Fatalf("guardian row points at %v, want the parent", linked)
	}
}

// ---- attachments ------------------------------------------------------------------

// TestREG_PATIENT_023_AttachmentRecordListRemove: Given a patient (files go to the no-op
// store in tests, so the URL is the key), When a scan's metadata is recorded, Then the
// profile lists it with its size, and plan usage counts the bytes; missing fields are
// 400; When it is removed, Then it leaves the profile, is soft-deleted, the bytes are
// released, and removing it again is 404.
func TestREG_PATIENT_023_AttachmentRecordListRemove(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	p := opPatient(t, c)
	path := "/patients/" + p.ID + "/attachments"
	key := fmt.Sprintf("%s/patients/%s/xray-1.pdf", c.TenantID, opUUID(t, id.PrefixPatient, p.ID))
	rc.Do("POST", path, map[string]any{"type": "scan", "filename": "x.pdf", "mime_type": "application/pdf"}).Expect(t, 400, "attachment without storage key")
	srv.As(t, c, "doctor").Do("POST", path, map[string]any{"type": "scan", "storage_key": key, "filename": "x.pdf", "mime_type": "application/pdf"}).
		Expect(t, 403, "doctor (no patient.update) records attachment")

	var att struct {
		ID        string `json:"id"`
		URL       string `json:"url"`
		SizeBytes int64  `json:"size_bytes"`
	}
	rc.Do("POST", path, map[string]any{"type": "scan", "storage_key": key, "filename": "xray-1.pdf", "mime_type": "application/pdf", "size_bytes": 2048}).
		Expect(t, 201, "record attachment").Decode(t, &att)
	if att.URL != key || att.SizeBytes != 2048 {
		t.Fatalf("recorded attachment %+v", att)
	}
	prof := opProfileOf(t, rc, p.ID)
	if len(prof.Attachments) != 1 || prof.Attachments[0].ID != att.ID || prof.Attachments[0].Filename != "xray-1.pdf" || prof.Attachments[0].SizeBytes != 2048 {
		t.Fatalf("attachments listed %+v", prof.Attachments)
	}
	usage := func() int64 {
		var u struct {
			Storage struct {
				Used int64 `json:"used"`
			} `json:"storage"`
		}
		rc.Do("GET", "/org/plan-usage", nil).Expect(t, 200, "plan usage").Decode(t, &u)
		return u.Storage.Used
	}
	if u := usage(); u != 2048 {
		t.Fatalf("storage used %d, want 2048", u)
	}
	srv.As(t, c, "cashier").Do("DELETE", path+"/"+att.ID, nil).Expect(t, 403, "cashier removes attachment")
	rc.Do("DELETE", path+"/"+att.ID, nil).Expect(t, 204, "remove attachment")
	if prof := opProfileOf(t, rc, p.ID); len(prof.Attachments) != 0 {
		t.Fatalf("removed attachment still listed")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM attachments WHERE id = $1`, &deleted, opUUID(t, id.PrefixAttachment, att.ID))
	if !deleted || usage() != 0 {
		t.Fatalf("attachment deleted=%v storage=%d after removal", deleted, usage())
	}
	if r := rc.Do("DELETE", path+"/"+att.ID, nil); r.Status != 404 || r.Code != "ATTACHMENT_NOT_FOUND" {
		t.Fatalf("remove twice: %d %s", r.Status, r.Code)
	}
	rc.Do("DELETE", path+"/"+id.Encode(id.PrefixAttachment, uuid.New()), nil).Expect(t, 404, "remove unknown attachment")
	rc.Do("DELETE", path+"/att_bad", nil).Expect(t, 404, "remove malformed attachment id")
}

// TestREG_PATIENT_024_UploadSigningWhenStorageIsFullOrOff: Given a clinic whose storage
// cap is overridden to 0 GB, When the desk asks to upload, Then 403
// STORAGE_LIMIT_REACHED; a request without a filename is 400; Given storage within the
// cap but no provider configured (as in tests), Then the answer is a clear 503
// STORAGE_DISABLED, the way lab-referral uploads say it. Today the patient path returns
// the provider's raw error as a 500.
func TestREG_PATIENT_024_UploadSigningWhenStorageIsFullOrOff(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	p := opPatient(t, c)
	path := "/patients/" + p.ID + "/attachments/sign"
	rc.Do("POST", path, map[string]any{"type": "image"}).Expect(t, 400, "sign without filename")
	srv.As(t, c, "nurse").Do("POST", path, map[string]any{"filename": "a.png", "type": "image"}).Expect(t, 403, "nurse signs upload")
	opExec(t, `UPDATE tenants SET storage_gb_override = 0 WHERE id = $1`, c.TenantID)
	if r := rc.Do("POST", path, map[string]any{"filename": "a.png", "type": "image"}); r.Status != 403 || r.Code != "STORAGE_LIMIT_REACHED" {
		t.Fatalf("sign with storage full: %d %s", r.Status, r.Code)
	}
	opExec(t, `UPDATE tenants SET storage_gb_override = NULL WHERE id = $1`, c.TenantID)
	r := rc.Do("POST", path, map[string]any{"filename": "scan.pdf", "type": "pdf"})
	if r.Status == 200 {
		t.Fatalf("the no-op store signed an upload: %s", trimBody(r.Raw))
	}
	testkit.KnownBug(t, "NEW-PAT-5", r.Status != 503, fmt.Sprintf(
		"POST /patients/:id/attachments/sign with no storage provider answers %d %s; SignAttachmentUpload returns the "+
			"provider error unwrapped (patient/service/service.go SignAttachmentUpload) instead of 503 STORAGE_DISABLED", r.Status, r.Code))
}

// TestREG_PATIENT_025_AttachmentKeyMustBeThisClinicsFolder: Given clinic B's storage
// folder, When clinic A records an attachment whose storage key lives there, Then the
// API refuses it — a client-chosen key lets one clinic point (and later delete) another
// clinic's object (SEC-1).
func TestREG_PATIENT_025_AttachmentKeyMustBeThisClinicsFolder(t *testing.T) {
	p := opPatient(t, clinicA)
	key := fmt.Sprintf("%s/patients/%s/their-file.pdf", clinicB.TenantID, uuid.New())
	r := srv.As(t, clinicA, "receptionist").Do("POST", "/patients/"+p.ID+"/attachments", map[string]any{
		"type": "pdf", "storage_key": key, "filename": "theirs.pdf", "mime_type": "application/pdf", "size_bytes": 10,
	})
	// (SEC-1, fixed 2026-10-03.)
	r.Expect(t, 400, "an attachment key in another clinic's folder")
	// Nor another patient's folder in this clinic, nor a path that climbs out of
	// this patient's folder; the key the upload step hands out is accepted.
	pid := opUUID(t, id.PrefixPatient, p.ID)
	own := fmt.Sprintf("%s/patients/%s/", clinicA.TenantID, pid)
	desk := srv.As(t, clinicA, "receptionist")
	for _, bad := range []string{
		fmt.Sprintf("%s/patients/%s/x.pdf", clinicA.TenantID, uuid.New()),
		own + "../" + uuid.NewString() + "/x.pdf",
		own,
		"/" + own + "x.pdf",
	} {
		desk.Do("POST", "/patients/"+p.ID+"/attachments", map[string]any{
			"type": "pdf", "storage_key": bad, "filename": "x.pdf", "mime_type": "application/pdf", "size_bytes": 10,
		}).Expect(t, 400, "attachment key "+bad)
	}
	var stored int
	one(t, `SELECT count(*) FROM attachments WHERE patient_id = $1`, &stored, pid)
	if stored != 0 {
		t.Fatalf("a refused key was stored (%d rows)", stored)
	}
	desk.Do("POST", "/patients/"+p.ID+"/attachments", map[string]any{
		"type": "pdf", "storage_key": own + "referral.pdf", "filename": "referral.pdf", "mime_type": "application/pdf", "size_bytes": 10,
	}).Expect(t, 201, "a key in this patient's own folder")
}

// TestREG_PATIENT_026_BadValuesAreRefusedNot500: Given a patient, When the desk sends a
// condition status, an attachment type or a guardian record the database will reject,
// Then the API answers 4xx. Today each reaches a CHECK or foreign-key violation and
// comes back as 500 INTERNAL_ERROR.
func TestREG_PATIENT_026_BadValuesAreRefusedNot500(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := opPatient(t, clinicA)
	cond := rc.Do("POST", "/patients/"+p.ID+"/conditions", map[string]any{"description": "Asthma", "status": "chronic"})
	// A real upload key, so the bad type is what the database sees (not the SEC-1 key check).
	key := fmt.Sprintf("%s/patients/%s/a.exe", clinicA.TenantID, opUUID(t, id.PrefixPatient, p.ID))
	att := rc.Do("POST", "/patients/"+p.ID+"/attachments", map[string]any{"type": "exe", "storage_key": key, "filename": "a.exe", "mime_type": "application/x"})
	grd := rc.Do("POST", "/patients/"+p.ID+"/guardians", map[string]any{"guardian_patient_id": id.Encode(id.PrefixPatient, uuid.New()), "relationship": "father"})
	prof := opProfileOf(t, rc, p.ID)
	if len(prof.Conditions)+len(prof.Attachments)+len(prof.Guardians) != 0 {
		t.Fatalf("a refused write was stored: %+v", prof)
	}
	testkit.KnownBug(t, "NEW-PAT-6", cond.Status >= 500 || att.Status >= 500 || grd.Status >= 500, fmt.Sprintf(
		"invalid values come back as server errors: condition status 'chronic' %d, attachment type 'exe' %d, unknown guardian patient %d "+
			"(no validation before the INSERT; mapWriteErr turns CHECK/FK violations into 500)", cond.Status, att.Status, grd.Status))
}

// TestREG_PATIENT_027_ChildRecordsOnAnotherClinicsPatientAreRefused: Given clinic B's
// patient, When clinic A adds a condition, a guardian, an attachment, a certificate or a
// history import to it, Then nothing appears on B's record and the API should refuse
// (404). Today each is accepted and stored in A's clinic pointing at B's patient
// (TENANT-FK-1).
func TestREG_PATIENT_027_ChildRecordsOnAnotherClinicsPatientAreRefused(t *testing.T) {
	a := newClinic(t)
	pb := opPatient(t, clinicB)
	oa := srv.As(t, a, "owner")
	codes := []int{
		oa.Do("POST", "/patients/"+pb.ID+"/conditions", map[string]any{"description": "Stray"}).Status,
		oa.Do("POST", "/patients/"+pb.ID+"/guardians", map[string]any{"relationship": "stray"}).Status,
		// A key in the caller's own folder for that patient id, so it passes the SEC-1
		// key check and reaches the cross-clinic patient question this test is about.
		oa.Do("POST", "/patients/"+pb.ID+"/attachments", map[string]any{"type": "pdf",
			"storage_key": fmt.Sprintf("%s/patients/%s/stray.pdf", a.TenantID, opUUID(t, id.PrefixPatient, pb.ID)),
			"filename": "s.pdf", "mime_type": "application/pdf"}).Status,
		oa.Do("POST", "/patients/"+pb.ID+"/certificates", map[string]any{"kind": "attendance"}).Status,
		oa.Do("POST", "/history-import", map[string]any{"patient_id": pb.ID, "date": "2020-01-01", "subjective": "stray"}).Status,
	}
	pid := opUUID(t, id.PrefixPatient, pb.ID)
	prof := opProfileOf(t, srv.As(t, clinicB, "receptionist"), pb.ID)
	if len(prof.Conditions)+len(prof.Guardians)+len(prof.Attachments) != 0 {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B's patient shows records written by clinic A: %+v", prof)
	}
	var certs struct {
		Items []any `json:"items"`
	}
	srv.As(t, clinicB, "doctor").Do("GET", "/patients/"+pb.ID+"/certificates", nil).Expect(t, 200, "B lists certificates").Decode(t, &certs)
	if len(certs.Items) != 0 {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B's patient has a certificate issued by clinic A")
	}
	var stray int
	one(t, `SELECT (SELECT count(*) FROM conditions WHERE patient_id = $1 AND tenant_id = $2)
	             + (SELECT count(*) FROM guardian_links WHERE patient_id = $1 AND tenant_id = $2)
	             + (SELECT count(*) FROM attachments WHERE patient_id = $1 AND tenant_id = $2)
	             + (SELECT count(*) FROM medical_certificates WHERE patient_id = $1 AND tenant_id = $2)
	             + (SELECT count(*) FROM encounters WHERE patient_id = $1 AND tenant_id = $2)`, &stray, pid, a.TenantID)
	accepted := 0
	for _, s := range codes {
		if s < 400 {
			accepted++
		}
	}
	testkit.KnownBug(t, "TENANT-FK-1", accepted > 0 || stray > 0, fmt.Sprintf(
		"child writes against another clinic's patient: statuses %v; %d dangling row(s) left in the caller's clinic", codes, stray))
}

// ---- legacy register import ----------------------------------------------------------

// opRegister is a register with every kind of row a clinic's old sheet throws at the
// importer: good rows in Ethiopian dates, a repeat visit by the same phone, and five
// bad rows (no name, bad phone, bad gender, no age, a visit in the future).
func opRegister() []map[string]any {
	future := time.Now().AddDate(1, 0, 0).Format("2006-01-02")
	return []map[string]any{
		opRow(1, "ABEBE kebede TESSEMA", "+251 911 22 33 44", "M", "34", "01/01/2010"),
		opRow(2, "almaz bekele", "0922 33 44 55", "ሴ", "28 yrs", "2010-02-15"),
		opRow(3, "Abebe Kebede Tessema", "251911223344", "m", "34", "15/03/2010"), // same phone, next visit
		opRow(4, "", "0933000000", "F", "40", ""),
		opRow(5, "Bad Phone", "12ab", "F", "40", ""),
		opRow(6, "Bad Gender", "0944000000", "X", "40", ""),
		opRow(7, "No Age", "0955000000", "F", "", ""),
		opRow(8, "Future Visit", "0966000000", "F", "30", future),
		opRow(9, "Selam", "", "", "6 months", ""),
	}
}

// TestREG_PATIENT_028_ImportDryRunReportsAndWritesNothing: Given a messy register, When
// it is checked as a dry run, Then the report counts 3 importable rows, 1 duplicate
// (the repeat visit, caught within the file), 5 failures with a reason each, the
// missing phone/gender counts — and no patient is created.
func TestREG_PATIENT_028_ImportDryRunReportsAndWritesNothing(t *testing.T) {
	c := newClinic(t)
	before := opPatientCount(t, c)
	rep := opImport(t, srv.As(t, c, "receptionist"), map[string]any{"dry_run": true, "rows": opRegister()})
	if !rep.DryRun || rep.Total != 9 || rep.Imported != 3 || rep.Duplicates != 1 || rep.Failed != 5 || rep.MissingPhone != 1 || rep.MissingGender != 1 {
		t.Fatalf("dry-run report %+v", rep)
	}
	reasons := map[int]string{}
	for _, r := range rep.Rows {
		reasons[r.RowNumber] = r.Outcome + ": " + r.Reason
	}
	for n, want := range map[int]string{
		3: "duplicate: Same phone as row 1", 4: "failed: Missing patient name", 5: "failed: Invalid phone number format",
		6: "failed: Invalid gender value", 7: "failed: Missing age", 8: "failed: Date of Visit is in the future",
	} {
		if !strings.HasPrefix(reasons[n], want) {
			t.Errorf("row %d: %q, want prefix %q", n, reasons[n], want)
		}
	}
	if after := opPatientCount(t, c); after != before {
		t.Fatalf("dry run created %d patients", after-before)
	}
}

// TestREG_PATIENT_029_ImportCreatesCleanRecords: Given the same register, When it is
// imported for real, Then three patients exist with title-cased names split into
// given/middle/last, local-form phones, normalised genders (including Amharic), a birth
// year estimated from the age at the visit, the first visit converted from the
// Ethiopian calendar, sequential card numbers — and the repeat visit is matched to the
// first by phone instead of creating a fourth person.
func TestREG_PATIENT_029_ImportCreatesCleanRecords(t *testing.T) {
	c := newClinic(t)
	rep := opImport(t, srv.As(t, c, "receptionist"), map[string]any{"rows": opRegister()})
	if rep.DryRun || rep.Imported != 3 || rep.Duplicates != 1 || rep.Failed != 5 || rep.EstimatedDOB != 3 {
		t.Fatalf("import report %+v", rep)
	}
	if n := opPatientCount(t, c); n != 3 {
		t.Fatalf("patients after import: %d, want 3", n)
	}
	mrns := map[int]string{}
	for _, r := range rep.Rows {
		mrns[r.RowNumber] = r.MRN
	}
	if mrns[1] != "P000001" || mrns[2] != "P000002" || mrns[3] != "P000001" || mrns[9] != "P000003" {
		t.Fatalf("card numbers %v (row 3 must point at row 1's patient)", mrns)
	}
	abebe := opImportedByMRN(t, c, "P000001")
	// 01/01/2010 Ethiopian (Meskerem 1) is 11 September 2017; aged 34 then → born 1983.
	if abebe != (opImported{"Abebe", "Kebede", "Tessema", "male", "0911223344", "1983-01-01", "2017-09-11", true}) {
		t.Fatalf("row 1 stored as %+v", abebe)
	}
	almaz := opImportedByMRN(t, c, "P000002")
	if almaz.First != "Almaz" || almaz.Last != "Bekele" || almaz.Gender != "female" || almaz.Phone != "0922334455" || almaz.DOB != "1989-01-01" {
		t.Fatalf("row 2 stored as %+v", almaz)
	}
	selam := opImportedByMRN(t, c, "P000003")
	if selam.First != "Selam" || selam.Last != "" || selam.Gender != "unknown" || selam.Phone != "" || selam.DOB != fmt.Sprintf("%d-01-01", time.Now().UTC().Year()) {
		t.Fatalf("row 9 (mononym, infant, no phone) stored as %+v", selam)
	}
	var events int
	one(t, `SELECT count(*) FROM event_outbox WHERE tenant_id = $1 AND event_type = 'patient.patient.registered'`, &events, c.TenantID)
	if events != 3 {
		t.Fatalf("registration events %d, want one per imported patient", events)
	}
}

// TestREG_PATIENT_030_ImportDatesInEveryShape: Given a Gregorian register, When rows use
// an Excel serial, an ISO date, day-first with dots and a two-digit year, Then each is
// stored as that day; an impossible date (31/02) and a stray number fail the row with a
// date reason. Given an Ethiopian register, a 13th-month date converts too.
func TestREG_PATIENT_030_ImportDatesInEveryShape(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	rep := opImport(t, rc, map[string]any{"calendar": "gregorian", "rows": []map[string]any{
		opRow(1, "Excel Serial", "0910000001", "F", "30", "42922"),
		opRow(2, "Iso Date", "0910000002", "F", "30", "2017-06-13"),
		opRow(3, "Dotted Short", "0910000003", "F", "30", "13.6.17"),
		opRow(4, "Month First", "0910000004", "F", "30", "06/13/2017"),
		opRow(5, "Impossible Day", "0910000005", "F", "30", "31/02/2017"),
		opRow(6, "Stray Number", "0910000006", "F", "30", "123"),
		opRow(7, "Two Parts", "0910000007", "F", "30", "12/2017"),
	}})
	if rep.Imported != 4 || rep.Failed != 3 {
		t.Fatalf("gregorian report %+v", rep)
	}
	want := map[int]string{1: "2017-07-06", 2: "2017-06-13", 3: "2017-06-13", 4: "2017-06-13"}
	for _, r := range rep.Rows {
		if w, ok := want[r.RowNumber]; ok {
			if got := opImportedByMRN(t, c, r.MRN).FirstVisit; got != w {
				t.Errorf("row %d visit stored %q, want %q", r.RowNumber, got, w)
			}
		} else if r.Outcome != "failed" || !strings.Contains(r.Reason, "date") {
			t.Errorf("row %d: %s %q, want a date failure", r.RowNumber, r.Outcome, r.Reason)
		}
	}
	eth := opImport(t, rc, map[string]any{"rows": []map[string]any{
		opRow(1, "Pagume Born", "0910000008", "M", "20", "05/13/2015"),
		opRow(2, "Bad Ethiopian", "0910000009", "M", "20", "31/13/2015"),
	}})
	if eth.Imported != 1 || eth.Failed != 1 {
		t.Fatalf("ethiopian report %+v", eth)
	}
	// Pagume 5, 2015 EC is 10 September 2023 (2016 EC began on the 12th).
	if got := opImportedByMRN(t, c, eth.Rows[0].MRN).FirstVisit; got != "2023-09-10" {
		t.Fatalf("Pagume 5 2015 stored as %q", got)
	}
}

// TestREG_PATIENT_031_ImportMatchesExistingPatients: Given registered patients, When an
// import repeats one by phone, one by name and age, and one with a small typo and the
// same age, Then by default each is reported as a duplicate of the right card number
// and nothing changes; With on_duplicate=update, Then the matched records are updated
// (dry run first says "would update" and changes nothing).
func TestREG_PATIENT_031_ImportMatchesExistingPatients(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	byPhone := patCreate(t, rc, map[string]any{"first_name": "Tigist", "last_name": "Haile", "dob": "1990-01-01", "phone": "0912121212", "gender": "female", "force": true})
	byName := patCreate(t, rc, map[string]any{"first_name": "Dawit", "last_name": "Girma", "dob": "1980-01-01", "gender": "male", "force": true})
	byFuzzy := patCreate(t, rc, map[string]any{"first_name": "Mekdes", "last_name": "Alemayehu", "dob": "1975-01-01", "gender": "female", "force": true})
	year := time.Now().UTC().Year()
	rows := []map[string]any{
		opRow(1, "Tigist Haile", "+251912121212", "F", fmt.Sprint(year-1990), ""),
		opRow(2, "DAWIT GIRMA", "", "M", fmt.Sprint(year-1981), ""),
		opRow(3, "Mekdes Alemayehuu", "", "F", fmt.Sprint(year-1976), ""),
	}
	rep := opImport(t, rc, map[string]any{"rows": rows})
	if rep.Duplicates != 3 || rep.Imported != 0 {
		t.Fatalf("skip report %+v", rep)
	}
	for _, r := range rep.Rows {
		want := map[int]string{1: byPhone.MRN, 2: byName.MRN, 3: byFuzzy.MRN}[r.RowNumber]
		if r.MRN != want || !strings.HasPrefix(r.Reason, "Already on file") {
			t.Errorf("row %d matched %s (%q), want %s", r.RowNumber, r.MRN, r.Reason, want)
		}
	}
	dry := opImport(t, rc, map[string]any{"dry_run": true, "on_duplicate": "update", "rows": rows[:1]})
	if dry.Updated != 1 || !strings.HasPrefix(dry.Rows[0].Reason, "Would update") {
		t.Fatalf("dry-run update report %+v", dry)
	}
	rows[1]["phone"] = "0919191919"
	rows[1]["gender"] = ""
	up := opImport(t, rc, map[string]any{"on_duplicate": "update", "rows": rows[1:2]})
	if up.Updated != 1 || !strings.HasPrefix(up.Rows[0].Reason, "Updated") {
		t.Fatalf("update report %+v", up)
	}
	d := opImportedByMRN(t, c, byName.MRN)
	if d.First != "Dawit" || d.Last != "Girma" || d.Gender != "male" || d.Phone != "0919191919" {
		t.Fatalf("matched record after update %+v (phone filled in, gender kept when the sheet has none)", d)
	}
	if n := opPatientCount(t, c); n != 3 {
		t.Fatalf("patients after matching imports: %d, want 3", n)
	}
}

// TestREG_PATIENT_032_ImportRequestLimitsAndPermissions: Given the desk, When an import
// has no rows, more than 2,000 rows or a malformed body, Then 400; a cashier cannot
// import; Given a clinic at its patient cap, Then every new row fails with the plan's
// message and nothing is written.
func TestREG_PATIENT_032_ImportRequestLimitsAndPermissions(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	rc.Do("POST", "/patients/import", map[string]any{"rows": []any{}}).Expect(t, 400, "no rows")
	rc.Do("POST", "/patients/import", map[string]any{"rows": "a,b"}).Expect(t, 400, "malformed rows")
	big := make([]map[string]any, 2001)
	for i := range big {
		big[i] = opRow(i+1, "X", "", "", "1", "")
	}
	rc.Do("POST", "/patients/import", map[string]any{"rows": big}).Expect(t, 400, "too many rows")
	srv.As(t, c, "cashier").Do("POST", "/patients/import", map[string]any{"rows": []any{opRow(1, "A B", "", "", "3", "")}}).Expect(t, 403, "cashier imports")

	opExec(t, `UPDATE tenants SET patient_limit_override = 0 WHERE id = $1`, c.TenantID)
	rep := opImport(t, rc, map[string]any{"rows": []map[string]any{opRow(1, "Capped Patient", "", "F", "20", "")}})
	if rep.Failed != 1 || !strings.Contains(rep.Rows[0].Reason, "patient limit") {
		t.Fatalf("import at the cap %+v", rep)
	}
	if n := opPatientCount(t, c); n != 0 {
		t.Fatalf("patients created at the cap: %d", n)
	}
}

// TestREG_PATIENT_033_ImportedCardIDThatIsTakenFailsOnlyThatRow: Given a patient with
// card ID LEG-77, When an import reuses it, Then that row fails with the card ID named
// and the rest of the batch imports.
func TestREG_PATIENT_033_ImportedCardIDThatIsTakenFailsOnlyThatRow(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	patCreate(t, rc, map[string]any{"mrn": "LEG-77", "first_name": "Original", "phone": patPhone(), "force": true})
	r1 := opRow(1, "Somebody Else", "0918000001", "F", "40", "")
	r1["mrn"] = "LEG-77"
	r2 := opRow(2, "Fine Row", "0918000002", "M", "41", "")
	r2["mrn"] = "LEG-78"
	rep := opImport(t, rc, map[string]any{"rows": []map[string]any{r1, r2}})
	if rep.Failed != 1 || rep.Imported != 1 || !strings.Contains(rep.Rows[0].Reason, "LEG-77") || rep.Rows[1].MRN != "LEG-78" {
		t.Fatalf("report %+v", rep)
	}
}

// TestREG_PATIENT_034_DryRunSeesCardIDCollisions: Given a patient with card ID LEG-90,
// When a dry run includes a row reusing it, Then the dry run reports that row as failing
// — the point of a dry run is to see exactly what the real run will do. Today it is
// reported "imported" and only the real run fails (PAT-9).
func TestREG_PATIENT_034_DryRunSeesCardIDCollisions(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	patCreate(t, rc, map[string]any{"mrn": "LEG-90", "first_name": "Holder", "phone": patPhone(), "force": true})
	row := opRow(1, "Different Person", "0917000009", "F", "33", "")
	row["mrn"] = "LEG-90"
	dry := opImport(t, rc, map[string]any{"dry_run": true, "rows": []map[string]any{row}})
	real := opImport(t, rc, map[string]any{"rows": []map[string]any{row}})
	if real.Failed != 1 {
		t.Fatalf("real run with a taken card ID: %+v", real)
	}
	testkit.KnownBug(t, "PAT-9", dry.Rows[0].Outcome != "failed",
		"a dry run reports a row with a taken card ID as "+dry.Rows[0].Outcome+"; the real run then fails it")
}

// TestREG_PATIENT_035_ImportedCardIDDoesNotBlockRegistration: Given a new clinic, When
// an old register is imported with card ID P000001 (the shape of the clinic's own auto
// numbers), Then the desk can still register a new patient. Today the auto sequence
// hands out P000001 again and registration fails with MRN_TAKEN (PAT-3).
func TestREG_PATIENT_035_ImportedCardIDDoesNotBlockRegistration(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	row := opRow(1, "Legacy Holder", "0916000001", "F", "50", "")
	row["mrn"] = "P000001"
	if rep := opImport(t, rc, map[string]any{"rows": []map[string]any{row}}); rep.Imported != 1 {
		t.Fatalf("import %+v", rep)
	}
	r := rc.Do("POST", "/patients", map[string]any{"first_name": "Brand", "last_name": "New", "phone": patPhone(), "force": true})
	if r.Status >= 500 {
		t.Fatalf("registration after import: %d %s", r.Status, trimBody(r.Raw))
	}
	testkit.KnownBug(t, "PAT-3", r.Status != 201, fmt.Sprintf(
		"registering after importing card ID P000001 answers %d %s: the auto sequence collides with the imported number", r.Status, r.Code))
}

// TestREG_PATIENT_036_FamilySharingAPhoneIsNotOnePerson: Given Abebe registered with the
// family's phone, When the register lists his wife Almaz (different name, different
// age) on the same phone, Then she is imported as a new patient. Today phone alone is a
// match, so she is dropped as a "duplicate" of Abebe (PAT-2).
func TestREG_PATIENT_036_FamilySharingAPhoneIsNotOnePerson(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	patCreate(t, rc, map[string]any{"first_name": "Abebe", "last_name": "Kebede", "dob": "1970-01-01", "phone": "0915151515", "gender": "male", "force": true})
	rep := opImport(t, rc, map[string]any{"rows": []map[string]any{opRow(1, "Almaz Tadesse", "0915151515", "F", "25", "")}})
	testkit.KnownBug(t, "PAT-2", rep.Imported != 1, fmt.Sprintf(
		"a different person on a shared family phone is reported %s (%s) instead of imported", rep.Rows[0].Outcome, rep.Rows[0].Reason))
}

// ---- history import -------------------------------------------------------------------

// TestREG_PATIENT_037_HistoryImportStoresABackDatedSignedVisit: Given a patient brought
// over from paper, When the desk imports their old history dated 2019-03-01, Then a
// closed encounter exists on that date with the note signed and the sections stored;
// with no section, a bad date, or a malformed patient it is 400; the doctor may import
// too; a cashier may not.
func TestREG_PATIENT_037_HistoryImportStoresABackDatedSignedVisit(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := opPatient(t, clinicA)
	srv.As(t, clinicA, "cashier").Do("POST", "/history-import", map[string]any{"patient_id": p.ID, "subjective": "x"}).Expect(t, 403, "cashier imports history")
	rc.Do("POST", "/history-import", map[string]any{"patient_id": p.ID, "subjective": "  "}).Expect(t, 400, "no section")
	rc.Do("POST", "/history-import", map[string]any{"patient_id": p.ID, "date": "01/03/2019", "subjective": "x"}).Expect(t, 400, "bad date")
	rc.Do("POST", "/history-import", map[string]any{"patient_id": "pat_bad", "subjective": "x"}).Expect(t, 400, "malformed patient")
	rc.Do("POST", "/history-import", "nope").Expect(t, 400, "malformed body")

	var out struct {
		EncounterID string `json:"encounter_id"`
	}
	rc.Do("POST", "/history-import", map[string]any{
		"patient_id": p.ID, "date": "2019-03-01", "subjective": "Toothache for years", "assessment": "Old caries", "plan": "Extraction done 2019",
	}).Expect(t, 201, "import history").Decode(t, &out)
	eid := opUUID(t, id.PrefixEncounter, out.EncounterID)
	var status, started, noteStatus, subj, plan string
	var branch uuid.UUID
	one(t, `SELECT status FROM encounters WHERE id = $1`, &status, eid)
	one(t, `SELECT to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD') FROM encounters WHERE id = $1`, &started, eid)
	one(t, `SELECT branch_id FROM encounters WHERE id = $1`, &branch, eid)
	one(t, `SELECT status FROM clinical_notes WHERE encounter_id = $1`, &noteStatus, eid)
	one(t, `SELECT coalesce(subjective,'') FROM clinical_notes WHERE encounter_id = $1`, &subj, eid)
	one(t, `SELECT coalesce(plan,'') FROM clinical_notes WHERE encounter_id = $1`, &plan, eid)
	if status != "closed" || started != "2019-03-01" || branch != clinicA.BranchID || noteStatus != "signed" || subj != "Toothache for years" || plan != "Extraction done 2019" {
		t.Fatalf("imported visit status=%s started=%s branch=%v note=%s subj=%q plan=%q", status, started, branch, noteStatus, subj, plan)
	}
	srv.As(t, clinicA, "doctor").Do("POST", "/history-import", map[string]any{"patient_id": p.ID, "objective": "BP 120/80"}).Expect(t, 201, "doctor imports history")
}

// TestREG_PATIENT_038_HistoryImportRefusesFutureDates: Given a patient, When old history
// is imported with a date next year, Then 400 — a migrated record cannot be from the
// future. Today it is stored (PAT-8).
func TestREG_PATIENT_038_HistoryImportRefusesFutureDates(t *testing.T) {
	p := opPatient(t, clinicA)
	r := srv.As(t, clinicA, "receptionist").Do("POST", "/history-import", map[string]any{
		"patient_id": p.ID, "date": time.Now().AddDate(1, 0, 0).Format("2006-01-02"), "subjective": "from the future",
	})
	testkit.KnownBug(t, "PAT-8", r.Status == 201, "history import dated next year is accepted (HTTP 201) and stored as a signed visit")
}

// ---- medical certificates ---------------------------------------------------------------

type opCert struct {
	ID            string `json:"id"`
	Ref           string `json:"ref"`
	Kind          string `json:"kind"`
	PatientName   string `json:"patient_name"`
	MRN           string `json:"mrn"`
	Diagnosis     string `json:"diagnosis"`
	ShowDiagnosis bool   `json:"show_diagnosis"`
	RestDays      int    `json:"rest_days"`
	RestFrom      string `json:"rest_from"`
	RestTo        string `json:"rest_to"`
	IssuedBy      string `json:"issued_by"`
	Branch        string `json:"branch"`
	Status        string `json:"status"`
	VoidReason    string `json:"void_reason"`
}

// TestREG_PATIENT_039_CertificateIssueValidateList: Given a patient seen by the dentist,
// When a three-day sick-leave certificate from 5 October is issued, Then it runs to 7
// October inclusive, carries a numbered reference, the dentist's name and the branch;
// an unknown kind, no rest days, more than a year, a bad start date and "show the
// diagnosis" without one are 400; an attendance note ignores rest days; the desk can
// list (reprint) but not issue; references are sequential.
func TestREG_PATIENT_039_CertificateIssueValidateList(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := opPatient(t, c)
	path := "/patients/" + p.ID + "/certificates"
	srv.As(t, c, "receptionist").Do("POST", path, map[string]any{"kind": "attendance"}).Expect(t, 403, "desk issues certificate")
	for name, body := range map[string]map[string]any{
		"unknown kind":           {"kind": "excuse"},
		"no rest days":           {"kind": "sick_leave", "rest_from": "2026-10-05"},
		"over a year":            {"kind": "sick_leave", "rest_days": 366, "rest_from": "2026-10-05"},
		"bad start":              {"kind": "sick_leave", "rest_days": 2, "rest_from": "05/10/2026"},
		"diagnosis shown, empty": {"kind": "fitness", "show_diagnosis": true, "diagnosis": "  "},
	} {
		if r := doc.Do("POST", path, body); r.Status != 400 {
			t.Errorf("%s: want 400, got %d %s", name, r.Status, r.Code)
		}
	}
	doc.Do("POST", path, map[string]any{"kind": "sick_leave", "rest_days": "three"}).Expect(t, 400, "malformed body")
	doc.Do("POST", "/patients/pat_bad/certificates", map[string]any{"kind": "attendance"}).Expect(t, 400, "malformed patient")

	var sick, att opCert
	doc.Do("POST", path, map[string]any{
		"kind": "sick_leave", "rest_days": 3, "rest_from": "2026-10-05", "diagnosis": "Dry socket", "show_diagnosis": true, "notes": " soft diet ",
	}).Expect(t, 201, "issue sick leave").Decode(t, &sick)
	year := time.Now().Year()
	if sick.Ref != fmt.Sprintf("MC-%d-0001", year) || sick.RestTo != "2026-10-07" || sick.RestDays != 3 || sick.Status != "active" ||
		sick.MRN != p.MRN || !strings.HasPrefix(sick.IssuedBy, "Doctor") || sick.Branch != "Main Branch" || sick.Diagnosis != "Dry socket" {
		t.Fatalf("sick-leave certificate %+v", sick)
	}
	doc.Do("POST", path, map[string]any{"kind": "attendance", "rest_days": 9}).Expect(t, 201, "issue attendance").Decode(t, &att)
	if att.Ref != fmt.Sprintf("MC-%d-0002", year) || att.RestDays != 0 || att.RestFrom != "" {
		t.Fatalf("attendance certificate %+v", att)
	}
	var notes string
	one(t, `SELECT coalesce(notes,'') FROM medical_certificates WHERE id = $1`, &notes, opUUID(t, id.PrefixCertificate, sick.ID))
	if notes != "soft diet" {
		t.Fatalf("stored notes %q, want trimmed", notes)
	}
	var list struct {
		Items []opCert `json:"items"`
	}
	srv.As(t, c, "receptionist").Do("GET", path, nil).Expect(t, 200, "desk lists certificates").Decode(t, &list)
	if len(list.Items) != 2 {
		t.Fatalf("certificates listed %+v", list.Items)
	}
	srv.As(t, c, "nurse").Do("GET", path, nil).Expect(t, 200, "nurse (patient.read) lists certificates")
	srv.As(t, c, "doctor").Do("GET", "/patients/pat_bad/certificates", nil).Expect(t, 400, "list malformed patient")
}

// TestREG_PATIENT_040_CertificateVoidKeepsTheNumber: Given an issued certificate, When
// it is voided without a reason, Then 400; with a reason, Then it is kept, marked void
// with who and why, and an event is published; voiding it again is 409 NOT_ACTIVE;
// another clinic cannot void it; the desk cannot void.
func TestREG_PATIENT_040_CertificateVoidKeepsTheNumber(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := opPatient(t, c)
	var cert opCert
	doc.Do("POST", "/patients/"+p.ID+"/certificates", map[string]any{"kind": "fitness"}).Expect(t, 201, "issue").Decode(t, &cert)
	path := "/certificates/" + cert.ID + "/void"
	srv.As(t, c, "receptionist").Do("POST", path, map[string]any{"reason": "x"}).Expect(t, 403, "desk voids")
	doc.Do("POST", path, map[string]any{"reason": " "}).Expect(t, 400, "void without reason")
	doc.Do("POST", path, "x").Expect(t, 400, "malformed body")
	doc.Do("POST", "/certificates/mcf_bad/void", map[string]any{"reason": "x"}).Expect(t, 400, "malformed certificate id")
	srv.As(t, clinicB, "doctor").Do("POST", path, map[string]any{"reason": "not ours"})
	cid := opUUID(t, id.PrefixCertificate, cert.ID)
	var status string
	one(t, `SELECT status FROM medical_certificates WHERE id = $1`, &status, cid)
	if status != "active" {
		t.Fatalf("CROSS-CLINIC WRITE: another clinic voided the certificate")
	}
	doc.Do("POST", path, map[string]any{"reason": "wrong patient"}).Expect(t, 204, "void")
	var reason string
	var by uuid.UUID
	one(t, `SELECT status FROM medical_certificates WHERE id = $1`, &status, cid)
	one(t, `SELECT coalesce(void_reason,'') FROM medical_certificates WHERE id = $1`, &reason, cid)
	one(t, `SELECT voided_by FROM medical_certificates WHERE id = $1`, &by, cid)
	if status != "void" || reason != "wrong patient" || by != c.Staff["doctor"].ID {
		t.Fatalf("voided certificate status=%s reason=%q by=%v", status, reason, by)
	}
	var ev int
	one(t, `SELECT count(*) FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'clinical.certificate.voided'`, &ev, cid)
	if ev != 1 {
		t.Fatalf("void events %d", ev)
	}
	if r := doc.Do("POST", path, map[string]any{"reason": "again"}); r.Status != 409 || r.Code != "NOT_ACTIVE" {
		t.Fatalf("void twice: %d %s", r.Status, r.Code)
	}
	var list struct {
		Items []opCert `json:"items"`
	}
	doc.Do("GET", "/patients/"+p.ID+"/certificates", nil).Expect(t, 200, "list").Decode(t, &list)
	if len(list.Items) != 1 || list.Items[0].Status != "void" || list.Items[0].VoidReason != "wrong patient" {
		t.Fatalf("voided certificate must stay listed as void: %+v", list.Items)
	}
}

// TestREG_PATIENT_041_CertificateForNoSuchPatientOrNoSuchCertificateIs404: Given ids
// that do not exist, When a certificate is issued for the patient or the certificate is
// voided, Then 404. Today issuing hits the foreign key and answers 500, and voiding
// answers 409 "already void" for a certificate that never existed.
func TestREG_PATIENT_041_CertificateForNoSuchPatientOrNoSuchCertificateIs404(t *testing.T) {
	doc := srv.As(t, clinicA, "doctor")
	issue := doc.Do("POST", "/patients/"+id.Encode(id.PrefixPatient, uuid.New())+"/certificates", map[string]any{"kind": "attendance"})
	void := doc.Do("POST", "/certificates/"+id.Encode(id.PrefixCertificate, uuid.New())+"/void", map[string]any{"reason": "x"})
	if issue.Status < 400 {
		t.Fatalf("certificate for a patient that does not exist was issued: %d", issue.Status)
	}
	testkit.KnownBug(t, "NEW-CERT-1", issue.Status != 404 || void.Status != 404, fmt.Sprintf(
		"unknown ids: issue for no such patient %d %s, void no such certificate %d %s (want 404 both)", issue.Status, issue.Code, void.Status, void.Code))
}

// ---- clinical read-outs the dental clinic reaches ---------------------------------------

// TestREG_PATIENT_042_StoryAndModuleGates: Given a dental clinic's patient with an
// imported history, When the dentist reads the patient's story, Then 200 and the desk
// (no encounter.manage) is refused; the maternity dating record is behind its module,
// which a dental clinic does not run (403 MODULE_DISABLED).
func TestREG_PATIENT_042_StoryAndModuleGates(t *testing.T) {
	p := opPatient(t, clinicA)
	srv.As(t, clinicA, "receptionist").Do("POST", "/history-import", map[string]any{"patient_id": p.ID, "date": "2018-05-05", "assessment": "Gum disease"}).
		Expect(t, 201, "import history")
	r := srv.As(t, clinicA, "doctor").Do("GET", "/patients/"+p.ID+"/story", nil).Expect(t, 200, "story")
	var story struct {
		Problems  []any `json:"problems"`
		Medicines []any `json:"medicines"`
		Trend     []any `json:"trend"`
	}
	r.Decode(t, &story)
	if story.Problems == nil || story.Medicines == nil || story.Trend == nil {
		t.Fatalf("story shape: %s", trimBody(r.Raw))
	}
	srv.As(t, clinicA, "doctor").Do("GET", "/patients/pat_bad/story", nil).Expect(t, 400, "story of a malformed id")
	srv.As(t, clinicA, "receptionist").Do("GET", "/patients/"+p.ID+"/story", nil).Expect(t, 403, "desk reads story")
	for _, call := range []struct{ m, p string }{
		{"GET", "/patients/" + p.ID + "/dating"}, {"GET", "/patients/" + p.ID + "/dating/history"}, {"POST", "/patients/" + p.ID + "/dating"},
	} {
		if x := srv.As(t, clinicA, "doctor").Do(call.m, call.p, map[string]any{}); x.Status != 403 || x.Code != "MODULE_DISABLED" {
			t.Errorf("%s %s in a dental clinic: %d %s, want 403 MODULE_DISABLED", call.m, call.p, x.Status, x.Code)
		}
	}
}

// TestREG_PATIENT_043_OverviewSaysWhatIsTrueNow: Given a patient waiting in the queue
// today, booked for tomorrow, with an old visit on file and a bill outstanding, When the
// desk opens their overview, Then it shows they are here (queue, department), the next
// booking, the last visit's date without who saw them, and what they owe; the cashier
// sees the money but not the schedule; the dentist sees who saw them; another clinic
// sees nothing about them.
func TestREG_PATIENT_043_OverviewSaysWhatIsTrueNow(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	e.desk.Do("POST", "/queue/walk-in", map[string]any{"branch_id": e.branch, "department_id": e.dept, "patient_id": p.ID}).Expect(t, 201, "walk-in")
	e.book(t, p.ID, apptTomorrowAt(10, 0), 30)
	e.desk.Do("POST", "/history-import", map[string]any{"patient_id": p.ID, "date": "2021-02-02", "assessment": "Old filling"}).Expect(t, 201, "history")
	payRaise(t, e.desk, e.c, p.ID, 250)

	type overview struct {
		HereNow *struct {
			Kind  string `json:"kind"`
			State string `json:"state"`
			Where string `json:"where"`
		} `json:"here_now"`
		Money *struct {
			Owed string `json:"owed"`
		} `json:"money"`
		Next *struct {
			Provider   string `json:"provider"`
			Department string `json:"department"`
		} `json:"next_appointment"`
		LastVisit *struct {
			At       time.Time `json:"at"`
			Provider string    `json:"provider"`
			Open     bool      `json:"open"`
		} `json:"last_visit"`
	}
	read := func(c *testkit.Client, pid string) overview {
		var o overview
		c.Do("GET", "/patients/"+pid+"/overview", nil).Expect(t, 200, "overview").Decode(t, &o)
		return o
	}
	desk := read(e.desk, p.ID)
	if desk.HereNow == nil || desk.HereNow.Kind != "queue" || desk.HereNow.State != "waiting" || desk.HereNow.Where != "General Practice" {
		t.Fatalf("desk here_now %+v", desk.HereNow)
	}
	if desk.Next == nil || !strings.HasPrefix(desk.Next.Provider, "Doctor") || desk.LastVisit == nil || desk.LastVisit.Open ||
		desk.LastVisit.At.UTC().Format("2006-01-02") != "2021-02-02" || desk.LastVisit.Provider != "" {
		t.Fatalf("desk next=%+v last=%+v", desk.Next, desk.LastVisit)
	}
	if desk.Money == nil || payNum(t, desk.Money.Owed) != 250 {
		t.Fatalf("desk money %+v", desk.Money)
	}
	cash := read(srv.As(t, e.c, "cashier"), p.ID)
	if cash.Money == nil || cash.Next != nil || cash.LastVisit != nil {
		t.Fatalf("cashier overview money=%+v next=%+v last=%+v", cash.Money, cash.Next, cash.LastVisit)
	}
	if doc := read(e.doc, p.ID); doc.LastVisit == nil || doc.Money != nil {
		t.Fatalf("dentist overview last=%+v money=%+v", doc.LastVisit, doc.Money)
	}
	if other := read(srv.As(t, clinicB, "owner"), p.ID); other.HereNow != nil || other.Next != nil || other.LastVisit != nil ||
		(other.Money != nil && payNum(t, other.Money.Owed) != 0) {
		t.Fatalf("CROSS-CLINIC READ: clinic B's overview of A's patient %+v", other)
	}
	e.desk.Do("GET", "/patients/pat_bad/overview", nil).Expect(t, 404, "overview malformed id")
}

// TestREG_PATIENT_044_ImportPhoneShapes: Given a register with phones written every way
// a clinic writes them, When it is imported, Then a number missing its trunk 0 gains it,
// a foreign number keeps its + country code, a short local landline is kept as digits,
// and a number too long to dial fails its row.
func TestREG_PATIENT_044_ImportPhoneShapes(t *testing.T) {
	c := newClinic(t)
	rep := opImport(t, srv.As(t, c, "receptionist"), map[string]any{"calendar": "gregorian", "rows": []map[string]any{
		opRow(1, "Trunkless Mobile", "911 445566", "M", "30", ""),
		opRow(2, "Foreign Caller", "+44 20 7946 0958", "F", "31", ""),
		opRow(3, "Landline Only", "1112233", "M", "32", ""),
		opRow(4, "Far Too Long", "1234567890123456", "F", "33", ""),
		opRow(5, "Double Zero", "0044 7700 900123", "F", "34", ""),
	}})
	if rep.Imported != 4 || rep.Failed != 1 || rep.Rows[3].Outcome != "failed" {
		t.Fatalf("report %+v", rep)
	}
	want := map[int]string{1: "0911445566", 2: "+442079460958", 3: "1112233", 5: "+447700900123"}
	for _, r := range rep.Rows {
		if w, ok := want[r.RowNumber]; ok {
			if got := opImportedByMRN(t, c, r.MRN).Phone; got != w {
				t.Errorf("row %d phone %q, want %q", r.RowNumber, got, w)
			}
		}
	}
}

// TestREG_PATIENT_045_HistoryImportFromTheAllBranchesView: Given the owner working in
// the consolidated all-branches view (no active branch), When they import old history,
// Then it is filed under the clinic's default branch.
func TestREG_PATIENT_045_HistoryImportFromTheAllBranchesView(t *testing.T) {
	c := newClinic(t)
	p := opPatient(t, c)
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	srv.As(t, c, "owner").Do("POST", "/auth/switch-branch", map[string]any{"branch_id": "all"}).Expect(t, 200, "all branches").Decode(t, &tok)
	var out struct {
		EncounterID string `json:"encounter_id"`
	}
	authBearer(t, tok.AccessToken).Do("POST", "/history-import", map[string]any{"patient_id": p.ID, "plan": "Crown 2016"}).
		Expect(t, 201, "import from all branches").Decode(t, &out)
	var branch uuid.UUID
	one(t, `SELECT branch_id FROM encounters WHERE id = $1`, &branch, opUUID(t, id.PrefixEncounter, out.EncounterID))
	if branch != c.BranchID {
		t.Fatalf("history filed under %v, want the main branch", branch)
	}
}
