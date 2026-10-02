package regression

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Staff (REG_USER): invitations, the staff list, roles and their assignment, profile
// edits, the plan's user cap, and the signed-in user's own email, second factor and
// branch switch. Anything that adds, edits or locks a user runs in newClinic(t).

// ---- helpers (prefixed op) ----------------------------------------------------

type opInvite struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	InviteLink string `json:"invite_link"`
}

// opInviteToken pulls the token out of an invitation (or reset) link.
func opInviteToken(t *testing.T, link string) string {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil || u.Query().Get("token") == "" {
		t.Fatalf("link has no token: %q", link)
	}
	return u.Query().Get("token")
}

// opInviteUser invites a member of staff (expects 201).
func opInviteUser(t *testing.T, owner *testkit.Client, email string, roles []string, branches []string) opInvite {
	t.Helper()
	body := map[string]any{"email": email, "full_name": "Invited " + email[:6], "roles": roles}
	if branches != nil {
		body["branch_ids"] = branches
	}
	var inv opInvite
	owner.Do("POST", "/users", body).Expect(t, 201, "invite "+email).Decode(t, &inv)
	if inv.ID == "" || inv.InviteLink == "" {
		t.Fatalf("invite returned no id/link")
	}
	return inv
}

type opMe struct {
	User struct {
		ID    string   `json:"id"`
		Email string   `json:"email"`
		Roles []string `json:"roles"`
	} `json:"user"`
	Permissions []string `json:"permissions"`
	Branches    []struct {
		ID string `json:"id"`
	} `json:"branches"`
	ActiveBranchID *string `json:"active_branch_id"`
	AllBranches    bool    `json:"all_branches"`
}

func opWhoAmI(t *testing.T, c *testkit.Client) opMe {
	t.Helper()
	var me opMe
	c.Do("GET", "/auth/me", nil).Expect(t, 200, "me").Decode(t, &me)
	return me
}

func opHas(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// opRoleCodes is what the database says a user's roles are, in their own clinic.
func opRoleCodes(t *testing.T, tenant, user uuid.UUID) string {
	t.Helper()
	var s string
	one(t, `SELECT coalesce(string_agg(r.code, ',' ORDER BY r.code), '') FROM user_role_scopes urs
	         JOIN roles r ON r.id = urs.role_id AND r.tenant_id = urs.tenant_id
	        WHERE urs.tenant_id = $1 AND urs.user_id = $2`, &s, tenant, user)
	return s
}

// ---- invitations --------------------------------------------------------------

// TestREG_USER_001_InviteAcceptThenSignIn: Given the owner invites a receptionist with a
// phone number, When the invitation exists, Then the account is "invited" (it cannot
// sign in yet) with the phone stored in local form; When the link is opened with a
// short password, Then 400; with a real one, Then the person is signed in as a
// receptionist, the account is active, they can sign in again, and the link cannot be
// used twice.
func TestREG_USER_001_InviteAcceptThenSignIn(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	email := "new.recep@" + c.Slug + ".test"
	var inv opInvite
	owner.Do("POST", "/users", map[string]any{
		"email": "New.Recep@" + c.Slug + ".test", "full_name": "Hana Tesfaye", "phone": "+251 911 22 33 44", "roles": []string{"receptionist"},
	}).Expect(t, 201, "invite").Decode(t, &inv)
	if inv.Email != email {
		t.Fatalf("invited email %q, want lower-cased %q", inv.Email, email)
	}
	uid := opUUID(t, id.PrefixUser, inv.ID)
	var status, phone string
	one(t, `SELECT status FROM users WHERE id = $1`, &status, uid)
	one(t, `SELECT coalesce(phone,'') FROM users WHERE id = $1`, &phone, uid)
	if status != "invited" || phone != "0911223344" {
		t.Fatalf("invited user status=%q phone=%q", status, phone)
	}
	if r := authLogin(t, c.Slug, email, testkit.StaffPassword); r.Status == 200 {
		t.Fatalf("an invited account without a password signed in")
	}

	tok := opInviteToken(t, inv.InviteLink)
	if r := authPost(t, "/auth/accept-invite", map[string]any{"token": tok, "password": "short"}, "", ""); r.Status != 400 {
		t.Fatalf("accept with a short password: %d", r.Status)
	}
	if r := authPost(t, "/auth/accept-invite", map[string]any{"token": tok}, "", ""); r.Status != 400 {
		t.Fatalf("accept without a password: %d", r.Status)
	}
	if r := authPost(t, "/auth/accept-invite", map[string]any{"token": "garbage", "password": "Welcome#2026"}, "", ""); r.Status != 401 {
		t.Fatalf("accept with a garbage token: %d", r.Status)
	}
	if r := authPost(t, "/auth/accept-invite", map[string]any{"token": id.Encode(id.PrefixTenant, c.TenantID) + ".nottherealone", "password": "Welcome#2026"}, "", ""); r.Status != 401 {
		t.Fatalf("accept with an unknown token: %d", r.Status)
	}
	acc := authPost(t, "/auth/accept-invite", map[string]any{"token": tok, "password": "Welcome#2026"}, "", "")
	if acc.Status != 200 || acc.Access == "" || acc.Refresh == "" {
		t.Fatalf("accept invitation: %d access=%t refresh=%t %s", acc.Status, acc.Access != "", acc.Refresh != "", trimAuth(acc.Raw))
	}
	me := opWhoAmI(t, authBearer(t, acc.Access))
	if me.User.Email != email || !opHas(me.User.Roles, "receptionist") || !opHas(me.Permissions, "patient.create") {
		t.Fatalf("accepted user's me: %+v", me)
	}
	one(t, `SELECT status FROM users WHERE id = $1`, &status, uid)
	if status != "active" {
		t.Fatalf("status after accept %q", status)
	}
	if r := authLogin(t, c.Slug, email, "Welcome#2026"); r.Status != 200 {
		t.Fatalf("sign in with the chosen password: %d", r.Status)
	}
	if r := authPost(t, "/auth/accept-invite", map[string]any{"token": tok, "password": "Another#2026"}, "", ""); r.Status != 409 || r.Code != "INVITE_USED" {
		t.Fatalf("reused invitation: %d %s", r.Status, r.Code)
	}
}

// TestREG_USER_002_InviteValidation: Given the owner, When an invitation has a bad
// email, no name, a blank name, an unreadable phone, an unknown role, a malformed
// branch or an email already on staff, Then it is refused (400/409) and no account is
// left behind; a receptionist cannot invite at all.
func TestREG_USER_002_InviteValidation(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	srv.As(t, c, "receptionist").Do("POST", "/users", map[string]any{"email": "x@y.test", "full_name": "X"}).Expect(t, 403, "receptionist invites")
	srv.As(t, c, "branch_manager").Do("POST", "/users", map[string]any{"email": "x@y.test", "full_name": "X"}).Expect(t, 403, "branch manager invites")
	cases := map[string]map[string]any{
		"bad email":     {"email": "not-an-email", "full_name": "X"},
		"no name":       {"email": "a@" + c.Slug + ".test"},
		"blank name":    {"email": "b@" + c.Slug + ".test", "full_name": "   "},
		"bad phone":     {"email": "c@" + c.Slug + ".test", "full_name": "C", "phone": "12"},
		"unknown role":  {"email": "d@" + c.Slug + ".test", "full_name": "D", "roles": []string{"astronaut"}},
		"bad branch id": {"email": "e@" + c.Slug + ".test", "full_name": "E", "roles": []string{"nurse"}, "branch_ids": []string{"brn_nope"}},
	}
	for name, body := range cases {
		if r := owner.Do("POST", "/users", body); r.Status != 400 {
			t.Errorf("%s: want 400, got %d %s", name, r.Status, r.Code)
		}
	}
	if r := owner.Do("POST", "/users", map[string]any{"email": strings.ToUpper(c.Staff["nurse"].Email), "full_name": "Twin"}); r.Status != 409 || r.Code != "USER_EMAIL_TAKEN" {
		t.Fatalf("invite an email already on staff: %d %s", r.Status, r.Code)
	}
	var n int
	one(t, `SELECT count(*) FROM users WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 6 {
		t.Fatalf("users after refused invitations: %d, want the original 6 (a refused invite must leave nothing)", n)
	}
}

// TestREG_USER_003_InviteScopedToABranch: Given a clinic with a second branch, When the
// owner invites a nurse for that branch only, Then the role is stored scoped to it, and
// after accepting, the nurse sees only that branch and cannot switch to the main one or
// to the all-branches view.
func TestREG_USER_003_InviteScopedToABranch(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	second := opNewBranch(t, owner, "Kazanchis", "KAZ")
	inv := opInviteUser(t, owner, "scoped.nurse@"+c.Slug+".test", []string{"nurse"}, []string{second.ID})
	var scoped uuid.UUID
	one(t, `SELECT branch_id FROM user_role_scopes WHERE user_id = $1`, &scoped, opUUID(t, id.PrefixUser, inv.ID))
	if scoped != opUUID(t, id.PrefixBranch, second.ID) {
		t.Fatalf("role scoped to %v, want the second branch", scoped)
	}
	acc := authPost(t, "/auth/accept-invite", map[string]any{"token": opInviteToken(t, inv.InviteLink), "password": "Welcome#2026"}, "", "")
	if acc.Status != 200 {
		t.Fatalf("accept: %d %s", acc.Status, trimAuth(acc.Raw))
	}
	nurse := authBearer(t, acc.Access)
	me := opWhoAmI(t, nurse)
	if me.AllBranches || len(me.Branches) != 1 || me.Branches[0].ID != second.ID || me.ActiveBranchID == nil || *me.ActiveBranchID != second.ID {
		t.Fatalf("scoped nurse's branches: %+v", me)
	}
	if r := nurse.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": opBranch(c)}); r.Status != 403 || r.Code != "BRANCH_DENIED" {
		t.Fatalf("scoped nurse switches to the main branch: %d %s", r.Status, r.Code)
	}
	if r := nurse.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": "all"}); r.Status != 403 || r.Code != "BRANCH_DENIED" {
		t.Fatalf("scoped nurse asks for all branches: %d %s", r.Status, r.Code)
	}
}

// TestREG_USER_004_UserCapIsEnforcedOnInviteAcceptAndReactivation: Given a clinic of
// six active staff whose user cap is overridden to 6, When the owner invites, Then 403
// USER_LIMIT_REACHED; with the cap at 7 the invite goes through (invited accounts are
// not counted) but, back at 6, accepting it is refused and the account stays invited;
// reactivating a deactivated member at the cap is refused too.
func TestREG_USER_004_UserCapIsEnforcedOnInviteAcceptAndReactivation(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	opExec(t, `UPDATE tenants SET user_limit_override = 6 WHERE id = $1`, c.TenantID)
	if r := owner.Do("POST", "/users", map[string]any{"email": "cap1@" + c.Slug + ".test", "full_name": "Cap One", "roles": []string{"nurse"}}); r.Status != 403 || r.Code != "USER_LIMIT_REACHED" {
		t.Fatalf("invite at the cap: %d %s", r.Status, r.Code)
	}
	opExec(t, `UPDATE tenants SET user_limit_override = 7 WHERE id = $1`, c.TenantID)
	inv := opInviteUser(t, owner, "cap2@"+c.Slug+".test", []string{"nurse"}, nil)
	opExec(t, `UPDATE tenants SET user_limit_override = 6 WHERE id = $1`, c.TenantID)
	r := authPost(t, "/auth/accept-invite", map[string]any{"token": opInviteToken(t, inv.InviteLink), "password": "Welcome#2026"}, "", "")
	if r.Status != 403 || r.Code != "USER_LIMIT_REACHED" {
		t.Fatalf("accept at the cap: %d %s", r.Status, r.Code)
	}
	var status string
	one(t, `SELECT status FROM users WHERE id = $1`, &status, opUUID(t, id.PrefixUser, inv.ID))
	if status != "invited" {
		t.Fatalf("refused acceptance left status %q", status)
	}

	authSetStatus(t, owner, c.Staff["cashier"].ID, "deactivated")
	opExec(t, `UPDATE tenants SET user_limit_override = 5 WHERE id = $1`, c.TenantID)
	x := owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, c.Staff["cashier"].ID)+"/status", map[string]any{"status": "active"})
	if x.Status != 403 || x.Code != "USER_LIMIT_REACHED" {
		t.Fatalf("reactivate at the cap: %d %s", x.Status, x.Code)
	}
	opExec(t, `UPDATE tenants SET user_limit_override = NULL WHERE id = $1`, c.TenantID)
	authSetStatus(t, owner, c.Staff["cashier"].ID, "active")
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, c.Staff["cashier"].ID)+"/status", map[string]any{"status": "on-holiday"}).Expect(t, 400, "unknown status")
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, c.Staff["cashier"].ID)+"/status", map[string]any{}).Expect(t, 400, "no status")
	owner.Do("POST", "/users/usr_bad/status", map[string]any{"status": "active"}).Expect(t, 404, "malformed user id")
}

// TestREG_USER_005_RemovedStaffEmailCanBeInvitedAgain: Given a member of staff who was
// removed (soft delete), When the owner invites the same email again, Then it is
// accepted. Today the users email uniqueness ignores deleted_at, so the address can
// never be used in that clinic again (DB-1).
func TestREG_USER_005_RemovedStaffEmailCanBeInvitedAgain(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	st := c.Staff["nurse"]
	owner.Do("DELETE", "/users/"+id.Encode(id.PrefixUser, st.ID), nil).Expect(t, 204, "remove nurse")
	r := owner.Do("POST", "/users", map[string]any{"email": st.Email, "full_name": "Returning Nurse", "roles": []string{"nurse"}})
	if r.Status >= 500 {
		t.Fatalf("re-invite a removed email: %d %s", r.Status, trimBody(r.Raw))
	}
	testkit.KnownBug(t, "DB-1", r.Status != 201, fmt.Sprintf(
		"re-inviting a removed member's email answers %d %s: users UNIQUE (tenant_id, email) ignores soft delete", r.Status, r.Code))
}

// ---- lists ------------------------------------------------------------------------

// TestREG_USER_006_StaffAndRolesListsAreClinicScoped: Given clinics A and B, When A's
// owner or branch manager lists staff, Then every A member is there with their roles
// and no B member is; a receptionist is refused; the roles list holds the clinic's
// system roles for whoever may read users.
func TestREG_USER_006_StaffAndRolesListsAreClinicScoped(t *testing.T) {
	type row struct {
		ID     string   `json:"id"`
		Email  string   `json:"email"`
		Status string   `json:"status"`
		Roles  []string `json:"roles"`
	}
	for _, who := range []string{"owner", "branch_manager"} {
		var list []row
		srv.As(t, clinicA, who).Do("GET", "/users", nil).Expect(t, 200, who+" lists staff").Decode(t, &list)
		byEmail := map[string]row{}
		for _, r := range list {
			byEmail[r.Email] = r
			if strings.HasSuffix(r.Email, "@"+clinicB.Slug+".test") {
				t.Fatalf("CROSS-CLINIC READ: clinic A's staff list has %s", r.Email)
			}
		}
		for role, st := range clinicA.Staff {
			if r, ok := byEmail[st.Email]; !ok || !opHas(r.Roles, role) || r.ID != id.Encode(id.PrefixUser, st.ID) {
				t.Fatalf("%s missing or wrong in staff list: %+v", st.Email, r)
			}
		}
		if r := byEmail[clinicA.Owner.Email]; !opHas(r.Roles, "tenant_owner") {
			t.Fatalf("owner row %+v", r)
		}
	}
	srv.As(t, clinicA, "receptionist").Do("GET", "/users", nil).Expect(t, 403, "receptionist lists staff")

	var roles []struct {
		ID       string `json:"id"`
		Code     string `json:"code"`
		Name     string `json:"name"`
		IsSystem bool   `json:"is_system"`
	}
	srv.As(t, clinicA, "branch_manager").Do("GET", "/roles", nil).Expect(t, 200, "roles").Decode(t, &roles)
	codes := map[string]bool{}
	for _, r := range roles {
		codes[r.Code] = r.IsSystem && r.ID != ""
	}
	for _, want := range []string{"tenant_owner", "clinic_admin", "receptionist", "doctor", "nurse", "cashier", "branch_manager"} {
		if !codes[want] {
			t.Fatalf("roles list lacks system role %s: %v", want, codes)
		}
	}
	srv.As(t, clinicA, "doctor").Do("GET", "/roles", nil).Expect(t, 403, "doctor lists roles")
}

// TestREG_USER_007_ProvidersListsOnlyActiveClinicians: Given a clinic, When the desk
// asks who can be assigned a patient, Then the doctor and the owner (both hold
// encounter.manage) are listed and the cashier and receptionist are not; a deactivated
// doctor drops off; the cashier cannot ask.
func TestREG_USER_007_ProvidersListsOnlyActiveClinicians(t *testing.T) {
	c := newClinic(t)
	var list []struct {
		ID       string `json:"id"`
		FullName string `json:"full_name"`
	}
	read := func() map[string]bool {
		srv.As(t, c, "receptionist").Do("GET", "/providers", nil).Expect(t, 200, "providers").Decode(t, &list)
		m := map[string]bool{}
		for _, p := range list {
			m[p.ID] = true
		}
		return m
	}
	got := read()
	u := func(s testkit.Staff) string { return id.Encode(id.PrefixUser, s.ID) }
	if !got[u(c.Staff["doctor"])] || !got[u(c.Owner)] || got[u(c.Staff["cashier"])] || got[u(c.Staff["receptionist"])] {
		t.Fatalf("providers %v", got)
	}
	authSetStatus(t, srv.As(t, c, "owner"), c.Staff["doctor"].ID, "deactivated")
	if read()[u(c.Staff["doctor"])] {
		t.Fatalf("a deactivated doctor is still offered as a provider")
	}
	srv.As(t, c, "cashier").Do("GET", "/providers", nil).Expect(t, 403, "cashier lists providers")
}

// ---- roles and profile ---------------------------------------------------------------

// TestREG_USER_008_AssignRolesReplacesTheSet: Given a receptionist, When the owner makes
// them a cashier, Then the stored roles are exactly cashier and a fresh sign-in has the
// cashier's permissions and not the desk's; an unknown role is 400 and leaves the
// previous roles in place; a malformed branch is 400; nobody without role.assign may
// do it.
func TestREG_USER_008_AssignRolesReplacesTheSet(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	st := c.Staff["receptionist"]
	path := "/users/" + id.Encode(id.PrefixUser, st.ID) + "/roles"
	srv.As(t, c, "branch_manager").Do("PUT", path, map[string]any{"roles": []string{"cashier"}}).Expect(t, 403, "branch manager assigns")
	srv.As(t, c, "receptionist").Do("PUT", path, map[string]any{"roles": []string{"tenant_owner"}}).Expect(t, 403, "receptionist promotes self")

	owner.Do("PUT", path, map[string]any{"roles": []string{"cashier"}}).Expect(t, 204, "assign cashier")
	if got := opRoleCodes(t, c.TenantID, st.ID); got != "cashier" {
		t.Fatalf("roles after assign %q, want cashier", got)
	}
	me := opWhoAmI(t, srv.As(t, c, "receptionist"))
	if !opHas(me.Permissions, "payment.collect") || opHas(me.Permissions, "patient.create") {
		t.Fatalf("permissions after becoming a cashier: %v", me.Permissions)
	}
	owner.Do("PUT", path, map[string]any{"roles": []string{"cashier", "astronaut"}}).Expect(t, 400, "unknown role")
	if got := opRoleCodes(t, c.TenantID, st.ID); got != "cashier" {
		t.Fatalf("roles after a refused assign %q, want cashier kept", got)
	}
	owner.Do("PUT", path, map[string]any{"roles": []string{"nurse"}, "branch_ids": []string{"x"}}).Expect(t, 400, "malformed branch")
	owner.Do("PUT", path, map[string]any{"roles": "nurse"}).Expect(t, 400, "roles not a list")
	owner.Do("PUT", "/users/nope/roles", map[string]any{"roles": []string{"nurse"}}).Expect(t, 404, "malformed user id")
	owner.Do("PUT", path, map[string]any{"roles": []string{"nurse", "cashier"}, "branch_ids": []string{opBranch(c)}}).Expect(t, 204, "two roles on the main branch")
	var scoped int
	one(t, `SELECT count(*) FROM user_role_scopes WHERE user_id = $1 AND branch_id = $2`, &scoped, st.ID, c.BranchID)
	if got := opRoleCodes(t, c.TenantID, st.ID); got != "cashier,nurse" || scoped != 2 {
		t.Fatalf("roles %q scoped=%d, want cashier,nurse on the main branch", got, scoped)
	}
}

// TestREG_USER_009_AssigningRolesToAnotherClinicsUserIs404: Given clinic B's
// receptionist, When clinic A's owner assigns them a role, Then 404 and nothing is
// stored. Today the write answers 204 and leaves a role row in clinic A pointing at
// B's user (the user id is checked by a foreign key, outside row-level security); B's
// own view of the user is unchanged.
func TestREG_USER_009_AssigningRolesToAnotherClinicsUserIs404(t *testing.T) {
	b := newClinic(t)
	a := newClinic(t)
	target := b.Staff["receptionist"]
	r := srv.As(t, a, "owner").Do("PUT", "/users/"+id.Encode(id.PrefixUser, target.ID)+"/roles", map[string]any{"roles": []string{"clinic_admin"}})
	if got := opRoleCodes(t, b.TenantID, target.ID); got != "receptionist" {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B's receptionist now has roles %q in B", got)
	}
	if me := opWhoAmI(t, srv.As(t, b, "receptionist")); opHas(me.Permissions, "clinic.manage") {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B's receptionist gained clinic.manage")
	}
	var stray int
	one(t, `SELECT count(*) FROM user_role_scopes WHERE tenant_id = $1 AND user_id = $2`, &stray, a.TenantID, target.ID)
	testkit.KnownBug(t, "TENANT-FK-1", r.Status != 404 || stray != 0, fmt.Sprintf(
		"assigning roles to another clinic's user answers %d and stores %d role row(s) in the caller's clinic for that user", r.Status, stray))
}

// TestREG_USER_010_ProfileEditTrimsNormalisesAndScopes: Given a member of staff, When
// the owner corrects their name and phone, Then the name is trimmed and the phone is
// stored in local form; the older /name path changes the name and leaves the phone; an
// empty phone clears it; a blank name or bad phone is 400; an unknown user or another
// clinic's user is 404 and unchanged; a receptionist cannot edit staff.
func TestREG_USER_010_ProfileEditTrimsNormalisesAndScopes(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	st := c.Staff["nurse"]
	ext := id.Encode(id.PrefixUser, st.ID)
	read := func() (string, string) {
		var n, p string
		one(t, `SELECT full_name FROM users WHERE id = $1`, &n, st.ID)
		one(t, `SELECT coalesce(phone,'') FROM users WHERE id = $1`, &p, st.ID)
		return n, p
	}
	owner.Do("POST", "/users/"+ext+"/profile", map[string]any{"full_name": "  Selam Bekele ", "phone": "+251 911 000 111"}).Expect(t, 204, "edit profile")
	if n, p := read(); n != "Selam Bekele" || p != "0911000111" {
		t.Fatalf("after profile edit name=%q phone=%q", n, p)
	}
	owner.Do("POST", "/users/"+ext+"/name", map[string]any{"full_name": "Selam B."}).Expect(t, 204, "rename via /name")
	if n, p := read(); n != "Selam B." || p != "0911000111" {
		t.Fatalf("after /name name=%q phone=%q (phone must be kept)", n, p)
	}
	owner.Do("POST", "/users/"+ext+"/profile", map[string]any{"full_name": "Selam B.", "phone": ""}).Expect(t, 204, "clear phone")
	if _, p := read(); p != "" {
		t.Fatalf("phone after clearing %q", p)
	}
	owner.Do("POST", "/users/"+ext+"/profile", map[string]any{"full_name": "   "}).Expect(t, 400, "blank name")
	owner.Do("POST", "/users/"+ext+"/profile", map[string]any{"full_name": "Ok", "phone": "123"}).Expect(t, 400, "bad phone")
	owner.Do("POST", "/users/"+ext+"/profile", "not an object").Expect(t, 400, "malformed body")
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, uuid.New())+"/profile", map[string]any{"full_name": "Ghost"}).Expect(t, 404, "unknown user")
	owner.Do("POST", "/users/bad/profile", map[string]any{"full_name": "Ghost"}).Expect(t, 404, "malformed id")
	srv.As(t, c, "receptionist").Do("POST", "/users/"+ext+"/profile", map[string]any{"full_name": "Hijack"}).Expect(t, 403, "receptionist edits staff")

	bNurse := clinicB.Staff["nurse"]
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, bNurse.ID)+"/profile", map[string]any{"full_name": "Stolen"}).Expect(t, 404, "edit another clinic's user")
	var bName string
	one(t, `SELECT full_name FROM users WHERE id = $1`, &bName, bNurse.ID)
	if bName == "Stolen" {
		t.Fatalf("CROSS-CLINIC WRITE: clinic B's nurse renamed by another clinic")
	}
}

// ---- the signed-in user's own account --------------------------------------------------

// TestREG_USER_011_ChangeOwnEmail: Given a signed-in nurse, When they change their
// email with the wrong password, Then 403 WRONG_PASSWORD; to a malformed email, 400; to
// a colleague's email, 409 EMAIL_TAKEN; with the right password, Then 204, they sign in
// with the new address (stored lower-case) and no longer with the old one.
func TestREG_USER_011_ChangeOwnEmail(t *testing.T) {
	c := newClinic(t)
	nurse := srv.As(t, c, "nurse")
	if r := nurse.Do("POST", "/auth/email", map[string]any{"new_email": "n2@" + c.Slug + ".test", "current_password": "wrong-password"}); r.Status != 403 || r.Code != "WRONG_PASSWORD" {
		t.Fatalf("wrong password: %d %s", r.Status, r.Code)
	}
	nurse.Do("POST", "/auth/email", map[string]any{"new_email": "nope", "current_password": testkit.StaffPassword}).Expect(t, 400, "malformed email")
	nurse.Do("POST", "/auth/email", map[string]any{"new_email": "n2@" + c.Slug + ".test"}).Expect(t, 400, "no password")
	if r := nurse.Do("POST", "/auth/email", map[string]any{"new_email": c.Staff["doctor"].Email, "current_password": testkit.StaffPassword}); r.Status != 409 || r.Code != "EMAIL_TAKEN" {
		t.Fatalf("colleague's email: %d %s", r.Status, r.Code)
	}
	next := "Nurse.Two@" + c.Slug + ".test"
	nurse.Do("POST", "/auth/email", map[string]any{"new_email": next, "current_password": testkit.StaffPassword}).Expect(t, 204, "change email")
	var stored string
	one(t, `SELECT email FROM users WHERE id = $1`, &stored, c.Staff["nurse"].ID)
	if stored != strings.ToLower(next) {
		t.Fatalf("stored email %q", stored)
	}
	if r := authLogin(t, c.Slug, c.Staff["nurse"].Email, testkit.StaffPassword); r.Status == 200 {
		t.Fatalf("old email still signs in")
	}
	if r := authLogin(t, c.Slug, strings.ToLower(next), testkit.StaffPassword); r.Status != 200 {
		t.Fatalf("new email does not sign in: %d", r.Status)
	}
	srv.Anon(t).Do("POST", "/auth/email", map[string]any{"new_email": next, "current_password": "x"}).Expect(t, 401, "anonymous change email")
}

// TestREG_USER_012_SecondFactorChallengeAndVerify: Given a receptionist with a second
// factor on their account, When they sign in with the right password, Then no tokens
// are issued, only an MFA challenge; a wrong code, a garbage challenge and a missing
// field are refused; the right TOTP code signs them in. A challenge for an account
// without a second factor is refused.
func TestREG_USER_012_SecondFactorChallengeAndVerify(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	key, err := auth.GenerateTOTPSecret("ClinicOS", st.Email)
	if err != nil {
		t.Fatal(err)
	}
	encKey, _ := base64.StdEncoding.DecodeString(base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	enc, err := auth.EncryptSecret(encKey, key.Secret())
	if err != nil {
		t.Fatal(err)
	}
	opExec(t, `UPDATE users SET mfa_enabled = true, mfa_secret = $2 WHERE id = $1`, st.ID, enc)

	r := srv.Anon(t).Do("POST", "/auth/login", map[string]any{"workspace": c.Slug, "email": st.Email, "password": testkit.StaffPassword}).Expect(t, 200, "password step")
	var ch struct {
		MFARequired bool   `json:"mfa_required"`
		MFAToken    string `json:"mfa_token"`
		AccessToken string `json:"access_token"`
	}
	r.Decode(t, &ch)
	if !ch.MFARequired || ch.MFAToken == "" || ch.AccessToken != "" {
		t.Fatalf("login with a second factor: %+v", ch)
	}
	if x := authPost(t, "/auth/mfa", map[string]any{"mfa_token": ch.MFAToken, "code": "000000"}, "", ""); x.Status != 401 || x.Access != "" {
		t.Fatalf("wrong code: %d", x.Status)
	}
	if x := authPost(t, "/auth/mfa", map[string]any{"mfa_token": "garbage", "code": "123456"}, "", ""); x.Status != 401 {
		t.Fatalf("garbage challenge: %d", x.Status)
	}
	if x := authPost(t, "/auth/mfa", map[string]any{"mfa_token": ch.MFAToken}, "", ""); x.Status != 400 {
		t.Fatalf("no code: %d", x.Status)
	}
	// An ACCESS token is not an MFA challenge.
	if x := authPost(t, "/auth/mfa", map[string]any{"mfa_token": srv.As(t, c, "nurse").Token, "code": "123456"}, "", ""); x.Status != 401 {
		t.Fatalf("access token used as a challenge: %d", x.Status)
	}
	code, err := totp.GenerateCode(key.Secret(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ok := authPost(t, "/auth/mfa", map[string]any{"mfa_token": ch.MFAToken, "code": " " + code + " "}, "", "")
	if ok.Status != 200 || ok.Access == "" || ok.Refresh == "" {
		t.Fatalf("right code: %d %s", ok.Status, trimAuth(ok.Raw))
	}
	if me := opWhoAmI(t, authBearer(t, ok.Access)); me.User.Email != st.Email {
		t.Fatalf("signed in as %q", me.User.Email)
	}

	// A challenge minted for a user without a second factor, or for no such user.
	ts := auth.NewTokenService([]byte(authJWTSecret), authJWTIssuer, time.Minute)
	plain, _ := ts.IssueMFAChallenge(c.Staff["nurse"].ID, c.TenantID, c.Staff["nurse"].Email)
	if x := authPost(t, "/auth/mfa", map[string]any{"mfa_token": plain, "code": code}, "", ""); x.Status != 401 {
		t.Fatalf("challenge for an account without MFA: %d", x.Status)
	}
	ghost, _ := ts.IssueMFAChallenge(uuid.New(), c.TenantID, "ghost@"+c.Slug+".test")
	if x := authPost(t, "/auth/mfa", map[string]any{"mfa_token": ghost, "code": code}, "", ""); x.Status != 401 {
		t.Fatalf("challenge for no such user: %d", x.Status)
	}
}

// TestREG_USER_013_SwitchBranchReissuesTheToken: Given the owner (clinic-wide) and a
// second branch, When they switch to it, Then the new token's active branch is that
// branch and a refresh stays there; "all" gives the consolidated view; an unknown or
// another clinic's branch is 403 and a malformed id 400.
func TestREG_USER_013_SwitchBranchReissuesTheToken(t *testing.T) {
	c := newClinic(t)
	ownerLogin := authMustLogin(t, c, c.Owner.Email)
	owner := authBearer(t, ownerLogin.Access)
	second := opNewBranch(t, owner, "Megenagna", "MEG")

	r := authPost(t, "/auth/switch-branch", map[string]any{"branch_id": second.ID}, ownerLogin.Refresh, ownerLogin.Access)
	if r.Status != 200 || r.Access == "" {
		t.Fatalf("switch to second branch: %d %s", r.Status, trimAuth(r.Raw))
	}
	if me := opWhoAmI(t, authBearer(t, r.Access)); me.ActiveBranchID == nil || *me.ActiveBranchID != second.ID || !me.AllBranches {
		t.Fatalf("after switch: %+v", me)
	}
	ref := authRefresh(t, ownerLogin.Refresh)
	if ref.Status != 200 {
		t.Fatalf("refresh after switch: %d", ref.Status)
	}
	if me := opWhoAmI(t, authBearer(t, ref.Access)); me.ActiveBranchID == nil || *me.ActiveBranchID != second.ID {
		t.Fatalf("refresh did not stay on the switched branch: %+v", me.ActiveBranchID)
	}

	all := authPost(t, "/auth/switch-branch", map[string]any{"branch_id": "all"}, "", ownerLogin.Access)
	if all.Status != 200 {
		t.Fatalf("switch to all branches: %d", all.Status)
	}
	if me := opWhoAmI(t, authBearer(t, all.Access)); me.ActiveBranchID != nil {
		t.Fatalf("all-branches view still has active branch %v", *me.ActiveBranchID)
	}
	owner.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": "brn_nope"}).Expect(t, 400, "malformed branch")
	owner.Do("POST", "/auth/switch-branch", "x").Expect(t, 400, "malformed body")
	if x := owner.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": opBranch(clinicB)}); x.Status != 403 {
		t.Fatalf("switch to another clinic's branch: %d", x.Status)
	}
	if x := owner.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": id.Encode(id.PrefixBranch, uuid.New())}); x.Status != 403 {
		t.Fatalf("switch to an unknown branch: %d", x.Status)
	}
}

// TestREG_USER_014_ResetLinkRules: Given staff members, When the owner issues a reset
// link for an active one, Then a single-use link comes back; for a suspended one, Then
// 400 (reactivating is a separate decision); for an unknown user 404 and a malformed id
// 400; the receptionist cannot issue one.
func TestREG_USER_014_ResetLinkRules(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	var inv opInvite
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, c.Staff["doctor"].ID)+"/reset-link", nil).Expect(t, 201, "reset link").Decode(t, &inv)
	if inv.Email != c.Staff["doctor"].Email || opInviteToken(t, inv.InviteLink) == "" {
		t.Fatalf("reset link %+v", inv)
	}
	authSetStatus(t, owner, c.Staff["nurse"].ID, "suspended")
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, c.Staff["nurse"].ID)+"/reset-link", nil).Expect(t, 400, "reset a suspended account")
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, uuid.New())+"/reset-link", nil).Expect(t, 404, "reset unknown user")
	owner.Do("POST", "/users/usr_bad/reset-link", nil).Expect(t, 400, "reset malformed id")
	srv.As(t, c, "receptionist").Do("POST", "/users/"+id.Encode(id.PrefixUser, c.Staff["doctor"].ID)+"/reset-link", nil).Expect(t, 403, "desk issues reset")
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, clinicB.Staff["doctor"].ID)+"/reset-link", nil).Expect(t, 404, "reset another clinic's user")
}

// TestREG_USER_015_RemovedBranchFallsBackToTheClinicView: Given the owner switched to a
// second branch, When that branch is deleted, Then /auth/me with the same token no
// longer claims it as active (the consolidated view), and the owner cannot delete their
// own account.
func TestREG_USER_015_RemovedBranchFallsBackToTheClinicView(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	second := opNewBranch(t, owner, "Short Lived", "SHL")
	sw := owner.Do("POST", "/auth/switch-branch", map[string]any{"branch_id": second.ID}).Expect(t, 200, "switch")
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	sw.Decode(t, &tok)
	owner.Do("DELETE", "/org/branches/"+second.ID, nil).Expect(t, 204, "delete branch")
	me := opWhoAmI(t, authBearer(t, tok.AccessToken))
	if me.ActiveBranchID != nil {
		t.Fatalf("me still reports deleted branch %s as active", *me.ActiveBranchID)
	}
	owner.Do("DELETE", "/users/"+id.Encode(id.PrefixUser, c.Owner.ID), nil).Expect(t, 400, "owner deletes self")
	owner.Do("DELETE", "/users/usr_bad", nil).Expect(t, 404, "delete malformed id")
}

// TestREG_USER_016_AccountsWithoutAPasswordOrRowAreRefusedCleanly: Given a validly
// signed token for an invited member who has not set a password yet, When they try to
// change their password or email, Then 400 (there is no current password to confirm);
// Given a token for a user that does not exist, Then the same calls and /auth/me are
// 404 or 401 — never a 500.
func TestREG_USER_016_AccountsWithoutAPasswordOrRowAreRefusedCleanly(t *testing.T) {
	c := newClinic(t)
	inv := opInviteUser(t, srv.As(t, c, "owner"), "nopass@"+c.Slug+".test", []string{"nurse"}, nil)
	ts := auth.NewTokenService([]byte(authJWTSecret), authJWTIssuer, time.Minute)
	mint := func(uid uuid.UUID, email string) *testkit.Client {
		tok, _, err := ts.IssueAccess(uid, c.TenantID, email, []string{"nurse"}, []string{"patient.read"}, map[string]bool{}, nil, c.BranchID.String())
		if err != nil {
			t.Fatal(err)
		}
		return authBearer(t, tok)
	}
	invited := mint(opUUID(t, id.PrefixUser, inv.ID), inv.Email)
	invited.Do("POST", "/auth/password", map[string]any{"current_password": "whatever1", "new_password": "Brand#New2026"}).Expect(t, 400, "password change without a password")
	invited.Do("POST", "/auth/email", map[string]any{"new_email": "x@" + c.Slug + ".test", "current_password": "whatever1"}).Expect(t, 400, "email change without a password")

	ghost := mint(uuid.New(), "ghost@"+c.Slug+".test")
	for _, call := range []struct {
		m, p string
		body any
	}{
		{"POST", "/auth/password", map[string]any{"current_password": "whatever1", "new_password": "Brand#New2026"}},
		{"POST", "/auth/email", map[string]any{"new_email": "y@" + c.Slug + ".test", "current_password": "whatever1"}},
		{"GET", "/auth/me", nil},
	} {
		if r := ghost.Do(call.m, call.p, call.body); r.Status != 404 && r.Status != 401 {
			t.Errorf("%s %s for a user that does not exist: %d %s", call.m, call.p, r.Status, r.Code)
		}
	}
}
