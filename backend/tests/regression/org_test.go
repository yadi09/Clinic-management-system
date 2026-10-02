package regression

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Organisation settings (REG_ORG): the clinic profile, the workspace (login handle),
// flow settings, branches and their per-branch modules, departments, bookable
// resources, payment rails and plan usage. Everything that changes clinic-wide state
// runs in a private clinic from newClinic(t), so the shared clinics A and B keep the
// shape every other test expects.

// ---- helpers (prefixed op; shared by the clinic-operations files) -------------

// opUUID is the database id behind an external prefixed id.
func opUUID(t *testing.T, prefix, ext string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(prefix, ext)
	if err != nil {
		t.Fatalf("decode %q as %s: %v", ext, prefix, err)
	}
	return u
}

// opExec runs a statement as the superuser: only to arrange what the API cannot
// (a plan override, a removed clinic row), never to exercise behaviour.
func opExec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := super.Pool.Exec(t.Context(), q, args...); err != nil {
		t.Fatalf("%v\n%s", err, q)
	}
}

// opBranch is the clinic's main branch as the API spells it.
func opBranch(c *testkit.Clinic) string { return id.Encode(id.PrefixBranch, c.BranchID) }

// opDept is the clinic's default department as the API spells it.
func opDept(c *testkit.Clinic) string { return id.Encode(id.PrefixDepartment, c.DeptID) }

// opStatus fails unless the response has one of the wanted statuses.
func opStatus(t *testing.T, r testkit.Resp, what string, want ...int) {
	t.Helper()
	for _, w := range want {
		if r.Status == w {
			return
		}
	}
	t.Fatalf("%s: want HTTP %v, got %d (%s %s)\n%s", what, want, r.Status, r.Code, r.Message, trimBody(r.Raw))
}

type opBranchRef struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Code         string          `json:"code"`
	Address      string          `json:"address"`
	Phone        string          `json:"phone"`
	OpeningHours json.RawMessage `json:"opening_hours"`
	IsActive     bool            `json:"is_active"`
}

// opNewBranch creates a branch as the given (clinic.manage) user.
func opNewBranch(t *testing.T, owner *testkit.Client, name, code string) opBranchRef {
	t.Helper()
	var b opBranchRef
	owner.Do("POST", "/org/branches", map[string]any{"name": name, "code": code}).
		Expect(t, 201, "create branch "+code).Decode(t, &b)
	if b.ID == "" {
		t.Fatalf("create branch returned no id")
	}
	return b
}

func opListBranches(t *testing.T, c *testkit.Client) []opBranchRef {
	t.Helper()
	var out []opBranchRef
	c.Do("GET", "/org/branches", nil).Expect(t, 200, "list branches").Decode(t, &out)
	return out
}

func opHasBranch(list []opBranchRef, ext string) bool {
	for _, b := range list {
		if b.ID == ext {
			return true
		}
	}
	return false
}

type opModule struct {
	Flag       string `json:"flag"`
	Enabled    bool   `json:"enabled"`
	Overridden bool   `json:"overridden"`
}

func opModuleOf(t *testing.T, mods []opModule, flag string) opModule {
	t.Helper()
	for _, m := range mods {
		if m.Flag == flag {
			return m
		}
	}
	t.Fatalf("module %q not listed in %+v", flag, mods)
	return opModule{}
}

type opRail struct {
	ID             string `json:"id"`
	Key            string `json:"key"`
	Label          string `json:"label"`
	Kind           string `json:"kind"`
	BankKey        string `json:"bank_key"`
	AccountName    string `json:"account_name"`
	AccountNumber  string `json:"account_number"`
	NeedsReference bool   `json:"needs_reference"`
	Active         bool   `json:"active"`
	SortOrder      int    `json:"sort_order"`
}

func opRails(t *testing.T, c *testkit.Client, all bool) []opRail {
	t.Helper()
	path := "/org/payment-rails"
	if all {
		path += "?all=1"
	}
	var out []opRail
	c.Do("GET", path, nil).Expect(t, 200, "list rails").Decode(t, &out)
	return out
}

func opRailIn(list []opRail, ext string) bool {
	for _, r := range list {
		if r.ID == ext {
			return true
		}
	}
	return false
}

// ---- clinic profile ---------------------------------------------------------

// TestREG_ORG_001_ClinicProfileReadAndSave: Given a clinic, When any staff member
// reads the profile, Then they see its name; When a receptionist tries to change it,
// Then 403; When the owner renames it and sets the locale without a timezone, Then
// the name and locale change and the timezone is kept; a profile without a name is
// refused.
func TestREG_ORG_001_ClinicProfileReadAndSave(t *testing.T) {
	c := newClinic(t)
	owner, rc := srv.As(t, c, "owner"), srv.As(t, c, "receptionist")
	var cl struct {
		Name     string `json:"name"`
		Timezone string `json:"timezone"`
		Locale   string `json:"locale"`
	}
	rc.Do("GET", "/org/clinic", nil).Expect(t, 200, "read clinic").Decode(t, &cl)
	if cl.Name != "Regression "+c.Slug || cl.Timezone != "Africa/Addis_Ababa" {
		t.Fatalf("clinic profile %+v", cl)
	}
	rc.Do("PUT", "/org/clinic", map[string]any{"name": "Hijack"}).Expect(t, 403, "receptionist saves clinic")
	owner.Do("PUT", "/org/clinic", map[string]any{"timezone": "UTC"}).Expect(t, 400, "save without name")

	newName := uniq("Smile Dental ")
	owner.Do("PUT", "/org/clinic", map[string]any{"name": newName, "locale": "am"}).Expect(t, 200, "save clinic").Decode(t, &cl)
	if cl.Name != newName || cl.Locale != "am" || cl.Timezone != "Africa/Addis_Ababa" {
		t.Fatalf("saved profile %+v, want name %q locale am, timezone kept", cl, newName)
	}
	var name, tz, loc string
	one(t, `SELECT name FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &name, c.TenantID)
	one(t, `SELECT timezone FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &tz, c.TenantID)
	one(t, `SELECT locale FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &loc, c.TenantID)
	if name != newName || tz != "Africa/Addis_Ababa" || loc != "am" {
		t.Fatalf("clinics row name=%q tz=%q locale=%q", name, tz, loc)
	}
	// Clinic B is untouched by A's save.
	var bName string
	one(t, `SELECT name FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &bName, clinicB.TenantID)
	if bName == newName {
		t.Fatalf("clinic B's profile changed with clinic A's save")
	}
}

// TestREG_ORG_002_UnconfiguredClinicIsReportedThenCreatedOnSave: Given a clinic whose
// profile row is gone, When the profile and settings are read, Then 404
// CLINIC_NOT_CONFIGURED (not a 500); adding a branch is refused with a conflict; When
// the owner saves a profile, Then it is created with the default timezone and reads
// back.
func TestREG_ORG_002_UnconfiguredClinicIsReportedThenCreatedOnSave(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	opExec(t, `UPDATE clinics SET deleted_at = now() WHERE tenant_id = $1`, c.TenantID)

	if r := owner.Do("GET", "/org/clinic", nil); r.Status != 404 || r.Code != "CLINIC_NOT_CONFIGURED" {
		t.Fatalf("read missing clinic: %d %s", r.Status, r.Code)
	}
	if r := owner.Do("GET", "/org/settings", nil); r.Status != 404 || r.Code != "CLINIC_NOT_CONFIGURED" {
		t.Fatalf("read settings of missing clinic: %d %s", r.Status, r.Code)
	}
	if r := owner.Do("PUT", "/org/settings", map[string]any{"doctor_assignment": "auto"}); r.Status != 404 {
		t.Fatalf("save settings of missing clinic: %d %s", r.Status, r.Code)
	}
	if r := owner.Do("POST", "/org/branches", map[string]any{"name": "North", "code": "NTH"}); r.Status != 409 || r.Code != "CLINIC_NOT_CONFIGURED" {
		t.Fatalf("branch without a clinic: %d %s", r.Status, r.Code)
	}

	var cl struct {
		Name     string `json:"name"`
		Timezone string `json:"timezone"`
		Locale   string `json:"locale"`
	}
	owner.Do("PUT", "/org/clinic", map[string]any{"name": "Fresh Start"}).Expect(t, 200, "create clinic on save").Decode(t, &cl)
	if cl.Name != "Fresh Start" || cl.Timezone != "Africa/Addis_Ababa" || cl.Locale != "en" {
		t.Fatalf("created profile %+v", cl)
	}
	var n int
	one(t, `SELECT count(*) FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &n, c.TenantID)
	if n != 1 {
		t.Fatalf("live clinic rows after save: %d, want 1", n)
	}
	owner.Do("GET", "/org/settings", nil).Expect(t, 200, "settings after the profile exists again")
}

// ---- workspace (login handle) -------------------------------------------------

// TestREG_ORG_003_WorkspaceSlugRules: Given a clinic, When the owner sets a slug that is
// too short, too long, edged with a hyphen or has other characters, Then 400; another
// clinic's slug, Then 409 WORKSPACE_TAKEN; a valid one (any case, padded), Then it is
// stored lower-case and staff sign in with it — and no longer with the old one.
func TestREG_ORG_003_WorkspaceSlugRules(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	var ws struct {
		Name string `json:"name"`
		Slug string `json:"slug"`
	}
	srv.As(t, c, "nurse").Do("GET", "/org/workspace", nil).Expect(t, 200, "read workspace").Decode(t, &ws)
	if ws.Slug != c.Slug {
		t.Fatalf("workspace slug %q, want %q", ws.Slug, c.Slug)
	}
	srv.As(t, c, "receptionist").Do("PUT", "/org/workspace", map[string]any{"slug": "taken-over"}).Expect(t, 403, "receptionist renames workspace")
	owner.Do("PUT", "/org/workspace", map[string]any{}).Expect(t, 400, "no slug")
	for _, bad := range []string{"ab", "-abcd", "abcd-", "abc_def", "abc def", "café", strings.Repeat("a", 41)} {
		if r := owner.Do("PUT", "/org/workspace", map[string]any{"slug": bad}); r.Status != 400 {
			t.Errorf("slug %q: want 400, got %d", bad, r.Status)
		}
	}
	if r := owner.Do("PUT", "/org/workspace", map[string]any{"slug": clinicB.Slug}); r.Status != 409 || r.Code != "WORKSPACE_TAKEN" {
		t.Fatalf("another clinic's slug: %d %s", r.Status, r.Code)
	}

	old := c.Slug
	next := "rg-ws-" + strings.ToLower(uuid.NewString()[:8])
	owner.Do("PUT", "/org/workspace", map[string]any{"slug": "  " + strings.ToUpper(next) + " "}).Expect(t, 200, "rename workspace").Decode(t, &ws)
	if ws.Slug != next {
		t.Fatalf("renamed slug %q, want %q", ws.Slug, next)
	}
	var stored string
	one(t, `SELECT slug FROM tenants WHERE id = $1`, &stored, c.TenantID)
	if stored != next {
		t.Fatalf("tenants.slug %q, want %q", stored, next)
	}
	if r := authLogin(t, old, c.Staff["receptionist"].Email, testkit.StaffPassword); r.Status == 200 {
		t.Fatalf("old workspace handle still signs in")
	}
	c.Slug = next
	srv.As(t, c, "receptionist") // fails the test unless the new handle signs in
}

// ---- flow settings --------------------------------------------------------------

// TestREG_ORG_004_SettingsAreNormalisedAndPersisted: Given a clinic, When the owner
// saves settings with an empty currency, a negative free window and an unknown
// assignment mode, Then they are stored as ETB, 0 and "manual"; the fee amount keeps
// two decimals; a malformed body is 400 and a receptionist is refused.
func TestREG_ORG_004_SettingsAreNormalisedAndPersisted(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	type settings struct {
		CardFeeEnabled   bool   `json:"card_fee_enabled"`
		CardFeeAmount    string `json:"card_fee_amount"`
		CardCurrency     string `json:"card_currency"`
		FreeWindowDays   int    `json:"free_window_days"`
		TriageRequired   bool   `json:"triage_required"`
		DoctorAssignment string `json:"doctor_assignment"`
	}
	var s settings
	srv.As(t, c, "cashier").Do("GET", "/org/settings", nil).Expect(t, 200, "read settings").Decode(t, &s)

	srv.As(t, c, "receptionist").Do("PUT", "/org/settings", map[string]any{"card_fee_enabled": true}).Expect(t, 403, "receptionist saves settings")
	owner.Do("PUT", "/org/settings", map[string]any{"card_fee_enabled": "yes"}).Expect(t, 400, "malformed settings")

	owner.Do("PUT", "/org/settings", map[string]any{
		"card_fee_enabled": true, "card_fee_amount": 150.5, "card_currency": " ",
		"free_window_days": -3, "triage_required": true, "doctor_assignment": "round-robin",
	}).Expect(t, 200, "save settings").Decode(t, &s)
	if !s.CardFeeEnabled || s.CardCurrency != "ETB" || s.FreeWindowDays != 0 || !s.TriageRequired || s.DoctorAssignment != "manual" {
		t.Fatalf("normalised settings %+v", s)
	}
	var amount, cur, mode string
	var window int
	var triage bool
	one(t, `SELECT card_fee_amount::text FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &amount, c.TenantID)
	one(t, `SELECT card_currency FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &cur, c.TenantID)
	one(t, `SELECT free_window_days FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &window, c.TenantID)
	one(t, `SELECT triage_required FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &triage, c.TenantID)
	one(t, `SELECT doctor_assignment FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL`, &mode, c.TenantID)
	if amount != "150.50" || cur != "ETB" || window != 0 || !triage || mode != "manual" {
		t.Fatalf("clinics row amount=%s cur=%s window=%d triage=%v mode=%s", amount, cur, window, triage, mode)
	}
	owner.Do("PUT", "/org/settings", map[string]any{"doctor_assignment": "auto", "free_window_days": 14, "card_currency": "USD"}).
		Expect(t, 200, "save auto").Decode(t, &s)
	if s.DoctorAssignment != "auto" || s.FreeWindowDays != 14 || s.CardCurrency != "USD" || s.CardFeeEnabled || s.TriageRequired {
		t.Fatalf("second save is a full replace: %+v", s)
	}
}

// TestREG_ORG_005_TriageRequiredSendsWalkInsToTriage: Given a clinic that turns on
// "triage required", When the desk receives a walk-in straight for the doctor, Then the
// queue entry is at the triage stage anyway — the setting governs every door.
func TestREG_ORG_005_TriageRequiredSendsWalkInsToTriage(t *testing.T) {
	c := newClinic(t)
	srv.As(t, c, "owner").Do("PUT", "/org/settings", map[string]any{"triage_required": true}).Expect(t, 200, "require triage")
	desk := srv.As(t, c, "receptionist")
	p := createPatient(t, desk, uniq("Triage"), "Always")
	desk.Do("POST", "/queue/walk-in", map[string]any{
		"branch_id": opBranch(c), "department_id": opDept(c), "patient_id": p.ID, "to_triage": false,
	}).Expect(t, 201, "walk-in")
	var stage string
	one(t, `SELECT stage FROM queue_entries WHERE patient_id = $1`, &stage, opUUID(t, id.PrefixPatient, p.ID))
	if stage != "triage" {
		t.Fatalf("walk-in stage %q with triage required, want triage", stage)
	}
}

// ---- branches ---------------------------------------------------------------------

// TestREG_ORG_006_BranchCreateListUpdate: Given a clinic, When the owner adds a branch
// with an address, phone and opening hours, Then it is listed and stored; a missing
// code is 400 and a reused code 409; When it is renamed and deactivated, Then that is
// what is stored; an unknown or malformed branch id is 404; a receptionist cannot add
// one.
func TestREG_ORG_006_BranchCreateListUpdate(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	srv.As(t, c, "receptionist").Do("POST", "/org/branches", map[string]any{"name": "X", "code": "X1"}).Expect(t, 403, "receptionist adds branch")
	owner.Do("POST", "/org/branches", map[string]any{"name": "No code"}).Expect(t, 400, "branch without code")
	owner.Do("POST", "/org/branches", map[string]any{"name": "  ", "code": " "}).Expect(t, 400, "blank branch")

	var b opBranchRef
	owner.Do("POST", "/org/branches", map[string]any{
		"name": "Bole", "code": "BOLE", "address": "Bole Rd", "phone": "0911000000",
		"opening_hours": map[string]any{"mon": "08:00-17:00"},
	}).Expect(t, 201, "create branch").Decode(t, &b)
	if b.Name != "Bole" || b.Code != "BOLE" || b.Address != "Bole Rd" || !b.IsActive || !strings.Contains(string(b.OpeningHours), "08:00-17:00") {
		t.Fatalf("created branch %+v", b)
	}
	if !opHasBranch(opListBranches(t, srv.As(t, c, "nurse")), b.ID) {
		t.Fatalf("new branch not listed")
	}
	if r := owner.Do("POST", "/org/branches", map[string]any{"name": "Bole 2", "code": "BOLE"}); r.Status != 409 || r.Code != "BRANCH_CODE_TAKEN" {
		t.Fatalf("reused branch code: %d %s", r.Status, r.Code)
	}

	inactive := false
	var up opBranchRef
	owner.Do("PUT", "/org/branches/"+b.ID, map[string]any{"name": "Bole Medhanialem", "code": "BOLE", "is_active": inactive}).
		Expect(t, 200, "update branch").Decode(t, &up)
	if up.Name != "Bole Medhanialem" || up.IsActive || up.Address != "" {
		t.Fatalf("updated branch %+v (update is a full replace)", up)
	}
	var name string
	var active bool
	one(t, `SELECT name FROM branches WHERE id = $1`, &name, opUUID(t, id.PrefixBranch, b.ID))
	one(t, `SELECT is_active FROM branches WHERE id = $1`, &active, opUUID(t, id.PrefixBranch, b.ID))
	if name != "Bole Medhanialem" || active {
		t.Fatalf("branches row name=%q active=%v", name, active)
	}
	if r := owner.Do("PUT", "/org/branches/"+b.ID, map[string]any{"name": "Clash", "code": "MAIN"}); r.Status != 409 || r.Code != "BRANCH_CODE_TAKEN" {
		t.Fatalf("rename onto the main branch's code: %d %s", r.Status, r.Code)
	}
	owner.Do("PUT", "/org/branches/"+b.ID, map[string]any{"name": "No code"}).Expect(t, 400, "update without code")
	owner.Do("PUT", "/org/branches/"+id.Encode(id.PrefixBranch, uuid.New()), map[string]any{"name": "Ghost", "code": "GH"}).Expect(t, 404, "update unknown branch")
	owner.Do("PUT", "/org/branches/not-an-id", map[string]any{"name": "Ghost", "code": "GH"}).Expect(t, 404, "update malformed id")
}

// TestREG_ORG_007_BranchesAreClinicScoped: Given a branch of clinic A, When clinic B's
// owner lists branches, renames or deletes it, Then B never sees it, the writes are
// 404, and A's branch is unchanged and still live.
func TestREG_ORG_007_BranchesAreClinicScoped(t *testing.T) {
	a := newClinic(t)
	b := opNewBranch(t, srv.As(t, a, "owner"), "Piassa", "PIA")
	ob := srv.As(t, clinicB, "owner")
	if opHasBranch(opListBranches(t, ob), b.ID) {
		t.Fatalf("CROSS-CLINIC READ: clinic B lists clinic A's branch")
	}
	ob.Do("PUT", "/org/branches/"+b.ID, map[string]any{"name": "Stolen", "code": "PIA"}).Expect(t, 404, "B renames A's branch")
	r := ob.Do("DELETE", "/org/branches/"+b.ID, nil)
	var name string
	var deleted bool
	one(t, `SELECT name FROM branches WHERE id = $1`, &name, opUUID(t, id.PrefixBranch, b.ID))
	one(t, `SELECT deleted_at IS NOT NULL FROM branches WHERE id = $1`, &deleted, opUUID(t, id.PrefixBranch, b.ID))
	if name != "Piassa" || deleted {
		t.Fatalf("CROSS-CLINIC WRITE: A's branch now name=%q deleted=%v after B's writes", name, deleted)
	}
	opStatus(t, r, "B deletes A's branch", 404, 204)
}

// TestREG_ORG_008_BranchCapFollowsThePlanAndTheOverride: Given a clinic whose branch cap
// is overridden to 1 (it already has its main branch), When the owner adds a branch,
// Then 409 BRANCH_LIMIT; plan usage reports the cap; When the override says unlimited,
// Then the branch is added.
func TestREG_ORG_008_BranchCapFollowsThePlanAndTheOverride(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	opExec(t, `UPDATE tenants SET branch_limit_override = 1 WHERE id = $1`, c.TenantID)
	if r := owner.Do("POST", "/org/branches", map[string]any{"name": "Two", "code": "TWO"}); r.Status != 409 || r.Code != "BRANCH_LIMIT" {
		t.Fatalf("branch over the cap: %d %s", r.Status, r.Code)
	}
	var n int
	one(t, `SELECT count(*) FROM branches WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 1 {
		t.Fatalf("branches after refused add: %d", n)
	}
	var pu struct {
		PlanName string `json:"plan_name"`
		Branches struct {
			Used  int64 `json:"used"`
			Limit int64 `json:"limit"`
		} `json:"branches"`
	}
	owner.Do("GET", "/org/plan-usage", nil).Expect(t, 200, "plan usage").Decode(t, &pu)
	if pu.Branches.Used != 1 || pu.Branches.Limit != 1 {
		t.Fatalf("plan usage branches %+v, want used 1 limit 1", pu.Branches)
	}
	opExec(t, `UPDATE tenants SET branch_limit_override = -1 WHERE id = $1`, c.TenantID)
	opNewBranch(t, owner, "Two", "TWO")
	owner.Do("GET", "/org/plan-usage", nil).Expect(t, 200, "plan usage").Decode(t, &pu)
	if pu.Branches.Used != 2 || pu.Branches.Limit != -1 {
		t.Fatalf("plan usage with unlimited override %+v, want used 2 limit -1", pu.Branches)
	}
}

// TestREG_ORG_009_BranchUsageHonoursTheClinicOverride: Given a clinic on the Business
// plan (10 branches) whose own cap is overridden to 1, When branch usage is read, Then
// it reports the cap that is actually enforced (1). Today it reads the plan's cap from
// the subscription and ignores the override, so the settings screen offers an "add
// branch" the server will refuse.
func TestREG_ORG_009_BranchUsageHonoursTheClinicOverride(t *testing.T) {
	c := newClinic(t)
	opExec(t, `UPDATE tenants SET branch_limit_override = 1 WHERE id = $1`, c.TenantID)
	var u struct {
		Used  int  `json:"used"`
		Limit *int `json:"limit"`
	}
	srv.As(t, c, "receptionist").Do("GET", "/org/branch-usage", nil).Expect(t, 200, "branch usage").Decode(t, &u)
	if u.Used != 1 {
		t.Fatalf("branch usage used=%d, want 1", u.Used)
	}
	got := -1
	if u.Limit != nil {
		got = *u.Limit
	}
	testkit.KnownBug(t, "NEW-ORG-1", got != 1, fmt.Sprintf(
		"GET /org/branch-usage reports limit %d while CreateBranch enforces the override of 1: BranchUsage reads "+
			"plans.branch_limit via GetBranchLimit and ignores tenants.branch_limit_override (org/service/service.go BranchUsage)", got))
}

// TestREG_ORG_010_BranchDeleteKeepsHistory: Given a new unused branch, When it is
// deleted, Then it leaves the list and the row is soft-deleted; Given the main branch
// with a patient in its queue, When it is deleted, Then 409 BRANCH_IN_USE and it stays.
func TestREG_ORG_010_BranchDeleteKeepsHistory(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	b := opNewBranch(t, owner, "Temp", "TMP")
	srv.As(t, c, "receptionist").Do("DELETE", "/org/branches/"+b.ID, nil).Expect(t, 403, "receptionist deletes branch")
	owner.Do("DELETE", "/org/branches/"+b.ID, nil).Expect(t, 204, "delete unused branch")
	if opHasBranch(opListBranches(t, owner), b.ID) {
		t.Fatalf("deleted branch still listed")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM branches WHERE id = $1`, &deleted, opUUID(t, id.PrefixBranch, b.ID))
	if !deleted {
		t.Fatalf("branch row not soft-deleted")
	}
	owner.Do("PUT", "/org/branches/"+b.ID, map[string]any{"name": "Back", "code": "TMP"}).Expect(t, 404, "update a deleted branch")

	desk := srv.As(t, c, "receptionist")
	p := createPatient(t, desk, uniq("Busy"), "Branch")
	desk.Do("POST", "/queue/walk-in", map[string]any{"branch_id": opBranch(c), "department_id": opDept(c), "patient_id": p.ID}).Expect(t, 201, "walk-in")
	if r := owner.Do("DELETE", "/org/branches/"+opBranch(c), nil); r.Status != 409 || r.Code != "BRANCH_IN_USE" {
		t.Fatalf("delete a branch with activity: %d %s", r.Status, r.Code)
	}
	if !opHasBranch(opListBranches(t, owner), opBranch(c)) {
		t.Fatalf("branch in use disappeared after a refused delete")
	}
	owner.Do("DELETE", "/org/branches/nope", nil).Expect(t, 404, "delete malformed id")
}

// TestREG_ORG_011_DeletedBranchCodeCanBeReused: Given a branch deleted (soft) for good,
// When the owner adds a new branch with the same code, Then it is accepted. Today the
// UNIQUE (tenant_id, code) ignores deleted_at, so the code is burned forever (DB-1).
func TestREG_ORG_011_DeletedBranchCodeCanBeReused(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	b := opNewBranch(t, owner, "Old Site", "OLD")
	owner.Do("DELETE", "/org/branches/"+b.ID, nil).Expect(t, 204, "delete branch")
	r := owner.Do("POST", "/org/branches", map[string]any{"name": "New Site", "code": "OLD"})
	if r.Status >= 500 {
		t.Fatalf("re-adding a deleted branch code: %d %s", r.Status, trimBody(r.Raw))
	}
	testkit.KnownBug(t, "DB-1", r.Status != 201, fmt.Sprintf(
		"re-adding branch code OLD after deleting its branch answers %d %s: branches UNIQUE (tenant_id, code) ignores soft delete", r.Status, r.Code))
}

// TestREG_ORG_012_BranchModulesToggleChangesWhatTheBranchCanDo: Given a dental clinic
// (dental on, laboratory off by default), When the owner turns dental off for the main
// branch, Then the modules list says so (overridden), the flag row is stored for that
// branch, and a doctor signing in there gets dental off and is refused the dental
// workspace (403 MODULE_DISABLED); unknown module names are ignored; When the override
// is cleared (null), Then the branch follows the clinic default again and dental works.
func TestREG_ORG_012_BranchModulesToggleChangesWhatTheBranchCanDo(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	path := "/org/branches/" + opBranch(c) + "/modules"
	var mods []opModule
	owner.Do("GET", path, nil).Expect(t, 200, "read modules").Decode(t, &mods)
	if m := opModuleOf(t, mods, "dental"); !m.Enabled || m.Overridden {
		t.Fatalf("dental default %+v, want enabled and not overridden", m)
	}
	if m := opModuleOf(t, mods, "laboratory"); m.Enabled {
		t.Fatalf("laboratory on in a dental clinic: %+v", m)
	}
	srv.As(t, c, "receptionist").Do("GET", path, nil).Expect(t, 403, "receptionist reads modules")
	srv.As(t, c, "receptionist").Do("PUT", path, map[string]any{"dental": false}).Expect(t, 403, "receptionist toggles modules")
	owner.Do("PUT", path, []any{"dental"}).Expect(t, 400, "modules body not a map")

	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Mod"), "Toggle")
	srv.As(t, c, "doctor").Do("GET", "/dental/patients/"+p.ID+"/summary", nil).Expect(t, 200, "dental before toggle")

	owner.Do("PUT", path, map[string]any{"dental": false, "laboratory": true, "telepathy": true}).Expect(t, 200, "toggle modules").Decode(t, &mods)
	if m := opModuleOf(t, mods, "dental"); m.Enabled || !m.Overridden {
		t.Fatalf("dental after toggle %+v", m)
	}
	if m := opModuleOf(t, mods, "laboratory"); !m.Enabled || !m.Overridden {
		t.Fatalf("laboratory after toggle %+v", m)
	}
	var rows int
	one(t, `SELECT count(*) FROM feature_flags WHERE tenant_id = $1 AND branch_id = $2 AND flag = 'dental' AND NOT enabled`, &rows, c.TenantID, c.BranchID)
	var bogus int
	one(t, `SELECT count(*) FROM feature_flags WHERE tenant_id = $1 AND flag = 'telepathy'`, &bogus, c.TenantID)
	if rows != 1 || bogus != 0 {
		t.Fatalf("feature_flags: dental override rows=%d, unknown flag rows=%d", rows, bogus)
	}

	doc := srv.As(t, c, "doctor") // a fresh sign-in picks up the branch's modules
	var me struct {
		Flags map[string]bool `json:"flags"`
	}
	doc.Do("GET", "/auth/me", nil).Expect(t, 200, "me").Decode(t, &me)
	if me.Flags["dental"] {
		t.Fatalf("doctor's flags still have dental on: %v", me.Flags)
	}
	if r := doc.Do("GET", "/dental/patients/"+p.ID+"/summary", nil); r.Status != 403 || r.Code != "MODULE_DISABLED" {
		t.Fatalf("dental with the module off for the branch: %d %s", r.Status, r.Code)
	}

	owner.Do("PUT", path, map[string]any{"dental": nil}).Expect(t, 200, "clear override").Decode(t, &mods)
	if m := opModuleOf(t, mods, "dental"); !m.Enabled || m.Overridden {
		t.Fatalf("dental after clearing %+v, want the clinic default", m)
	}
	srv.As(t, c, "doctor").Do("GET", "/dental/patients/"+p.ID+"/summary", nil).Expect(t, 200, "dental after clearing")
}

// TestREG_ORG_013_BranchModulesOfAnotherClinicsBranchAre404: Given clinic A's branch,
// When clinic B's owner reads or toggles that branch's modules, Then 404 — and A's
// branch keeps its modules. Today both answer 200: GetBranchModules returns B's own
// defaults for any id, and SetBranchModules stores a flag row in B pointing at A's
// branch (no leak, RLS holds, but a misleading success).
func TestREG_ORG_013_BranchModulesOfAnotherClinicsBranchAre404(t *testing.T) {
	a := newClinic(t)
	ob := srv.As(t, clinicB, "owner")
	path := "/org/branches/" + opBranch(a) + "/modules"
	g := ob.Do("GET", path, nil)
	s := ob.Do("PUT", path, map[string]any{"dental": false})
	var aRows int
	one(t, `SELECT count(*) FROM feature_flags WHERE tenant_id = $1 AND branch_id = $2`, &aRows, a.TenantID, a.BranchID)
	if aRows != 0 {
		t.Fatalf("CROSS-CLINIC WRITE: clinic A's branch gained %d module overrides from clinic B", aRows)
	}
	var me struct {
		Flags map[string]bool `json:"flags"`
	}
	srv.As(t, a, "doctor").Do("GET", "/auth/me", nil).Expect(t, 200, "A me").Decode(t, &me)
	if !me.Flags["dental"] {
		t.Fatalf("CROSS-CLINIC WRITE: clinic A's doctor lost dental after clinic B's toggle")
	}
	var stray int
	one(t, `SELECT count(*) FROM feature_flags WHERE tenant_id = $1 AND branch_id = $2`, &stray, clinicB.TenantID, a.BranchID)
	opExec(t, `DELETE FROM feature_flags WHERE tenant_id = $1 AND branch_id = $2`, clinicB.TenantID, a.BranchID)
	testkit.KnownBug(t, "NEW-ORG-2", g.Status != 404 || s.Status != 404 || stray != 0, fmt.Sprintf(
		"another clinic's branch modules: GET %d, PUT %d, stray flag rows %d — Get/SetBranchModules never check the "+
			"branch belongs to the caller's clinic (org/service/service.go GetBranchModules/SetBranchModules)", g.Status, s.Status, stray))
}

// ---- departments ----------------------------------------------------------------------

type opDeptRef struct {
	ID        string `json:"id"`
	BranchID  string `json:"branch_id"`
	Name      string `json:"name"`
	Specialty string `json:"specialty"`
}

func opDepts(t *testing.T, c *testkit.Client) []opDeptRef {
	t.Helper()
	var out []opDeptRef
	c.Do("GET", "/org/departments", nil).Expect(t, 200, "list departments").Decode(t, &out)
	return out
}

func opDeptIn(list []opDeptRef, ext string) (opDeptRef, bool) {
	for _, d := range list {
		if d.ID == ext {
			return d, true
		}
	}
	return opDeptRef{}, false
}

// TestREG_ORG_014_DepartmentsCreateUpdateDelete: Given a clinic, When the owner adds a
// department to the main branch, Then it is listed with its branch and stored; missing
// or blank names and a malformed branch are 400; When renamed, Then the row changes;
// When deleted, Then it leaves the list and the row is soft-deleted; a receptionist is
// refused every write.
func TestREG_ORG_014_DepartmentsCreateUpdateDelete(t *testing.T) {
	c := newClinic(t)
	owner, rc := srv.As(t, c, "owner"), srv.As(t, c, "receptionist")
	if _, ok := opDeptIn(opDepts(t, rc), opDept(c)); !ok {
		t.Fatalf("default department not listed")
	}
	rc.Do("POST", "/org/departments", map[string]any{"branch_id": opBranch(c), "name": "X"}).Expect(t, 403, "receptionist adds department")
	owner.Do("POST", "/org/departments", map[string]any{"branch_id": opBranch(c)}).Expect(t, 400, "department without name")
	owner.Do("POST", "/org/departments", map[string]any{"branch_id": opBranch(c), "name": "   "}).Expect(t, 400, "blank department name")
	owner.Do("POST", "/org/departments", map[string]any{"branch_id": "brn_nope", "name": "Ortho"}).Expect(t, 400, "malformed branch")

	var d opDeptRef
	owner.Do("POST", "/org/departments", map[string]any{"branch_id": opBranch(c), "name": "Orthodontics", "specialty": "ortho"}).
		Expect(t, 201, "add department").Decode(t, &d)
	if d.Name != "Orthodontics" || d.Specialty != "ortho" || d.BranchID != opBranch(c) {
		t.Fatalf("created department %+v", d)
	}
	got, ok := opDeptIn(opDepts(t, rc), d.ID)
	if !ok || got.Name != "Orthodontics" {
		t.Fatalf("department not listed: %+v", got)
	}
	did := opUUID(t, id.PrefixDepartment, d.ID)
	var tenant, branch uuid.UUID
	one(t, `SELECT tenant_id FROM departments WHERE id = $1`, &tenant, did)
	one(t, `SELECT branch_id FROM departments WHERE id = $1`, &branch, did)
	if tenant != c.TenantID || branch != c.BranchID {
		t.Fatalf("department row tenant=%v branch=%v", tenant, branch)
	}

	rc.Do("PUT", "/org/departments/"+d.ID, map[string]any{"branch_id": opBranch(c), "name": "Hijack"}).Expect(t, 403, "receptionist renames")
	owner.Do("PUT", "/org/departments/"+d.ID, map[string]any{"branch_id": opBranch(c)}).Expect(t, 400, "rename without name")
	owner.Do("PUT", "/org/departments/"+d.ID, map[string]any{"branch_id": opBranch(c), "name": "Ortho & Braces"}).Expect(t, 200, "rename department")
	var name string
	var spec *string
	one(t, `SELECT name FROM departments WHERE id = $1`, &name, did)
	one(t, `SELECT specialty FROM departments WHERE id = $1`, &spec, did)
	if name != "Ortho & Braces" || spec != nil {
		t.Fatalf("department row after rename name=%q specialty=%v (full replace)", name, spec)
	}
	owner.Do("PUT", "/org/departments/dep_bad", map[string]any{"branch_id": opBranch(c), "name": "X"}).Expect(t, 404, "rename malformed id")

	rc.Do("DELETE", "/org/departments/"+d.ID, nil).Expect(t, 403, "receptionist deletes")
	owner.Do("DELETE", "/org/departments/"+d.ID, nil).Expect(t, 204, "delete department")
	if _, ok := opDeptIn(opDepts(t, owner), d.ID); ok {
		t.Fatalf("deleted department still listed")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM departments WHERE id = $1`, &deleted, did)
	if !deleted {
		t.Fatalf("department not soft-deleted")
	}
	owner.Do("DELETE", "/org/departments/x", nil).Expect(t, 404, "delete malformed id")
}

// TestREG_ORG_015_RenamingAnUnknownDepartmentIs404: Given a department id that does not
// exist (or belongs to another clinic), When the owner renames it, Then 404 and the
// other clinic's department is unchanged. Today the API answers 200 and echoes the
// requested name back as if it had been saved (UpdateDepartment is :exec, no row check).
func TestREG_ORG_015_RenamingAnUnknownDepartmentIs404(t *testing.T) {
	oa := srv.As(t, clinicA, "owner")
	ghost := oa.Do("PUT", "/org/departments/"+id.Encode(id.PrefixDepartment, uuid.New()),
		map[string]any{"branch_id": opBranch(clinicA), "name": "Ghost"})
	cross := oa.Do("PUT", "/org/departments/"+opDept(clinicB), map[string]any{"branch_id": opBranch(clinicB), "name": "Stolen"})
	var bName string
	one(t, `SELECT name FROM departments WHERE id = $1`, &bName, clinicB.DeptID)
	if bName == "Stolen" {
		t.Fatalf("CROSS-CLINIC WRITE: clinic A renamed clinic B's department")
	}
	delB := oa.Do("DELETE", "/org/departments/"+opDept(clinicB), nil)
	var bDeleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM departments WHERE id = $1`, &bDeleted, clinicB.DeptID)
	if bDeleted {
		t.Fatalf("CROSS-CLINIC WRITE: clinic A deleted clinic B's department")
	}
	testkit.KnownBug(t, "NEW-ORG-3", ghost.Status != 404 || cross.Status != 404 || delB.Status != 404, fmt.Sprintf(
		"department writes against an id the clinic does not have answer rename-unknown %d, rename-other-clinic %d, "+
			"delete-other-clinic %d (want 404): Update/DeleteDepartment never check the affected row count", ghost.Status, cross.Status, delB.Status))
}

// TestREG_ORG_016_DepartmentOnAnotherClinicsBranchIsRefused: Given clinic B's branch id,
// When clinic A's owner adds a department to it, Then the API refuses (4xx) and stores
// nothing. Today the single-column foreign key is checked outside row-level security,
// so A gets a department "in" B's branch (TENANT-FK-1 class).
func TestREG_ORG_016_DepartmentOnAnotherClinicsBranchIsRefused(t *testing.T) {
	c := newClinic(t)
	name := uniq("Stray ")
	r := srv.As(t, c, "owner").Do("POST", "/org/departments", map[string]any{"branch_id": opBranch(clinicB), "name": name})
	var stray int
	one(t, `SELECT count(*) FROM departments WHERE name = $1 AND branch_id = $2`, &stray, name, clinicB.BranchID)
	var visibleToB int
	one(t, `SELECT count(*) FROM departments WHERE name = $1 AND tenant_id = $2`, &visibleToB, name, clinicB.TenantID)
	if visibleToB != 0 {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B gained a department written by another clinic")
	}
	testkit.KnownBug(t, "TENANT-FK-1", r.Status < 400 || stray != 0, fmt.Sprintf(
		"a department on another clinic's branch is accepted (HTTP %d) and stored in the caller's clinic pointing at it", r.Status))
}

// ---- resources ----------------------------------------------------------------------

// TestREG_ORG_017_ResourcesCreateListDelete: Given a clinic, When the owner adds a chair
// in a department, Then it is listed with its branch and department; an unknown type,
// a missing name, a malformed branch or department are 400; When it is deleted, Then it
// leaves the list (soft delete); another clinic cannot delete it; a receptionist is
// refused.
func TestREG_ORG_017_ResourcesCreateListDelete(t *testing.T) {
	c := newClinic(t)
	owner, rc := srv.As(t, c, "owner"), srv.As(t, c, "receptionist")
	body := func(name, typ string) map[string]any {
		return map[string]any{"branch_id": opBranch(c), "department_id": opDept(c), "name": name, "type": typ}
	}
	rc.Do("POST", "/org/resources", body("Chair 1", "chair")).Expect(t, 403, "receptionist adds resource")
	owner.Do("POST", "/org/resources", body("Chair 1", "sofa")).Expect(t, 400, "unknown resource type")
	owner.Do("POST", "/org/resources", map[string]any{"branch_id": opBranch(c), "type": "chair"}).Expect(t, 400, "resource without name")
	owner.Do("POST", "/org/resources", map[string]any{"branch_id": "nope", "name": "C", "type": "chair"}).Expect(t, 400, "malformed branch")
	owner.Do("POST", "/org/resources", map[string]any{"branch_id": opBranch(c), "department_id": "nope", "name": "C", "type": "chair"}).Expect(t, 400, "malformed department")

	type res struct {
		ID           string  `json:"id"`
		BranchID     string  `json:"branch_id"`
		DepartmentID *string `json:"department_id"`
		Name         string  `json:"name"`
		Type         string  `json:"type"`
	}
	var chair, xray res
	owner.Do("POST", "/org/resources", body("Chair 1", "chair")).Expect(t, 201, "add chair").Decode(t, &chair)
	owner.Do("POST", "/org/resources", map[string]any{"branch_id": opBranch(c), "name": "X-ray", "type": "equipment"}).Expect(t, 201, "add equipment").Decode(t, &xray)
	if chair.Type != "chair" || chair.BranchID != opBranch(c) || chair.DepartmentID == nil || *chair.DepartmentID != opDept(c) || xray.DepartmentID != nil {
		t.Fatalf("created resources chair=%+v xray=%+v", chair, xray)
	}
	list := func() map[string]res {
		var out []res
		srv.As(t, c, "nurse").Do("GET", "/org/resources", nil).Expect(t, 200, "list resources").Decode(t, &out)
		m := map[string]res{}
		for _, r := range out {
			m[r.ID] = r
		}
		return m
	}
	if l := list(); len(l) != 2 || l[chair.ID].Name != "Chair 1" {
		t.Fatalf("resources listed %+v", l)
	}
	var bList []res
	srv.As(t, clinicB, "owner").Do("GET", "/org/resources", nil).Expect(t, 200, "B lists").Decode(t, &bList)
	for _, r := range bList {
		if r.ID == chair.ID {
			t.Fatalf("CROSS-CLINIC READ: clinic B lists clinic A's chair")
		}
	}
	srv.As(t, clinicB, "owner").Do("DELETE", "/org/resources/"+chair.ID, nil)
	if _, ok := list()[chair.ID]; !ok {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B deleted clinic A's chair")
	}
	rc.Do("DELETE", "/org/resources/"+chair.ID, nil).Expect(t, 403, "receptionist deletes resource")
	owner.Do("DELETE", "/org/resources/"+chair.ID, nil).Expect(t, 204, "delete chair")
	if _, ok := list()[chair.ID]; ok {
		t.Fatalf("deleted chair still listed")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM resources WHERE id = $1`, &deleted, opUUID(t, id.PrefixResource, chair.ID))
	if !deleted {
		t.Fatalf("chair not soft-deleted")
	}
	owner.Do("DELETE", "/org/resources/bad", nil).Expect(t, 404, "delete malformed id")
}

// ---- payment rails ---------------------------------------------------------------------

// TestREG_ORG_018_PaymentRailsCreateValidateList: Given a new clinic, When the cashier
// lists payment methods, Then the four defaults are there; When the owner adds a named
// bank account without a code, Then the code is derived from the name and the provider
// lower-cased; a reused code is 409; a missing name, unknown kind, a provider on cash,
// an unknown provider and a bad code are 400; a card method drops any account details.
func TestREG_ORG_018_PaymentRailsCreateValidateList(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	def := opRails(t, srv.As(t, c, "cashier"), false)
	keys := []string{}
	for _, r := range def {
		keys = append(keys, r.Key)
	}
	if strings.Join(keys, ",") != "cash,card,mobile,transfer" {
		t.Fatalf("default rails %v", keys)
	}
	srv.As(t, c, "cashier").Do("POST", "/org/payment-rails", map[string]any{"label": "Mine", "kind": "cash"}).Expect(t, 403, "cashier adds rail")

	var r opRail
	owner.Do("POST", "/org/payment-rails", map[string]any{
		"label": "  CBE — main account ", "kind": "bank", "bank_key": " CBE ", "account_name": "Smile Dental",
		"account_number": " 1000123456 ", "needs_reference": true, "sort_order": 7,
	}).Expect(t, 201, "add bank rail").Decode(t, &r)
	if r.Key != "cbe_main_account" || r.Label != "CBE — main account" || r.BankKey != "cbe" || r.AccountNumber != "1000123456" ||
		!r.NeedsReference || !r.Active || r.SortOrder != 7 {
		t.Fatalf("created rail %+v", r)
	}
	var stored string
	one(t, `SELECT bank_key FROM payment_rails WHERE id = $1`, &stored, opUUID(t, id.PrefixPaymentRail, r.ID))
	if stored != "cbe" {
		t.Fatalf("payment_rails.bank_key %q", stored)
	}
	if x := owner.Do("POST", "/org/payment-rails", map[string]any{"label": "CBE main account", "kind": "bank"}); x.Status != 409 || x.Code != "RAIL_EXISTS" {
		t.Fatalf("reused rail code: %d %s", x.Status, x.Code)
	}
	for name, body := range map[string]map[string]any{
		"no label":           {"kind": "cash"},
		"unknown kind":       {"label": "Crypto", "kind": "crypto"},
		"cash with provider": {"label": "Till", "kind": "cash", "bank_key": "cbe"},
		"unknown provider":   {"label": "Mystery", "kind": "wallet", "bank_key": "paypal"},
		"bad code":           {"label": "Odd", "kind": "wallet", "key": "Bad Key!"},
		"symbols only":       {"label": "!!!", "kind": "wallet"},
	} {
		if x := owner.Do("POST", "/org/payment-rails", body); x.Status != 400 {
			t.Errorf("%s: want 400, got %d %s", name, x.Status, x.Code)
		}
	}
	owner.Do("POST", "/org/payment-rails", map[string]any{"label": "X", "kind": "cash", "active": "yes"}).Expect(t, 400, "malformed rail")

	var card opRail
	owner.Do("POST", "/org/payment-rails", map[string]any{
		"key": "pos_2", "label": "POS terminal 2", "kind": "card", "account_number": "999", "needs_reference": true, "active": false,
	}).Expect(t, 201, "add card rail").Decode(t, &card)
	if card.Key != "pos_2" || card.AccountNumber != "" || card.NeedsReference || card.Active {
		t.Fatalf("card rail kept account details or reference: %+v", card)
	}
	if opRailIn(opRails(t, owner, false), card.ID) || !opRailIn(opRails(t, owner, true), card.ID) {
		t.Fatalf("an inactive rail must be hidden from the desk and shown to settings")
	}
	if opRailIn(opRails(t, srv.As(t, clinicB, "cashier"), true), r.ID) {
		t.Fatalf("CROSS-CLINIC READ: clinic B lists clinic A's rail")
	}
}

// TestREG_ORG_019_PaymentRailUpdateKeepsTheKey: Given a rail, When the owner renames it,
// switches it off and sends a different code, Then the label and state change but the
// code (written on every settled charge) does not; an invalid update is 400; an
// unknown or another clinic's rail is 404 and unchanged.
func TestREG_ORG_019_PaymentRailUpdateKeepsTheKey(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	var r opRail
	owner.Do("POST", "/org/payment-rails", map[string]any{"label": "Telebirr", "kind": "wallet", "bank_key": "telebirr"}).Expect(t, 201, "add rail").Decode(t, &r)

	var up opRail
	owner.Do("PUT", "/org/payment-rails/"+r.ID, map[string]any{
		"key": "renamed", "label": "Telebirr merchant", "kind": "wallet", "bank_key": "telebirr", "needs_reference": true, "active": false, "sort_order": 3,
	}).Expect(t, 200, "update rail").Decode(t, &up)
	if up.Key != "telebirr" || up.Label != "Telebirr merchant" || up.Active || !up.NeedsReference || up.SortOrder != 3 {
		t.Fatalf("updated rail %+v (key must not change)", up)
	}
	var key string
	var active bool
	one(t, `SELECT key FROM payment_rails WHERE id = $1`, &key, opUUID(t, id.PrefixPaymentRail, r.ID))
	one(t, `SELECT active FROM payment_rails WHERE id = $1`, &active, opUUID(t, id.PrefixPaymentRail, r.ID))
	if key != "telebirr" || active {
		t.Fatalf("payment_rails row key=%q active=%v", key, active)
	}
	owner.Do("PUT", "/org/payment-rails/"+r.ID, map[string]any{"label": "", "kind": "wallet"}).Expect(t, 400, "update without label")
	owner.Do("PUT", "/org/payment-rails/"+r.ID, map[string]any{"label": "X", "kind": "wallet", "sort_order": "first"}).Expect(t, 400, "malformed update")
	owner.Do("PUT", "/org/payment-rails/"+id.Encode(id.PrefixPaymentRail, uuid.New()), map[string]any{"label": "Ghost", "kind": "cash"}).Expect(t, 404, "update unknown rail")
	owner.Do("PUT", "/org/payment-rails/bad", map[string]any{"label": "Ghost", "kind": "cash"}).Expect(t, 404, "update malformed id")
	srv.As(t, c, "cashier").Do("PUT", "/org/payment-rails/"+r.ID, map[string]any{"label": "Mine", "kind": "cash"}).Expect(t, 403, "cashier edits rail")

	ob := srv.As(t, clinicB, "owner")
	ob.Do("PUT", "/org/payment-rails/"+r.ID, map[string]any{"label": "Stolen", "kind": "cash"}).Expect(t, 404, "B edits A's rail")
	ob.Do("DELETE", "/org/payment-rails/"+r.ID, nil).Expect(t, 404, "B deletes A's rail")
	var label string
	one(t, `SELECT label FROM payment_rails WHERE id = $1`, &label, opUUID(t, id.PrefixPaymentRail, r.ID))
	if label != "Telebirr merchant" {
		t.Fatalf("CROSS-CLINIC WRITE: A's rail label is now %q", label)
	}
}

// TestREG_ORG_020_PaymentRailThatTookMoneyCannotBeDeleted: Given a rail that has never
// been used, When the owner deletes it, Then it is gone; Given a rail the cashier
// settled a charge with, When the owner deletes it, Then 409 RAIL_IN_USE and it stays;
// deleting an unknown rail is 404.
func TestREG_ORG_020_PaymentRailThatTookMoneyCannotBeDeleted(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	var unused, till opRail
	owner.Do("POST", "/org/payment-rails", map[string]any{"label": "Unused wallet", "kind": "wallet"}).Expect(t, 201, "add").Decode(t, &unused)
	owner.Do("POST", "/org/payment-rails", map[string]any{"label": "Front till", "kind": "cash"}).Expect(t, 201, "add").Decode(t, &till)
	srv.As(t, c, "cashier").Do("DELETE", "/org/payment-rails/"+unused.ID, nil).Expect(t, 403, "cashier deletes rail")
	owner.Do("DELETE", "/org/payment-rails/"+unused.ID, nil).Expect(t, 204, "delete unused rail")
	if opRailIn(opRails(t, owner, true), unused.ID) {
		t.Fatalf("deleted rail still listed")
	}
	owner.Do("DELETE", "/org/payment-rails/"+unused.ID, nil).Expect(t, 404, "delete it again")
	owner.Do("DELETE", "/org/payment-rails/bad", nil).Expect(t, 404, "delete malformed id")

	desk, cashier := srv.As(t, c, "receptionist"), srv.As(t, c, "cashier")
	p := createPatient(t, desk, uniq("Rail"), "Payer")
	chg := payRaise(t, desk, c, p.ID, 120)
	cashier.Do("POST", "/billing/charges/"+chg+"/settle", map[string]any{"rail_id": till.ID}).Expect(t, 204, "settle with the till")
	var used uuid.UUID
	one(t, `SELECT payment_rail_id FROM charges WHERE id = $1`, &used, opUUID(t, id.PrefixCharge, chg))
	if used != opUUID(t, id.PrefixPaymentRail, till.ID) {
		t.Fatalf("charge settled on rail %v, want the till", used)
	}
	if r := owner.Do("DELETE", "/org/payment-rails/"+till.ID, nil); r.Status != 409 || r.Code != "RAIL_IN_USE" {
		t.Fatalf("delete a rail that took money: %d %s", r.Status, r.Code)
	}
	if !opRailIn(opRails(t, owner, true), till.ID) {
		t.Fatalf("used rail disappeared after a refused delete")
	}
}

// ---- plan usage -------------------------------------------------------------------------

// TestREG_ORG_021_PlanUsageCountsWhatTheClinicHas: Given a new clinic (owner + five
// staff, one branch, no patients) with its user cap overridden to 8, When plan usage is
// read, Then it names the plan and reports users 6/8, branches 1, patients 0 then 1
// after a registration, storage 0, and the feature list.
func TestREG_ORG_021_PlanUsageCountsWhatTheClinicHas(t *testing.T) {
	c := newClinic(t)
	opExec(t, `UPDATE tenants SET user_limit_override = 8 WHERE id = $1`, c.TenantID)
	type line struct {
		Used  int64 `json:"used"`
		Limit int64 `json:"limit"`
	}
	var pu struct {
		PlanName string `json:"plan_name"`
		Storage  line   `json:"storage"`
		Patients line   `json:"patients"`
		Users    line   `json:"users"`
		Branches line   `json:"branches"`
		Features []struct {
			Code     string `json:"code"`
			Included bool   `json:"included"`
		} `json:"features"`
	}
	rc := srv.As(t, c, "receptionist")
	rc.Do("GET", "/org/plan-usage", nil).Expect(t, 200, "plan usage").Decode(t, &pu)
	if pu.PlanName != "Business" || pu.Users != (line{6, 8}) || pu.Branches.Used != 1 || pu.Patients.Used != 0 || pu.Storage.Used != 0 {
		t.Fatalf("plan usage %+v", pu)
	}
	if len(pu.Features) == 0 {
		t.Fatalf("plan usage lists no features")
	}
	createPatient(t, rc, uniq("Usage"), "Count")
	rc.Do("GET", "/org/plan-usage", nil).Expect(t, 200, "plan usage").Decode(t, &pu)
	if pu.Patients.Used != 1 {
		t.Fatalf("patients used %d after one registration", pu.Patients.Used)
	}
}
