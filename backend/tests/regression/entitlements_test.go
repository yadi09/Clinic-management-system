package regression

import (
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Plan entitlements and limits (REG_PLAN). What a clinic pays for decides what it can
// use: plan_features (the plan's list), tenant_entitlements (one clinic's exception,
// either way) and feature_flags (the clinic's own switch, per branch too) resolve into
// the flag map in the access token, which every RequireFlag gate reads; a feature that
// is off answers 403 MODULE_DISABLED. The numeric caps (patients, users, branches,
// storage, images per patient, SMS per month) come from the plan unless the clinic has
// an override (tenants.*_override; negative = unlimited).
//
// Every test runs in a private clinic moved onto a plan row it created itself (code
// "xc-…"), so no shared plan row is ever changed. Flags are read at sign-in, so each
// check signs in afresh after the plan is arranged.

// ---- helpers (prefixed xc) ---------------------------------------------------------

// xcFeatures is every plan feature in the catalogue (migration 00077).
var xcFeatures = []string{"payment_verification", "debt_ageing", "finance_advanced", "messaging", "recalls", "dhis2", "ai_assist"}

// xcPlanSpec is a plan row: nil caps are unlimited; Features lists the plan's
// entitlements (nil = an unconfigured plan with no plan_features rows at all).
type xcPlanSpec struct {
	Patients, Users, Branches, StorageGB, Images, SMS *int
	Features                                          map[string]bool
}

func xcInt(n int) *int { return &n }

// xcAllFeatures is a feature list with every feature on except the ones named.
func xcAllFeatures(except ...string) map[string]bool {
	m := map[string]bool{}
	for _, f := range xcFeatures {
		m[f] = true
	}
	for _, f := range except {
		m[f] = false
	}
	return m
}

// xcPlan creates a plan row of its own and returns its id.
func xcPlan(t *testing.T, s xcPlanSpec) uuid.UUID {
	t.Helper()
	var pid uuid.UUID
	if err := super.Pool.QueryRow(t.Context(),
		`INSERT INTO plans (code, name, clinic_type, patient_limit, user_limit, branch_limit, storage_gb,
		                    images_per_patient, sms_monthly, audit_retention_days, price_monthly)
		 VALUES ($1, 'Regression plan', 'all', $2, $3, $4, $5, $6, $7, 365, 0) RETURNING id`,
		"xc-"+uuid.NewString()[:12], s.Patients, s.Users, s.Branches, s.StorageGB, s.Images, s.SMS).Scan(&pid); err != nil {
		t.Fatalf("create plan: %v", err)
	}
	for f, on := range s.Features {
		xcExec(t, `INSERT INTO plan_features (plan_id, feature, enabled) VALUES ($1, $2, $3)`, pid, f, on)
	}
	return pid
}

// xcPlanClinic is a private dental clinic moved onto a plan built from the spec.
func xcPlanClinic(t *testing.T, s xcPlanSpec) *testkit.Clinic {
	t.Helper()
	c := newClinic(t)
	pid := xcPlan(t, s)
	xcExec(t, `UPDATE tenants SET plan_id = $2 WHERE id = $1`, c.TenantID, pid)
	xcExec(t, `UPDATE subscriptions SET plan_id = $2 WHERE tenant_id = $1`, c.TenantID, pid)
	return c
}

// xcGate is one request that a feature guards.
type xcGate struct{ method, path string }

// xcGates are the routes behind each plan feature, as mounted in the API.
func xcGates() map[string][]xcGate {
	enc := id.Encode(id.PrefixEncounter, uuid.New())
	return map[string][]xcGate{
		"payment_verification": {{"GET", "/billing/verify-payment/status"}, {"POST", "/billing/verify-payment"}},
		"debt_ageing":          {{"GET", "/finance/receivables"}},
		"finance_advanced": {{"GET", "/finance/overview"}, {"GET", "/finance/cash"}, {"GET", "/finance/services"},
			{"GET", "/finance/book"}, {"GET", "/finance/receivables"}},
		"messaging": {{"GET", "/messaging/settings"}, {"GET", "/messaging/log"}, {"GET", "/messaging/templates"},
			{"GET", "/messaging/rules"}, {"GET", "/messaging/usage"}, {"GET", "/messaging/audience"}},
		"recalls":   {{"GET", "/messaging/audience?not_seen_days=180"}},
		"dhis2":     {{"GET", "/reporting/dhis2/config"}, {"GET", "/reporting/dhis2"}},
		"ai_assist": {{"POST", "/encounters/" + enc + "/assist"}},
	}
}

func xcDisabled(r testkit.Resp) bool { return r.Status == 403 && r.Code == "MODULE_DISABLED" }

// xcCall sends a gated request with an empty JSON body for POSTs.
func xcCall(c *testkit.Client, g xcGate) testkit.Resp {
	var body any
	if g.method == "POST" {
		body = map[string]any{}
	}
	return c.Do(g.method, g.path, body)
}

// ---- features ------------------------------------------------------------------------

// TestREG_PLAN_001_EveryFeatureGatesItsRoutes: Given a plan with every feature, When
// the owner calls each feature's routes, Then none answers MODULE_DISABLED (nor 5xx, bar AI assist's own
// server-key check);
// Given, for each feature in turn, a plan with only that feature missing, Then every
// route behind it answers 403 MODULE_DISABLED while the routes of the other features
// still work.
func TestREG_PLAN_001_EveryFeatureGatesItsRoutes(t *testing.T) {
	gates := xcGates()
	all := srv.As(t, xcPlanClinic(t, xcPlanSpec{Features: xcAllFeatures()}), "owner")
	for f, gs := range gates {
		for _, g := range gs {
			// AI assist also needs the server's own API key, which the test API never has:
			// past the plan gate it answers 503 ASSIST_DISABLED, which is not a plan refusal.
			if r := xcCall(all, g); xcDisabled(r) || (r.Status >= 500 && r.Code != "ASSIST_DISABLED") {
				t.Fatalf("plan with every feature: %s %s (%s) answers %d %s", g.method, g.path, f, r.Status, r.Code)
			}
		}
	}
	for _, f := range xcFeatures {
		t.Run(f, func(t *testing.T) {
			owner := srv.As(t, xcPlanClinic(t, xcPlanSpec{Features: xcAllFeatures(f)}), "owner")
			var me struct {
				Flags map[string]bool `json:"flags"`
			}
			owner.Do("GET", "/auth/me", nil).Expect(t, 200, "me").Decode(t, &me)
			if me.Flags[f] {
				t.Fatalf("plan without %s: /auth/me still says it is on", f)
			}
			for _, g := range gates[f] {
				if r := xcCall(owner, g); !xcDisabled(r) {
					t.Fatalf("plan without %s: %s %s answers %d %s, want 403 MODULE_DISABLED", f, g.method, g.path, r.Status, r.Code)
				}
			}
			behind := map[string]bool{}
			for _, g := range gates[f] {
				behind[g.path] = true
			}
			for other, gs := range gates {
				if other == f || (f == "finance_advanced" && other == "debt_ageing") || (f == "messaging" && other == "recalls") {
					continue // those routes sit behind the missing feature too
				}
				for _, g := range gs {
					if behind[g.path] {
						continue // a route gated by both features
					}
					if r := xcCall(owner, g); xcDisabled(r) {
						t.Fatalf("plan without %s: unrelated %s %s (%s) is MODULE_DISABLED", f, g.method, g.path, other)
					}
				}
			}
		})
	}
}

// TestREG_PLAN_002_ClinicExceptionWinsOverThePlan: Given a plan with every feature
// and a clinic exception revoking the finance dashboard, Then /finance is
// MODULE_DISABLED for that clinic; Given a plan with no paid features and a clinic
// exception granting patient SMS (an add-on sold), Then /messaging works for it while
// the finance dashboard stays off.
func TestREG_PLAN_002_ClinicExceptionWinsOverThePlan(t *testing.T) {
	rev := xcPlanClinic(t, xcPlanSpec{Features: xcAllFeatures()})
	xcExec(t, `INSERT INTO tenant_entitlements (tenant_id, feature, enabled, note) VALUES ($1, 'finance_advanced', false, 'regress')`, rev.TenantID)
	if r := srv.As(t, rev, "owner").Do("GET", "/finance/overview", nil); !xcDisabled(r) {
		t.Fatalf("revoked finance_advanced: %d %s", r.Status, r.Code)
	}

	add := xcPlanClinic(t, xcPlanSpec{Features: xcAllFeatures(xcFeatures...)})
	xcExec(t, `INSERT INTO tenant_entitlements (tenant_id, feature, enabled, note) VALUES ($1, 'messaging', true, 'regress add-on')`, add.TenantID)
	owner := srv.As(t, add, "owner")
	owner.Do("GET", "/messaging/settings", nil).Expect(t, 200, "messaging granted as an add-on")
	if r := owner.Do("GET", "/finance/overview", nil); !xcDisabled(r) {
		t.Fatalf("finance on a plan without it: %d %s", r.Status, r.Code)
	}
}

// TestREG_PLAN_003_TheClinicSwitchCannotExceedThePlan: Given a plan with the finance
// dashboard, When the clinic switches it off, Then it is off (off-but-available keeps
// its meaning); Given a plan without it, When the clinic's switch says on, Then it is
// still off — a clinic cannot switch on what it does not pay for.
func TestREG_PLAN_003_TheClinicSwitchCannotExceedThePlan(t *testing.T) {
	off := xcPlanClinic(t, xcPlanSpec{Features: xcAllFeatures()})
	xcExec(t, `UPDATE feature_flags SET enabled = false WHERE tenant_id = $1 AND flag = 'finance_advanced' AND branch_id IS NULL`, off.TenantID)
	if r := srv.As(t, off, "owner").Do("GET", "/finance/overview", nil); !xcDisabled(r) {
		t.Fatalf("entitled but switched off: %d %s", r.Status, r.Code)
	}
	not := xcPlanClinic(t, xcPlanSpec{Features: xcAllFeatures("finance_advanced")})
	var on bool
	one(t, `SELECT enabled FROM feature_flags WHERE tenant_id = $1 AND flag = 'finance_advanced' AND branch_id IS NULL`, &on, not.TenantID)
	if !on {
		t.Fatalf("arrangement: the clinic's own finance switch should be on")
	}
	if r := srv.As(t, not, "owner").Do("GET", "/finance/overview", nil); !xcDisabled(r) {
		t.Fatalf("switched on but not entitled: %d %s", r.Status, r.Code)
	}
	// A branch override cannot exceed the plan either.
	xcExec(t, `INSERT INTO feature_flags (tenant_id, branch_id, flag, enabled, source) VALUES ($1, $2, 'finance_advanced', true, 'override')`,
		not.TenantID, not.BranchID)
	if r := srv.As(t, not, "owner").Do("GET", "/finance/overview", nil); !xcDisabled(r) {
		t.Fatalf("branch override on, not entitled: %d %s", r.Status, r.Code)
	}
}

// TestREG_PLAN_004_UnconfiguredPlanGatesNothing: Given a plan nobody has given a
// feature list (no plan_features rows), When the owner signs in, Then the finance
// dashboard follows the clinic's own switch (on) — an unconfigured plan revokes
// nothing.
func TestREG_PLAN_004_UnconfiguredPlanGatesNothing(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{})
	srv.As(t, c, "owner").Do("GET", "/finance/overview", nil).Expect(t, 200, "finance on an unconfigured plan")
}

// TestREG_PLAN_005_ClinicTypePresetsSetTheModules: Given a dental clinic, Then the
// dental workspace works and the general-medical modules it does not run (lab,
// pharmacy, wards, maternity) answer MODULE_DISABLED; Given a general clinic, Then the
// dental workspace is MODULE_DISABLED and lab and pharmacy work.
func TestREG_PLAN_005_ClinicTypePresetsSetTheModules(t *testing.T) {
	dental := srv.As(t, newClinic(t), "owner")
	dental.Do("GET", "/dental/procedures", nil).Expect(t, 200, "dental clinic: dental")
	for _, path := range []string{"/lab/tests", "/pharmacy/drugs", "/inpatient/wards", "/dating/summary"} {
		if r := dental.Do("GET", path, nil); !xcDisabled(r) {
			t.Fatalf("dental clinic %s: %d %s, want MODULE_DISABLED", path, r.Status, r.Code)
		}
	}
	general := srv.As(t, testkit.NewClinic(t, super, testkit.ClinicOpts{ClinicType: "general"}), "owner")
	if r := general.Do("GET", "/dental/procedures", nil); !xcDisabled(r) {
		t.Fatalf("general clinic dental: %d %s, want MODULE_DISABLED", r.Status, r.Code)
	}
	for _, path := range []string{"/lab/tests", "/pharmacy/drugs"} {
		if r := general.Do("GET", path, nil); xcDisabled(r) || r.Status >= 500 {
			t.Fatalf("general clinic %s: %d %s", path, r.Status, r.Code)
		}
	}
	for _, path := range []string{"/inpatient/wards", "/dating/summary"} {
		if r := general.Do("GET", path, nil); !xcDisabled(r) {
			t.Fatalf("general clinic %s (off by default): %d %s", path, r.Status, r.Code)
		}
	}
}

// ---- limits ---------------------------------------------------------------------------

// TestREG_PLAN_010_PatientCapIsExact: Given a plan of 2 patients, When the desk
// registers them, Then both are accepted and the third is 403 PATIENT_LIMIT_REACHED
// with nothing stored; When the clinic's override says 3, Then a third is accepted and
// a fourth refused; When the override says unlimited (-1), Then a fourth is accepted.
func TestREG_PLAN_010_PatientCapIsExact(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{Patients: xcInt(2)})
	desk := srv.As(t, c, "receptionist")
	reg := func() testkit.Resp {
		return desk.Do("POST", "/patients", map[string]any{"first_name": uniq("Cap"), "last_name": "P", "gender": "female",
			"dob": "1990-01-01", "phone": patPhone(), "force": true})
	}
	count := func() int {
		var n int
		one(t, `SELECT count(*) FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL`, &n, c.TenantID)
		return n
	}
	reg().Expect(t, 201, "patient 1 of 2")
	reg().Expect(t, 201, "patient 2 of 2")
	if r := reg(); r.Status != 403 || r.Code != "PATIENT_LIMIT_REACHED" || count() != 2 {
		t.Fatalf("patient 3 of 2: %d %s, %d stored", r.Status, r.Code, count())
	}
	xcExec(t, `UPDATE tenants SET patient_limit_override = 3 WHERE id = $1`, c.TenantID)
	reg().Expect(t, 201, "patient 3 of override 3")
	if r := reg(); r.Code != "PATIENT_LIMIT_REACHED" {
		t.Fatalf("patient 4 of override 3: %d %s", r.Status, r.Code)
	}
	xcExec(t, `UPDATE tenants SET patient_limit_override = -1 WHERE id = $1`, c.TenantID)
	reg().Expect(t, 201, "patient 4 with an unlimited override")
}

// TestREG_PLAN_011_UserCapIsExact: Given a plan of 7 users and a clinic of 6 active
// staff, When the owner invites a seventh and they accept, Then both succeed (7 of 7);
// When the owner invites an eighth, Then 403 USER_LIMIT_REACHED; with the clinic's
// override at 8 the invitation goes through.
func TestREG_PLAN_011_UserCapIsExact(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{Users: xcInt(7)})
	owner := srv.As(t, c, "owner")
	inv := opInviteUser(t, owner, "seventh-"+uuid.NewString()[:6]+"@"+c.Slug+".test", []string{"nurse"}, nil)
	if r := authPost(t, "/auth/accept-invite", map[string]any{"token": opInviteToken(t, inv.InviteLink), "password": "Welcome#2026"}, "", ""); r.Status != 200 {
		t.Fatalf("seventh user accepts at 6 of 7: %d", r.Status)
	}
	var active int
	one(t, `SELECT count(*) FROM users WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL`, &active, c.TenantID)
	if active != 7 {
		t.Fatalf("active users %d, want 7", active)
	}
	body := map[string]any{"email": "eighth-" + uuid.NewString()[:6] + "@" + c.Slug + ".test", "full_name": "Eighth", "roles": []string{"nurse"}}
	if r := owner.Do("POST", "/users", body); r.Status != 403 || r.Code != "USER_LIMIT_REACHED" {
		t.Fatalf("invite at 7 of 7: %d %s", r.Status, r.Code)
	}
	xcExec(t, `UPDATE tenants SET user_limit_override = 8 WHERE id = $1`, c.TenantID)
	owner.Do("POST", "/users", body).Expect(t, 201, "invite with the override at 8")
}

// TestREG_PLAN_012_BranchCapIsExact: Given a plan of 2 branches (the clinic has its
// main one), When the owner adds a second, Then it is created; a third is 409
// BRANCH_LIMIT and not stored; with the override at 3 it is created.
func TestREG_PLAN_012_BranchCapIsExact(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{Branches: xcInt(2)})
	owner := srv.As(t, c, "owner")
	opNewBranch(t, owner, "Second", "SEC")
	if r := owner.Do("POST", "/org/branches", map[string]any{"name": "Third", "code": "THR"}); r.Status != 409 || r.Code != "BRANCH_LIMIT" {
		t.Fatalf("branch 3 of 2: %d %s", r.Status, r.Code)
	}
	var n int
	one(t, `SELECT count(*) FROM branches WHERE tenant_id = $1 AND deleted_at IS NULL`, &n, c.TenantID)
	if n != 2 {
		t.Fatalf("branches after a refused add: %d", n)
	}
	xcExec(t, `UPDATE tenants SET branch_limit_override = 3 WHERE id = $1`, c.TenantID)
	opNewBranch(t, owner, "Third", "THR")
}

// xcRecordImage files an image of the given size against a patient (the dentist's
// record-after-upload call) and returns nothing; the size is what storage counts.
func xcRecordImage(t *testing.T, doc *testkit.Client, c *testkit.Clinic, patientID string, size int64) {
	t.Helper()
	doc.Do("POST", "/dental/patients/"+patientID+"/images", map[string]any{
		"storage_key": c.TenantID.String() + "/dental/" + uuid.NewString() + ".jpg",
		"filename":    "pa.jpg", "mime_type": "image/jpeg", "size_bytes": size, "category": "xray",
	}).Expect(t, 201, "record image")
}

// TestREG_PLAN_013_StorageCapIsExact: Given a plan of 1 GB and files totalling one
// byte under it, When the desk or the dentist asks to upload, Then the request gets
// past the cap (the test API has no storage provider, so it then fails for that
// reason — never STORAGE_LIMIT_REACHED); When one more byte is stored (exactly 1 GB),
// Then both upload paths answer 403 STORAGE_LIMIT_REACHED; the override wins.
func TestREG_PLAN_013_StorageCapIsExact(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{StorageGB: xcInt(1)})
	doc, desk := srv.As(t, c, "doctor"), srv.As(t, c, "receptionist")
	p := createPatient(t, desk, uniq("Store"), "Cap")
	signs := []struct {
		c    *testkit.Client
		path string
		body map[string]any
	}{
		{desk, "/patients/" + p.ID + "/attachments/sign", map[string]any{"filename": "a.pdf", "type": "pdf"}},
		{doc, "/dental/patients/" + p.ID + "/images/sign", map[string]any{"filename": "b.jpg", "mime_type": "image/jpeg"}},
	}
	xcRecordImage(t, doc, c, p.ID, (1<<30)-1)
	for _, s := range signs {
		if r := s.c.Do("POST", s.path, s.body); r.Code == "STORAGE_LIMIT_REACHED" || (r.Status >= 200 && r.Status < 300) {
			t.Fatalf("one byte under the cap: %s %d %s (want past the cap, refused by the absent provider)", s.path, r.Status, r.Code)
		}
	}
	xcRecordImage(t, doc, c, p.ID, 1)
	for _, s := range signs {
		if r := s.c.Do("POST", s.path, s.body); r.Status != 403 || r.Code != "STORAGE_LIMIT_REACHED" {
			t.Fatalf("exactly at the cap: %s %d %s", s.path, r.Status, r.Code)
		}
	}
	xcExec(t, `UPDATE tenants SET storage_gb_override = 2 WHERE id = $1`, c.TenantID)
	for _, s := range signs {
		if r := s.c.Do("POST", s.path, s.body); r.Code == "STORAGE_LIMIT_REACHED" {
			t.Fatalf("override at 2 GB still refuses %s", s.path)
		}
	}
}

// TestREG_PLAN_014_ImagesPerPatientCapIsExact: Given a plan of 2 images per patient,
// When a patient has 1, Then signing another gets past the cap; with 2, Then 403
// IMAGE_LIMIT_REACHED; another patient of the clinic is unaffected.
func TestREG_PLAN_014_ImagesPerPatientCapIsExact(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{Images: xcInt(2)})
	doc, desk := srv.As(t, c, "doctor"), srv.As(t, c, "receptionist")
	p := createPatient(t, desk, uniq("Img"), "Cap")
	other := createPatient(t, desk, uniq("Img"), "Other")
	sign := func(pid string) testkit.Resp {
		return doc.Do("POST", "/dental/patients/"+pid+"/images/sign", map[string]any{"filename": "x.jpg", "mime_type": "image/jpeg"})
	}
	xcRecordImage(t, doc, c, p.ID, 1000)
	if r := sign(p.ID); r.Code == "IMAGE_LIMIT_REACHED" {
		t.Fatalf("1 of 2 images: refused")
	}
	xcRecordImage(t, doc, c, p.ID, 1000)
	if r := sign(p.ID); r.Status != 403 || r.Code != "IMAGE_LIMIT_REACHED" {
		t.Fatalf("2 of 2 images: %d %s", r.Status, r.Code)
	}
	if r := sign(other.ID); r.Code == "IMAGE_LIMIT_REACHED" {
		t.Fatalf("another patient with no images is refused")
	}
}

// TestREG_PLAN_015_SMSAllowanceIsExact: Given a plan with patient SMS and 2 segments a
// month, one already sent, When the desk sends a one-segment test, Then it is queued
// (2 of 2); with two sent, Then the next is 403 SMS_LIMIT_REACHED and nothing is
// queued; the clinic's override at 3 lets it through.
func TestREG_PLAN_015_SMSAllowanceIsExact(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{SMS: xcInt(2), Features: xcAllFeatures()})
	msgOn(t, c, "en")
	desk := srv.As(t, c, "receptionist")
	send := func() testkit.Resp {
		return desk.Do("POST", "/messaging/test", map[string]any{"phone": msgPhone(), "body": "Hello"})
	}
	queued := func() int {
		var n int
		one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1 AND status = 'scheduled'`, &n, c.TenantID)
		return n
	}
	msgInsert(t, c, nil, "custom", "sent", "251911000001", "used", "")
	if r := send(); r.Status >= 300 {
		t.Fatalf("1 used + 1 of 2: %d %s", r.Status, r.Code)
	}
	before := queued()
	msgInsert(t, c, nil, "custom", "sent", "251911000002", "used", "")
	if r := send(); r.Status != 403 || r.Code != "SMS_LIMIT_REACHED" || queued() != before {
		t.Fatalf("2 used + 1 of 2: %d %s, queued %d → %d", r.Status, r.Code, before, queued())
	}
	xcExec(t, `UPDATE tenants SET sms_monthly_override = 3 WHERE id = $1`, c.TenantID)
	if r := send(); r.Status >= 300 {
		t.Fatalf("2 used + 1 with the override at 3: %d %s", r.Status, r.Code)
	}
}

// TestREG_PLAN_016_RecordingAFileRespectsTheStorageCap: Given a clinic whose 1 GB is
// exactly used, When the desk records a patient attachment or the dentist records an
// image (the call made after uploading, which a client can make without asking for a
// signature first), Then it must be refused 403 STORAGE_LIMIT_REACHED like the
// signature is. NEW-PLAN-1: the cap is checked only when signing the upload; both
// record calls store the file and push usage past the plan.
func TestREG_PLAN_016_RecordingAFileRespectsTheStorageCap(t *testing.T) {
	c := xcPlanClinic(t, xcPlanSpec{StorageGB: xcInt(1)})
	doc, desk := srv.As(t, c, "doctor"), srv.As(t, c, "receptionist")
	p := createPatient(t, desk, uniq("Full"), "Store")
	xcRecordImage(t, doc, c, p.ID, 1<<30)
	if r := doc.Do("POST", "/dental/patients/"+p.ID+"/images/sign", map[string]any{"filename": "b.jpg", "mime_type": "image/jpeg"}); r.Code != "STORAGE_LIMIT_REACHED" {
		t.Fatalf("arrangement: signing at the cap answers %d %s", r.Status, r.Code)
	}
	pid := xcID(t, id.PrefixPatient, p.ID)
	att := desk.Do("POST", "/patients/"+p.ID+"/attachments", map[string]any{"type": "scan",
		"storage_key": c.TenantID.String() + "/patients/" + pid.String() + "/over.pdf", "filename": "over.pdf",
		"mime_type": "application/pdf", "size_bytes": 4096})
	img := doc.Do("POST", "/dental/patients/"+p.ID+"/images", map[string]any{
		"storage_key": c.TenantID.String() + "/dental/" + uuid.NewString() + ".jpg", "filename": "over.jpg",
		"mime_type": "image/jpeg", "size_bytes": 4096, "category": "xray"})
	var used int64
	one(t, `SELECT coalesce(sum(size_bytes), 0)::bigint FROM attachments WHERE tenant_id = $1 AND deleted_at IS NULL`, &used, c.TenantID)
	testkit.KnownBug(t, "NEW-PLAN-1", att.Status < 300 || img.Status < 300 || used > 1<<30, fmt.Sprintf(
		"with storage full, recording an attachment answers %d and an image %d; usage is now %d bytes of %d — "+
			"EnsureStorageRoom runs only in the sign calls (patient/service/service.go, dental/service/service.go SignImageUpload)",
		att.Status, img.Status, used, int64(1<<30)))
}
