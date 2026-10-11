package regression

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Patients: registration, the card number (MRN), duplicate detection, search,
// edits, soft delete and allergies. Every write is checked twice: what the API
// answers, and what the database actually holds afterwards.

// ---- helpers (prefixed pat) ---------------------------------------------

// patPhone is a phone number no other test (or run) will have.
func patPhone() string { return fmt.Sprintf("09%08d", rand.IntN(100000000)) }

type patFull struct {
	ID         string          `json:"id"`
	MRN        string          `json:"mrn"`
	FirstName  string          `json:"first_name"`
	MiddleName string          `json:"middle_name"`
	LastName   string          `json:"last_name"`
	Gender     string          `json:"gender"`
	DOB        string          `json:"dob"`
	NationalID string          `json:"national_id"`
	PassportNo string          `json:"passport_no"`
	Phone      string          `json:"phone"`
	Email      string          `json:"email"`
	BloodGroup string          `json:"blood_group"`
	Address    json.RawMessage `json:"address"`
	Allergies  []struct {
		ID        string `json:"id"`
		Substance string `json:"substance"`
		Reaction  string `json:"reaction"`
		Severity  string `json:"severity"`
	} `json:"allergies"`
}

// patCreate posts a patient body and returns the decoded record (expects 201).
func patCreate(t *testing.T, c *testkit.Client, body map[string]any) patFull {
	t.Helper()
	r := c.Do("POST", "/patients", body).Expect(t, 201, "create patient")
	var p patFull
	r.Decode(t, &p)
	if p.ID == "" {
		t.Fatalf("create returned no id: %s", r.Raw)
	}
	return p
}

func patGet(t *testing.T, c *testkit.Client, pid string) patFull {
	t.Helper()
	r := c.Do("GET", "/patients/"+pid, nil).Expect(t, 200, "get patient")
	var p patFull
	r.Decode(t, &p)
	return p
}

// patUUID is the database id behind an external pat_… id.
func patUUID(t *testing.T, ext string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(id.PrefixPatient, ext)
	if err != nil {
		t.Fatalf("decode %q: %v", ext, err)
	}
	return u
}

// patSearchIDs returns the ids a search answers with.
func patSearchIDs(t *testing.T, c *testkit.Client, q string) []string {
	t.Helper()
	r := c.Do("GET", "/patients?page_size=100&q="+url.QueryEscape(q), nil).Expect(t, 200, "search "+q)
	var items []struct {
		ID string `json:"id"`
	}
	r.Decode(t, &items)
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.ID)
	}
	return out
}

func patContains(ids []string, want string) bool {
	for _, s := range ids {
		if s == want {
			return true
		}
	}
	return false
}

// patDuplicates decodes the 409 PATIENT_DUPLICATE body, whose candidates sit
// beside the error envelope rather than in "data".
func patDuplicates(t *testing.T, r testkit.Resp) []struct {
	ID       string `json:"id"`
	MRN      string `json:"mrn"`
	FullName string `json:"full_name"`
} {
	t.Helper()
	var body struct {
		Duplicates []struct {
			ID       string `json:"id"`
			MRN      string `json:"mrn"`
			FullName string `json:"full_name"`
		} `json:"duplicates"`
	}
	if err := json.Unmarshal([]byte(r.Raw), &body); err != nil {
		t.Fatalf("decode duplicates: %v\n%s", err, r.Raw)
	}
	return body.Duplicates
}

// ---- tests --------------------------------------------------------------

// TestREG_PATIENT_001_CreateThenGetReturnsSameFields: Given a receptionist registers
// a patient with full demographics, When the record is read back, Then every field
// is what was sent, an MRN was assigned, and the row exists in the clinic.
func TestREG_PATIENT_001_CreateThenGetReturnsSameFields(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	phone := patPhone()
	first := uniq("Abebe")
	body := map[string]any{
		"first_name": first, "middle_name": "Kebede", "last_name": "Tesfaye", "gender": "male",
		"dob": "1985-03-02", "phone": phone, "email": strings.ToLower(first) + "@example.test",
		"national_id": "NID" + phone, "passport_no": "EP" + phone[2:], "blood_group": "O+",
		"address": map[string]any{"city": "Addis Ababa", "subcity": "Bole"},
	}
	created := patCreate(t, rc, body)
	if created.MRN == "" {
		t.Fatalf("no MRN assigned: %+v", created)
	}
	got := patGet(t, rc, created.ID)
	checks := map[string][2]string{
		"first_name": {first, got.FirstName}, "middle_name": {"Kebede", got.MiddleName},
		"last_name": {"Tesfaye", got.LastName}, "gender": {"male", got.Gender}, "dob": {"1985-03-02", got.DOB},
		"phone": {phone, got.Phone}, "email": {body["email"].(string), got.Email},
		"national_id": {"NID" + phone, got.NationalID}, "passport_no": {"EP" + phone[2:], got.PassportNo},
		"blood_group": {"O+", got.BloodGroup}, "mrn": {created.MRN, got.MRN},
	}
	for f, v := range checks {
		if v[0] != v[1] {
			t.Errorf("%s: sent %q, read back %q", f, v[0], v[1])
		}
	}
	if !strings.Contains(string(got.Address), "Bole") {
		t.Errorf("address not stored: %s", got.Address)
	}
	var tenant uuid.UUID
	one(t, `SELECT tenant_id FROM patients WHERE id = $1`, &tenant, patUUID(t, created.ID))
	if tenant != clinicA.TenantID {
		t.Fatalf("patient stored under tenant %s, want clinic A", tenant)
	}
}

// TestREG_PATIENT_002_MRNIsAutoSequentialAndUnique: Given a brand-new clinic, When
// two patients are registered without a card number, Then they get P000001 and
// P000002; a supplied legacy card number is kept as-is; and reusing a card number
// already in the clinic is refused with 409 MRN_TAKEN and creates no row.
func TestREG_PATIENT_002_MRNIsAutoSequentialAndUnique(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	p1 := patCreate(t, rc, map[string]any{"first_name": uniq("Seq"), "force": true})
	p2 := patCreate(t, rc, map[string]any{"first_name": uniq("Seq"), "force": true})
	if p1.MRN != "P000001" || p2.MRN != "P000002" {
		t.Fatalf("MRNs not sequential from P000001: got %q, %q", p1.MRN, p2.MRN)
	}
	legacy := "OLD-" + uuid.NewString()[:6]
	p3 := patCreate(t, rc, map[string]any{"first_name": uniq("Legacy"), "mrn": legacy, "force": true})
	if p3.MRN != legacy {
		t.Fatalf("supplied card number not kept: got %q want %q", p3.MRN, legacy)
	}
	r := rc.Do("POST", "/patients", map[string]any{"first_name": uniq("Clash"), "mrn": legacy, "force": true})
	if r.Status != 409 || r.Code != "MRN_TAKEN" {
		t.Fatalf("reused card number: want 409 MRN_TAKEN, got %d %s %s", r.Status, r.Code, r.Message)
	}
	var n int
	one(t, `SELECT count(*) FROM patients WHERE tenant_id = $1 AND mrn = $2`, &n, c.TenantID, legacy)
	if n != 1 {
		t.Fatalf("card number %s held by %d rows, want 1", legacy, n)
	}
	// The same number in another clinic is not a clash: MRNs are per clinic.
	other := patCreate(t, srv.As(t, clinicB, "receptionist"), map[string]any{"first_name": uniq("Other"), "mrn": legacy, "force": true})
	if other.MRN != legacy {
		t.Fatalf("clinic B could not use a card number clinic A holds: %q", other.MRN)
	}
}

// TestREG_PATIENT_003_FirstNameIsRequired: Given a registration with no first name
// (missing, or only spaces), When it is posted, Then the API answers 400 and no
// patient row is created.
func TestREG_PATIENT_003_FirstNameIsRequired(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	for name, body := range map[string]map[string]any{
		"missing": {"last_name": "Nofirst", "phone": patPhone(), "force": true},
		"blank":   {"first_name": "   ", "last_name": "Nofirst", "phone": patPhone(), "force": true},
	} {
		r := rc.Do("POST", "/patients", body)
		if r.Status != 400 {
			t.Errorf("%s first name: want 400, got %d %s", name, r.Status, trimBody(r.Raw))
		}
	}
	var n int
	one(t, `SELECT count(*) FROM patients WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 0 {
		t.Fatalf("%d patient rows created by refused registrations", n)
	}
}

// TestREG_PATIENT_004_DuplicatePhoneIsFlaggedThenForceCreates: Given a patient with
// a phone number, When someone else is registered with the same phone, Then the API
// answers 409 PATIENT_DUPLICATE listing the existing patient and creates nothing;
// When resubmitted with force=true, Then a second patient is created.
func TestREG_PATIENT_004_DuplicatePhoneIsFlaggedThenForceCreates(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	phone := patPhone()
	orig := patCreate(t, rc, map[string]any{"first_name": uniq("Almaz"), "last_name": "Bekele", "phone": phone})

	body := map[string]any{"first_name": uniq("Different"), "last_name": "Person", "phone": phone}
	r := rc.Do("POST", "/patients", body)
	if r.Status != 409 || r.Code != "PATIENT_DUPLICATE" {
		t.Fatalf("same phone: want 409 PATIENT_DUPLICATE, got %d %s", r.Status, trimBody(r.Raw))
	}
	dups := patDuplicates(t, r)
	found := false
	for _, d := range dups {
		if d.ID == orig.ID && d.MRN == orig.MRN {
			found = true
		}
	}
	if !found {
		t.Fatalf("duplicate candidates do not include the existing patient %s: %+v", orig.ID, dups)
	}
	var n int
	one(t, `SELECT count(*) FROM patients WHERE tenant_id = $1 AND phone = $2`, &n, clinicA.TenantID, phone)
	if n != 1 {
		t.Fatalf("refused duplicate still wrote a row: %d rows with the phone", n)
	}

	body["force"] = true
	forced := patCreate(t, rc, body)
	if forced.ID == orig.ID || forced.MRN == orig.MRN {
		t.Fatalf("force=true did not create a distinct patient: %+v", forced)
	}
	one(t, `SELECT count(*) FROM patients WHERE tenant_id = $1 AND phone = $2`, &n, clinicA.TenantID, phone)
	if n != 2 {
		t.Fatalf("after force: %d rows with the phone, want 2", n)
	}
}

// TestREG_PATIENT_005_DuplicateNameAndDOBIsFlagged: Given a patient, When a patient
// with the same first+last name (any case) and date of birth but a different phone
// is registered, Then the API answers 409 PATIENT_DUPLICATE naming the existing one.
func TestREG_PATIENT_005_DuplicateNameAndDOBIsFlagged(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	first := uniq("Hirut")
	orig := patCreate(t, rc, map[string]any{"first_name": first, "last_name": "Girma", "dob": "1979-11-30", "phone": patPhone()})
	r := rc.Do("POST", "/patients", map[string]any{
		"first_name": strings.ToUpper(first), "last_name": "girma", "dob": "1979-11-30", "phone": patPhone(),
	})
	if r.Status != 409 || r.Code != "PATIENT_DUPLICATE" {
		t.Fatalf("same name+dob: want 409 PATIENT_DUPLICATE, got %d %s", r.Status, trimBody(r.Raw))
	}
	if d := patDuplicates(t, r); len(d) == 0 || d[0].ID != orig.ID {
		t.Fatalf("candidates do not name the existing patient: %+v", d)
	}
	// A different date of birth is a different person: no prompt.
	patCreate(t, rc, map[string]any{"first_name": first, "last_name": "Girma", "dob": "1980-01-01", "phone": patPhone()})
}

// TestREG_PATIENT_006_SearchFindsByNameMRNAndPhone: Given a registered patient, When
// the desk searches by first name, full name, MRN or phone, Then the patient is in
// every result; a search for nonsense does not return them.
func TestREG_PATIENT_006_SearchFindsByNameMRNAndPhone(t *testing.T) {
	c := newClinic(t)
	rc := srv.As(t, c, "receptionist")
	first := uniq("Selam")
	phone := patPhone()
	p := patCreate(t, rc, map[string]any{"first_name": first, "last_name": "Worku", "phone": phone, "force": true})
	for _, q := range []string{first, first + " Worku", p.MRN, phone, phone[len(phone)-6:]} {
		if !patContains(patSearchIDs(t, rc, q), p.ID) {
			t.Errorf("search %q did not find the patient", q)
		}
	}
	if patContains(patSearchIDs(t, rc, "zzqxv"+uuid.NewString()[:4]), p.ID) {
		t.Errorf("unrelated search returned the patient")
	}
}

// TestREG_PATIENT_007_UpdatePersistsAndKeepsWhatWasNotSent: Given a patient with a
// passport number, an address and an emergency contact, When PUT /patients/:id is
// sent with new names and phone but WITHOUT those three, Then the new values persist
// AND the three omitted fields are kept. (This used to be a full replace: any edit
// that did not show those fields erased them — audit PAT-6, AUD-01.)
func TestREG_PATIENT_007_UpdatePersistsAndKeepsWhatWasNotSent(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := patCreate(t, rc, map[string]any{
		"first_name": uniq("Before"), "last_name": "Old", "gender": "female", "dob": "1992-02-02",
		"phone": patPhone(), "passport_no": "EP123456", "address": map[string]any{"city": "Adama"},
		"emergency_contact": map[string]any{"name": "Almaz", "phone": "0911222333"}, "national_id": "NID-" + uniq("k"),
		"blood_group": "O+", "force": true,
	})
	newPhone := patPhone()
	newFirst := uniq("After")
	up := rc.Do("PUT", "/patients/"+p.ID, map[string]any{
		"first_name": newFirst, "last_name": "New", "gender": "female", "dob": "1992-02-03", "phone": newPhone,
	}).Expect(t, 200, "update patient")
	var upd patFull
	up.Decode(t, &upd)
	if upd.FirstName != newFirst || upd.LastName != "New" || upd.Phone != newPhone || upd.DOB != "1992-02-03" {
		t.Fatalf("update response does not carry the new values: %+v", upd)
	}
	got := patGet(t, rc, p.ID)
	if got.FirstName != newFirst || got.Phone != newPhone || got.MRN != p.MRN {
		t.Fatalf("update not persisted (or MRN changed): %+v", got)
	}
	var passport, nid, blood *string
	var addr, emerg string
	one(t, `SELECT passport_no FROM patients WHERE id = $1`, &passport, patUUID(t, p.ID))
	one(t, `SELECT national_id FROM patients WHERE id = $1`, &nid, patUUID(t, p.ID))
	one(t, `SELECT blood_group FROM patients WHERE id = $1`, &blood, patUUID(t, p.ID))
	one(t, `SELECT address::text FROM patients WHERE id = $1`, &addr, patUUID(t, p.ID))
	one(t, `SELECT emergency_contact::text FROM patients WHERE id = $1`, &emerg, patUUID(t, p.ID))
	if passport == nil || *passport != "EP123456" || nid == nil || blood == nil || *blood != "O+" ||
		!strings.Contains(addr, "Adama") || !strings.Contains(emerg, "Almaz") {
		t.Fatalf("an edit that did not send these fields erased them: passport=%v national_id=%v blood=%v address=%s emergency=%s",
			passport, nid, blood, addr, emerg)
	}
}

// TestREG_PATIENT_009_AFieldSentEmptyIsCleared: Given a patient with a passport, an
// address, an email and a phone, When PUT sends those keys empty (or null), Then they
// are cleared — "not sent" keeps, "sent empty" clears — and what was not sent stays.
func TestREG_PATIENT_009_AFieldSentEmptyIsCleared(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := patCreate(t, rc, map[string]any{
		"first_name": uniq("Clear"), "last_name": "Fields", "gender": "male", "dob": "1990-01-01",
		"phone": patPhone(), "email": "keep" + uniq("") + "@example.test", "passport_no": "EP777",
		"address": map[string]any{"city": "Bahir Dar"}, "emergency_contact": map[string]any{"name": "Kebede"}, "force": true,
	})
	rc.Do("PUT", "/patients/"+p.ID, map[string]any{
		"first_name": "Clear", "passport_no": "", "phone": "", "address": nil,
	}).Expect(t, 200, "clear some fields")
	var passport, phone, email *string
	var addr, emerg string
	var gender string
	var last string
	one(t, `SELECT passport_no FROM patients WHERE id = $1`, &passport, patUUID(t, p.ID))
	one(t, `SELECT phone FROM patients WHERE id = $1`, &phone, patUUID(t, p.ID))
	one(t, `SELECT email FROM patients WHERE id = $1`, &email, patUUID(t, p.ID))
	one(t, `SELECT address::text FROM patients WHERE id = $1`, &addr, patUUID(t, p.ID))
	one(t, `SELECT emergency_contact::text FROM patients WHERE id = $1`, &emerg, patUUID(t, p.ID))
	one(t, `SELECT gender FROM patients WHERE id = $1`, &gender, patUUID(t, p.ID))
	one(t, `SELECT last_name FROM patients WHERE id = $1`, &last, patUUID(t, p.ID))
	if passport != nil || phone != nil || strings.Contains(addr, "Bahir") {
		t.Fatalf("fields sent empty were not cleared: passport=%v phone=%v address=%s", passport, phone, addr)
	}
	if email == nil || !strings.Contains(emerg, "Kebede") || gender != "male" || last != "Fields" {
		t.Fatalf("fields that were NOT sent changed: email=%v emergency=%s gender=%s last=%s", email, emerg, gender, last)
	}
}

// TestREG_PATIENT_010_TheFirstNameAloneChangesOnlyTheFirstName: Given a fully filled
// patient, When PUT sends only first_name, Then every other stored field is untouched.
func TestREG_PATIENT_010_TheFirstNameAloneChangesOnlyTheFirstName(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := patCreate(t, rc, map[string]any{
		"first_name": uniq("Only"), "middle_name": "Mid", "last_name": "Whole", "gender": "female", "dob": "1988-08-08",
		"phone": patPhone(), "passport_no": "EP999", "blood_group": "A-", "address": map[string]any{"city": "Hawassa"}, "force": true,
	})
	before := patGet(t, rc, p.ID)
	rc.Do("PUT", "/patients/"+p.ID, map[string]any{"first_name": "Renamed"}).Expect(t, 200, "rename")
	after := patGet(t, rc, p.ID)
	if after.FirstName != "Renamed" {
		t.Fatalf("first name not changed: %+v", after)
	}
	if after.MiddleName != before.MiddleName || after.LastName != before.LastName || after.Gender != before.Gender ||
		after.DOB != before.DOB || after.Phone != before.Phone || after.BloodGroup != before.BloodGroup {
		t.Fatalf("a rename changed other fields:\nbefore %+v\nafter  %+v", before, after)
	}
	var passport *string
	one(t, `SELECT passport_no FROM patients WHERE id = $1`, &passport, patUUID(t, p.ID))
	if passport == nil || *passport != "EP999" {
		t.Fatalf("a rename erased the passport: %v", passport)
	}
}

// TestREG_PATIENT_011_AnUpdateWithoutAFirstNameOrWithBrokenJSONIsRefused: When PUT
// sends no first name, or a body that is not JSON, Then 400 and nothing is stored.
func TestREG_PATIENT_011_AnUpdateWithoutAFirstNameOrWithBrokenJSONIsRefused(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	first := uniq("Intact")
	p := patCreate(t, rc, map[string]any{"first_name": first, "phone": patPhone(), "passport_no": "EP-INTACT", "force": true})
	rc.Do("PUT", "/patients/"+p.ID, map[string]any{"phone": patPhone()}).Expect(t, 400, "no first name")
	rc.Do("PUT", "/patients/"+p.ID, "this is not an object").Expect(t, 400, "not an object")
	var stored string
	var passport *string
	one(t, `SELECT first_name FROM patients WHERE id = $1`, &stored, patUUID(t, p.ID))
	one(t, `SELECT passport_no FROM patients WHERE id = $1`, &passport, patUUID(t, p.ID))
	if stored != first || passport == nil || *passport != "EP-INTACT" {
		t.Fatalf("a refused update changed the record: first=%q passport=%v", stored, passport)
	}
}

// TestREG_PATIENT_008_UpdateCannotBlankTheFirstName: Given a patient, When PUT sends
// a first name of only spaces, Then the API refuses it (400), exactly as registration
// does, and the stored name is unchanged.
func TestREG_PATIENT_008_UpdateCannotBlankTheFirstName(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	first := uniq("Keepname")
	p := patCreate(t, rc, map[string]any{"first_name": first, "phone": patPhone(), "force": true})
	r := rc.Do("PUT", "/patients/"+p.ID, map[string]any{"first_name": "   ", "last_name": "X"})
	var stored string
	one(t, `SELECT first_name FROM patients WHERE id = $1`, &stored, patUUID(t, p.ID))
	testkit.KnownBug(t, "NEW-PAT-2", r.Status != 400 || stored != first, fmt.Sprintf(
		"PUT /patients/:id with first_name \"   \" answered %d and stored first_name=%q — Update does not "+
			"apply Create's TrimSpace check (patient/service/service.go Update)", r.Status, stored))
}

// TestREG_PATIENT_009_SoftDeleteHidesButKeepsRow: Given a patient, When it is deleted,
// Then GET answers 404, search no longer finds it, it no longer counts as a duplicate
// candidate, and the row is still in the database with deleted_at set.
func TestREG_PATIENT_009_SoftDeleteHidesButKeepsRow(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	first := uniq("Gone")
	phone := patPhone()
	p := patCreate(t, rc, map[string]any{"first_name": first, "last_name": "Soon", "phone": phone, "force": true})
	rc.Do("DELETE", "/patients/"+p.ID, nil).Expect(t, 204, "delete patient")

	if r := rc.Do("GET", "/patients/"+p.ID, nil); r.Status != 404 {
		t.Errorf("GET of a deleted patient: want 404, got %d", r.Status)
	}
	if patContains(patSearchIDs(t, rc, first), p.ID) || patContains(patSearchIDs(t, rc, phone), p.ID) {
		t.Errorf("deleted patient still returned by search")
	}
	// A new registration with that phone is not blocked by a deleted record.
	patCreate(t, rc, map[string]any{"first_name": uniq("New"), "phone": phone})

	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM patients WHERE id = $1`, &deleted, patUUID(t, p.ID))
	if !deleted {
		t.Fatalf("row not soft-deleted (deleted_at is NULL)")
	}
	if r := rc.Do("PUT", "/patients/"+p.ID, map[string]any{"first_name": "Revive"}); r.Status != 404 {
		t.Errorf("PUT on a deleted patient: want 404, got %d", r.Status)
	}
	var name string
	one(t, `SELECT first_name FROM patients WHERE id = $1`, &name, patUUID(t, p.ID))
	if name != first {
		t.Fatalf("deleted patient was edited: %q", name)
	}
}

// TestREG_PATIENT_010_UpdateOfUnknownPatientIs404: Given an id no patient has, When
// PUT is sent, Then the API answers 404 PATIENT_NOT_FOUND.
func TestREG_PATIENT_010_UpdateOfUnknownPatientIs404(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	ghost := id.Encode(id.PrefixPatient, uuid.New())
	r := rc.Do("PUT", "/patients/"+ghost, map[string]any{"first_name": "Nobody"})
	if r.Status != 404 {
		t.Fatalf("update unknown patient: want 404, got %d %s", r.Status, trimBody(r.Raw))
	}
}

// TestREG_PATIENT_011_DeleteOfUnknownPatientIs404: Given an id no patient has (or one
// already deleted), When DELETE is sent, Then the API should answer 404, not a
// success — a 204 tells the desk something was removed when nothing was.
func TestREG_PATIENT_011_DeleteOfUnknownPatientIs404(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	ghost := id.Encode(id.PrefixPatient, uuid.New())
	r := rc.Do("DELETE", "/patients/"+ghost, nil)
	if r.Status != 404 && r.Status != 204 {
		t.Fatalf("delete unknown patient: want 404, got %d", r.Status)
	}
	testkit.KnownBug(t, "NEW-PAT-1", r.Status == 204,
		"DELETE /patients/<nonexistent> answers 204: SoftDeletePatient is :exec and the affected row count is never checked")
}

// TestREG_PATIENT_012_AllergiesAddListRemove: Given a patient, When an allergy is
// added, Then the profile lists it with its severity; When it is removed, Then the
// profile no longer lists it but the row is kept with deleted_at set.
func TestREG_PATIENT_012_AllergiesAddListRemove(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := patCreate(t, rc, map[string]any{"first_name": uniq("Allergic"), "phone": patPhone(), "force": true})
	r := rc.Do("POST", "/patients/"+p.ID+"/allergies", map[string]any{"substance": "Penicillin", "reaction": "rash", "severity": "severe"}).
		Expect(t, 201, "add allergy")
	var a struct {
		ID string `json:"id"`
	}
	r.Decode(t, &a)
	if bad := rc.Do("POST", "/patients/"+p.ID+"/allergies", map[string]any{"reaction": "x"}); bad.Status != 400 {
		t.Errorf("allergy without substance: want 400, got %d", bad.Status)
	}
	got := patGet(t, rc, p.ID)
	if len(got.Allergies) != 1 || got.Allergies[0].ID != a.ID || got.Allergies[0].Substance != "Penicillin" || got.Allergies[0].Severity != "severe" {
		t.Fatalf("allergy not listed as added: %+v", got.Allergies)
	}
	rc.Do("DELETE", "/patients/"+p.ID+"/allergies/"+a.ID, nil).Expect(t, 204, "remove allergy")
	if got := patGet(t, rc, p.ID); len(got.Allergies) != 0 {
		t.Fatalf("removed allergy still listed: %+v", got.Allergies)
	}
	aid, _ := id.Decode(id.PrefixAllergy, a.ID)
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM allergies WHERE id = $1`, &deleted, aid)
	if !deleted {
		t.Fatalf("allergy row not soft-deleted")
	}
}

// TestREG_PATIENT_013_RemoveUnknownAllergyIs404: Given a patient, When DELETE names an
// allergy id that does not exist, Then the API should answer 404, not 204.
func TestREG_PATIENT_013_RemoveUnknownAllergyIs404(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := patCreate(t, rc, map[string]any{"first_name": uniq("Noallergy"), "phone": patPhone(), "force": true})
	r := rc.Do("DELETE", "/patients/"+p.ID+"/allergies/"+id.Encode(id.PrefixAllergy, uuid.New()), nil)
	if r.Status != 404 && r.Status != 204 {
		t.Fatalf("remove unknown allergy: want 404, got %d", r.Status)
	}
	testkit.KnownBug(t, "NEW-PAT-3", r.Status == 204,
		"DELETE /patients/:id/allergies/<nonexistent> answers 204: RemoveAllergy is :exec with no row-count check")
}

// TestREG_PATIENT_014_EditLeavesAnAuditTrail: Given a patient, When their
// demographics are changed, Then an audit record (or the outbox event the audit
// worker turns into one) exists for that change — who changed what, when.
func TestREG_PATIENT_014_EditLeavesAnAuditTrail(t *testing.T) {
	rc := srv.As(t, clinicA, "receptionist")
	p := patCreate(t, rc, map[string]any{"first_name": uniq("Audited"), "phone": patPhone(), "force": true})
	pid := patUUID(t, p.ID)
	rc.Do("PUT", "/patients/"+p.ID, map[string]any{"first_name": uniq("Changed"), "phone": patPhone()}).Expect(t, 200, "update")

	// Registration does leave an event — so the absence below is not a test artefact.
	var reg int
	one(t, `SELECT count(*) FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'patient.patient.registered'`, &reg, pid)
	if reg != 1 {
		t.Fatalf("registration event missing (%d): the outbox check is not working", reg)
	}
	var trail int
	one(t, `SELECT (SELECT count(*) FROM event_outbox WHERE aggregate_id = $1 AND event_type <> 'patient.patient.registered')
	            + (SELECT count(*) FROM audit_logs WHERE target_id = $1 AND action <> 'patient.patient.registered')`, &trail, pid)
	testkit.KnownBug(t, "PAT-1", trail == 0,
		"PUT /patients/:id publishes no event and writes no audit_logs row — patient edits leave no audit trail")
}
