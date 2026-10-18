package regression

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Billing, the cashier and the service catalogue, through the HTTP API.
//
// The rules held here (read from billing/service, billing/http and kernel/payments):
//   - The catalogue is billing.manage's, except the dental list, which a dentist
//     (dental.manage) may keep. Toggles, providers and delete are billing.manage only.
//   - A charge is raised with payment.charge; settled with payment.collect; waived,
//     voided or deferred with payment.waive; refunded with billing.manage.
//   - A settle names a configured payment rail (or the legacy free-text method). A
//     rail that needs a reference refuses without one; an inactive or unknown rail is
//     refused; a reference can pay one receipt only (REFERENCE_USED).
//   - A reference the bank rejected is refused (VERIFY_REJECTED) unless a payment.waive
//     holder forces it. Verify.ET is unconfigured in tests: every check answers
//     "unchecked" and the desk may still take the money.
//   - Receipt numbers are per clinic, consecutive, one per payment event (a checkout of
//     several charges shares one), and a refund gets its own.
//
// Every test runs in its own clinic so the totals it asserts are exact.

// ---- helpers (bl-prefixed: other files in this package are written concurrently) ----

// blExpect fails unless the response has this status and (when given) error code.
func blExpect(t *testing.T, r testkit.Resp, status int, code, what string) testkit.Resp {
	t.Helper()
	if r.Status != status || (code != "" && r.Code != code) {
		t.Fatalf("%s: want HTTP %d %s, got %d %s (%s)", what, status, code, r.Status, r.Code, r.Message)
	}
	return r
}

// blExec runs a statement as the superuser (arranging state the API cannot reach).
func blExec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := super.Pool.Exec(t.Context(), q, args...); err != nil {
		t.Fatalf("%v\n%s", err, q)
	}
}

func blUUID(t *testing.T, prefix, s string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(prefix, s)
	if err != nil {
		t.Fatalf("id %q: %v", s, err)
	}
	return u
}

func blPatientUUID(t *testing.T, p patientRef) uuid.UUID { return blUUID(t, id.PrefixPatient, p.ID) }

func blDept(c *testkit.Clinic) string { return id.Encode(id.PrefixDepartment, c.DeptID) }

func blUser(s testkit.Staff) string { return id.Encode(id.PrefixUser, s.ID) }

// blRails is the clinic's payment methods by key (cash, card, mobile, transfer).
func blRails(t *testing.T, c *testkit.Client) map[string]string {
	t.Helper()
	var rails []struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	c.Do("GET", "/org/payment-rails?all=1", nil).Expect(t, 200, "payment rails").Decode(t, &rails)
	out := map[string]string{}
	for _, r := range rails {
		out[r.Key] = r.ID
	}
	for _, k := range []string{"cash", "card", "mobile", "transfer"} {
		if out[k] == "" {
			t.Fatalf("clinic has no %q payment rail: %+v", k, rails)
		}
	}
	return out
}

// blService creates a catalogue item as c and returns its id.
func blService(t *testing.T, c *testkit.Client, name, category string, price float64, assignable string) string {
	t.Helper()
	var s struct {
		ID string `json:"id"`
	}
	c.Do("POST", "/billing/services", map[string]any{
		"code": uniq("C"), "name": name, "category": category, "price": price, "assignable_by": assignable,
	}).Expect(t, 201, "create service").Decode(t, &s)
	return s.ID
}

// blStatus is a charge's stored status.
func blStatus(t *testing.T, chargeID string) string {
	t.Helper()
	var s string
	one(t, `SELECT status FROM charges WHERE id = $1`, &s, blUUID(t, id.PrefixCharge, chargeID))
	return s
}

func blReceipt(t *testing.T, chargeID string) int64 {
	t.Helper()
	var n *int64
	one(t, `SELECT receipt_no FROM charges WHERE id = $1`, &n, blUUID(t, id.PrefixCharge, chargeID))
	if n == nil {
		t.Fatalf("charge %s has no receipt number", chargeID)
	}
	return *n
}

// blRaiseNoBranch raises a charge with no branch (as lab/pharmacy/refund rows are).
func blRaiseNoBranch(t *testing.T, c *testkit.Client, patientID string, amount float64) string {
	t.Helper()
	var out struct {
		ID string `json:"id"`
	}
	c.Do("POST", "/billing/charges", map[string]any{
		"patient_id": patientID, "source": "service", "description": uniq("Unbranched "), "amount": amount,
	}).Expect(t, 201, "raise charge").Decode(t, &out)
	return out.ID
}

// blCustomUser signs in a user holding exactly these permissions — for the
// refusal branches no built-in role reaches (e.g. payment.collect without payment.waive).
func blCustomUser(t *testing.T, clinic *testkit.Clinic, perms ...string) *testkit.Client {
	t.Helper()
	ctx := t.Context()
	code := strings.ToLower(uniq("custom_"))
	var roleID, userID uuid.UUID
	if err := super.Pool.QueryRow(ctx, `INSERT INTO roles (tenant_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
		clinic.TenantID, code).Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	blExec(t, `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
	           SELECT $1, $2, id FROM permissions WHERE code = ANY($3)`, clinic.TenantID, roleID, perms)
	email := code + "@" + clinic.Slug + ".test"
	if err := super.Pool.QueryRow(ctx,
		`INSERT INTO users (tenant_id, email, password_hash, full_name, status)
		 VALUES ($1, $2, (SELECT password_hash FROM users WHERE id = $3), $4, 'active') RETURNING id`,
		clinic.TenantID, email, clinic.Owner.ID, "Custom "+code).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	blExec(t, `INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, clinic.TenantID, userID, roleID)
	return srv.Login(t, clinic.Slug, email)
}

// blRace fires the requests at the same instant.
func blRace(fns ...func() testkit.Resp) []testkit.Resp {
	out := make([]testkit.Resp, len(fns))
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i, f := range fns {
		wg.Add(1)
		go func(i int, f func() testkit.Resp) {
			defer wg.Done()
			<-start
			out[i] = f()
		}(i, f)
	}
	close(start)
	wg.Wait()
	return out
}

// ---- catalogue ----

type blSvc struct {
	ID           string `json:"id"`
	Code         string `json:"code"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	Price        string `json:"price"`
	IsActive     bool   `json:"is_active"`
	IsDefault    bool   `json:"is_default"`
	AssignableBy string `json:"assignable_by"`
}

func blListServices(t *testing.T, c *testkit.Client, q string) map[string]blSvc {
	t.Helper()
	var list []blSvc
	c.Do("GET", "/billing/services"+q, nil).Expect(t, 200, "list services").Decode(t, &list)
	out := map[string]blSvc{}
	for _, s := range list {
		out[s.ID] = s
	}
	return out
}

// TestREG_BILL_001_ServiceCatalogueLifecycle: Given a manager, When they create,
// edit, deactivate, make default and delete a service, Then each change is stored and
// the list (all / active only) agrees; invalid input, a duplicate code and an invalid
// id are refused with the right codes.
func TestREG_BILL_001_ServiceCatalogueLifecycle(t *testing.T) {
	clinic := payClinic(t)
	mgr := srv.As(t, clinic, "branch_manager")

	r := mgr.Do("POST", "/billing/services", map[string]any{"code": "CONS", "name": "Consultation", "price": 250, "assignable_by": "bogus"})
	blExpect(t, r, 201, "", "create service")
	var s blSvc
	r.Decode(t, &s)
	if s.Category != "general" || !payEq(payNum(t, s.Price), 250) || !s.IsActive || s.IsDefault || s.AssignableBy != "either" {
		t.Fatalf("created service %+v: want general, 250, active, not default, assignable either", s)
	}
	blExpect(t, mgr.Do("POST", "/billing/services", map[string]any{"code": "CONS", "name": "Again", "price": 1}), 409, "SERVICE_EXISTS", "duplicate code")
	blExpect(t, mgr.Do("POST", "/billing/services", map[string]any{"code": "", "name": "No code"}), 400, "VALIDATION_FAILED", "empty code")
	blExpect(t, mgr.Do("POST", "/billing/services", map[string]any{"code": "NEG", "name": "Neg", "price": -1}), 400, "VALIDATION_FAILED", "negative price")
	blExpect(t, mgr.Do("POST", "/billing/services", map[string]any{"code": 5}), 400, "VALIDATION_FAILED", "malformed body")

	// Edit.
	blExpect(t, mgr.Do("PUT", "/billing/services/"+s.ID, map[string]any{"code": "CONS", "name": "Consultation (new)", "category": "general", "price": 300, "assignable_by": "reception"}), 204, "", "update")
	var name string
	sid := blUUID(t, id.PrefixServiceItem, s.ID)
	one(t, `SELECT name || '|' || price::text || '|' || assignable_by FROM service_items WHERE id = $1`, &name, sid)
	if name != "Consultation (new)|300.00|reception" {
		t.Fatalf("after update the row reads %q", name)
	}
	other := blService(t, mgr, "X-ray", "general", 100, "")
	blExpect(t, mgr.Do("PUT", "/billing/services/"+other, map[string]any{"code": "CONS", "name": "X-ray"}), 409, "SERVICE_EXISTS", "update onto a taken code")
	blExpect(t, mgr.Do("PUT", "/billing/services/"+s.ID, map[string]any{"code": "CONS", "name": " "}), 400, "VALIDATION_FAILED", "update with no name")
	blExpect(t, mgr.Do("PUT", "/billing/services/"+s.ID, map[string]any{"code": "CONS", "name": "C", "price": -5}), 400, "VALIDATION_FAILED", "update negative price")
	blExpect(t, mgr.Do("PUT", "/billing/services/"+s.ID, "nope"), 400, "VALIDATION_FAILED", "update malformed body")
	blExpect(t, mgr.Do("PUT", "/billing/services/svc_nope", map[string]any{"code": "A", "name": "B"}), 400, "VALIDATION_FAILED", "update invalid id")

	// Active / default.
	blExpect(t, mgr.Do("PUT", "/billing/services/"+other+"/active", map[string]any{"is_active": false}), 204, "", "deactivate")
	if _, ok := blListServices(t, mgr, "?active=1")[other]; ok {
		t.Fatalf("a deactivated service is still in the active list")
	}
	if got, ok := blListServices(t, mgr, "")[other]; !ok || got.IsActive {
		t.Fatalf("the full list lost the inactive service or shows it active: %+v", got)
	}
	blExpect(t, mgr.Do("PUT", "/billing/services/"+s.ID+"/default", map[string]any{"is_default": true}), 204, "", "make default")
	if !blListServices(t, mgr, "")[s.ID].IsDefault {
		t.Fatalf("service not marked default")
	}
	blExpect(t, mgr.Do("PUT", "/billing/services/x/active", nil), 400, "VALIDATION_FAILED", "active invalid id")
	blExpect(t, mgr.Do("PUT", "/billing/services/x/default", nil), 400, "VALIDATION_FAILED", "default invalid id")

	// Delete: soft, and gone from both lists.
	blExpect(t, mgr.Do("DELETE", "/billing/services/"+other, nil), 204, "", "delete")
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL AND NOT is_active FROM service_items WHERE id = $1`, &deleted, blUUID(t, id.PrefixServiceItem, other))
	if !deleted {
		t.Fatalf("deleted service is not soft-deleted and inactive")
	}
	if _, ok := blListServices(t, mgr, "")[other]; ok {
		t.Fatalf("deleted service still listed")
	}
	blExpect(t, mgr.Do("DELETE", "/billing/services/zz", nil), 400, "VALIDATION_FAILED", "delete invalid id")
	// Editing a deleted service changes nothing (and does not resurrect it).
	blExpect(t, mgr.Do("PUT", "/billing/services/"+other, map[string]any{"code": "XR", "name": "Back"}), 204, "", "edit deleted")
	if _, ok := blListServices(t, mgr, "")[other]; ok {
		t.Fatalf("editing a deleted service brought it back")
	}

	// Anyone signed in may read the list (to price a charge); nobody else may change it.
	nurse := srv.As(t, clinic, "nurse")
	if _, ok := blListServices(t, nurse, "")[s.ID]; !ok {
		t.Fatalf("a nurse cannot read the catalogue")
	}
	recp := srv.As(t, clinic, "receptionist")
	blExpect(t, recp.Do("POST", "/billing/services", map[string]any{"code": "R", "name": "R"}), 403, "FORBIDDEN_PERMISSION", "receptionist create")
	blExpect(t, recp.Do("PUT", "/billing/services/"+s.ID+"/active", map[string]any{"is_active": false}), 403, "FORBIDDEN_PERMISSION", "receptionist deactivate")
	blExpect(t, recp.Do("PUT", "/billing/services/"+s.ID+"/default", map[string]any{"is_default": false}), 403, "FORBIDDEN_PERMISSION", "receptionist default")
	blExpect(t, recp.Do("DELETE", "/billing/services/"+s.ID, nil), 403, "FORBIDDEN_PERMISSION", "receptionist delete")
	blExpect(t, srv.Anon(t).Do("GET", "/billing/services", nil), 401, "", "anonymous list")
}

// TestREG_BILL_002_DentistKeepsOnlyTheDentalList: Given a dentist (dental.manage, no
// billing.manage), Then they may add and edit a "dental" service but not a general
// one, may not move a dental item to another category, and may not use the
// manager-only toggles.
func TestREG_BILL_002_DentistKeepsOnlyTheDentalList(t *testing.T) {
	clinic := payClinic(t)
	doctor := srv.As(t, clinic, "doctor")
	dental := blService(t, doctor, "Molar root canal", "Dental", 4000, "clinician")
	blExpect(t, doctor.Do("POST", "/billing/services", map[string]any{"code": uniq("G"), "name": "General", "category": "general"}), 403, "NOT_ALLOWED", "dentist creates general")
	blExpect(t, doctor.Do("PUT", "/billing/services/"+dental, map[string]any{"code": "RC", "name": "Root canal", "category": "dental", "price": 4500}), 204, "", "dentist edits dental")
	blExpect(t, doctor.Do("PUT", "/billing/services/"+dental, map[string]any{"code": "RC", "name": "Root canal", "category": "general"}), 403, "NOT_ALLOWED", "dentist moves to general")
	var price string
	one(t, `SELECT price::text FROM service_items WHERE id = $1`, &price, blUUID(t, id.PrefixServiceItem, dental))
	if !payEq(payNum(t, price), 4500) {
		t.Fatalf("dentist's edit not stored: price %s", price)
	}
	for _, path := range []string{"/active", "/default"} {
		blExpect(t, doctor.Do("PUT", "/billing/services/"+dental+path, map[string]any{}), 403, "FORBIDDEN_PERMISSION", "dentist "+path)
	}
	blExpect(t, doctor.Do("DELETE", "/billing/services/"+dental, nil), 403, "FORBIDDEN_PERMISSION", "dentist delete")
	blExpect(t, srv.As(t, clinic, "nurse").Do("POST", "/billing/services", map[string]any{"code": "N", "name": "N", "category": "dental"}), 403, "FORBIDDEN_PERMISSION", "nurse create dental")
}

// TestREG_BILL_003_ServiceProvidersFilterTheAssignList: Given a service assigned to the
// dentist, Then the editor reads back exactly that staff list, reception's
// /billing/providers returns the dentist by name for that service, replacing the list
// with none empties it, and malformed ids are refused.
func TestREG_BILL_003_ServiceProvidersFilterTheAssignList(t *testing.T) {
	clinic := payClinic(t)
	mgr, recp := srv.As(t, clinic, "branch_manager"), srv.As(t, clinic, "receptionist")
	svc := blService(t, mgr, "Scaling", "dental", 800, "")
	svc2 := blService(t, mgr, "Whitening", "dental", 900, "")
	doc := clinic.Staff["doctor"]

	var got struct {
		UserIDs []string `json:"user_ids"`
	}
	mgr.Do("GET", "/billing/services/"+svc+"/providers", nil).Expect(t, 200, "providers (none)").Decode(t, &got)
	if len(got.UserIDs) != 0 {
		t.Fatalf("new service already has providers %v", got.UserIDs)
	}
	blExpect(t, mgr.Do("PUT", "/billing/services/"+svc+"/providers", map[string]any{"user_ids": []string{blUser(doc), blUser(doc)}}), 204, "", "set providers")
	blExpect(t, mgr.Do("PUT", "/billing/services/"+svc2+"/providers", map[string]any{"user_ids": []string{blUser(doc), blUser(clinic.Staff["nurse"])}}), 204, "", "set providers 2")
	mgr.Do("GET", "/billing/services/"+svc+"/providers", nil).Expect(t, 200, "providers").Decode(t, &got)
	if len(got.UserIDs) != 1 || got.UserIDs[0] != blUser(doc) {
		t.Fatalf("providers %v, want just the dentist once", got.UserIDs)
	}

	var provs []struct {
		ID       string `json:"id"`
		FullName string `json:"full_name"`
	}
	recp.Do("GET", "/billing/providers?services="+svc+","+svc2+",%20", nil).Expect(t, 200, "providers for services").Decode(t, &provs)
	if len(provs) != 2 || provs[0].FullName == "" {
		t.Fatalf("providers for two services: %+v, want the dentist and the nurse once each, named", provs)
	}
	recp.Do("GET", "/billing/providers?services=", nil).Expect(t, 200, "no services").Decode(t, &provs)
	if len(provs) != 0 {
		t.Fatalf("no services asked, got providers %+v", provs)
	}
	blExpect(t, recp.Do("GET", "/billing/providers?services=bad", nil), 400, "VALIDATION_FAILED", "bad service id")

	blExpect(t, mgr.Do("PUT", "/billing/services/"+svc+"/providers", map[string]any{"user_ids": []string{}}), 204, "", "clear providers")
	mgr.Do("GET", "/billing/services/"+svc+"/providers", nil).Expect(t, 200, "providers cleared").Decode(t, &got)
	if len(got.UserIDs) != 0 {
		t.Fatalf("clearing left providers %v", got.UserIDs)
	}
	blExpect(t, mgr.Do("PUT", "/billing/services/"+svc+"/providers", map[string]any{"user_ids": []string{"usr_bad"}}), 400, "VALIDATION_FAILED", "bad user id")
	blExpect(t, mgr.Do("PUT", "/billing/services/bad/providers", nil), 400, "VALIDATION_FAILED", "bad service id on PUT")
	blExpect(t, mgr.Do("GET", "/billing/services/bad/providers", nil), 400, "VALIDATION_FAILED", "bad service id on GET")
	blExpect(t, recp.Do("GET", "/billing/services/"+svc+"/providers", nil), 403, "FORBIDDEN_PERMISSION", "receptionist reads editor list")
	blExpect(t, srv.As(t, clinic, "doctor").Do("GET", "/billing/providers?services="+svc, nil), 403, "FORBIDDEN_PERMISSION", "dentist (no payment.charge)")
}

// ---- raising charges ----

// TestREG_BILL_010_RaiseChargeRules: Given the desk, When it raises charges, Then a
// valid one is stored pending with its amount and branch, an unknown source is stored
// as 'service', malformed input is refused, a clinician-only service cannot be raised
// by reception, a deleted service is refused, and a dentist (no payment.charge) cannot
// raise at all.
func TestREG_BILL_010_RaiseChargeRules(t *testing.T) {
	clinic := payClinic(t)
	recp, mgr := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "branch_manager")
	p := createPatient(t, recp, uniq("Raise"), "Rules")
	var out struct {
		ID string `json:"id"`
	}
	recp.Do("POST", "/billing/charges", map[string]any{
		"patient_id": p.ID, "source": "nonsense", "description": "Filling", "amount": 650.5, "branch_id": payBranch(t, clinic),
	}).Expect(t, 201, "raise").Decode(t, &out)
	var src, amt, status string
	var branch uuid.UUID
	uid := blUUID(t, id.PrefixCharge, out.ID)
	one(t, `SELECT source FROM charges WHERE id=$1`, &src, uid)
	one(t, `SELECT amount::text FROM charges WHERE id=$1`, &amt, uid)
	one(t, `SELECT status FROM charges WHERE id=$1`, &status, uid)
	one(t, `SELECT branch_id FROM charges WHERE id=$1`, &branch, uid)
	if src != "service" || amt != "650.50" || status != "pending" || branch != clinic.BranchID {
		t.Fatalf("raised charge: source=%s amount=%s status=%s branch=%v", src, amt, status, branch)
	}

	cases := []struct {
		body map[string]any
		what string
	}{
		{map[string]any{"description": "x", "amount": 1}, "no patient"},
		{map[string]any{"patient_id": "pat_bad", "description": "x"}, "bad patient id"},
		{map[string]any{"patient_id": p.ID, "description": "x", "amount": -1}, "negative amount"},
		{map[string]any{"patient_id": p.ID, "description": "  "}, "no description"},
		{map[string]any{"patient_id": p.ID, "description": "x", "branch_id": "brn_bad"}, "bad branch"},
		{map[string]any{"patient_id": p.ID, "description": "x", "encounter_id": "bad"}, "bad encounter"},
		{map[string]any{"patient_id": p.ID, "description": "x", "provider_id": "bad"}, "bad provider"},
		{map[string]any{"patient_id": p.ID, "description": "x", "department_id": "bad"}, "bad department"},
		{map[string]any{"patient_id": p.ID, "description": "x", "service_item_id": "bad"}, "bad service"},
	}
	for _, c := range cases {
		blExpect(t, recp.Do("POST", "/billing/charges", c.body), 400, "VALIDATION_FAILED", c.what)
	}

	clin := blService(t, mgr, "Extraction", "dental", 1500, "clinician")
	blExpect(t, recp.Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "description": "Extraction", "amount": 1500, "service_item_id": clin}),
		403, "CLINICIAN_ONLY", "reception raises a clinician-only service")
	gone := blService(t, mgr, "Old", "general", 10, "")
	mgr.Do("DELETE", "/billing/services/"+gone, nil).Expect(t, 204, "delete")
	blExpect(t, recp.Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "description": "Old", "amount": 10, "service_item_id": gone}),
		400, "VALIDATION_FAILED", "raise a deleted service")
	blExpect(t, srv.As(t, clinic, "doctor").Do("POST", "/billing/charges", map[string]any{"patient_id": p.ID, "description": "x"}), 403, "FORBIDDEN_PERMISSION", "dentist raises")

	var n int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1`, &n, blPatientUUID(t, p))
	if n != 1 {
		t.Fatalf("refused raises wrote rows: %d charges, want 1", n)
	}
}

// TestREG_BILL_011_BatchRegistersAVisitOnce: Given reception registering a whole visit,
// Then every line is written routed (branch + department) under one call; a second
// registration while the first is unpaid is refused with nothing written; once paid,
// the patient is in today's queue, and registering again is refused as an active
// visit. Malformed batches write nothing.
func TestREG_BILL_011_BatchRegistersAVisitOnce(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier")
	p := createPatient(t, recp, uniq("Batch"), "Visit")
	body := func(items ...map[string]any) map[string]any {
		return map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic),
			"provider_id": blUser(clinic.Staff["doctor"]), "items": items}
	}
	bad := []struct {
		body map[string]any
		what string
	}{
		{map[string]any{"patient_id": p.ID}, "missing branch/department/items"},
		{map[string]any{"patient_id": "x", "branch_id": payBranch(t, clinic), "department_id": blDept(clinic), "items": []any{}}, "bad patient"},
		{map[string]any{"patient_id": p.ID, "branch_id": "x", "department_id": blDept(clinic), "items": []any{}}, "bad branch"},
		{map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "department_id": "x", "items": []any{}}, "bad department"},
		{map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic), "provider_id": "x", "items": []any{}}, "bad provider"},
		{body(), "no items"},
		{body(map[string]any{"description": "x", "amount": -1}), "negative line"},
		{body(map[string]any{"description": "x", "amount": 1, "service_item_id": "bad"}), "bad service line"},
		{body(map[string]any{"description": "ok", "amount": 1}, map[string]any{"description": "", "amount": 1}), "a line without description"},
	}
	for _, b := range bad {
		blExpect(t, recp.Do("POST", "/billing/charges/batch", b.body), 400, "VALIDATION_FAILED", b.what)
	}
	var n int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1`, &n, blPatientUUID(t, p))
	if n != 0 {
		t.Fatalf("refused batches wrote %d charges (half a visit)", n)
	}

	var out struct {
		IDs []string `json:"ids"`
	}
	recp.Do("POST", "/billing/charges/batch", body(
		map[string]any{"description": "Registration", "amount": 100, "source": "consultation"},
		map[string]any{"description": "Exam", "amount": 250},
	)).Expect(t, 201, "batch").Decode(t, &out)
	if len(out.IDs) != 2 {
		t.Fatalf("batch returned %d ids, want 2", len(out.IDs))
	}
	var routed int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1 AND status = 'pending' AND branch_id = $2 AND department_id = $3`,
		&routed, blPatientUUID(t, p), clinic.BranchID, clinic.DeptID)
	if routed != 2 {
		t.Fatalf("%d routed pending lines, want 2", routed)
	}

	blExpect(t, recp.Do("POST", "/billing/charges/batch", body(map[string]any{"description": "Exam", "amount": 250})),
		409, "PATIENT_HAS_PENDING_CHARGES", "second registration while unpaid")
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1`, &n, blPatientUUID(t, p))
	if n != 2 {
		t.Fatalf("duplicate registration wrote lines: %d charges, want 2", n)
	}

	// Paying the visit sends the patient to the chair (advanceIfPaid), once.
	paySettle(cashier, out.IDs[0]).Expect(t, 204, "settle line 1")
	var q int
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id = $1`, &q, blPatientUUID(t, p))
	if q != 0 {
		t.Fatalf("patient queued with a line of the visit still unpaid")
	}
	paySettle(cashier, out.IDs[1]).Expect(t, 204, "settle line 2")
	var stage, prov string
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id = $1 AND state = 'waiting'`, &q, blPatientUUID(t, p))
	one(t, `SELECT stage FROM queue_entries WHERE patient_id = $1`, &stage, blPatientUUID(t, p))
	one(t, `SELECT coalesce(assigned_provider_id::text,'') FROM queue_entries WHERE patient_id = $1`, &prov, blPatientUUID(t, p))
	if q != 1 || stage != "with_doctor" || prov != clinic.Staff["doctor"].ID.String() {
		t.Fatalf("after paying the visit: %d queue entries, stage %s, provider %s; want 1 with_doctor for the dentist", q, stage, prov)
	}
	blExpect(t, recp.Do("POST", "/billing/charges/batch", body(map[string]any{"description": "Exam", "amount": 250})),
		409, "PATIENT_HAS_ACTIVE_VISIT", "registration while in today's queue")

	// A clinic that requires triage routes every paid visit to triage, provider unset.
	blExec(t, `UPDATE clinics SET triage_required = true WHERE tenant_id = $1`, clinic.TenantID)
	p2 := createPatient(t, recp, uniq("Batch"), "Triage")
	var out2 struct {
		IDs []string `json:"ids"`
	}
	recp.Do("POST", "/billing/charges/batch", map[string]any{"patient_id": p2.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic),
		"provider_id": blUser(clinic.Staff["doctor"]), "items": []map[string]any{{"description": "Exam", "amount": 250}}}).
		Expect(t, 201, "batch 2").Decode(t, &out2)
	paySettle(cashier, out2.IDs[0]).Expect(t, 204, "settle")
	one(t, `SELECT stage || '|' || coalesce(assigned_provider_id::text,'') FROM queue_entries WHERE patient_id = $1`, &stage, blPatientUUID(t, p2))
	if stage != "triage|" {
		t.Fatalf("triage-required clinic queued the patient as %q, want triage with no provider", stage)
	}
	blExpect(t, srv.As(t, clinic, "doctor").Do("POST", "/billing/charges/batch", body()), 403, "FORBIDDEN_PERMISSION", "dentist batch")
}

// TestREG_BILL_012_WorklistAndLedger: Given a patient with paid, refunded, pending,
// waived and void charges, Then the cashier worklist shows only the pending one with
// the patient's name and MRN, and the patient ledger's totals are exact: charged
// excludes waived/void, paid is net of refunds, awaiting is the pending amount.
func TestREG_BILL_012_WorklistAndLedger(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Ledger"), "Mix")
	paid := payRaise(t, cashier, clinic, p.ID, 100)
	paySettle(cashier, paid).Expect(t, 204, "settle 100")
	refunded := payRaise(t, cashier, clinic, p.ID, 200)
	paySettle(cashier, refunded).Expect(t, 204, "settle 200")
	mgr.Do("POST", "/billing/charges/"+refunded+"/refund", map[string]any{"reason": "redo"}).Expect(t, 204, "refund 200")
	pending := payRaise(t, cashier, clinic, p.ID, 300)
	waived := payRaise(t, cashier, clinic, p.ID, 50)
	cashier.Do("POST", "/billing/charges/"+waived+"/waive", map[string]any{"reason": "Staff / dependent"}).Expect(t, 204, "waive")
	void := payRaise(t, cashier, clinic, p.ID, 70)
	cashier.Do("POST", "/billing/charges/"+void+"/void", map[string]any{"reason": "keyed twice"}).Expect(t, 204, "void")

	var wl []struct {
		ID          string `json:"id"`
		PatientID   string `json:"patient_id"`
		PatientName string `json:"patient_name"`
		MRN         string `json:"mrn"`
		Amount      string `json:"amount"`
		Currency    string `json:"currency"`
	}
	cashier.Do("GET", "/billing/charges/pending", nil).Expect(t, 200, "worklist").Decode(t, &wl)
	if len(wl) != 1 || wl[0].ID != pending || wl[0].PatientID != p.ID || wl[0].MRN != p.MRN ||
		wl[0].PatientName != p.FirstName+" "+p.LastName || wl[0].Currency != "ETB" || !payEq(payNum(t, wl[0].Amount), 300) {
		t.Fatalf("worklist %+v, want only the pending 300 for %s (%s)", wl, p.FirstName, p.MRN)
	}

	var led struct {
		Rows []struct {
			ID          string `json:"id"`
			Status      string `json:"status"`
			Source      string `json:"source"`
			ReceiptNo   *int64 `json:"receipt_no"`
			SettledBy   string `json:"settled_by"`
			WaiveReason string `json:"waive_reason"`
		} `json:"rows"`
		Charged    string `json:"charged"`
		Paid       string `json:"paid"`
		Refunded   string `json:"refunded"`
		Awaiting   string `json:"awaiting"`
		Waived     string `json:"waived"`
		TotalCount int    `json:"total_count"`
		Truncated  bool   `json:"truncated"`
	}
	mgr.Do("GET", "/billing/charges?patient="+p.ID, nil).Expect(t, 200, "ledger").Decode(t, &led)
	if !payEq(payNum(t, led.Charged), 600) || !payEq(payNum(t, led.Paid), 100) || !payEq(payNum(t, led.Refunded), 200) ||
		!payEq(payNum(t, led.Awaiting), 300) || !payEq(payNum(t, led.Waived), 50) || led.TotalCount != 6 || led.Truncated || len(led.Rows) != 6 {
		t.Fatalf("ledger charged=%s paid=%s refunded=%s awaiting=%s waived=%s count=%d rows=%d; want 600/100/200/300/50/6/6",
			led.Charged, led.Paid, led.Refunded, led.Awaiting, led.Waived, led.TotalCount, len(led.Rows))
	}
	for _, r := range led.Rows {
		if r.ID == paid && (r.ReceiptNo == nil || r.SettledBy == "" || r.Status != "paid") {
			t.Fatalf("paid row lacks receipt or the cashier's name: %+v", r)
		}
		if r.ID == waived && r.WaiveReason != "Staff / dependent" {
			t.Fatalf("waived row reason %q", r.WaiveReason)
		}
	}
	blExpect(t, cashier.Do("GET", "/billing/charges", nil), 400, "VALIDATION_FAILED", "ledger without patient")
	blExpect(t, srv.As(t, clinic, "doctor").Do("GET", "/billing/charges?patient="+p.ID, nil), 403, "FORBIDDEN_PERMISSION", "dentist reads ledger")
	blExpect(t, srv.As(t, clinic, "receptionist").Do("GET", "/billing/charges/pending", nil), 403, "FORBIDDEN_PERMISSION", "reception reads worklist")
}

// ---- settling: methods, rails, references ----

// TestREG_BILL_020_SettleRecordsHowTheMoneyArrived: Given the clinic's payment rails,
// When the cashier settles with each, Then the rail key is the stored method, a cash
// rail drops a reference, a transfer keeps it, the legacy free-text method still
// works (blank = cash), and an unknown, malformed, switched-off or reference-needing
// rail without a reference is refused with the charge left pending.
func TestREG_BILL_020_SettleRecordsHowTheMoneyArrived(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	rails := blRails(t, cashier)
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Rail"), "Payer")
	settle := func(body map[string]any) (string, testkit.Resp) {
		cid := payRaise(t, cashier, clinic, p.ID, 100)
		return cid, cashier.Do("POST", "/billing/charges/"+cid+"/settle", body)
	}
	row := func(cid string) (method, rail, ref string) {
		u := blUUID(t, id.PrefixCharge, cid)
		one(t, `SELECT coalesce(payment_method,'') FROM charges WHERE id=$1`, &method, u)
		one(t, `SELECT coalesce(payment_rail_id::text,'') FROM charges WHERE id=$1`, &rail, u)
		one(t, `SELECT coalesce(payment_reference,'') FROM charges WHERE id=$1`, &ref, u)
		return
	}

	c1, r := settle(map[string]any{"rail_id": rails["cash"], "reference": "IGNORED"})
	blExpect(t, r, 204, "", "cash rail")
	if m, rl, ref := row(c1); m != "cash" || rl != blUUID(t, id.PrefixPaymentRail, rails["cash"]).String() || ref != "" {
		t.Fatalf("cash settle stored method=%s rail=%s ref=%q; want cash, the rail, no reference", m, rl, ref)
	}
	c2, r := settle(map[string]any{"rail_id": rails["transfer"], "reference": " FT-" + uniq("") + " "})
	blExpect(t, r, 204, "", "transfer rail")
	if m, _, ref := row(c2); m != "transfer" || ref == "" || strings.HasPrefix(ref, " ") {
		t.Fatalf("transfer settle stored method=%s ref=%q; want transfer and the trimmed reference", m, ref)
	}
	var claimed int64
	one(t, `SELECT count(*) FROM payment_references WHERE tenant_id=$1 AND receipt_no=$2`, &claimed, clinic.TenantID, blReceipt(t, c2))
	if claimed != 1 {
		t.Fatalf("transfer reference not recorded against its receipt")
	}
	c3, r := settle(map[string]any{"method": "telebirr", "reference": "LEGACY1"})
	blExpect(t, r, 204, "", "legacy method")
	if m, rl, ref := row(c3); m != "telebirr" || rl != "" || ref != "LEGACY1" {
		t.Fatalf("legacy settle stored method=%s rail=%q ref=%q", m, rl, ref)
	}
	c4, r := settle(map[string]any{})
	blExpect(t, r, 204, "", "no method at all")
	if m, _, _ := row(c4); m != "cash" {
		t.Fatalf("blank method stored %q, want cash", m)
	}

	blExec(t, `UPDATE payment_rails SET needs_reference = true WHERE tenant_id = $1 AND key = 'mobile'`, clinic.TenantID)
	blExec(t, `UPDATE payment_rails SET active = false WHERE tenant_id = $1 AND key = 'card'`, clinic.TenantID)
	refusals := []struct {
		body map[string]any
		what string
	}{
		{map[string]any{"rail_id": rails["mobile"]}, "reference-needing rail without one"},
		{map[string]any{"rail_id": rails["mobile"], "reference": "   "}, "blank reference"},
		{map[string]any{"rail_id": rails["card"]}, "switched-off rail"},
		{map[string]any{"rail_id": id.Encode(id.PrefixPaymentRail, uuid.New())}, "unknown rail"},
		{map[string]any{"rail_id": "pmt_bad"}, "malformed rail"},
		{map[string]any{"charge_ids": []string{"bad"}}, "malformed charge id in body"},
	}
	for _, f := range refusals {
		cid, r := settle(f.body)
		blExpect(t, r, 400, "VALIDATION_FAILED", f.what)
		if s := blStatus(t, cid); s != "pending" {
			t.Fatalf("%s: refused settle left the charge %s", f.what, s)
		}
	}
	blExpect(t, cashier.Do("POST", "/billing/charges/chg_bad/settle", nil), 400, "VALIDATION_FAILED", "malformed charge path")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+id.Encode(id.PrefixCharge, uuid.New())+"/settle", map[string]any{"method": "cash"}),
		409, "ALREADY_SETTLED", "unknown charge")
	blExpect(t, srv.As(t, clinic, "receptionist").Do("POST", "/billing/charges/"+c1+"/settle", nil), 403, "FORBIDDEN_PERMISSION", "reception settles")
}

// TestREG_BILL_021_ATransferReferencePaysOnce: Given a transfer reference that paid a
// receipt, Then the same reference — retyped in another case or with spaces, on a
// single settle or a checkout — is refused REFERENCE_USED naming the receipt, and the
// second charge stays pending. A reference the desk checked first (an unsettled
// verification row) is claimed by the settle, then refused for the next one.
func TestREG_BILL_021_ATransferReferencePaysOnce(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	rails := blRails(t, cashier)
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Ref"), "Once")
	ref := "FT" + strings.ToUpper(uniq(""))

	a := payRaise(t, cashier, clinic, p.ID, 400)
	cashier.Do("POST", "/billing/charges/"+a+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref}).Expect(t, 204, "first use")
	receipt := blReceipt(t, a)

	b := payRaise(t, cashier, clinic, p.ID, 400)
	for _, again := range []string{ref, " " + strings.ToLower(ref) + " "} {
		r := cashier.Do("POST", "/billing/charges/"+b+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": again})
		blExpect(t, r, 409, "REFERENCE_USED", "reuse "+again)
		if !strings.Contains(r.Message, fmt.Sprintf("#%d", receipt)) {
			t.Fatalf("refusal %q does not name receipt #%d", r.Message, receipt)
		}
	}
	blExpect(t, cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "rail_id": rails["transfer"], "reference": ref}),
		409, "REFERENCE_USED", "reuse on checkout")
	if s := blStatus(t, b); s != "pending" {
		t.Fatalf("charge settled on a reused reference: %s", s)
	}

	// Checked before collecting: the verification row exists without a receipt.
	ref2 := "FT" + strings.ToUpper(uniq(""))
	blExec(t, `INSERT INTO payment_references (tenant_id, payment_rail_id, reference, reference_norm, verify_state, verify_reason)
	           VALUES ($1, $2, $3, upper(btrim($3)), 'review', 'looks fine')`, clinic.TenantID, blUUID(t, id.PrefixPaymentRail, rails["transfer"]), ref2)
	cashier.Do("POST", "/billing/charges/"+b+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref2}).Expect(t, 204, "settle a checked reference")
	var claimedBy *int64
	one(t, `SELECT receipt_no FROM payment_references WHERE tenant_id=$1 AND reference=$2`, &claimedBy, clinic.TenantID, ref2)
	if claimedBy == nil || *claimedBy != blReceipt(t, b) {
		t.Fatalf("checked reference not claimed by the receipt that used it: %v", claimedBy)
	}
	c := payRaise(t, cashier, clinic, p.ID, 400)
	blExpect(t, cashier.Do("POST", "/billing/charges/"+c+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref2}),
		409, "REFERENCE_USED", "reuse of a checked-then-claimed reference")
}

// TestREG_BILL_022_TwoDesksOneReference (FIN-3): Given two patients each owing 400,
// When two desks settle them at the same instant with the same transfer reference,
// Then exactly one is taken and the other is refused REFERENCE_USED — both for a fresh
// reference and for one the desk had checked first (an unclaimed verification row,
// the path audit FIN-3 points at in kernel/payments ClaimReference). Today the two
// settles serialise on the per-clinic receipt counter (billing.sql NextReceiptNo takes
// a row lock before ClaimReference), which is what keeps this true; a change that moves
// the claim ahead of the counter, or drops the counter lock, fails here.
func TestREG_BILL_022_TwoDesksOneReference(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	rails := blRails(t, cashier)
	recp := srv.As(t, clinic, "receptionist")
	rail := blUUID(t, id.PrefixPaymentRail, rails["transfer"])
	for i := 0; i < 8; i++ {
		prechecked := i%2 == 1
		ref := "FT" + strings.ToUpper(uniq(""))
		if prechecked {
			blExec(t, `INSERT INTO payment_references (tenant_id, payment_rail_id, reference, reference_norm, verify_state)
			           VALUES ($1, $2, $3, upper(btrim($3)), 'review')`, clinic.TenantID, rail, ref)
		}
		a := payRaise(t, cashier, clinic, createPatient(t, recp, uniq("DeskA"), "P").ID, 400)
		b := payRaise(t, cashier, clinic, createPatient(t, recp, uniq("DeskB"), "P").ID, 400)
		body := map[string]any{"rail_id": rails["transfer"], "reference": ref}
		var rs []testkit.Resp
		if i%4 < 2 {
			rs = blRace(
				func() testkit.Resp { return cashier.Do("POST", "/billing/charges/"+a+"/settle", body) },
				func() testkit.Resp { return mgr.Do("POST", "/billing/charges/"+b+"/settle", body) },
			)
		} else {
			// The same race through one-click checkout.
			pa, pb := map[string]any{"rail_id": rails["transfer"], "reference": ref, "charge_ids": []string{a}},
				map[string]any{"rail_id": rails["transfer"], "reference": ref, "charge_ids": []string{b}}
			var ida, idb string
			one(t, `SELECT patient_id::text FROM charges WHERE id=$1`, &ida, blUUID(t, id.PrefixCharge, a))
			one(t, `SELECT patient_id::text FROM charges WHERE id=$1`, &idb, blUUID(t, id.PrefixCharge, b))
			pa["patient_id"] = id.Encode(id.PrefixPatient, uuid.MustParse(ida))
			pb["patient_id"] = id.Encode(id.PrefixPatient, uuid.MustParse(idb))
			rs = blRace(
				func() testkit.Resp { return cashier.Do("POST", "/billing/checkout", pa) },
				func() testkit.Resp { return mgr.Do("POST", "/billing/checkout", pb) },
			)
		}
		won, refused := 0, 0
		for _, r := range rs {
			switch {
			case r.Status == 204 || r.Status == 200:
				won++
			case r.Status == 409 && r.Code == "REFERENCE_USED":
				refused++
			default:
				t.Fatalf("race %d: unexpected HTTP %d %s", i, r.Status, r.Code)
			}
		}
		var paid int
		one(t, `SELECT count(*) FROM charges WHERE tenant_id=$1 AND payment_reference=$2 AND status='paid'`, &paid, clinic.TenantID, ref)
		if won != 1 || refused != 1 || paid != 1 {
			t.Fatalf("race %d (prechecked=%v): [%s], %d charges paid with the reference; want one taken, one REFERENCE_USED",
				i, prechecked, payDescribe(rs), paid)
		}
	}
}

// TestREG_BILL_023_BankRejectedNeedsAManager (FIN-4): Given a reference the bank
// contradicted, Then a plain settle is refused VERIFY_REJECTED with the bank's
// reason; a user who may collect but not waive cannot force it (403); a payment.waive
// holder can, with a reason — and that reason (and who overrode) is stored with the
// payment event.
func TestREG_BILL_023_BankRejectedNeedsAManager(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	rails := blRails(t, cashier)
	desk := blCustomUser(t, clinic, "payment.collect", "patient.read")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Rejected"), "Transfer")
	ref := "FT" + strings.ToUpper(uniq(""))
	blExec(t, `INSERT INTO payment_references (tenant_id, payment_rail_id, reference, reference_norm, verify_state, verify_reason)
	           VALUES ($1, $2, $3, upper(btrim($3)), 'rejected', 'paid to a different account')`,
		clinic.TenantID, blUUID(t, id.PrefixPaymentRail, rails["transfer"]), ref)
	cid := payRaise(t, cashier, clinic, p.ID, 900)

	r := cashier.Do("POST", "/billing/charges/"+cid+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref})
	blExpect(t, r, 409, "VERIFY_REJECTED", "settle a rejected reference")
	if r.Message != "paid to a different account" {
		t.Fatalf("refusal message %q, want the bank's reason", r.Message)
	}
	blExpect(t, cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "rail_id": rails["transfer"], "reference": ref}),
		409, "VERIFY_REJECTED", "checkout a rejected reference")
	blExpect(t, desk.Do("POST", "/billing/charges/"+cid+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref, "force": true, "force_reason": "x"}),
		403, "FORBIDDEN_PERMISSION", "collect-only user forces")
	blExpect(t, desk.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "rail_id": rails["transfer"], "reference": ref, "force": true}),
		403, "FORBIDDEN_PERMISSION", "collect-only user forces a checkout")
	if s := blStatus(t, cid); s != "pending" {
		t.Fatalf("refused forces left the charge %s", s)
	}
	reason := "patient showed the bank SMS " + uniq("")
	cashier.Do("POST", "/billing/charges/"+cid+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref, "force": true, "force_reason": reason}).
		Expect(t, 204, "manager forces")
	if s := blStatus(t, cid); s != "paid" {
		t.Fatalf("forced settle left the charge %s", s)
	}
	var overrideReason, overrideBy *string
	one(t, `SELECT override_reason FROM payment_references WHERE tenant_id=$1 AND reference=$2`, &overrideReason, clinic.TenantID, ref)
	one(t, `SELECT override_by::text FROM payment_references WHERE tenant_id=$1 AND reference=$2`, &overrideBy, clinic.TenantID, ref)
	var anywhere int
	one(t, `SELECT (SELECT count(*) FROM event_outbox WHERE tenant_id=$1 AND payload::text LIKE '%'||$2||'%')
	             + (SELECT count(*) FROM audit_logs WHERE tenant_id=$1 AND payload::text LIKE '%'||$2||'%')`, &anywhere, clinic.TenantID, reason)
	if overrideReason == nil || *overrideReason != reason || overrideBy == nil {
		testkit.KnownBug(t, "FIN-4", true, fmt.Sprintf(
			"override of a bank-rejected payment stored override_reason=%v override_by=%v (reason found in %d events/audit rows); "+
				"billing/http/handlers.go:520 reads force_reason and nothing writes it", overrideReason, overrideBy, anywhere))
	}
	testkit.KnownBug(t, "FIN-4", false, "a forced settle stores who overrode and why")
}

// TestREG_BILL_024_ReceiptCheckWhenTheBankIsUnreachable: Given Verify.ET is not
// configured (as in tests), Then the desk is told verification is unavailable, a check
// answers "unchecked" with a reason (cash: nothing to check; a provider rail:
// verification not switched on) and the desk can still take the money; a reference
// already used answers rejected/already_used from our own record; malformed requests
// are refused, and a plan without the feature does not mount it.
func TestREG_BILL_024_ReceiptCheckWhenTheBankIsUnreachable(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	rails := blRails(t, cashier)
	blExec(t, `UPDATE payment_rails SET bank_key = 'cbe', account_number = '1000123' WHERE tenant_id = $1 AND key = 'transfer'`, clinic.TenantID)
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Verify"), "Desk")

	var st struct {
		Available *bool `json:"available"`
	}
	cashier.Do("GET", "/billing/verify-payment/status", nil).Expect(t, 200, "status").Decode(t, &st)
	// The suite's API runs with a stand-in bank key (internal/testkit/fakebank.go), so the
	// desk is offered the check; a bank that cannot be reached is the next assertions.
	if st.Available == nil || !*st.Available {
		t.Fatalf("verification status %v, want available=true with the stand-in bank configured", st.Available)
	}
	type verdict struct {
		State       string `json:"state"`
		Reason      string `json:"reason"`
		AlreadyUsed bool   `json:"already_used"`
	}
	check := func(body map[string]any) verdict {
		var v verdict
		cashier.Do("POST", "/billing/verify-payment", body).Expect(t, 200, "verify").Decode(t, &v)
		return v
	}
	ref := "FT" + strings.ToUpper(uniq(""))
	if v := check(map[string]any{"rail_id": rails["cash"], "reference": ref}); v.State != "unchecked" || !strings.Contains(v.Reason, "no bank") {
		t.Fatalf("cash check: %+v, want unchecked (nothing to check against)", v)
	}
	if v := check(map[string]any{"rail_id": rails["transfer"], "reference": ref, "expected": "500", "patient_id": p.ID}); v.State != "unchecked" || !strings.Contains(v.Reason, "bank check") {
		t.Fatalf("transfer check with no verifier: %+v, want unchecked (vendor unavailable)", v)
	}
	var rows int
	one(t, `SELECT count(*) FROM payment_references WHERE tenant_id=$1 AND reference=$2`, &rows, clinic.TenantID, ref)
	if rows != 0 {
		t.Fatalf("an unchecked verification wrote a payment_references row")
	}
	// "Could not check" never stops the desk taking the money.
	cid := payRaise(t, cashier, clinic, p.ID, 500)
	cashier.Do("POST", "/billing/charges/"+cid+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref}).Expect(t, 204, "settle unchecked")
	if v := check(map[string]any{"rail_id": rails["transfer"], "reference": strings.ToLower(ref)}); v.State != "rejected" || !v.AlreadyUsed ||
		!strings.Contains(v.Reason, fmt.Sprintf("#%d", blReceipt(t, cid))) {
		t.Fatalf("check of a used reference: %+v, want rejected / already_used naming the receipt", v)
	}

	for _, b := range []struct {
		body any
		what string
	}{
		{map[string]any{"reference": ref}, "no rail"},
		{map[string]any{"rail_id": "bad", "reference": ref}, "malformed rail"},
		{map[string]any{"rail_id": id.Encode(id.PrefixPaymentRail, uuid.New()), "reference": ref}, "unknown rail"},
		{map[string]any{"rail_id": rails["transfer"], "reference": "  "}, "no reference"},
		{"not an object", "malformed body"},
	} {
		blExpect(t, cashier.Do("POST", "/billing/verify-payment", b.body), 400, "VALIDATION_FAILED", b.what)
	}
	blExpect(t, srv.As(t, clinic, "receptionist").Do("POST", "/billing/verify-payment", map[string]any{}), 403, "FORBIDDEN_PERMISSION", "reception verifies")

	chair := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-chair"})
	cc := srv.As(t, chair, "cashier")
	blExpect(t, cc.Do("GET", "/billing/verify-payment/status", nil), 403, "MODULE_DISABLED", "status on a plan without verification")
	blExpect(t, cc.Do("POST", "/billing/verify-payment", map[string]any{}), 403, "MODULE_DISABLED", "verify on a plan without verification")
}

// ---- checkout ----

// TestREG_BILL_030_CheckoutTakesOnlyWhatTheButtonSays (FIN-5): Given a patient owing
// 1,200 from last month and 300 today, When the desk checks out naming today's charge,
// Then exactly 300 is taken and the old debt stays pending; naming another patient's
// charge takes nothing. Without charge_ids the checkout sweeps everything — which is
// why the bank's verified amount must be held against the total: a reference verified
// for 300 must not settle 1,500.
func TestREG_BILL_030_CheckoutTakesOnlyWhatTheButtonSays(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	rails := blRails(t, cashier)
	recp := srv.As(t, clinic, "receptionist")
	p := createPatient(t, recp, uniq("Old"), "Debt")
	old := payRaise(t, cashier, clinic, p.ID, 1200)
	today := payRaise(t, cashier, clinic, p.ID, 300)
	stranger := payRaise(t, cashier, clinic, createPatient(t, recp, uniq("Other"), "Patient").ID, 50)

	var out struct {
		ReceiptNo int64  `json:"receipt_no"`
		Total     string `json:"total"`
		Count     int    `json:"count"`
	}
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "rail_id": rails["cash"], "charge_ids": []string{today}}).
		Expect(t, 200, "scoped checkout").Decode(t, &out)
	if out.Count != 1 || !payEq(payNum(t, out.Total), 300) || blStatus(t, today) != "paid" || blStatus(t, old) != "pending" {
		t.Fatalf("scoped checkout %+v: today=%s old=%s; want 300 taken, old debt pending", out, blStatus(t, today), blStatus(t, old))
	}
	blExpect(t, cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "charge_ids": []string{stranger}}),
		409, "NOTHING_PENDING", "checkout naming another patient's charge")
	if blStatus(t, stranger) != "pending" {
		t.Fatalf("another patient's charge was settled")
	}
	blExpect(t, cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "charge_ids": []string{"chg_bad"}}), 400, "VALIDATION_FAILED", "bad charge id")
	blExpect(t, cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": "pat_bad"}), 400, "VALIDATION_FAILED", "bad patient id")
	blExpect(t, cashier.Do("POST", "/billing/checkout", "x"), 400, "VALIDATION_FAILED", "malformed body")
	blExpect(t, cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "rail_id": "bad"}), 400, "VALIDATION_FAILED", "bad rail")
	blExpect(t, recp.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID}), 403, "FORBIDDEN_PERMISSION", "reception checks out")

	// The sweep (FIN-5, fixed 2026-10-10): a transfer the bank confirmed as 300 must
	// not settle 1,500. Refused whole, nothing marked paid, the reference still free.
	p2 := createPatient(t, recp, uniq("Sweep"), "Debt")
	oldDebt := payRaise(t, cashier, clinic, p2.ID, 1200)
	todaysFee := payRaise(t, cashier, clinic, p2.ID, 300)
	ref := "FT" + strings.ToUpper(uniq(""))
	blExec(t, `INSERT INTO payment_references (tenant_id, payment_rail_id, reference, reference_norm, verify_state, verified_amount)
	           VALUES ($1, $2, $3, upper(btrim($3)), 'verified', 300)`, clinic.TenantID, blUUID(t, id.PrefixPaymentRail, rails["transfer"]), ref)
	r := cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p2.ID, "rail_id": rails["transfer"], "reference": ref})
	blExpect(t, r, 409, "AMOUNT_EXCEEDS_VERIFIED", "a 1,500 sweep against a 300 confirmed transfer")
	if !strings.Contains(r.Message, "300.00") || !strings.Contains(r.Message, "1500.00") {
		t.Fatalf("the refusal does not say what the bank confirmed and what was being settled: %q", r.Message)
	}
	if blStatus(t, oldDebt) != "pending" || blStatus(t, todaysFee) != "pending" {
		t.Fatalf("a refused sweep left charges settled: old=%s today=%s", blStatus(t, oldDebt), blStatus(t, todaysFee))
	}
	var receipt *int64
	one(t, `SELECT receipt_no FROM payment_references WHERE tenant_id = $1 AND reference_norm = upper(btrim($2))`, &receipt, clinic.TenantID, ref)
	if receipt != nil {
		t.Fatalf("a refused sweep still claimed the reference for receipt %d", *receipt)
	}
	// The right way: today's 300 against the transfer, the old debt by cash.
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p2.ID, "rail_id": rails["transfer"], "reference": ref, "charge_ids": []string{todaysFee}}).
		Expect(t, 200, "collect exactly what the transfer covers").Decode(t, &out)
	if !payEq(payNum(t, out.Total), 300) || blStatus(t, todaysFee) != "paid" || blStatus(t, oldDebt) != "pending" {
		t.Fatalf("scoped collect %+v: today=%s old=%s", out, blStatus(t, todaysFee), blStatus(t, oldDebt))
	}
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p2.ID, "rail_id": rails["cash"]}).
		Expect(t, 200, "the old debt by cash").Decode(t, &out)
	if !payEq(payNum(t, out.Total), 1200) || blStatus(t, oldDebt) != "paid" {
		t.Fatalf("old debt by cash %+v: %s", out, blStatus(t, oldDebt))
	}
}

// TestREG_BILL_031_ASettlementNeverExceedsWhatTheBankConfirmed (FIN-5): the rule at its
// edges and on every door that records a reference. A bill equal to the confirmed
// amount goes through; one cent over is refused; a reference the bank did NOT
// confirm, or confirmed with no amount, is not compared (nothing to compare with);
// a single-charge settle is held to the same rule as a whole-visit one.
func TestREG_BILL_031_ASettlementNeverExceedsWhatTheBankConfirmed(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	rails := blRails(t, cashier)
	recp := srv.As(t, clinic, "receptionist")
	rail := blUUID(t, id.PrefixPaymentRail, rails["transfer"])
	mk := func(state string, amount any) string {
		ref := "FT" + strings.ToUpper(uniq(""))
		blExec(t, `INSERT INTO payment_references (tenant_id, payment_rail_id, reference, reference_norm, verify_state, verified_amount)
		           VALUES ($1, $2, $3, upper(btrim($3)), $4, $5)`, clinic.TenantID, rail, ref, state, amount)
		return ref
	}
	settle := func(chg, ref string) testkit.Resp {
		return cashier.Do("POST", "/billing/charges/"+chg+"/settle", map[string]any{"rail_id": rails["transfer"], "reference": ref})
	}
	pat := func() patientRef { return createPatient(t, recp, uniq("Edge"), "Case") }

	// Equal to the confirmed amount: settled.
	exact := payRaise(t, cashier, clinic, pat().ID, 300)
	settle(exact, mk("verified", 300)).Expect(t, 204, "bill equals the confirmed amount")
	if blStatus(t, exact) != "paid" {
		t.Fatalf("an exact-amount settle did not settle")
	}
	// One cent over: refused, on the single-charge door.
	over := payRaise(t, cashier, clinic, pat().ID, 300.01)
	blExpect(t, settle(over, mk("verified", 300)), 409, "AMOUNT_EXCEEDS_VERIFIED", "one cent over the confirmed amount")
	if blStatus(t, over) != "pending" {
		t.Fatalf("a refused settle marked the charge paid")
	}
	// Under the confirmed amount (the patient sent more than was owed): settled.
	under := payRaise(t, cashier, clinic, pat().ID, 250)
	settle(under, mk("verified", 400)).Expect(t, 204, "bill under the confirmed amount")
	// No bank answer to compare with: not held to an amount that does not exist.
	for _, c := range []struct {
		state  string
		amount any
	}{{"pending", nil}, {"review", 100}, {"verified", nil}} {
		chg := payRaise(t, cashier, clinic, pat().ID, 300)
		if r := settle(chg, mk(c.state, c.amount)); r.Status != 204 {
			t.Fatalf("state %q amount %v: HTTP %d %s, want the old behaviour (settled)", c.state, c.amount, r.Status, r.Code)
		}
	}
}

// TestREG_BILL_032_OneTransferCannotPayTwiceThroughTwoMethods (NEW-KERNEL-PAY-2): Given a
// clinic with two Telebirr numbers (and a generic bank method beside a named CBE account),
// When the cashier enters the same transfer reference against two different bills under the
// two methods, Then the second is refused naming the receipt the first paid, the second bill
// stays unpaid and its reference is free; a different bank's account is not confused with it.
func TestREG_BILL_032_OneTransferCannotPayTwiceThroughTwoMethods(t *testing.T) {
	clinic := payClinic(t)
	cashier, recp := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "receptionist")
	newRail := func(kind, bank string) string {
		var rid uuid.UUID
		key := kind + "-" + uniq("")
		if err := super.Pool.QueryRow(t.Context(),
			`INSERT INTO payment_rails (tenant_id, key, label, kind, bank_key, needs_reference, active)
			 VALUES ($1, $2, $2, $3, nullif($4,''), true, true) RETURNING id`, clinic.TenantID, key, kind, bank).Scan(&rid); err != nil {
			t.Fatal(err)
		}
		return id.Encode(id.PrefixPaymentRail, rid)
	}
	tele1, tele2 := newRail("wallet", "telebirr"), newRail("wallet", "telebirr")
	genericBank, cbe, zemen := newRail("bank", ""), newRail("bank", "cbe"), newRail("bank", "zemen")
	pay := func(rail, ref string, amount float64) (string, testkit.Resp) {
		chg := payRaise(t, cashier, clinic, createPatient(t, recp, uniq("Twice"), "Pay").ID, amount)
		return chg, cashier.Do("POST", "/billing/charges/"+chg+"/settle", map[string]any{"rail_id": rail, "reference": ref})
	}
	ref := "DAB" + strings.ToUpper(uniq(""))

	first, r := pay(tele1, ref, 500)
	r.Expect(t, 204, "the transfer pays a bill")
	second, r := pay(tele2, ref, 500)
	blExpect(t, r, 409, "REFERENCE_USED", "the same Telebirr transfer under the other number")
	if !strings.Contains(r.Message, "receipt #") {
		t.Fatalf("the refusal does not name the receipt it paid: %q", r.Message)
	}
	if blStatus(t, first) != "paid" || blStatus(t, second) != "pending" {
		t.Fatalf("first=%s second=%s, want paid and pending", blStatus(t, first), blStatus(t, second))
	}
	// The refused bill can still be paid with a real, different reference on that number.
	cashier.Do("POST", "/billing/charges/"+second+"/settle", map[string]any{"rail_id": tele2, "reference": ref + "-B"}).
		Expect(t, 204, "the second bill with its own transfer")

	// A generic bank method is the same source as a named bank; two named banks are not.
	bankRef := "FT" + strings.ToUpper(uniq(""))
	_, r = pay(cbe, bankRef, 300)
	r.Expect(t, 204, "a CBE transfer")
	_, r = pay(genericBank, bankRef, 300)
	blExpect(t, r, 409, "REFERENCE_USED", "the same CBE transfer under the generic bank method")
	_, r = pay(zemen, bankRef, 300)
	r.Expect(t, 204, "the same text from a different bank is a different payment")
}

// ---- defer, waive, void, refund ----

// TestREG_BILL_040_DeferLetsThePatientInStillOwing: Given a registered, unpaid visit,
// When a payment.waive holder defers it with a reason, Then the charges stay pending
// and owed (receivables) but the patient is queued; deferring again is NOTHING_TO_DEFER;
// a named subset defers only those; no reason, malformed ids and reception are refused.
func TestREG_BILL_040_DeferLetsThePatientInStillOwing(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, owner := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "owner")
	p := createPatient(t, recp, uniq("Defer"), "Later")
	var out struct {
		IDs []string `json:"ids"`
	}
	recp.Do("POST", "/billing/charges/batch", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic),
		"items": []map[string]any{{"description": "Registration", "amount": 100}, {"description": "Exam", "amount": 200}}}).
		Expect(t, 201, "batch").Decode(t, &out)

	blExpect(t, recp.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "emergency"}), 403, "FORBIDDEN_PERMISSION", "reception defers")
	blExpect(t, cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": " "}), 400, "VALIDATION_FAILED", "no reason")
	blExpect(t, cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", "x"), 400, "VALIDATION_FAILED", "malformed body")
	blExpect(t, cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "r", "charge_ids": []string{"bad"}}), 400, "VALIDATION_FAILED", "bad charge id")
	blExpect(t, cashier.Do("POST", "/billing/patients/bad/defer", map[string]any{"reason": "r"}), 400, "VALIDATION_FAILED", "bad patient id")

	var d struct {
		Deferred int `json:"deferred"`
	}
	cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "staff child", "charge_ids": []string{out.IDs[0]}}).
		Expect(t, 200, "defer one").Decode(t, &d)
	if d.Deferred != 1 {
		t.Fatalf("deferred %d, want 1", d.Deferred)
	}
	var q int
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1`, &q, blPatientUUID(t, p))
	if q != 0 {
		t.Fatalf("patient let in with an undeferred visit line still unpaid")
	}
	cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "staff child"}).Expect(t, 200, "defer the rest").Decode(t, &d)
	if d.Deferred != 1 {
		t.Fatalf("deferring the rest deferred %d, want 1 (the exam)", d.Deferred)
	}
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1 AND state='waiting'`, &q, blPatientUUID(t, p))
	if q != 1 {
		t.Fatalf("deferred visit: %d queue entries, want the patient let in once", q)
	}
	unrouted := payRaise(t, cashier, clinic, p.ID, 50)
	cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "staff child", "charge_ids": []string{unrouted}}).
		Expect(t, 200, "defer an unrouted charge").Decode(t, &d)
	var pending int
	var reason string
	one(t, `SELECT count(*) FROM charges WHERE patient_id=$1 AND status='pending' AND deferred_at IS NOT NULL AND deferred_by IS NOT NULL`, &pending, blPatientUUID(t, p))
	one(t, `SELECT defer_reason FROM charges WHERE id=$1`, &reason, blUUID(t, id.PrefixCharge, unrouted))
	if pending != 3 || reason != "staff child" {
		t.Fatalf("deferred charges: %d pending+deferred (want 3), reason %q", pending, reason)
	}
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); !payEq(payNum(t, got), 350) {
		t.Fatalf("receivables after deferring: owed %q, want 350 (deferred is still owed)", got)
	}
	blExpect(t, cashier.Do("POST", "/billing/patients/"+p.ID+"/defer", map[string]any{"reason": "again"}), 409, "NOTHING_TO_DEFER", "defer again")
	// A deferred charge is still collectable.
	paySettle(cashier, unrouted).Expect(t, 204, "settle a deferred charge")
}

// TestREG_BILL_041_WaiveNeedsAListedReason: Given pending charges, Then the waiver
// reasons list is the clinic's seven, a waive stores its reason and counts as waived,
// a waived or paid charge cannot be waived again (ALREADY_SETTLED), a routed visit
// waived in full lets the patient in, and reception / no reason are refused.
func TestREG_BILL_041_WaiveNeedsAListedReason(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier")
	var reasons []string
	cashier.Do("GET", "/billing/waiver-reasons", nil).Expect(t, 200, "waiver reasons").Decode(t, &reasons)
	want := []string{"Staff / dependent", "Indigent (charity)", "Exemption program", "Courtesy / VIP", "Insurance / credit", "Follow-up", "Other"}
	if strings.Join(reasons, "|") != strings.Join(want, "|") {
		t.Fatalf("waiver reasons %v, want %v", reasons, want)
	}
	blExpect(t, recp.Do("GET", "/billing/waiver-reasons", nil), 403, "FORBIDDEN_PERMISSION", "reception reads waiver reasons")

	p := createPatient(t, recp, uniq("Waive"), "Me")
	var out struct {
		IDs []string `json:"ids"`
	}
	recp.Do("POST", "/billing/charges/batch", map[string]any{"patient_id": p.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic),
		"items": []map[string]any{{"description": "Registration", "amount": 100}}}).Expect(t, 201, "batch").Decode(t, &out)
	blExpect(t, recp.Do("POST", "/billing/charges/"+out.IDs[0]+"/waive", map[string]any{"reason": "Other"}), 403, "FORBIDDEN_PERMISSION", "reception waives")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+out.IDs[0]+"/waive", map[string]any{"reason": ""}), 400, "VALIDATION_FAILED", "no reason")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+out.IDs[0]+"/waive", "x"), 400, "VALIDATION_FAILED", "malformed body")
	blExpect(t, cashier.Do("POST", "/billing/charges/bad/waive", map[string]any{"reason": "Other"}), 400, "VALIDATION_FAILED", "bad id")
	cashier.Do("POST", "/billing/charges/"+out.IDs[0]+"/waive", map[string]any{"reason": "Indigent (charity)"}).Expect(t, 204, "waive")
	var st string
	one(t, `SELECT status || '|' || waive_reason FROM charges WHERE id=$1`, &st, blUUID(t, id.PrefixCharge, out.IDs[0]))
	if st != "waived|Indigent (charity)" {
		t.Fatalf("waived row reads %q", st)
	}
	var q int
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id=$1`, &q, blPatientUUID(t, p))
	if q != 1 {
		t.Fatalf("a fully waived visit did not let the patient in (%d queue entries)", q)
	}
	blExpect(t, cashier.Do("POST", "/billing/charges/"+out.IDs[0]+"/waive", map[string]any{"reason": "Other"}), 409, "ALREADY_SETTLED", "waive twice")
	paid := payRaise(t, cashier, clinic, p.ID, 80)
	paySettle(cashier, paid).Expect(t, 204, "settle")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+paid+"/waive", map[string]any{"reason": "Other"}), 409, "ALREADY_SETTLED", "waive a paid charge")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+paid+"/settle", nil), 409, "ALREADY_SETTLED", "settle a paid charge")
	// Waived money is not collected money.
	ov := payGetOverview(t, srv.As(t, clinic, "owner"), "")
	if !payEq(payNum(t, ov.Waived), 100) || !payEq(payNum(t, ov.Collected), 80) {
		t.Fatalf("overview waived=%s collected=%s, want 100 / 80", ov.Waived, ov.Collected)
	}
}

// TestREG_BILL_042_VoidAndRefundRefusals: Given charges in every state, Then void is
// refused for anything not pending (NOT_PENDING) and for reception; refund is refused
// for a pending charge or a refund row (NOT_REFUNDABLE), an unknown charge (404),
// without a reason, and for a cashier; a refund carries its own receipt number.
func TestREG_BILL_042_VoidAndRefundRefusals(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, mgr := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	p := createPatient(t, recp, uniq("Void"), "Refund")
	pend := payRaise(t, cashier, clinic, p.ID, 100)
	waived := payRaise(t, cashier, clinic, p.ID, 100)
	cashier.Do("POST", "/billing/charges/"+waived+"/waive", map[string]any{"reason": "Other"}).Expect(t, 204, "waive")

	blExpect(t, recp.Do("POST", "/billing/charges/"+pend+"/void", map[string]any{"reason": "x"}), 403, "FORBIDDEN_PERMISSION", "reception voids")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+waived+"/void", map[string]any{"reason": "x"}), 409, "NOT_PENDING", "void a waived charge")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+id.Encode(id.PrefixCharge, uuid.New())+"/void", map[string]any{"reason": "x"}), 409, "NOT_PENDING", "void unknown")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+pend+"/void", "x"), 400, "VALIDATION_FAILED", "void malformed body")
	blExpect(t, cashier.Do("POST", "/billing/charges/bad/void", map[string]any{"reason": "x"}), 400, "VALIDATION_FAILED", "void bad id")

	blExpect(t, mgr.Do("POST", "/billing/charges/"+pend+"/refund", map[string]any{"reason": "x"}), 409, "NOT_REFUNDABLE", "refund a pending charge")
	blExpect(t, mgr.Do("POST", "/billing/charges/"+waived+"/refund", map[string]any{"reason": "x"}), 409, "NOT_REFUNDABLE", "refund a waived charge")
	blExpect(t, mgr.Do("POST", "/billing/charges/"+id.Encode(id.PrefixCharge, uuid.New())+"/refund", map[string]any{"reason": "x"}), 404, "CHARGE_NOT_FOUND", "refund unknown")
	blExpect(t, mgr.Do("POST", "/billing/charges/"+pend+"/refund", "x"), 400, "VALIDATION_FAILED", "refund malformed body")
	blExpect(t, mgr.Do("POST", "/billing/charges/bad/refund", map[string]any{"reason": "x"}), 400, "VALIDATION_FAILED", "refund bad id")

	paid := payRaise(t, cashier, clinic, p.ID, 450)
	paySettle(cashier, paid).Expect(t, 204, "settle")
	blExpect(t, cashier.Do("POST", "/billing/charges/"+paid+"/refund", map[string]any{"reason": "x"}), 403, "FORBIDDEN_PERMISSION", "cashier refunds")
	mgr.Do("POST", "/billing/charges/"+paid+"/refund", map[string]any{"reason": "wrong tooth"}).Expect(t, 204, "refund")
	var revID uuid.UUID
	var revReceipt *int64
	var desc string
	one(t, `SELECT id FROM charges WHERE reverses_charge_id=$1`, &revID, blUUID(t, id.PrefixCharge, paid))
	one(t, `SELECT receipt_no FROM charges WHERE id=$1`, &revReceipt, revID)
	one(t, `SELECT description FROM charges WHERE id=$1`, &desc, revID)
	if revReceipt == nil || *revReceipt <= blReceipt(t, paid) || !strings.Contains(desc, "wrong tooth") {
		t.Fatalf("refund row receipt=%v (orig %d) description=%q; want its own later receipt and the reason", revReceipt, blReceipt(t, paid), desc)
	}
	blExpect(t, mgr.Do("POST", "/billing/charges/"+id.Encode(id.PrefixCharge, revID)+"/refund", map[string]any{"reason": "x"}), 409, "NOT_REFUNDABLE", "refund a refund")
	blExpect(t, mgr.Do("POST", "/billing/charges/"+id.Encode(id.PrefixCharge, revID)+"/void", map[string]any{"reason": "x"}), 409, "NOT_PENDING", "void a refund")
	blExpect(t, mgr.Do("POST", "/billing/charges/"+paid+"/void", map[string]any{"reason": "x"}), 409, "NOT_PENDING", "void a refunded charge")
}

// TestREG_BILL_043_RefundVisitRules: Given a receipt of two lines, one already refunded
// on its own, When a manager refunds the receipt, Then only the remaining line is
// reversed; again is NOTHING_TO_REFUND; an unknown receipt is NOTHING_TO_REFUND; a
// missing receipt or reason is refused; a cashier cannot.
func TestREG_BILL_043_RefundVisitRules(t *testing.T) {
	clinic := payClinic(t)
	recp, cashier, mgr := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	p := createPatient(t, recp, uniq("Receipt"), "Partial")
	a := payRaise(t, cashier, clinic, p.ID, 600)
	payRaise(t, cashier, clinic, p.ID, 400)
	var out struct {
		ReceiptNo int64 `json:"receipt_no"`
	}
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "method": "cash"}).Expect(t, 200, "checkout").Decode(t, &out)
	mgr.Do("POST", "/billing/charges/"+a+"/refund", map[string]any{"reason": "one line"}).Expect(t, 204, "refund one line")

	blExpect(t, cashier.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": out.ReceiptNo, "reason": "x"}), 403, "FORBIDDEN_PERMISSION", "cashier refunds a receipt")
	blExpect(t, mgr.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": 0, "reason": "x"}), 400, "VALIDATION_FAILED", "no receipt")
	blExpect(t, mgr.Do("POST", "/billing/refund-visit", "x"), 400, "VALIDATION_FAILED", "malformed body")
	blExpect(t, mgr.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": out.ReceiptNo, "reason": " "}), 400, "VALIDATION_FAILED", "no reason")
	blExpect(t, mgr.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": 999999, "reason": "x"}), 409, "NOTHING_TO_REFUND", "unknown receipt")

	mgr.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": out.ReceiptNo, "reason": "rest"}).Expect(t, 204, "refund receipt")
	var n int
	var sum string
	one(t, `SELECT count(*) FROM charges r JOIN charges o ON o.id = r.reverses_charge_id WHERE o.tenant_id=$1 AND o.receipt_no=$2`, &n, clinic.TenantID, out.ReceiptNo)
	one(t, `SELECT sum(r.amount)::text FROM charges r JOIN charges o ON o.id = r.reverses_charge_id WHERE o.tenant_id=$1 AND o.receipt_no=$2`, &sum, clinic.TenantID, out.ReceiptNo)
	if n != 2 || !payEq(payNum(t, sum), -1000) {
		t.Fatalf("receipt refund after a line refund: %d reversals totalling %s; want 2 (one per line) totalling -1000", n, sum)
	}
	blExpect(t, mgr.Do("POST", "/billing/refund-visit", map[string]any{"receipt_no": out.ReceiptNo, "reason": "again"}), 409, "NOTHING_TO_REFUND", "refund a fully refunded receipt")
}

// ---- receipts and the paid list ----

// TestREG_BILL_050_ReceiptNumbersAreConsecutivePerClinic: Given a new clinic, Then its
// first receipt is 1; a settle, a two-line checkout and a refund take 1, 2, 3 (the
// checkout's lines share 2); a refused checkout consumes no number; and another
// clinic's numbering is independent.
func TestREG_BILL_050_ReceiptNumbersAreConsecutivePerClinic(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Receipt"), "Seq")
	a := payRaise(t, cashier, clinic, p.ID, 100)
	paySettle(cashier, a).Expect(t, 204, "settle")
	blExpect(t, cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID}), 409, "NOTHING_PENDING", "empty checkout")
	b := payRaise(t, cashier, clinic, p.ID, 200)
	c := payRaise(t, cashier, clinic, p.ID, 300)
	var out struct {
		ReceiptNo int64 `json:"receipt_no"`
	}
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID}).Expect(t, 200, "checkout").Decode(t, &out)
	mgr.Do("POST", "/billing/charges/"+a+"/refund", map[string]any{"reason": "x"}).Expect(t, 204, "refund")
	var refund int64
	one(t, `SELECT receipt_no FROM charges WHERE reverses_charge_id=$1`, &refund, blUUID(t, id.PrefixCharge, a))
	if got := []int64{blReceipt(t, a), blReceipt(t, b), blReceipt(t, c), out.ReceiptNo, refund}; fmt.Sprint(got) != "[1 2 2 2 3]" {
		t.Fatalf("receipts settle/checkout×2/checkout-result/refund = %v, want [1 2 2 2 3]", got)
	}
	other := payClinic(t)
	oc := srv.As(t, other, "cashier")
	x := payRaise(t, oc, other, createPatient(t, srv.As(t, other, "receptionist"), uniq("Other"), "Clinic").ID, 10)
	paySettle(oc, x).Expect(t, 204, "settle elsewhere")
	if n := blReceipt(t, x); n != 1 {
		t.Fatalf("another clinic's first receipt is %d, want 1 (numbering is per clinic)", n)
	}
}

// TestREG_BILL_051_PaidTodayListByReceipt: Given a two-line checkout by transfer and a
// single cash settle that was then refunded, Then /billing/payments lists two receipts
// newest first with their lines, totals, method, rail label, reference and cashier;
// only the fully refunded one is flagged refunded; a window in the future is empty.
func TestREG_BILL_051_PaidTodayListByReceipt(t *testing.T) {
	clinic := payClinic(t)
	cashier, mgr := srv.As(t, clinic, "cashier"), srv.As(t, clinic, "branch_manager")
	rails := blRails(t, cashier)
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Paid"), "List")
	single := payRaise(t, cashier, clinic, p.ID, 150)
	cashier.Do("POST", "/billing/charges/"+single+"/settle", map[string]any{"rail_id": rails["cash"]}).Expect(t, 204, "settle")
	mgr.Do("POST", "/billing/charges/"+single+"/refund", map[string]any{"reason": "x"}).Expect(t, 204, "refund")
	payRaise(t, cashier, clinic, p.ID, 200)
	payRaise(t, cashier, clinic, p.ID, 300)
	ref := "FT" + strings.ToUpper(uniq(""))
	var co struct {
		ReceiptNo int64 `json:"receipt_no"`
	}
	cashier.Do("POST", "/billing/checkout", map[string]any{"patient_id": p.ID, "rail_id": rails["transfer"], "reference": ref}).Expect(t, 200, "checkout").Decode(t, &co)

	type paidVisit struct {
		ReceiptNo   int64  `json:"receipt_no"`
		PatientName string `json:"patient_name"`
		MRN         string `json:"mrn"`
		Total       string `json:"total"`
		Method      string `json:"method"`
		MethodLabel string `json:"method_label"`
		Reference   string `json:"reference"`
		Refunded    bool   `json:"refunded"`
		SettledBy   string `json:"settled_by"`
		Lines       []struct {
			Amount string `json:"amount"`
		} `json:"lines"`
	}
	var list []paidVisit
	cashier.Do("GET", "/billing/payments", nil).Expect(t, 200, "payments").Decode(t, &list)
	if len(list) != 2 {
		t.Fatalf("paid list has %d receipts, want 2: %+v", len(list), list)
	}
	top, bottom := list[0], list[1]
	if top.ReceiptNo != co.ReceiptNo || len(top.Lines) != 2 || !payEq(payNum(t, top.Total), 500) || top.Method != "transfer" ||
		top.MethodLabel != "Bank transfer" || top.Reference != ref || top.Refunded || top.SettledBy == "" || top.MRN != p.MRN {
		t.Fatalf("checkout receipt in the paid list: %+v", top)
	}
	if bottom.ReceiptNo != blReceipt(t, single) || !bottom.Refunded || !payEq(payNum(t, bottom.Total), 150) || bottom.MethodLabel != "Cash" {
		t.Fatalf("refunded receipt in the paid list: %+v", bottom)
	}
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	cashier.Do("GET", "/billing/payments?since="+future, nil).Expect(t, 200, "future").Decode(t, &list)
	if len(list) != 0 {
		t.Fatalf("payments since an hour from now: %d receipts", len(list))
	}
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	cashier.Do("GET", "/billing/payments?since="+past+"&until="+past, nil).Expect(t, 200, "empty window").Decode(t, &list)
	if len(list) != 0 {
		t.Fatalf("payments in an empty window: %d receipts", len(list))
	}
	cashier.Do("GET", "/billing/payments?since=garbage&to=garbage", nil).Expect(t, 200, "bad since falls back to today").Decode(t, &list)
	if len(list) != 2 {
		t.Fatalf("payments with an unparsable since: %d receipts, want today's 2", len(list))
	}
	blExpect(t, srv.As(t, clinic, "receptionist").Do("GET", "/billing/payments", nil), 403, "FORBIDDEN_PERMISSION", "reception lists payments")
}

var _ = json.Marshal
