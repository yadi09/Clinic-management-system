package regression

import (
	"strconv"
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/testkit"
)

// Clinic isolation: a user of clinic A, holding every permission in A, must not be
// able to read, change or delete anything of clinic B's by sending B's ids.
// Anything other than "not found" (or an empty list) is a cross-clinic leak.

// TestREG_TENANT_001_ClinicACannotReadClinicBPatient: Given a patient of clinic B,
// When clinic A's owner requests it by id, Then the API answers 404 and no field of
// it is returned.
func TestREG_TENANT_001_ClinicACannotReadClinicBPatient(t *testing.T) {
	bOwner := srv.As(t, clinicB, "owner")
	pb := createPatient(t, bOwner, uniq("Secret"), "Bpatient")

	aOwner := srv.As(t, clinicA, "owner")
	r := aOwner.Do("GET", "/patients/"+pb.ID, nil)
	if r.Status != 404 {
		t.Fatalf("clinic A read clinic B's patient: HTTP %d %s", r.Status, trimBody(r.Raw))
	}
	if strings.Contains(r.Raw, pb.FirstName) {
		t.Fatalf("response leaked clinic B's patient name")
	}
	// The overview aggregates under RLS, so for a patient A cannot see it answers with
	// zeros rather than 404. That is not a leak; a name or a balance would be.
	ov := aOwner.Do("GET", "/patients/"+pb.ID+"/overview", nil)
	if strings.Contains(ov.Raw, pb.FirstName) || strings.Contains(ov.Raw, pb.MRN) {
		t.Fatalf("overview leaked clinic B's patient: %s", trimBody(ov.Raw))
	}
}

// TestREG_TENANT_002_ClinicACannotChangeOrDeleteClinicBPatient: updates and deletes
// addressed at B's patient must not touch B's row.
func TestREG_TENANT_002_ClinicACannotChangeOrDeleteClinicBPatient(t *testing.T) {
	bOwner := srv.As(t, clinicB, "owner")
	pb := createPatient(t, bOwner, uniq("Keep"), "Bpatient")
	aOwner := srv.As(t, clinicA, "owner")

	up := aOwner.Do("PUT", "/patients/"+pb.ID, map[string]any{"first_name": "Hijacked", "last_name": "X", "gender": "male"})
	if up.Status == 200 || up.Status == 204 {
		t.Fatalf("clinic A updated clinic B's patient: HTTP %d", up.Status)
	}
	// DELETE answers 204 for any id it cannot see (REG_PATIENT_011 tracks that as a
	// misleading success); what matters here is that B's row is untouched.
	aOwner.Do("DELETE", "/patients/"+pb.ID, nil)

	var name string
	var deleted bool
	var allergies int
	one(t, `SELECT first_name FROM patients WHERE mrn = $1 AND tenant_id = $2`, &name, pb.MRN, clinicB.TenantID)
	one(t, `SELECT deleted_at IS NOT NULL FROM patients WHERE mrn = $1 AND tenant_id = $2`, &deleted, pb.MRN, clinicB.TenantID)
	// Only rows clinic B can see count as a change to B's record.
	one(t, `SELECT count(*) FROM allergies a JOIN patients p ON p.id = a.patient_id
	         WHERE p.mrn = $1 AND p.tenant_id = $2 AND a.tenant_id = $2`, &allergies, pb.MRN, clinicB.TenantID)
	if name != pb.FirstName || deleted || allergies != 0 {
		t.Fatalf("clinic B's patient was changed by clinic A: name=%q deleted=%v allergies=%d", name, deleted, allergies)
	}
}

// TestREG_TENANT_003_SearchNeverReturnsOtherClinicPatients: a name that exists only
// in clinic B is not found by clinic A's search, and is found by B's.
func TestREG_TENANT_003_SearchNeverReturnsOtherClinicPatients(t *testing.T) {
	bOwner := srv.As(t, clinicB, "owner")
	pb := createPatient(t, bOwner, uniq("Zebulon"), "Onlyinb")

	aRes := srv.As(t, clinicA, "receptionist").Do("GET", "/patients?q="+pb.FirstName, nil).Expect(t, 200, "search A")
	if strings.Contains(aRes.Raw, pb.ID) || strings.Contains(aRes.Raw, pb.FirstName) {
		t.Fatalf("clinic A's search returned clinic B's patient")
	}
	bRes := srv.As(t, clinicB, "receptionist").Do("GET", "/patients?q="+pb.FirstName, nil).Expect(t, 200, "search B")
	if !strings.Contains(bRes.Raw, pb.ID) {
		t.Fatalf("clinic B cannot find its own patient (search is broken, isolation test inconclusive)")
	}
}

// TestREG_TENANT_004_ClinicACannotReadClinicBDentalRecord: B's dental summary,
// chart, plans and examinations are invisible to A; A's write attempts on them fail.
func TestREG_TENANT_004_ClinicACannotReadClinicBDentalRecord(t *testing.T) {
	bDoc := srv.As(t, clinicB, "doctor")
	pb := createPatient(t, srv.As(t, clinicB, "receptionist"), uniq("Tooth"), "Bpatient")
	plan := createPlan(t, bDoc, pb.ID, "3000", 3, "")

	aDoc := srv.As(t, clinicA, "doctor")
	for _, path := range []string{
		"/dental/patients/" + pb.ID + "/summary",
		"/dental/patients/" + pb.ID + "/chart",
		"/dental/patients/" + pb.ID + "/plans",
		"/dental/patients/" + pb.ID + "/exams",
	} {
		r := aDoc.Do("GET", path, nil)
		if r.Status == 200 && (strings.Contains(r.Raw, plan.ID) || strings.Contains(r.Raw, "Root canal")) {
			t.Fatalf("GET %s leaked clinic B's dental record", path)
		}
	}
	// Writes addressed at B's visit and chart.
	s := plan.Sessions[0]
	aDoc.Do("PUT", "/dental/patients/"+pb.ID+"/sessions/"+s.ID, map[string]any{"status": "done", "notes": "hijack"})
	aDoc.Do("PUT", "/dental/patients/"+pb.ID+"/chart", map[string]any{"changes": map[string]string{"UR1": "missing"}})
	var status string
	one(t, `SELECT status FROM treatment_sessions WHERE tenant_id = $1 AND kind = 'visit' ORDER BY seq LIMIT 1`, &status, clinicB.TenantID)
	if status != "planned" {
		t.Fatalf("clinic A changed clinic B's visit: status=%s", status)
	}
	var charts int
	one(t, `SELECT count(*) FROM dental_charts WHERE tenant_id = $1 AND teeth ? 'UR1'`, &charts, clinicB.TenantID)
	if charts != 0 {
		t.Fatalf("clinic A wrote clinic B's chart")
	}
}

// TestREG_TENANT_005_MoneyViewsAreClinicScoped: B's pending charge is not in A's
// cashier worklist, A's receivables, or A's dashboard; and A cannot settle it.
func TestREG_TENANT_005_MoneyViewsAreClinicScoped(t *testing.T) {
	pb := createPatient(t, srv.As(t, clinicB, "receptionist"), uniq("Payer"), "Bpatient")
	plan := createPlan(t, srv.As(t, clinicB, "doctor"), pb.ID, "1700", 1, "")
	bCashier := srv.As(t, clinicB, "cashier")
	bCashier.Do("POST", "/dental/patients/"+pb.ID+"/sessions/"+plan.Sessions[0].ID+"/collect", nil).Expect(t, 204, "B collects")

	aOwner := srv.As(t, clinicA, "owner")
	for _, path := range []string{"/billing/charges/pending", "/finance/receivables", "/dashboard/today", "/dental/unbilled", "/dental/outstanding"} {
		r := aOwner.Do("GET", path, nil)
		if strings.Contains(r.Raw, pb.ID) || strings.Contains(r.Raw, pb.FirstName) {
			t.Fatalf("GET %s in clinic A shows clinic B's patient", path)
		}
	}
	// B's own cashier list gives the charge's real (prefixed) id.
	var pendingB []struct {
		ID string `json:"id"`
	}
	bCashier.Do("GET", "/billing/charges/pending", nil).Expect(t, 200, "B pending").Decode(t, &pendingB)
	if len(pendingB) == 0 {
		t.Fatalf("clinic B has no pending charge to attack (setup broken)")
	}
	r := aOwner.Do("POST", "/billing/charges/"+pendingB[0].ID+"/settle", map[string]any{"payment_method": "cash"})
	if r.Status == 200 {
		t.Fatalf("clinic A settled clinic B's charge")
	}
	var pending int
	one(t, `SELECT count(*) FROM charges WHERE tenant_id = $1 AND status = 'pending'`, &pending, clinicB.TenantID)
	if pending != 1 {
		t.Fatalf("clinic B's pending charge changed: %d pending", pending)
	}
}

// TestREG_TENANT_006_EveryClinicTableIsRowLevelSecured: every table holding a
// clinic's rows (a tenant_id column) has RLS enabled AND forced and at least one
// policy. New tables must not ship without it. event_outbox and crm_prospects are
// deliberately cross-tenant and readable only by the platform role.
func TestREG_TENANT_006_EveryClinicTableIsRowLevelSecured(t *testing.T) {
	rows, err := super.Pool.Query(t.Context(), `
		SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
		       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)
		  FROM pg_class c
		  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
		 WHERE c.relkind = 'r'
		   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
		   AND c.relname NOT IN ('event_outbox', 'crm_prospects', 'tenants')
		 ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var bad []string
	n := 0
	for rows.Next() {
		var name string
		var on, forced bool
		var policies int
		if err := rows.Scan(&name, &on, &forced, &policies); err != nil {
			t.Fatal(err)
		}
		n++
		if !on || !forced || policies == 0 {
			bad = append(bad, name)
		}
	}
	if n < 30 {
		t.Fatalf("only %d tenant tables found — the catalogue query is wrong", n)
	}
	if len(bad) > 0 {
		t.Fatalf("tables without enabled+forced RLS and a policy: %v", bad)
	}
}

// TestREG_TENANT_007_ChildWritesAgainstAnotherClinicsPatientAreRefused: adding an
// allergy (or any child row) to a patient id the caller cannot see must answer 404
// and store nothing. Today the row is stored in the CALLER's clinic, pointing at the
// other clinic's patient: invisible to that clinic (no leak, RLS holds) but a
// dangling record and a misleading "created".
func TestREG_TENANT_007_ChildWritesAgainstAnotherClinicsPatientAreRefused(t *testing.T) {
	pb := createPatient(t, srv.As(t, clinicB, "owner"), uniq("Child"), "Bpatient")
	r := srv.As(t, clinicA, "owner").Do("POST", "/patients/"+pb.ID+"/allergies",
		map[string]any{"substance": "Penicillin", "severity": "severe"})
	var stray int
	one(t, `SELECT count(*) FROM allergies a JOIN patients p ON p.id = a.patient_id
	         WHERE p.mrn = $1 AND p.tenant_id = $2`, &stray, pb.MRN, clinicB.TenantID)
	var visibleToB int
	one(t, `SELECT count(*) FROM allergies a JOIN patients p ON p.id = a.patient_id
	         WHERE p.mrn = $1 AND p.tenant_id = $2 AND a.tenant_id = $2`, &visibleToB, pb.MRN, clinicB.TenantID)
	if visibleToB != 0 {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B's patient gained an allergy written by clinic A")
	}
	testkit.KnownBug(t, "TENANT-FK-1", r.Status != 404 || stray != 0,
		"a write addressed at another clinic's patient is accepted (HTTP "+itoa(r.Status)+") and leaves a dangling row in the caller's clinic")
}

func itoa(n int) string { return strconv.Itoa(n) }

func trimBody(s string) string {
	if len(s) > 300 {
		return s[:300]
	}
	return s
}
