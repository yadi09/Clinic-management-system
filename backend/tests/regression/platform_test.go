package regression

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The platform super-admin console (REG_PLAT).
//
// The vendor's own surface: platform admins (platform_admins, not tenant users) sign
// in at /platform/auth/login and get a tenant-less token carrying platform.admin. With
// it they provision clinics, suspend them, move them between plans, describe what a
// plan includes, grant per-clinic exceptions, hold the Verify.ET key and read partner
// leads. The API runs this module on the privileged (RLS-bypassing) pool, so the
// guard on every route is the only thing between a clinic login and every clinic.
//
// The API has no endpoint that creates a platform admin, so each test inserts its own
// through the superuser pool (platNewAdmin) and then signs in over HTTP like the
// console does. Every clinic a test touches is one it provisioned itself.

// ---- helpers (prefixed plat) ---------------------------------------------------

const platPassword = "Vendor#Console-2026"

var (
	platHashOnce sync.Once
	platHash     string
	platHashErr  error
)

// platNewAdmin inserts a platform admin ("admin" or "marketer") and returns its
// email and id.
func platNewAdmin(t *testing.T, role string) (string, uuid.UUID) {
	t.Helper()
	platHashOnce.Do(func() { platHash, platHashErr = auth.HashPassword(platPassword) })
	if platHashErr != nil {
		t.Fatalf("hash: %v", platHashErr)
	}
	email := strings.ToLower(uniq("vendor")) + "@platform.test"
	var uid uuid.UUID
	one(t, `INSERT INTO platform_admins (email, password_hash, full_name, role)
	        VALUES ($1, $2, $3, $4) RETURNING id`, &uid, email, platHash, "Vendor "+email, role)
	return email, uid
}

// platLogin signs a platform admin in over HTTP and returns the client.
func platLogin(t *testing.T, email string) *testkit.Client {
	t.Helper()
	c := srv.Anon(t)
	r := c.Do("POST", "/platform/auth/login", map[string]any{"email": email, "password": platPassword}).
		Expect(t, 200, "platform login")
	var out struct {
		AccessToken string `json:"access_token"`
	}
	r.Decode(t, &out)
	if out.AccessToken == "" {
		t.Fatalf("platform login returned no token: %s", r.Raw)
	}
	c.Token = out.AccessToken
	return c
}

// platAdmin is a freshly created, signed-in super-admin.
func platAdmin(t *testing.T) (*testkit.Client, string, uuid.UUID) {
	t.Helper()
	email, uid := platNewAdmin(t, "admin")
	return platLogin(t, email), email, uid
}

// platClaims decodes an access token's payload without verifying it.
func platClaims(t *testing.T, tok string) map[string]any {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("not a JWT: %q", tok)
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode claims: %v", err)
	}
	m := map[string]any{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("claims json: %v", err)
	}
	return m
}

func platHasString(list any, want string) bool {
	arr, _ := list.([]any)
	for _, v := range arr {
		if s, _ := v.(string); s == want {
			return true
		}
	}
	return false
}

type platClinic struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Slug       string `json:"slug"`
	Status     string `json:"status"`
	OwnerEmail string `json:"owner_email"`
	OwnerPhone string `json:"owner_phone"`
	Users      int    `json:"users"`
	Patients   int    `json:"patients"`
	ClinicType string `json:"clinic_type"`
	PlanCode   string `json:"plan_code"`
	PlanName   string `json:"plan_name"`
}

type platProvisioned struct {
	Clinic        platClinic `json:"clinic"`
	OwnerEmail    string     `json:"owner_email"`
	TempPassword  string     `json:"temp_password"`
	WorkspaceSlug string     `json:"workspace_slug"`
	tenant        uuid.UUID
}

// platProvisionBody is a valid provisioning request with a unique workspace.
func platProvisionBody(clinicType string) map[string]any {
	slug := strings.ToLower(uniq("pl-"))
	return map[string]any{
		"clinic_name": "Platform " + slug, "slug": slug, "owner_name": "Owner " + slug,
		"owner_email": "owner@" + slug + ".test", "clinic_type": clinicType,
	}
}

func platProvision(t *testing.T, c *testkit.Client, body map[string]any) platProvisioned {
	t.Helper()
	r := c.Do("POST", "/platform/clinics", body).Expect(t, 201, "provision clinic")
	var p platProvisioned
	r.Decode(t, &p)
	tid, err := id.Decode(id.PrefixTenant, p.Clinic.ID)
	if err != nil {
		t.Fatalf("provision returned a bad clinic id %q: %s", p.Clinic.ID, r.Raw)
	}
	p.tenant = tid
	return p
}

// platStaffLogin signs a clinic user in with an explicit password.
func platStaffLogin(t *testing.T, workspace, email, password string) (testkit.Resp, *testkit.Client) {
	t.Helper()
	c := srv.Anon(t)
	r := c.Do("POST", "/auth/login", map[string]any{"workspace": workspace, "email": email, "password": password})
	if r.Status == 200 {
		var tok struct {
			AccessToken string `json:"access_token"`
		}
		r.Decode(t, &tok)
		c.Token = tok.AccessToken
	}
	return r, c
}

type platPlan struct {
	ID               string `json:"id"`
	Code             string `json:"code"`
	Name             string `json:"name"`
	ClinicType       string `json:"clinic_type"`
	BranchLimit      *int   `json:"branch_limit"`
	UserLimit        *int   `json:"user_limit"`
	StorageGB        *int   `json:"storage_gb"`
	PatientLimit     *int   `json:"patient_limit"`
	ImagesPerPatient *int   `json:"images_per_patient"`
	SMSMonthly       *int   `json:"sms_monthly"`
	PriceMonthly     string `json:"price_monthly"`
	Status           string `json:"status"`
	InUse            int    `json:"in_use"`
}

func platCreatePlan(t *testing.T, c *testkit.Client, clinicType string) platPlan {
	t.Helper()
	code := strings.ToLower(uniq("plan"))
	r := c.Do("POST", "/platform/plans", map[string]any{
		"code": code, "name": "Plan " + code, "clinic_type": clinicType, "patient_limit": 500, "user_limit": 5,
		"price_monthly": "1500",
	}).Expect(t, 201, "create plan")
	var p platPlan
	r.Decode(t, &p)
	if p.ID == "" {
		t.Fatalf("create plan returned no id: %s", r.Raw)
	}
	return p
}

func platListPlans(t *testing.T, c *testkit.Client) map[string]platPlan {
	t.Helper()
	var list []platPlan
	c.Do("GET", "/platform/plans", nil).Expect(t, 200, "list plans").Decode(t, &list)
	out := map[string]platPlan{}
	for _, p := range list {
		out[p.Code] = p
	}
	return out
}

func platListClinics(t *testing.T, c *testkit.Client) map[string]platClinic {
	t.Helper()
	var list []platClinic
	c.Do("GET", "/platform/clinics", nil).Expect(t, 200, "list clinics").Decode(t, &list)
	out := map[string]platClinic{}
	for _, cl := range list {
		out[cl.Slug] = cl
	}
	return out
}

func platFlag(t *testing.T, tenant uuid.UUID, flag string) bool {
	t.Helper()
	var on bool
	one(t, `SELECT enabled FROM feature_flags WHERE tenant_id = $1 AND flag = $2 AND branch_id IS NULL`, &on, tenant, flag)
	return on
}

func platFirstFeature(t *testing.T) string {
	t.Helper()
	var code string
	one(t, `SELECT code FROM features ORDER BY sort LIMIT 1`, &code)
	return code
}

// platRoutes lists every registered route whose path starts with prefix, from the
// API's own route table (the GIN debug lines it prints at start-up).
func platRoutes(t *testing.T, prefix string) [][2]string {
	t.Helper()
	seen := map[string]bool{}
	var out [][2]string
	for _, m := range ginRoute.FindAllStringSubmatch(srv.Logs(), -1) {
		if !strings.HasPrefix(m[2], prefix) || seen[m[1]+" "+m[2]] {
			continue
		}
		seen[m[1]+" "+m[2]] = true
		out = append(out, [2]string{m[1], m[2]})
	}
	if len(out) == 0 {
		t.Fatalf("no %s routes found in the API's route table", prefix)
	}
	return out
}

var platParam = regexp.MustCompile(`:[a-z_]+`)

// platFill turns a route template into a requestable path.
func platFill(path string) string {
	return platParam.ReplaceAllString(path, "x"+strings.Repeat("0", 3))
}

// ---- sign-in ---------------------------------------------------------------------

// TestREG_PLAT_001_AdminSignsInWithAPlatformToken: Given an active platform admin,
// When they sign in (email typed in capitals with spaces), Then they get a tenant-less
// token carrying platform.admin, and their last sign-in time is recorded.
func TestREG_PLAT_001_AdminSignsInWithAPlatformToken(t *testing.T) {
	email, uid := platNewAdmin(t, "admin")
	r := srv.Anon(t).Do("POST", "/platform/auth/login", map[string]any{
		"email": "  " + strings.ToUpper(email) + " ", "password": platPassword,
	}).Expect(t, 200, "platform login")
	var out struct {
		AccessToken string `json:"access_token"`
		Email       string `json:"email"`
		ExpiresAt   string `json:"expires_at"`
	}
	r.Decode(t, &out)
	if out.Email != email || out.ExpiresAt == "" {
		t.Fatalf("login body: %s", r.Raw)
	}
	cl := platClaims(t, out.AccessToken)
	if !platHasString(cl["perms"], "platform.admin") || !platHasString(cl["roles"], "platform_admin") {
		t.Fatalf("platform token lacks platform.admin / platform_admin: %v", cl)
	}
	if cl["tid"] != uuid.Nil.String() {
		t.Fatalf("platform token must be tenant-less, tid=%v", cl["tid"])
	}
	if cl["sub"] != uid.String() {
		t.Fatalf("platform token sub=%v, want the admin id %s", cl["sub"], uid)
	}
	var seen bool
	one(t, `SELECT last_login_at IS NOT NULL FROM platform_admins WHERE id = $1`, &seen, uid)
	if !seen {
		t.Fatal("last_login_at was not recorded")
	}
}

// TestREG_PLAT_002_WrongPasswordAndUnknownEmailLookTheSame: Given an admin, When
// someone signs in with the wrong password, or with an email that is not an admin,
// Then both get the same 401 (no account enumeration); a malformed body is a 400.
func TestREG_PLAT_002_WrongPasswordAndUnknownEmailLookTheSame(t *testing.T) {
	email, _ := platNewAdmin(t, "admin")
	a := srv.Anon(t)
	wrong := a.Do("POST", "/platform/auth/login", map[string]any{"email": email, "password": "nope-nope"}).
		Expect(t, 401, "wrong password")
	unknown := a.Do("POST", "/platform/auth/login", map[string]any{"email": "nobody-" + email, "password": platPassword}).
		Expect(t, 401, "unknown email")
	if wrong.Code != unknown.Code || wrong.Message != unknown.Message {
		t.Fatalf("wrong password (%s %q) and unknown email (%s %q) must look the same",
			wrong.Code, wrong.Message, unknown.Code, unknown.Message)
	}
	if strings.Contains(wrong.Raw, "access_token") {
		t.Fatalf("a failed login returned a token: %s", wrong.Raw)
	}
	a.Do("POST", "/platform/auth/login", "not an object").Expect(t, 400, "malformed body")
}

// TestREG_PLAT_003_SuspendedAdminCannotSignIn: Given a suspended platform admin, When
// they sign in with the right password, Then 403 ADMIN_INACTIVE; with a wrong one, the
// ordinary 401 (the status is not revealed to someone without the password).
func TestREG_PLAT_003_SuspendedAdminCannotSignIn(t *testing.T) {
	email, uid := platNewAdmin(t, "admin")
	if _, err := super.Pool.Exec(t.Context(), `UPDATE platform_admins SET status = 'suspended' WHERE id = $1`, uid); err != nil {
		t.Fatal(err)
	}
	a := srv.Anon(t)
	r := a.Do("POST", "/platform/auth/login", map[string]any{"email": email, "password": platPassword}).
		Expect(t, 403, "suspended admin")
	if r.Code != "ADMIN_INACTIVE" {
		t.Fatalf("want ADMIN_INACTIVE, got %s", r.Code)
	}
	a.Do("POST", "/platform/auth/login", map[string]any{"email": email, "password": "wrong-one"}).
		Expect(t, 401, "suspended admin, wrong password")
}

// TestREG_PLAT_004_ClinicStaffCannotSignInToThePlatform: Given a clinic owner, When
// they use their own email and password at the platform sign-in, Then 401: clinic
// accounts and platform accounts are different tables.
func TestREG_PLAT_004_ClinicStaffCannotSignInToThePlatform(t *testing.T) {
	srv.Anon(t).Do("POST", "/platform/auth/login", map[string]any{
		"email": clinicA.Owner.Email, "password": testkit.StaffPassword,
	}).Expect(t, 401, "clinic owner at the platform login")
}

// TestREG_PLAT_005_RepeatedFailuresLockTheAdminOut: Given a platform admin, When ten
// wrong passwords are tried in a row, Then the account is locked and even the right
// password is refused for a while. Known bug SEC-3: the platform login has no failure
// counter and no lockout, so a guessed password still opens every clinic.
func TestREG_PLAT_005_RepeatedFailuresLockTheAdminOut(t *testing.T) {
	email, _ := platNewAdmin(t, "admin")
	a := srv.Anon(t)
	for i := 0; i < 10; i++ {
		r := a.Do("POST", "/platform/auth/login", map[string]any{"email": email, "password": "guess-" + uniq("")})
		if r.Status == 200 {
			t.Fatalf("attempt %d: a wrong password signed in", i)
		}
	}
	r := a.Do("POST", "/platform/auth/login", map[string]any{"email": email, "password": platPassword})
	testkit.KnownBug(t, "SEC-3", r.Status == 200,
		"after 10 failed attempts the right password still signs the platform admin in (no lockout)")
	if r.Status == 200 {
		t.Fatal("locked admin signed in")
	}
}

// ---- the guard on every route ------------------------------------------------------

// TestREG_PLAT_006_EveryPlatformRouteRefusesAnonymousAndClinicStaff: Given every route
// the API registers under /platform (console, CRM, campaigns), When it is called with
// no token, Then 401; When called by a clinic owner (who holds every clinic
// permission) or a receptionist, Then 401/403 — never served. Only the login is open.
func TestREG_PLAT_006_EveryPlatformRouteRefusesAnonymousAndClinicStaff(t *testing.T) {
	anon := srv.Anon(t)
	owner := srv.As(t, clinicA, "owner")
	recep := srv.As(t, clinicA, "receptionist")
	n := 0
	for _, rt := range platRoutes(t, "/platform/") {
		if rt[1] == "/platform/auth/login" {
			continue
		}
		n++
		path := platFill(rt[1])
		if r := anon.Do(rt[0], path, map[string]any{}); r.Status != 401 {
			t.Errorf("%s %s with no token: want 401, got %d %s", rt[0], rt[1], r.Status, r.Code)
		}
		for who, c := range map[string]*testkit.Client{"owner": owner, "receptionist": recep} {
			if r := c.Do(rt[0], path, map[string]any{}); r.Status != 401 && r.Status != 403 {
				t.Errorf("%s %s as clinic %s: want 401/403, got %d %s", rt[0], rt[1], who, r.Status, r.Code)
			}
		}
	}
	if n < 20 {
		t.Fatalf("only %d platform routes found; the route table looks wrong", n)
	}
}

// TestREG_PLAT_007_MarketerIsRefusedEveryTenantControl: Given a marketing account (a
// platform login holding only crm.work), When it calls any console route of the
// platform module (clinics, plans, features, integrations, partner leads), Then 403;
// it can still reach its own CRM worklist.
func TestREG_PLAT_007_MarketerIsRefusedEveryTenantControl(t *testing.T) {
	email, _ := platNewAdmin(t, "marketer")
	m := platLogin(t, email)
	cl := platClaims(t, m.Token)
	if platHasString(cl["perms"], "platform.admin") || !platHasString(cl["perms"], "crm.work") {
		t.Fatalf("marketer token perms = %v, want crm.work only", cl["perms"])
	}
	n := 0
	for _, rt := range platRoutes(t, "/platform/") {
		p := rt[1]
		if p == "/platform/auth/login" || strings.HasPrefix(p, "/platform/crm") || strings.HasPrefix(p, "/platform/campaigns") {
			continue
		}
		n++
		if r := m.Do(rt[0], platFill(p), map[string]any{}); r.Status != 403 {
			t.Errorf("%s %s as marketer: want 403, got %d %s", rt[0], p, r.Status, r.Code)
		}
	}
	if n < 20 {
		t.Fatalf("only %d console routes checked", n)
	}
	m.Do("GET", "/platform/crm/campaigns", nil).Expect(t, 200, "marketer reads CRM campaigns")
}

// TestREG_PLAT_008_PlatformTokenNeverSeesClinicData: Given a clinic with a patient,
// When a super-admin token (tenant-less) is presented to every read route of the
// clinic API, Then the routes that need a clinic permission refuse it (401/403), and
// no answer from any route contains that clinic's patient, workspace or branch: the
// platform reaches a clinic only through the console actions, never by presenting
// its own token to the clinic API.
func TestREG_PLAT_008_PlatformTokenNeverSeesClinicData(t *testing.T) {
	adm, _, _ := platAdmin(t)
	c := newClinic(t)
	pt := createPatient(t, srv.As(t, c, "receptionist"), uniq("Leak"), "Probe")
	markers := []string{pt.FirstName, pt.ID, c.Slug, id.Encode(id.PrefixBranch, c.BranchID), c.Owner.Email}
	for _, rt := range [][2]string{
		{"GET", "/patients"}, {"POST", "/patients"}, {"GET", "/patients/" + pt.ID}, {"GET", "/users"},
		{"POST", "/users"}, {"GET", "/roles"}, {"GET", "/dental/outstanding"},
	} {
		if r := adm.Do(rt[0], rt[1], map[string]any{}); r.Status != 401 && r.Status != 403 {
			t.Errorf("%s %s with a platform token: want 401/403, got %d %s", rt[0], rt[1], r.Status, trimRaw(r.Raw))
		}
	}
	n := 0
	for _, rt := range platRoutes(t, "/") {
		if rt[0] != "GET" || strings.HasPrefix(rt[1], "/platform") {
			continue
		}
		n++
		path := strings.ReplaceAll(platFill(rt[1]), "x000", pt.ID)
		r := adm.Do("GET", path, nil)
		for _, m := range markers {
			if strings.Contains(r.Raw, m) {
				t.Errorf("GET %s with a platform token returned clinic data (%q): %s", rt[1], m, trimRaw(r.Raw))
			}
		}
	}
	if n < 50 {
		t.Fatalf("only %d clinic GET routes swept", n)
	}
}

func trimRaw(s string) string {
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}

// ---- provisioning ------------------------------------------------------------------

// TestREG_PLAT_009_ProvisionGeneralClinicCreatesAWorkingClinic: Given a super-admin,
// When they provision a general clinic (workspace typed with capitals and spaces, an
// owner phone, no password), Then 201 with a generated temporary password; the owner
// signs in with it; lab and pharmacy are on and dental off; the clinic is on the
// roster with its owner, one user and its plan.
func TestREG_PLAT_009_ProvisionGeneralClinicCreatesAWorkingClinic(t *testing.T) {
	adm, _, _ := platAdmin(t)
	body := platProvisionBody("general")
	slug := body["slug"].(string)
	body["slug"] = "  " + strings.ToUpper(slug) + " !! "
	body["owner_phone"] = "0911223344"
	p := platProvision(t, adm, body)
	if p.WorkspaceSlug != slug || p.Clinic.Slug != slug {
		t.Fatalf("workspace not normalised: got %q / %q, want %q", p.WorkspaceSlug, p.Clinic.Slug, slug)
	}
	if p.TempPassword == "" || p.OwnerEmail != body["owner_email"] || p.Clinic.Status != "active" {
		t.Fatalf("provision result: %+v", p)
	}
	r, _ := platStaffLogin(t, slug, p.OwnerEmail, p.TempPassword)
	r.Expect(t, 200, "owner signs in with the temporary password")

	var ctype string
	var doctorRegisters bool
	one(t, `SELECT clinic_type FROM tenants WHERE id = $1`, &ctype, p.tenant)
	one(t, `SELECT doctor_registers_patients FROM tenants WHERE id = $1`, &doctorRegisters, p.tenant)
	if ctype != "general" || doctorRegisters {
		t.Fatalf("general clinic: type %q doctor_registers %v", ctype, doctorRegisters)
	}
	if !platFlag(t, p.tenant, "laboratory") || !platFlag(t, p.tenant, "pharmacy") || platFlag(t, p.tenant, "dental") {
		t.Fatal("general preset: want laboratory+pharmacy on, dental off")
	}
	row, ok := platListClinics(t, adm)[slug]
	if !ok {
		t.Fatalf("provisioned clinic %s is not on the roster", slug)
	}
	if row.ID != p.Clinic.ID || row.OwnerEmail != p.OwnerEmail || row.OwnerPhone == "" || row.Users != 1 ||
		row.Patients != 0 || row.ClinicType != "general" || row.PlanCode == "" || row.PlanName == "" {
		t.Fatalf("roster row: %+v", row)
	}
}

// TestREG_PLAT_010_ProvisionDentalClinicAppliesTheDentalPreset: Given a super-admin,
// When they provision a dental clinic, Then the dental module is on, laboratory,
// pharmacy and inventory are off, and a dentist may register patients from the chair.
func TestREG_PLAT_010_ProvisionDentalClinicAppliesTheDentalPreset(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("DENTAL"))
	var ctype string
	var doctorRegisters bool
	one(t, `SELECT clinic_type FROM tenants WHERE id = $1`, &ctype, p.tenant)
	one(t, `SELECT doctor_registers_patients FROM tenants WHERE id = $1`, &doctorRegisters, p.tenant)
	if ctype != "dental" || !doctorRegisters {
		t.Fatalf("dental clinic: type %q doctor_registers %v", ctype, doctorRegisters)
	}
	for flag, want := range map[string]bool{"dental": true, "laboratory": false, "pharmacy": false, "inventory": false} {
		if got := platFlag(t, p.tenant, flag); got != want {
			t.Errorf("dental preset: %s = %v, want %v", flag, got, want)
		}
	}
}

// TestREG_PLAT_011_ProvisionHonoursModulesAndAChosenPassword: Given a super-admin, When
// they provision a general clinic with pharmacy switched off, an unknown module, and
// an owner password of their own, Then pharmacy is off, the unknown module is ignored,
// no temporary password is returned and the owner signs in with the chosen one.
func TestREG_PLAT_011_ProvisionHonoursModulesAndAChosenPassword(t *testing.T) {
	adm, _, _ := platAdmin(t)
	body := platProvisionBody("general")
	body["modules"] = map[string]bool{"pharmacy": false, "teleportation": true}
	body["owner_password"] = "Chosen#Pass-123"
	p := platProvision(t, adm, body)
	if p.TempPassword != "" {
		t.Fatalf("a chosen password must not be echoed as a temp password: %+v", p)
	}
	if platFlag(t, p.tenant, "pharmacy") || !platFlag(t, p.tenant, "laboratory") {
		t.Fatal("module choice not honoured: want pharmacy off, laboratory on")
	}
	var n int
	one(t, `SELECT count(*) FROM feature_flags WHERE tenant_id = $1 AND flag = 'teleportation'`, &n, p.tenant)
	if n != 0 {
		t.Fatal("an unknown module became a feature flag")
	}
	r, _ := platStaffLogin(t, p.WorkspaceSlug, p.OwnerEmail, "Chosen#Pass-123")
	r.Expect(t, 200, "owner signs in with the chosen password")
}

// TestREG_PLAT_012_ProvisionValidatesItsInput: Given a super-admin, When required
// fields are missing, the clinic type is unknown, the phone is not a phone, or the
// workspace is already taken, Then 400/400/400/409 and no clinic is created.
func TestREG_PLAT_012_ProvisionValidatesItsInput(t *testing.T) {
	adm, _, _ := platAdmin(t)
	var before int
	one(t, `SELECT count(*) FROM tenants`, &before)

	for _, field := range []string{"clinic_name", "slug", "owner_email", "owner_name"} {
		b := platProvisionBody("general")
		b[field] = "   "
		adm.Do("POST", "/platform/clinics", b).Expect(t, 400, "missing "+field)
	}
	b := platProvisionBody("veterinary")
	adm.Do("POST", "/platform/clinics", b).Expect(t, 400, "unknown clinic type")
	b = platProvisionBody("general")
	b["owner_phone"] = "call me maybe"
	if r := adm.Do("POST", "/platform/clinics", b).Expect(t, 400, "bad phone"); !strings.Contains(r.Raw, "owner_phone") {
		t.Fatalf("bad phone error should name the field: %s", r.Raw)
	}
	adm.Do("POST", "/platform/clinics", "nope").Expect(t, 400, "malformed body")

	var after int
	one(t, `SELECT count(*) FROM tenants`, &after)
	if after != before {
		t.Fatalf("refused requests created %d clinic(s)", after-before)
	}

	b = platProvisionBody("general")
	platProvision(t, adm, b)
	b2 := platProvisionBody("dental")
	b2["slug"] = b["slug"]
	if r := adm.Do("POST", "/platform/clinics", b2).Expect(t, 409, "duplicate workspace"); r.Code != "SLUG_TAKEN" {
		t.Fatalf("want SLUG_TAKEN, got %s", r.Code)
	}
}

// TestREG_PLAT_013_ProvisionPlanMustSuitTheClinicType: Given a general-only plan, a
// dental plan and a universal plan, When a dental clinic is provisioned on each, Then
// it lands on the dental and the universal plan as asked, but never on the general
// one (it falls back to the default business plan instead).
func TestREG_PLAT_013_ProvisionPlanMustSuitTheClinicType(t *testing.T) {
	adm, _, _ := platAdmin(t)
	general := platCreatePlan(t, adm, "general")
	dental := platCreatePlan(t, adm, "dental")
	all := platCreatePlan(t, adm, "all")
	planOf := func(code string) string {
		b := platProvisionBody("dental")
		b["plan_code"] = strings.ToUpper(code)
		p := platProvision(t, adm, b)
		var got string
		one(t, `SELECT p.code FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, &got, p.tenant)
		var sub string
		one(t, `SELECT p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, &sub, p.tenant)
		if sub != got {
			t.Fatalf("subscription plan %q differs from tenant plan %q", sub, got)
		}
		return got
	}
	if got := planOf(dental.Code); got != dental.Code {
		t.Errorf("dental clinic on a dental plan: landed on %q", got)
	}
	if got := planOf(all.Code); got != all.Code {
		t.Errorf("dental clinic on a universal plan: landed on %q", got)
	}
	if got := planOf(general.Code); got == general.Code {
		t.Errorf("dental clinic was put on a general-only plan %q", got)
	}
}

// TestREG_PLAT_014_ProvisionOntoARetiredPlanIsRefused: Given a retired plan ("kept for
// whoever is on it, never offered again"), When a new clinic is provisioned onto it,
// Then the request is refused (or at least the clinic does not join the retired
// plan). Known bug NEW-PLAT-1: SetClinicPlan refuses a retired plan but provisioning
// does not check the status, so the price list quietly grows the old tier again.
func TestREG_PLAT_014_ProvisionOntoARetiredPlanIsRefused(t *testing.T) {
	adm, _, _ := platAdmin(t)
	retired := platCreatePlan(t, adm, "all")
	if _, err := super.Pool.Exec(t.Context(), `UPDATE plans SET status = 'retired' WHERE code = $1`, retired.Code); err != nil {
		t.Fatal(err)
	}
	b := platProvisionBody("general")
	b["plan_code"] = retired.Code
	r := adm.Do("POST", "/platform/clinics", b)
	joined := false
	if r.Status == 201 {
		var n int
		one(t, `SELECT count(*) FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.slug = $1 AND p.code = $2`,
			&n, b["slug"], retired.Code)
		joined = n == 1
	}
	testkit.KnownBug(t, "NEW-PLAT-1", joined, "a new clinic can be provisioned onto a retired plan")
	if joined {
		t.Fatal("new clinic joined a retired plan")
	}
}

// ---- suspend / reactivate ------------------------------------------------------------

// TestREG_PLAT_015_SuspendLocksTheClinicOutAndReactivateLetsItBack: Given a
// provisioned clinic, When the super-admin suspends it, Then the roster says
// suspended and its owner's sign-in is refused (TENANT_INACTIVE); When reactivated,
// Then the owner signs in again. An unknown clinic is 404, a malformed id 400.
func TestREG_PLAT_015_SuspendLocksTheClinicOutAndReactivateLetsItBack(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("dental"))
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/suspend", nil).Expect(t, 204, "suspend")
	if st := platListClinics(t, adm)[p.WorkspaceSlug].Status; st != "suspended" {
		t.Fatalf("roster status after suspend = %q", st)
	}
	r, _ := platStaffLogin(t, p.WorkspaceSlug, p.OwnerEmail, p.TempPassword)
	r.Expect(t, 403, "owner sign-in at a suspended clinic")
	if r.Code != "TENANT_INACTIVE" {
		t.Fatalf("want TENANT_INACTIVE, got %s", r.Code)
	}
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/reactivate", nil).Expect(t, 204, "reactivate")
	if st := platListClinics(t, adm)[p.WorkspaceSlug].Status; st != "active" {
		t.Fatalf("roster status after reactivate = %q", st)
	}
	r, _ = platStaffLogin(t, p.WorkspaceSlug, p.OwnerEmail, p.TempPassword)
	r.Expect(t, 200, "owner sign-in after reactivation")

	ghost := id.Encode(id.PrefixTenant, uuid.New())
	adm.Do("POST", "/platform/clinics/"+ghost+"/suspend", nil).Expect(t, 404, "suspend unknown clinic")
	adm.Do("POST", "/platform/clinics/"+ghost+"/reactivate", nil).Expect(t, 404, "reactivate unknown clinic")
	adm.Do("POST", "/platform/clinics/not-an-id/suspend", nil).Expect(t, 400, "suspend malformed id")
}

// TestREG_PLAT_016_SuspendingAClinicEndsItsSessions: Given a clinic owner who is
// signed in, When the super-admin suspends the clinic, Then the owner's existing
// token stops working. Known bug SEC-10: only new sign-ins are blocked; a session
// opened before the suspension keeps reading patient data until it expires.
func TestREG_PLAT_016_SuspendingAClinicEndsItsSessions(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("dental"))
	_, owner := platStaffLogin(t, p.WorkspaceSlug, p.OwnerEmail, p.TempPassword)
	owner.Do("GET", "/patients", nil).Expect(t, 200, "owner reads patients before suspension")
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/suspend", nil).Expect(t, 204, "suspend")
	r := owner.Do("GET", "/patients", nil)
	// (SEC-10, fixed 2026-10-03.)
	if r.Status != 403 || r.Code != "TENANT_INACTIVE" {
		t.Fatalf("suspended clinic session: HTTP %d %s, want 403 TENANT_INACTIVE", r.Status, r.Code)
	}
	var live int
	one(t, `SELECT count(*) FROM sessions s JOIN tenants t ON t.id = s.tenant_id
	         WHERE t.slug = $1 AND s.revoked_at IS NULL`, &live, p.WorkspaceSlug)
	if live != 0 {
		t.Fatalf("suspending left %d live session(s) in the clinic", live)
	}
	// Reactivated: nobody is silently signed back in, and a fresh sign-in works.
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/reactivate", nil).Expect(t, 204, "reactivate")
	platStaffLogin(t, p.WorkspaceSlug, p.OwnerEmail, p.TempPassword)
}

// ---- modules and policies --------------------------------------------------------------

// TestREG_PLAT_017_ModulesAreReadAndSwitchedPerClinic: Given a general clinic, When the
// super-admin reads its modules, Then every toggleable module is listed with its
// state; When they switch laboratory off (plus an unknown key), Then laboratory is
// stored off as an override, nothing else changes, and the read shows it.
func TestREG_PLAT_017_ModulesAreReadAndSwitchedPerClinic(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("general"))
	type mod struct {
		Key     string `json:"key"`
		Label   string `json:"label"`
		Enabled bool   `json:"enabled"`
	}
	read := func() map[string]mod {
		var list []mod
		adm.Do("GET", "/platform/clinics/"+p.Clinic.ID+"/modules", nil).Expect(t, 200, "get modules").Decode(t, &list)
		out := map[string]mod{}
		for _, m := range list {
			out[m.Key] = m
		}
		return out
	}
	m := read()
	for _, k := range []string{"laboratory", "pharmacy", "dental", "maternity", "inpatient"} {
		if _, ok := m[k]; !ok || m[k].Label == "" {
			t.Fatalf("module %s missing from %v", k, m)
		}
	}
	if !m["laboratory"].Enabled || m["dental"].Enabled {
		t.Fatalf("general clinic modules: %v", m)
	}
	adm.Do("PUT", "/platform/clinics/"+p.Clinic.ID+"/modules", map[string]any{
		"modules": map[string]bool{"laboratory": false, "warp_drive": true},
	}).Expect(t, 204, "set modules")
	if m := read(); m["laboratory"].Enabled || !m["pharmacy"].Enabled {
		t.Fatalf("after switching laboratory off: %v", m)
	}
	var src string
	one(t, `SELECT source FROM feature_flags WHERE tenant_id = $1 AND flag = 'laboratory' AND branch_id IS NULL`, &src, p.tenant)
	if src != "override" {
		t.Fatalf("laboratory flag source = %q, want override", src)
	}
	var n int
	one(t, `SELECT count(*) FROM feature_flags WHERE tenant_id = $1 AND flag = 'warp_drive'`, &n, p.tenant)
	if n != 0 {
		t.Fatal("unknown module stored")
	}
	adm.Do("PUT", "/platform/clinics/"+p.Clinic.ID+"/modules", "x").Expect(t, 400, "malformed modules body")
	adm.Do("GET", "/platform/clinics/bad/modules", nil).Expect(t, 400, "get modules malformed id")
	adm.Do("PUT", "/platform/clinics/bad/modules", map[string]any{"modules": map[string]bool{}}).Expect(t, 400, "set modules malformed id")
}

// TestREG_PLAT_018_DoctorRegistrationPolicyChangesTheGrant: Given a general clinic
// (doctors may not register patients), When the super-admin turns the policy on, Then
// the doctor role holds patient.create and a doctor who signs in can register a
// patient; When turned off, Then the grant is gone again. An unknown clinic is 404.
func TestREG_PLAT_018_DoctorRegistrationPolicyChangesTheGrant(t *testing.T) {
	adm, _, _ := platAdmin(t)
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{ClinicType: "general"})
	cid := id.Encode(id.PrefixTenant, c.TenantID)
	type pol struct {
		Key     string `json:"key"`
		Label   string `json:"label"`
		Help    string `json:"help"`
		Enabled bool   `json:"enabled"`
	}
	read := func() pol {
		var list []pol
		adm.Do("GET", "/platform/clinics/"+cid+"/policies", nil).Expect(t, 200, "get policies").Decode(t, &list)
		for _, p := range list {
			if p.Key == "doctor_registers_patients" {
				return p
			}
		}
		t.Fatalf("doctor_registers_patients missing from %v", list)
		return pol{}
	}
	granted := func() bool {
		var n int
		one(t, `SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
		         WHERE r.tenant_id = $1 AND r.code = 'doctor' AND p.code = 'patient.create'`, &n, c.TenantID)
		return n == 1
	}
	if p := read(); p.Enabled || p.Label == "" || p.Help == "" || granted() {
		t.Fatalf("general clinic starts with doctors registering: %+v granted=%v", p, granted())
	}
	adm.Do("PUT", "/platform/clinics/"+cid+"/policies", map[string]any{"policies": map[string]bool{"doctor_registers_patients": true}}).
		Expect(t, 204, "turn on")
	if !read().Enabled || !granted() {
		t.Fatal("policy on: column or grant not updated")
	}
	createPatient(t, srv.As(t, c, "doctor"), uniq("Doc"), "Registers")

	adm.Do("PUT", "/platform/clinics/"+cid+"/policies", map[string]any{"policies": map[string]bool{"doctor_registers_patients": false}}).
		Expect(t, 204, "turn off")
	if read().Enabled || granted() {
		t.Fatal("policy off: column or grant not reverted")
	}
	srv.As(t, c, "doctor").Do("POST", "/patients", map[string]any{"first_name": "No", "last_name": "Grant", "gender": "male", "dob": "1990-01-01"}).
		Expect(t, 403, "doctor registers after the policy is off")

	// A body that names no known policy changes nothing.
	adm.Do("PUT", "/platform/clinics/"+cid+"/policies", map[string]any{"policies": map[string]bool{}}).Expect(t, 204, "empty policies")
	ghost := id.Encode(id.PrefixTenant, uuid.New())
	adm.Do("GET", "/platform/clinics/"+ghost+"/policies", nil).Expect(t, 404, "policies unknown clinic")
	adm.Do("PUT", "/platform/clinics/"+ghost+"/policies", map[string]any{"policies": map[string]bool{"doctor_registers_patients": true}}).
		Expect(t, 404, "set policies unknown clinic")
	adm.Do("PUT", "/platform/clinics/"+cid+"/policies", 7).Expect(t, 400, "malformed policies")
	adm.Do("GET", "/platform/clinics/x/policies", nil).Expect(t, 400, "malformed id")
	adm.Do("PUT", "/platform/clinics/x/policies", map[string]any{}).Expect(t, 400, "malformed id")
}

// ---- plans -------------------------------------------------------------------------------

// TestREG_PLAT_019_PlanIsCreatedListedAndUpdated: Given a super-admin, When they create
// a plan (code in capitals, no type, no price, blank limits), Then it is stored with
// a lower-case code, type "all", price 0, unlimited limits and status active, and is
// listed; When they edit it, Then the list shows the new name, type and caps.
func TestREG_PLAT_019_PlanIsCreatedListedAndUpdated(t *testing.T) {
	adm, _, _ := platAdmin(t)
	code := strings.ToLower(uniq("tier"))
	r := adm.Do("POST", "/platform/plans", map[string]any{"code": "  " + strings.ToUpper(code) + " ", "name": " Tier One "}).
		Expect(t, 201, "create plan")
	var p platPlan
	r.Decode(t, &p)
	if p.Code != code || p.Name != "Tier One" || p.ClinicType != "all" || p.PriceMonthly != "0" || p.Status != "active" ||
		p.PatientLimit != nil || p.UserLimit != nil || p.StorageGB != nil || p.BranchLimit != nil || p.InUse != 0 {
		t.Fatalf("created plan: %+v", p)
	}
	if got, ok := platListPlans(t, adm)[code]; !ok || got.ID != p.ID {
		t.Fatalf("new plan not listed: %+v", got)
	}
	adm.Do("PUT", "/platform/plans/"+p.ID, map[string]any{
		"code": "ignored", "name": "Tier One Plus", "clinic_type": "dental", "patient_limit": 900, "storage_gb": 20,
		"user_limit": 4, "branch_limit": 2, "images_per_patient": 12, "sms_monthly": 300, "price_monthly": "2500.50",
	}).Expect(t, 204, "update plan")
	got := platListPlans(t, adm)[code]
	if got.Name != "Tier One Plus" || got.ClinicType != "dental" || got.PatientLimit == nil || *got.PatientLimit != 900 ||
		got.StorageGB == nil || *got.StorageGB != 20 || got.SMSMonthly == nil || *got.SMSMonthly != 300 ||
		got.ImagesPerPatient == nil || *got.ImagesPerPatient != 12 || got.PriceMonthly != "2500.50" {
		t.Fatalf("updated plan: %+v", got)
	}
	if _, renamed := platListPlans(t, adm)["ignored"]; renamed {
		t.Fatal("update changed the plan code")
	}
}

// TestREG_PLAT_020_PlanWritesAreValidated: Given a plan, When a second plan reuses its
// code, Then 409 PLAN_CODE_TAKEN; a missing code or name, or an unknown clinic type,
// is 400; editing an unknown plan is 404 and a blank name 400.
func TestREG_PLAT_020_PlanWritesAreValidated(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platCreatePlan(t, adm, "general")
	if r := adm.Do("POST", "/platform/plans", map[string]any{"code": p.Code, "name": "Again"}).Expect(t, 409, "duplicate code"); r.Code != "PLAN_CODE_TAKEN" {
		t.Fatalf("want PLAN_CODE_TAKEN, got %s", r.Code)
	}
	adm.Do("POST", "/platform/plans", map[string]any{"code": "", "name": "No code"}).Expect(t, 400, "missing code")
	adm.Do("POST", "/platform/plans", map[string]any{"code": uniq("x"), "name": " "}).Expect(t, 400, "missing name")
	adm.Do("POST", "/platform/plans", map[string]any{"code": uniq("x"), "name": "Vet", "clinic_type": "veterinary"}).Expect(t, 400, "bad type")
	adm.Do("POST", "/platform/plans", "x").Expect(t, 400, "malformed")
	adm.Do("PUT", "/platform/plans/"+p.ID, map[string]any{"name": ""}).Expect(t, 400, "blank name")
	adm.Do("PUT", "/platform/plans/"+p.ID, map[string]any{"name": "Ok", "clinic_type": "vet"}).Expect(t, 400, "bad type on update")
	adm.Do("PUT", "/platform/plans/"+p.ID, "x").Expect(t, 400, "malformed update")
	adm.Do("PUT", "/platform/plans/"+id.Encode(id.PrefixPlan, uuid.New()), map[string]any{"name": "Ghost"}).Expect(t, 404, "unknown plan")
	adm.Do("PUT", "/platform/plans/nope", map[string]any{"name": "Ghost"}).Expect(t, 400, "malformed plan id")
}

// TestREG_PLAT_021_ClinicPlanMustMatchTheClinicType: Given a dental clinic, When the
// super-admin moves it onto a general-only plan, Then 400 and the clinic keeps its
// plan; onto a dental or universal plan, Then 204 and the list counts it in_use.
func TestREG_PLAT_021_ClinicPlanMustMatchTheClinicType(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("dental"))
	general := platCreatePlan(t, adm, "general")
	dental := platCreatePlan(t, adm, "dental")
	before := platListClinics(t, adm)[p.WorkspaceSlug].PlanCode

	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/plan", map[string]any{"plan_id": general.ID}).Expect(t, 400, "cross-type plan")
	if got := platListClinics(t, adm)[p.WorkspaceSlug].PlanCode; got != before {
		t.Fatalf("refused move still changed the plan: %q -> %q", before, got)
	}
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/plan", map[string]any{"plan_id": dental.ID}).Expect(t, 204, "same-type plan")
	if got := platListClinics(t, adm)[p.WorkspaceSlug]; got.PlanCode != dental.Code || got.PlanName != dental.Name {
		t.Fatalf("clinic plan after move: %+v", got)
	}
	if n := platListPlans(t, adm)[dental.Code].InUse; n != 1 {
		t.Fatalf("dental plan in_use = %d, want 1", n)
	}
	var sub string
	one(t, `SELECT p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, &sub, p.tenant)
	if sub != dental.Code {
		t.Fatalf("subscription plan = %q, want %q", sub, dental.Code)
	}
}

// TestREG_PLAT_022_RetiredPlanTakesNoNewClinics: Given a clinic already on a plan that
// is then retired, When another clinic is moved onto the retired plan, Then 400; the
// clinic already on it keeps it.
func TestREG_PLAT_022_RetiredPlanTakesNoNewClinics(t *testing.T) {
	adm, _, _ := platAdmin(t)
	plan := platCreatePlan(t, adm, "all")
	first := platProvision(t, adm, platProvisionBody("general"))
	second := platProvision(t, adm, platProvisionBody("general"))
	adm.Do("POST", "/platform/clinics/"+first.Clinic.ID+"/plan", map[string]any{"plan_id": plan.ID}).Expect(t, 204, "join before retirement")
	if _, err := super.Pool.Exec(t.Context(), `UPDATE plans SET status = 'retired' WHERE code = $1`, plan.Code); err != nil {
		t.Fatal(err)
	}
	r := adm.Do("POST", "/platform/clinics/"+second.Clinic.ID+"/plan", map[string]any{"plan_id": plan.ID}).Expect(t, 400, "join a retired plan")
	if !strings.Contains(strings.ToLower(r.Message), "retired") {
		t.Fatalf("refusal should say the plan is retired: %q", r.Message)
	}
	roster := platListClinics(t, adm)
	if roster[first.WorkspaceSlug].PlanCode != plan.Code || roster[second.WorkspaceSlug].PlanCode == plan.Code {
		t.Fatalf("after refusal: first on %q, second on %q", roster[first.WorkspaceSlug].PlanCode, roster[second.WorkspaceSlug].PlanCode)
	}
	if got := platListPlans(t, adm)[plan.Code]; got.Status != "retired" || got.InUse != 1 {
		t.Fatalf("retired plan row: %+v", got)
	}
}

// TestREG_PLAT_023_ClinicPlanOverridesAreStoredAndReported: Given a clinic, When the
// super-admin puts it on a plan with per-clinic overrides (a number, "unlimited" as
// -1, and blank to inherit), Then the overrides are stored, and the usage view shows
// the overridden caps, -1 for unlimited, and the plan's own cap where inherited.
func TestREG_PLAT_023_ClinicPlanOverridesAreStoredAndReported(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("general"))
	plan := platCreatePlan(t, adm, "general") // patient_limit 500, user_limit 5
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/plan", map[string]any{
		"plan_id": plan.ID, "patient_limit_override": 50, "storage_gb_override": -1, "branch_limit_override": 3,
	}).Expect(t, 204, "set plan with overrides")
	var usage struct {
		PlanName string `json:"plan_name"`
		Patients struct{ Used, Limit int64 }
		Users    struct{ Used, Limit int64 }
		Storage  struct{ Used, Limit int64 }
		Branches struct{ Used, Limit int64 }
		Patient  *int `json:"patient_limit_override"`
		Storage2 *int `json:"storage_gb_override"`
		User     *int `json:"user_limit_override"`
		Branch   *int `json:"branch_limit_override"`
	}
	adm.Do("GET", "/platform/clinics/"+p.Clinic.ID+"/usage", nil).Expect(t, 200, "usage").Decode(t, &usage)
	if usage.PlanName != plan.Name {
		t.Fatalf("usage plan name %q, want %q", usage.PlanName, plan.Name)
	}
	if usage.Patients.Limit != 50 || usage.Users.Limit != 5 || usage.Storage.Limit != -1 || usage.Branches.Limit != 3 {
		t.Fatalf("effective caps: patients %d users %d storage %d branches %d",
			usage.Patients.Limit, usage.Users.Limit, usage.Storage.Limit, usage.Branches.Limit)
	}
	if usage.Users.Used != 1 || usage.Branches.Used != 1 || usage.Patients.Used != 0 {
		t.Fatalf("usage counts: users %d branches %d patients %d", usage.Users.Used, usage.Branches.Used, usage.Patients.Used)
	}
	if usage.Patient == nil || *usage.Patient != 50 || usage.Storage2 == nil || *usage.Storage2 != -1 || usage.User != nil {
		t.Fatalf("override fields: %+v", usage)
	}
	ghost := id.Encode(id.PrefixTenant, uuid.New())
	adm.Do("POST", "/platform/clinics/"+ghost+"/plan", map[string]any{"plan_id": plan.ID}).Expect(t, 404, "unknown clinic")
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/plan", map[string]any{"plan_id": id.Encode(id.PrefixPlan, uuid.New())}).Expect(t, 400, "unknown plan")
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/plan", map[string]any{"plan_id": "garbage"}).Expect(t, 400, "malformed plan id")
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/plan", "x").Expect(t, 400, "malformed body")
	adm.Do("POST", "/platform/clinics/zzz/plan", map[string]any{"plan_id": plan.ID}).Expect(t, 400, "malformed clinic id")
	adm.Do("GET", "/platform/clinics/zzz/usage", nil).Expect(t, 400, "usage malformed id")
}

// TestREG_PLAT_024_PatientCapOverrideIsEnforced: Given a clinic whose patient cap is
// overridden to 0, When reception registers a patient, Then the clinic API refuses it;
// When the override is cleared back to "unlimited", Then registration works.
func TestREG_PLAT_024_PatientCapOverrideIsEnforced(t *testing.T) {
	adm, _, _ := platAdmin(t)
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{ClinicType: "general"})
	cid := id.Encode(id.PrefixTenant, c.TenantID)
	plan := platCreatePlan(t, adm, "all")
	adm.Do("POST", "/platform/clinics/"+cid+"/plan", map[string]any{"plan_id": plan.ID, "patient_limit_override": 0}).Expect(t, 204, "cap at 0")
	r := srv.As(t, c, "receptionist").Do("POST", "/patients", map[string]any{
		"first_name": "Over", "last_name": "Cap", "gender": "female", "dob": "1990-01-01", "force": true,
	})
	if r.Status < 400 || r.Status >= 500 {
		t.Fatalf("registering past a 0 cap: want a 4xx refusal, got %d %s", r.Status, r.Raw)
	}
	adm.Do("POST", "/platform/clinics/"+cid+"/plan", map[string]any{"plan_id": plan.ID, "patient_limit_override": -1}).Expect(t, 204, "unlimited")
	createPatient(t, srv.As(t, c, "receptionist"), uniq("Under"), "Cap")
}

// TestREG_PLAT_025_UsageOfAnUnknownClinicIsNotFound: Given a clinic id that does not
// exist, When the usage view is asked for it, Then 404 rather than a server error.
func TestREG_PLAT_025_UsageOfAnUnknownClinicIsNotFound(t *testing.T) {
	adm, _, _ := platAdmin(t)
	r := adm.Do("GET", "/platform/clinics/"+id.Encode(id.PrefixTenant, uuid.New())+"/usage", nil)
	if r.Status == 500 {
		testkit.KnownBug(t, "NEW-PLAT-2", true, "usage of an unknown clinic is a 500, not a 404")
	}
	if r.Status != 404 {
		t.Fatalf("usage of unknown clinic: want 404, got %d %s", r.Status, r.Raw)
	}
}

// ---- features and entitlements --------------------------------------------------------------

// TestREG_PLAT_026_PlanFeaturesStartUndescribedAndCanBeSet: Given the feature
// catalogue and a new plan, When the plan's features are read, Then it is
// "not configured" (it gates nothing); When features are saved, Then it is configured
// and reads back what was saved. An unknown plan is 404.
func TestREG_PLAT_026_PlanFeaturesStartUndescribedAndCanBeSet(t *testing.T) {
	adm, _, _ := platAdmin(t)
	var cat []struct {
		Code, Name, Category string
		ClinicType           string `json:"clinic_type"`
	}
	adm.Do("GET", "/platform/features", nil).Expect(t, 200, "features").Decode(t, &cat)
	if len(cat) == 0 || cat[0].Code == "" || cat[0].Name == "" || cat[0].Category == "" {
		t.Fatalf("feature catalogue: %+v", cat)
	}
	plan := platCreatePlan(t, adm, "all")
	var set struct {
		Configured bool            `json:"configured"`
		Features   map[string]bool `json:"features"`
	}
	adm.Do("GET", "/platform/plans/"+plan.ID+"/features", nil).Expect(t, 200, "plan features").Decode(t, &set)
	if set.Configured || len(set.Features) != 0 {
		t.Fatalf("new plan should be undescribed: %+v", set)
	}
	f := cat[0].Code
	adm.Do("PUT", "/platform/plans/"+plan.ID+"/features", map[string]any{"features": map[string]bool{f: false}}).Expect(t, 204, "set features")
	adm.Do("PUT", "/platform/plans/"+plan.ID+"/features", map[string]any{"features": map[string]bool{f: true}}).Expect(t, 204, "flip feature")
	adm.Do("GET", "/platform/plans/"+plan.ID+"/features", nil).Expect(t, 200, "plan features").Decode(t, &set)
	if !set.Configured || !set.Features[f] {
		t.Fatalf("after save: %+v", set)
	}
	ghost := id.Encode(id.PrefixPlan, uuid.New())
	adm.Do("PUT", "/platform/plans/"+ghost+"/features", map[string]any{"features": map[string]bool{f: true}}).Expect(t, 404, "unknown plan")
	adm.Do("PUT", "/platform/plans/"+plan.ID+"/features", "x").Expect(t, 400, "malformed")
	adm.Do("GET", "/platform/plans/bad/features", nil).Expect(t, 400, "malformed plan id")
	adm.Do("PUT", "/platform/plans/bad/features", map[string]any{}).Expect(t, 400, "malformed plan id")
}

// TestREG_PLAT_027_UnknownPlanFeatureIsABadRequest: Given a plan, When its features
// are saved with a code that is not in the catalogue, Then 400, not a server error,
// and nothing is stored.
func TestREG_PLAT_027_UnknownPlanFeatureIsABadRequest(t *testing.T) {
	adm, _, _ := platAdmin(t)
	plan := platCreatePlan(t, adm, "all")
	r := adm.Do("PUT", "/platform/plans/"+plan.ID+"/features", map[string]any{"features": map[string]bool{"time_travel": true}})
	if r.Status == 500 {
		testkit.KnownBug(t, "NEW-PLAT-3", true, "saving a plan feature that is not in the catalogue is a 500, not a 400")
	}
	if r.Status != 400 {
		t.Fatalf("unknown feature: want 400, got %d %s", r.Status, r.Raw)
	}
}

// TestREG_PLAT_028_ClinicEntitlementExceptionsAreSetAndCleared: Given a clinic on a
// plan that includes nothing, When the super-admin adds one feature for this clinic
// with a note, Then the read shows the plan's answer and the exception with its note;
// When the exception is cleared (state null), Then the plan decides again. Unknown or
// missing features are 400, an unknown clinic 404.
func TestREG_PLAT_028_ClinicEntitlementExceptionsAreSetAndCleared(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("general"))
	plan := platCreatePlan(t, adm, "all")
	f := platFirstFeature(t)
	adm.Do("PUT", "/platform/plans/"+plan.ID+"/features", map[string]any{"features": map[string]bool{f: false}}).Expect(t, 204, "describe plan")
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/plan", map[string]any{"plan_id": plan.ID}).Expect(t, 204, "move clinic")

	type ent struct {
		PlanName       string            `json:"plan_name"`
		PlanConfigured bool              `json:"plan_configured"`
		FromPlan       map[string]bool   `json:"from_plan"`
		Override       map[string]bool   `json:"override"`
		Note           map[string]string `json:"note"`
	}
	read := func() ent {
		var e ent
		adm.Do("GET", "/platform/clinics/"+p.Clinic.ID+"/entitlements", nil).Expect(t, 200, "entitlements").Decode(t, &e)
		return e
	}
	e := read()
	if e.PlanName != plan.Name || !e.PlanConfigured || e.FromPlan[f] || len(e.Override) != 0 {
		t.Fatalf("before exception: %+v", e)
	}
	adm.Do("PUT", "/platform/clinics/"+p.Clinic.ID+"/entitlements", map[string]any{"feature": " " + f + " ", "state": true, "note": " sold as add-on "}).
		Expect(t, 204, "add exception")
	e = read()
	if on, ok := e.Override[f]; !ok || !on || e.Note[f] != "sold as add-on" {
		t.Fatalf("after add: %+v", e)
	}
	adm.Do("PUT", "/platform/clinics/"+p.Clinic.ID+"/entitlements", map[string]any{"feature": f, "state": false}).Expect(t, 204, "withdraw")
	if e = read(); e.Override[f] {
		t.Fatalf("after withdraw: %+v", e)
	}
	adm.Do("PUT", "/platform/clinics/"+p.Clinic.ID+"/entitlements", map[string]any{"feature": f, "state": nil}).Expect(t, 204, "clear")
	if e = read(); len(e.Override) != 0 {
		t.Fatalf("after clear: %+v", e)
	}
	var n int
	one(t, `SELECT count(*) FROM tenant_entitlements WHERE tenant_id = $1`, &n, p.tenant)
	if n != 0 {
		t.Fatalf("cleared exception left %d row(s)", n)
	}

	adm.Do("PUT", "/platform/clinics/"+p.Clinic.ID+"/entitlements", map[string]any{"feature": "levitation", "state": true}).Expect(t, 400, "unknown feature")
	adm.Do("PUT", "/platform/clinics/"+p.Clinic.ID+"/entitlements", map[string]any{"feature": "  ", "state": true}).Expect(t, 400, "blank feature")
	adm.Do("GET", "/platform/clinics/"+id.Encode(id.PrefixTenant, uuid.New())+"/entitlements", nil).Expect(t, 404, "unknown clinic")
	adm.Do("GET", "/platform/clinics/q/entitlements", nil).Expect(t, 400, "malformed id")
	adm.Do("PUT", "/platform/clinics/q/entitlements", map[string]any{"feature": f}).Expect(t, 400, "malformed id")
}

// ---- Verify.ET key -----------------------------------------------------------------------------

// TestREG_PLAT_029_VerifyETKeyIsStoredEncryptedAndNeverEchoed: Given no key, When the
// super-admin saves one, Then the answer says configured with a four-character hint
// and never contains the key; the read never contains it; the database holds only
// ciphertext and names who saved it. A blank key is 400; removing it turns
// verification off again.
func TestREG_PLAT_029_VerifyETKeyIsStoredEncryptedAndNeverEchoed(t *testing.T) {
	adm, _, uid := platAdmin(t)
	adm.Do("DELETE", "/platform/integrations/verifyet", nil).Expect(t, 204, "start clean")
	type integ struct {
		Key        string `json:"key"`
		Configured bool   `json:"configured"`
		Hint       string `json:"hint"`
		UpdatedAt  string `json:"updated_at"`
		Source     string `json:"source"`
	}
	var g integ
	adm.Do("GET", "/platform/integrations/verifyet", nil).Expect(t, 200, "read empty").Decode(t, &g)
	if g.Configured || g.Hint != "" || g.Key != "verifyet_api_key" {
		t.Fatalf("no key loaded: %+v", g)
	}

	secret := "VERIFY_BANK_ET_" + strings.ReplaceAll(uuid.NewString(), "-", "") + "a3f9"
	r := adm.Do("PUT", "/platform/integrations/verifyet", map[string]any{"key": "  " + secret + "  "}).Expect(t, 200, "save key")
	if strings.Contains(r.Raw, secret) || strings.Contains(r.Raw, secret[:20]) {
		t.Fatalf("save echoed the key: %s", r.Raw)
	}
	r.Decode(t, &g)
	if !g.Configured || g.Hint != "…a3f9" || g.Source != "saved" || g.UpdatedAt == "" {
		t.Fatalf("after save: %+v", g)
	}
	r = adm.Do("GET", "/platform/integrations/verifyet", nil).Expect(t, 200, "read")
	if strings.Contains(r.Raw, secret) || strings.Contains(r.Raw, secret[:20]) {
		t.Fatalf("read echoed the key: %s", r.Raw)
	}
	var stored string
	var by uuid.UUID
	one(t, `SELECT value_enc FROM platform_settings WHERE key = 'verifyet_api_key'`, &stored)
	one(t, `SELECT updated_by FROM platform_settings WHERE key = 'verifyet_api_key'`, &by)
	if stored == secret || strings.Contains(stored, secret) {
		t.Fatal("the key is stored in plain text")
	}
	if by != uid {
		t.Fatalf("updated_by = %s, want the admin %s", by, uid)
	}

	adm.Do("PUT", "/platform/integrations/verifyet", map[string]any{"key": "   "}).Expect(t, 400, "blank key")
	adm.Do("PUT", "/platform/integrations/verifyet", "x").Expect(t, 400, "malformed")
	adm.Do("PUT", "/platform/integrations/verifyet", map[string]any{"key": "abc"}).Expect(t, 200, "short key").Decode(t, &g)
	if g.Hint != "…" {
		t.Fatalf("a key of 4 characters or fewer must not be hinted at all, got %q", g.Hint)
	}
	adm.Do("DELETE", "/platform/integrations/verifyet", nil).Expect(t, 204, "remove")
	adm.Do("GET", "/platform/integrations/verifyet", nil).Expect(t, 200, "read after remove").Decode(t, &g)
	if g.Configured {
		t.Fatalf("after remove: %+v", g)
	}
}

// ---- partner leads ---------------------------------------------------------------------------

// TestREG_PLAT_030_PartnerLeadIsCapturedListedAndWorked: Given the public partner page,
// When someone registers, Then the lead is stored (with the caller's address) and
// the super-admin sees it as new; a bot that fills the honeypot is thanked but not
// stored; a lead without a name is 400. When the admin marks it contacted, Then the
// list says so; an unknown status is 400, an unknown lead 404.
func TestREG_PLAT_030_PartnerLeadIsCapturedListedAndWorked(t *testing.T) {
	adm, _, _ := platAdmin(t)
	anon := srv.Anon(t)
	name := uniq("Partner ")
	anon.Do("POST", "/partner/leads", map[string]any{
		"name": "  " + name + " ", "phone": "0911000000", "email": "p@x.test", "region": "Addis",
		"audience": "influencer", "clinics_estimate": "5-10", "goal": "Earn", "source": "partners/abebe",
	}).Expect(t, 200, "capture lead")
	bot := uniq("Bot ")
	anon.Do("POST", "/partner/leads", map[string]any{"name": bot, "website": "http://spam"}).Expect(t, 200, "honeypot")
	anon.Do("POST", "/partner/leads", map[string]any{"name": "  "}).Expect(t, 400, "no name")
	anon.Do("POST", "/partner/leads", "x").Expect(t, 400, "malformed")

	var ip string
	one(t, `SELECT coalesce(ip,'') FROM partner_leads WHERE name = $1`, &ip, name)
	if ip == "" {
		t.Fatal("captured lead has no caller address")
	}
	var bots int
	one(t, `SELECT count(*) FROM partner_leads WHERE name = $1`, &bots, bot)
	if bots != 0 {
		t.Fatal("a honeypot submission was stored")
	}

	type lead struct {
		ID, Name, Phone, Email, Region, Audience, Goal, Source, Status string
		Estimate                                                       string `json:"clinics_estimate"`
	}
	find := func() lead {
		var list []lead
		adm.Do("GET", "/platform/partner-leads", nil).Expect(t, 200, "list leads").Decode(t, &list)
		for _, l := range list {
			if l.Name == name {
				return l
			}
		}
		t.Fatalf("lead %q not listed", name)
		return lead{}
	}
	l := find()
	if l.Status != "new" || l.Phone != "0911000000" || l.Audience != "influencer" || l.Estimate != "5-10" || l.Source != "partners/abebe" {
		t.Fatalf("listed lead: %+v", l)
	}
	adm.Do("POST", "/platform/partner-leads/"+l.ID+"/status", map[string]any{"status": "contacted"}).Expect(t, 204, "mark contacted")
	if got := find().Status; got != "contacted" {
		t.Fatalf("status after update = %q", got)
	}
	adm.Do("POST", "/platform/partner-leads/"+l.ID+"/status", map[string]any{"status": "married"}).Expect(t, 400, "bad status")
	adm.Do("POST", "/platform/partner-leads/"+l.ID+"/status", "x").Expect(t, 400, "malformed")
	adm.Do("POST", "/platform/partner-leads/"+id.Encode(id.PrefixPartnerLead, uuid.New())+"/status", map[string]any{"status": "signed"}).
		Expect(t, 404, "unknown lead")
	adm.Do("POST", "/platform/partner-leads/zz/status", map[string]any{"status": "signed"}).Expect(t, 400, "malformed lead id")
}

// ---- impersonation ---------------------------------------------------------------------------

// TestREG_PLAT_031_ImpersonationSignsInAsTheOwner: Given a provisioned clinic, When the
// super-admin signs in as its owner, Then they get a token for that clinic carrying
// the owner's roles, which reads the clinic's patients; a clinic without an active
// owner is 404 OWNER_NOT_FOUND, an unknown clinic 404, a malformed id 400.
func TestREG_PLAT_031_ImpersonationSignsInAsTheOwner(t *testing.T) {
	adm, _, _ := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("dental"))
	r := adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/impersonate", nil).Expect(t, 200, "impersonate")
	var out struct {
		AccessToken   string `json:"access_token"`
		ExpiresIn     int    `json:"expires_in"`
		WorkspaceSlug string `json:"workspace_slug"`
		User          struct {
			ID       string   `json:"id"`
			TenantID string   `json:"tenant_id"`
			Email    string   `json:"email"`
			FullName string   `json:"full_name"`
			Roles    []string `json:"roles"`
		} `json:"user"`
	}
	r.Decode(t, &out)
	if out.AccessToken == "" || out.ExpiresIn <= 0 || out.WorkspaceSlug != p.WorkspaceSlug ||
		out.User.Email != p.OwnerEmail || out.User.TenantID != p.Clinic.ID || len(out.User.Roles) == 0 {
		t.Fatalf("impersonation: %+v", out)
	}
	cl := platClaims(t, out.AccessToken)
	if cl["tid"] != p.tenant.String() || !platHasString(cl["roles"], "tenant_owner") {
		t.Fatalf("impersonation claims: %v", cl)
	}
	if platHasString(cl["perms"], "platform.admin") {
		t.Fatal("impersonation token carries platform.admin")
	}
	as := srv.Anon(t)
	as.Token = out.AccessToken
	as.Do("GET", "/patients", nil).Expect(t, 200, "impersonated owner reads patients")
	as.Do("GET", "/platform/clinics", nil).Expect(t, 403, "impersonated token on the console")

	if _, err := super.Pool.Exec(t.Context(), `UPDATE users SET status = 'suspended' WHERE tenant_id = $1`, p.tenant); err != nil {
		t.Fatal(err)
	}
	if r := adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/impersonate", nil).Expect(t, 404, "no active owner"); r.Code != "OWNER_NOT_FOUND" {
		t.Fatalf("want OWNER_NOT_FOUND, got %s", r.Code)
	}
	adm.Do("POST", "/platform/clinics/"+id.Encode(id.PrefixTenant, uuid.New())+"/impersonate", nil).Expect(t, 404, "unknown clinic")
	adm.Do("POST", "/platform/clinics/??/impersonate", nil).Expect(t, 400, "malformed id")
}

// TestREG_PLAT_032_ImpersonationIsAuditedAgainstThePlatformAdmin: Given a clinic, When
// a platform admin signs in as its owner, Then the clinic's audit trail has a row that
// names the platform admin (as actor, or in the payload). Known bug SEC-9: the only
// record is a server log line, so everything done in the session reads as the owner.
func TestREG_PLAT_032_ImpersonationIsAuditedAgainstThePlatformAdmin(t *testing.T) {
	adm, email, uid := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("dental"))
	xcDrainAudit(t, p.tenant)
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/impersonate", nil).Expect(t, 200, "impersonate")
	xcDrainAudit(t, p.tenant)
	var n int
	one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1
	          AND (actor_id = $2 OR payload::text ILIKE '%' || $3 || '%' OR action ILIKE '%imperson%')`, &n, p.tenant, uid, email)
	testkit.KnownBug(t, "SEC-9", n == 0, "impersonating a clinic owner leaves no audit row naming the platform admin")
	if n == 0 {
		t.Fatal("impersonation not audited")
	}
}

// TestREG_PLAT_033_ImpersonationTokenSaysWhoIsReallyActing: Given a clinic, When a
// platform admin signs in as its owner, Then the token carries a claim naming the
// platform admin (impersonated_by / act), so every write in that session can be
// attributed. Known bug SEC-9: the token is indistinguishable from the owner's own.
func TestREG_PLAT_033_ImpersonationTokenSaysWhoIsReallyActing(t *testing.T) {
	adm, email, uid := platAdmin(t)
	p := platProvision(t, adm, platProvisionBody("dental"))
	var out struct {
		AccessToken string `json:"access_token"`
	}
	adm.Do("POST", "/platform/clinics/"+p.Clinic.ID+"/impersonate", nil).Expect(t, 200, "impersonate").Decode(t, &out)
	raw, _ := json.Marshal(platClaims(t, out.AccessToken))
	marked := strings.Contains(string(raw), uid.String()) || strings.Contains(string(raw), email) ||
		strings.Contains(strings.ToLower(string(raw)), "imperson")
	testkit.KnownBug(t, "SEC-9", !marked, "the impersonation token is indistinguishable from the owner's own token")
	if !marked {
		t.Fatalf("impersonation token claims do not name the platform admin: %s", raw)
	}
}
