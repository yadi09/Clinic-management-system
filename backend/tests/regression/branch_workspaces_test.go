package regression

// Branches as separate workspaces. A branch is a workspace of its own, behind the
// same database wall as two different clinics: it starts with a copy of the clinic's
// settings and none of its patients, notes, money or stock. The owner (and branch
// admins) move between branches; staff of one branch see only that branch.

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

type orgWorkspace struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	Current bool   `json:"current"`
}

type orgBranchResult struct {
	Branch struct {
		ID   string `json:"id"`
		Slug string `json:"slug"`
		Name string `json:"name"`
	} `json:"branch"`
	Admins []string `json:"admins"`
	Copied []string `json:"copied"`
}

type orgWorld struct {
	c        *testkit.Clinic
	owner    *testkit.Client
	branch   orgBranchResult
	mainID   string
	patient  patientRef
	railName string
	procName string
}

// orgClinic is a clinic with real settings and real patient data, then a second
// branch added by the vendor.
func orgClinic(t *testing.T) *orgWorld {
	t.Helper()
	c := newClinic(t)
	exec(t, `UPDATE tenants SET branch_limit_override = 5 WHERE id = $1`, c.TenantID)
	w := &orgWorld{c: c, owner: srv.As(t, c, "owner"), mainID: id.Encode(id.PrefixTenant, c.TenantID)}
	// Settings the branch should inherit.
	w.railName = uniq("Telebirr ")
	w.owner.Do("POST", "/org/payment-rails", map[string]any{"label": w.railName, "kind": "wallet", "bank_key": "telebirr", "account_number": "0911000111"}).Expect(t, 201, "rail")
	w.procName = uniq("Gold inlay ")
	w.owner.Do("POST", "/dental/procedures", map[string]any{"name": w.procName}).Expect(t, 201, "procedure")
	portalOn(t, c, map[string]any{"welcome_note": "Main branch note"})
	// Data the branch must NOT inherit.
	w.patient = createPatient(t, srv.As(t, c, "receptionist"), "Meron", "Main")
	createPlan(t, srv.As(t, c, "doctor"), w.patient.ID, "3000", 2, "")

	adm, _, _ := platAdmin(t)
	slug := strings.ToLower(uniq("br-"))
	adm.Do("POST", "/platform/clinics/"+w.mainID+"/branches", map[string]any{"name": "Bole branch", "slug": slug}).
		Expect(t, 201, "add branch").Decode(t, &w.branch)
	return w
}

func workspacesOf(t *testing.T, cl *testkit.Client) []orgWorkspace {
	t.Helper()
	var out []orgWorkspace
	cl.Do("GET", "/auth/workspaces", nil).Expect(t, 200, "workspaces").Decode(t, &out)
	return out
}

func switchTo(t *testing.T, cl *testkit.Client, workspaceID string) testkit.Resp {
	t.Helper()
	r := cl.Do("POST", "/auth/switch-workspace", map[string]any{"workspace_id": workspaceID})
	if r.Status == 200 {
		var tok struct {
			AccessToken string `json:"access_token"`
		}
		r.Decode(t, &tok)
		cl.Token = tok.AccessToken
	}
	return r
}

func tenantOfToken(t *testing.T, tok string) string {
	t.Helper()
	s, _ := platClaims(t, tok)["tid"].(string)
	return s
}

// REG_BRWS_001: a new branch opens with the clinic's settings and none of its data.
func TestREG_BRWS_001_NewBranchHasSettingsNotData(t *testing.T) {
	w := orgClinic(t)
	if len(w.branch.Admins) != 1 || w.branch.Admins[0] != w.c.Owner.Email {
		t.Fatalf("admins = %v, want the owner", w.branch.Admins)
	}
	// The owner signs in at the branch's own workspace name, with the same password.
	r, br := platStaffLogin(t, w.branch.Branch.Slug, w.c.Owner.Email, testkit.StaffPassword)
	r.Expect(t, 200, "owner signs in at the branch")
	// Settings came across.
	var rails []struct {
		Label         string `json:"label"`
		AccountNumber string `json:"account_number"`
	}
	br.Do("GET", "/org/payment-rails?all=1", nil).Expect(t, 200, "rails").Decode(t, &rails)
	found := false
	for _, x := range rails {
		found = found || (x.Label == w.railName && x.AccountNumber == "0911000111")
	}
	if !found {
		t.Fatalf("the clinic's payment method did not come across: %+v", rails)
	}
	var procs []struct {
		Name string `json:"name"`
	}
	br.Do("GET", "/dental/procedures", nil).Expect(t, 200, "procedures").Decode(t, &procs)
	found = false
	for _, x := range procs {
		found = found || x.Name == w.procName
	}
	if !found {
		t.Fatalf("the clinic's procedure did not come across")
	}
	var ps struct {
		Enabled     bool   `json:"enabled"`
		WelcomeNote string `json:"welcome_note"`
	}
	br.Do("GET", "/portal-settings", nil).Expect(t, 200, "portal").Decode(t, &ps)
	if !ps.Enabled || ps.WelcomeNote != "Main branch note" {
		t.Fatalf("portal settings did not come across: %+v", ps)
	}
	// Data did not.
	tid, _ := id.Decode(id.PrefixTenant, w.branch.Branch.ID)
	for _, table := range []string{"patients", "treatment_plans", "treatment_sessions", "charges", "encounters", "appointments", "payment_references", "audit_logs"} {
		var n int
		one(t, `SELECT count(*) FROM `+table+` WHERE tenant_id = $1 AND `+map[bool]string{true: "action NOT LIKE 'auth.%' AND action NOT LIKE 'org.%' AND action NOT LIKE 'user.%'", false: "true"}[table == "audit_logs"], &n, tid)
		if table != "audit_logs" && n != 0 {
			t.Fatalf("the new branch has %d %s — data must never be copied", n, table)
		}
	}
	// Its own numbering: the branch's first patient is a fresh card.
	if r := br.Do("GET", "/patients/"+w.patient.ID, nil); r.Status != 404 {
		t.Fatalf("the main branch's patient opened at the new branch: %d", r.Status)
	}
}

// REG_BRWS_002: the owner moves between branches, and each side sees only its own.
func TestREG_BRWS_002_OwnerMovesBetweenBranches(t *testing.T) {
	w := orgClinic(t)
	ws := workspacesOf(t, w.owner)
	if len(ws) != 2 || !ws[0].Current || ws[0].ID != w.mainID || ws[1].ID != w.branch.Branch.ID {
		t.Fatalf("workspaces = %+v", ws)
	}
	switchTo(t, w.owner, w.branch.Branch.ID).Expect(t, 200, "switch to the branch")
	if got := tenantOfToken(t, w.owner.Token); got != mustTenant(t, w.branch.Branch.ID) {
		t.Fatalf("token is for %s, want the branch", got)
	}
	if r := w.owner.Do("GET", "/patients/"+w.patient.ID, nil); r.Status != 404 {
		t.Fatalf("from the branch, the main branch's patient answered %d", r.Status)
	}
	// A patient registered here is invisible from the main branch.
	bp := createPatient(t, w.owner, "Hana", "Bole")
	if ws := workspacesOf(t, w.owner); len(ws) != 2 || !ws[1].Current {
		t.Fatalf("from the branch, workspaces = %+v", ws)
	}
	// The browser's session moved too: a silent refresh stays in the branch.
	var ref struct {
		AccessToken string `json:"access_token"`
	}
	w.owner.Do("POST", "/auth/refresh", nil).Expect(t, 200, "refresh").Decode(t, &ref)
	if tenantOfToken(t, ref.AccessToken) != mustTenant(t, w.branch.Branch.ID) {
		t.Fatalf("after a refresh the session is back in the main branch")
	}
	switchTo(t, w.owner, w.mainID).Expect(t, 200, "switch back")
	if r := w.owner.Do("GET", "/patients/"+bp.ID, nil); r.Status != 404 {
		t.Fatalf("from the main branch, the branch's patient answered %d", r.Status)
	}
	w.owner.Do("GET", "/patients/"+w.patient.ID, nil).Expect(t, 200, "own patient again")
	if r := switchTo(t, w.owner, w.mainID); r.Status != 400 {
		t.Fatalf("switching to the branch you are in = %d", r.Status)
	}
}

// REG_BRWS_003: staff work in one branch; there is nowhere to switch to.
func TestREG_BRWS_003_StaffStayInTheirBranch(t *testing.T) {
	w := orgClinic(t)
	for _, role := range []string{"receptionist", "doctor", "cashier", "branch_manager"} {
		cl := srv.As(t, w.c, role)
		if ws := workspacesOf(t, cl); len(ws) != 0 {
			t.Fatalf("%s sees branches %+v", role, ws)
		}
		if r := switchTo(t, cl, w.branch.Branch.ID); r.Status != 403 {
			t.Fatalf("%s switched into the other branch: %d", role, r.Status)
		}
		// Nor can they sign in there: they have no account in that workspace.
		if r, _ := platStaffLogin(t, w.branch.Branch.Slug, w.c.Staff[role].Email, testkit.StaffPassword); r.Status != 401 {
			t.Fatalf("%s signed in at the other branch: %d", role, r.Status)
		}
	}
}

// REG_BRWS_004: an owner cannot switch into a workspace of a different clinic.
func TestREG_BRWS_004_NoSwitchIntoAnotherClinic(t *testing.T) {
	w := orgClinic(t)
	other := newClinic(t)
	if r := switchTo(t, w.owner, id.Encode(id.PrefixTenant, other.TenantID)); r.Status != 403 {
		t.Fatalf("switched into another clinic: %d", r.Status)
	}
	if r := switchTo(t, w.owner, "ten_garbage"); r.Status != 400 {
		t.Fatalf("garbage id = %d", r.Status)
	}
	// Underneath, as the application itself: a session of another clinic sees none of
	// this clinic's branch links; a session of this clinic sees them.
	app, err := pgx.Connect(t.Context(), testkit.AppDSNFrom(superDSN))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close(t.Context())
	links := func(as uuid.UUID) int {
		tx, err := app.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(t.Context()) }()
		if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, as.String()); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := tx.QueryRow(t.Context(), `SELECT count(*) FROM org_links WHERE tenant_id = $1`, w.c.TenantID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := links(other.TenantID); n != 0 {
		t.Fatalf("another clinic's session read %d of this clinic's branch links", n)
	}
	if n := links(w.c.TenantID); n == 0 {
		t.Fatalf("the clinic's own session cannot read its branch links")
	}
}

// REG_BRWS_005: one person, one password, whichever branch they sign in at.
func TestREG_BRWS_005_PasswordFollowsThePerson(t *testing.T) {
	w := orgClinic(t)
	w.owner.Do("POST", "/auth/password", map[string]any{"current_password": testkit.StaffPassword, "new_password": "BranchesTogether#1"}).Expect(t, 204, "change password")
	if r, _ := platStaffLogin(t, w.branch.Branch.Slug, w.c.Owner.Email, "BranchesTogether#1"); r.Status != 200 {
		t.Fatalf("new password at the branch = %d", r.Status)
	}
	if r, _ := platStaffLogin(t, w.branch.Branch.Slug, w.c.Owner.Email, testkit.StaffPassword); r.Status != 401 {
		t.Fatalf("old password still opens the branch: %d", r.Status)
	}
}

// REG_BRWS_006: the plan's branch count is the number of workspaces; names are unique.
func TestREG_BRWS_006_BranchCapAndNames(t *testing.T) {
	w := orgClinic(t)
	adm, _, _ := platAdmin(t)
	exec(t, `UPDATE tenants SET branch_limit_override = 2 WHERE id = $1`, w.c.TenantID)
	r := adm.Do("POST", "/platform/clinics/"+w.mainID+"/branches", map[string]any{"name": "Third", "slug": strings.ToLower(uniq("br-"))})
	if r.Status != 409 || r.Code != "BRANCH_LIMIT" {
		t.Fatalf("third branch on a 2-branch plan = %d %s", r.Status, r.Code)
	}
	exec(t, `UPDATE tenants SET branch_limit_override = 5 WHERE id = $1`, w.c.TenantID)
	if r := adm.Do("POST", "/platform/clinics/"+w.mainID+"/branches", map[string]any{"name": "Dup", "slug": w.branch.Branch.Slug}); r.Status != 409 || r.Code != "SLUG_TAKEN" {
		t.Fatalf("duplicate workspace name = %d %s", r.Status, r.Code)
	}
	if r := adm.Do("POST", "/platform/clinics/"+w.mainID+"/branches", map[string]any{"name": "", "slug": ""}); r.Status != 400 {
		t.Fatalf("empty branch = %d", r.Status)
	}
	// A branch added from the branch's own id joins the same clinic.
	third := strings.ToLower(uniq("br-"))
	adm.Do("POST", "/platform/clinics/"+w.branch.Branch.ID+"/branches", map[string]any{"name": "Piassa", "slug": third}).Expect(t, 201, "third branch")
	var list []struct {
		Slug string `json:"slug"`
		Main bool   `json:"main"`
	}
	adm.Do("GET", "/platform/clinics/"+w.branch.Branch.ID+"/branches", nil).Expect(t, 200, "branches").Decode(t, &list)
	if len(list) != 3 || !list[0].Main || list[0].Slug != w.c.Slug || list[2].Slug != third {
		t.Fatalf("branches = %+v", list)
	}
	if ws := workspacesOf(t, w.owner); len(ws) != 3 {
		t.Fatalf("owner sees %d branches, want 3", len(ws))
	}
	if r := srv.As(t, w.c, "owner").Do("POST", "/platform/clinics/"+w.mainID+"/branches", map[string]any{"name": "x", "slug": "y"}); r.Status != 401 && r.Status != 403 {
		t.Fatalf("a clinic owner added a branch through the vendor's console: %d", r.Status)
	}
}

func mustTenant(t *testing.T, enc string) string {
	t.Helper()
	u, err := id.Decode(id.PrefixTenant, enc)
	if err != nil {
		t.Fatal(err)
	}
	return u.String()
}

// REG_BRWS_007: the console's branch calls answer plainly when something is wrong.
func TestREG_BRWS_007_ConsoleRefusalsAreClear(t *testing.T) {
	adm, _, _ := platAdmin(t)
	ghost := id.Encode(id.PrefixTenant, uuid.New())
	if r := adm.Do("GET", "/platform/clinics/"+ghost+"/branches", nil); r.Status != 404 {
		t.Fatalf("branches of an unknown clinic = %d", r.Status)
	}
	if r := adm.Do("POST", "/platform/clinics/"+ghost+"/branches", map[string]any{"name": "x", "slug": uniq("g-")}); r.Status != 404 {
		t.Fatalf("branch for an unknown clinic = %d", r.Status)
	}
	for _, p := range []string{"/platform/clinics/nope/branches"} {
		if r := adm.Do("GET", p, nil); r.Status != 400 {
			t.Fatalf("GET %s = %d", p, r.Status)
		}
		if r := adm.Do("POST", p, map[string]any{"name": "x", "slug": "y"}); r.Status != 400 {
			t.Fatalf("POST %s = %d", p, r.Status)
		}
	}
	c := newClinic(t)
	exec(t, `UPDATE tenants SET branch_limit_override = 5 WHERE id = $1`, c.TenantID)
	main := id.Encode(id.PrefixTenant, c.TenantID)
	if r := adm.Do("POST", "/platform/clinics/"+main+"/branches", "not an object"); r.Status != 400 {
		t.Fatalf("a body that is not a branch = %d", r.Status)
	}
	exec(t, `UPDATE tenants SET status = 'suspended' WHERE id = $1`, c.TenantID)
	if r := adm.Do("POST", "/platform/clinics/"+main+"/branches", map[string]any{"name": "x", "slug": uniq("s-")}); r.Status != 409 || r.Code != "CLINIC_INACTIVE" {
		t.Fatalf("branch for a suspended clinic = %d %s", r.Status, r.Code)
	}
	exec(t, `UPDATE tenants SET status = 'active' WHERE id = $1`, c.TenantID)
	exec(t, `UPDATE users SET status = 'deactivated' WHERE tenant_id = $1 AND email = $2`, c.TenantID, c.Owner.Email)
	if r := adm.Do("POST", "/platform/clinics/"+main+"/branches", map[string]any{"name": "x", "slug": uniq("o-")}); r.Status != 409 || r.Code != "OWNER_NOT_FOUND" {
		t.Fatalf("branch for a clinic with no active owner = %d %s", r.Status, r.Code)
	}
}

// REG_BRWS_008: a clinic with two owners: both get an account in the new branch, each
// with their own password, and each can move between the branches.
func TestREG_BRWS_008_EveryOwnerComesAlong(t *testing.T) {
	c := newClinic(t)
	exec(t, `UPDATE tenants SET branch_limit_override = 5 WHERE id = $1`, c.TenantID)
	hash, err := auth.HashPassword("SecondOwner#2026")
	if err != nil {
		t.Fatal(err)
	}
	second := "partner@" + strings.ToLower(uniq("own")) + ".test"
	exec(t, `WITH u AS (INSERT INTO users (tenant_id, email, password_hash, full_name, status) VALUES ($1,$2,$3,'Second Owner','active') RETURNING id)
	          INSERT INTO user_role_scopes (tenant_id, user_id, role_id) SELECT $1, u.id, r.id FROM u, roles r WHERE r.tenant_id = $1 AND r.code = 'tenant_owner'`,
		c.TenantID, second, hash)
	adm, _, _ := platAdmin(t)
	var res orgBranchResult
	adm.Do("POST", "/platform/clinics/"+id.Encode(id.PrefixTenant, c.TenantID)+"/branches", map[string]any{"name": "Two owners", "slug": strings.ToLower(uniq("two-"))}).
		Expect(t, 201, "branch").Decode(t, &res)
	if len(res.Admins) != 2 {
		t.Fatalf("admins = %v, want both owners", res.Admins)
	}
	r, cl := platStaffLogin(t, res.Branch.Slug, second, "SecondOwner#2026")
	r.Expect(t, 200, "the second owner signs in at the branch with their own password")
	if ws := workspacesOf(t, cl); len(ws) != 2 {
		t.Fatalf("the second owner sees %d branches", len(ws))
	}
	switchTo(t, cl, id.Encode(id.PrefixTenant, c.TenantID)).Expect(t, 200, "second owner moves to the main branch")
	if r := cl.Do("POST", "/auth/switch-workspace", nil); r.Status != 400 {
		t.Fatalf("a switch with no branch named = %d", r.Status)
	}
	// A disabled account in the target branch cannot be entered by switching either.
	exec(t, `UPDATE users SET status = 'deactivated' WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1) AND email = $2`, res.Branch.Slug, second)
	if r := switchTo(t, cl, res.Branch.ID); r.Status != 403 {
		t.Fatalf("switch into a branch where the account is disabled = %d", r.Status)
	}
}
