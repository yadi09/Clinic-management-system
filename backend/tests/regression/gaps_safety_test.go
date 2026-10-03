package regression

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/messaging"
	"github.com/reicb/clinicsaas/internal/messaging/dispatch"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Safety gaps found by the 2026-10-02 audit that no test covered yet: a suspended
// clinic, deleting a patient (audit trail, debt, SMS), the last owner, holes in the
// role matrix, the live-queue stream's permission, a booking with a dentist who has
// left, and error codes that were never asserted. Everything that changes state runs
// in newClinic(t).

// ---- helpers (prefixed gs) ------------------------------------------------------

// gsSuspend switches a clinic off the way the vendor console does
// (platform/service SetClinicStatus is exactly this UPDATE).
func gsSuspend(t *testing.T, c *testkit.Clinic) {
	t.Helper()
	xcExec(t, `UPDATE tenants SET status = 'suspended', updated_at = now() WHERE id = $1`, c.TenantID)
}

// gsExpect asserts status and error code together.
func gsExpect(t *testing.T, r testkit.Resp, status int, code, what string) {
	t.Helper()
	if r.Status != status || r.Code != code {
		t.Fatalf("%s: want HTTP %d %s, got %d %s\n%s", what, status, code, r.Status, r.Code, trimAuth(r.Raw))
	}
}

// gsAcceptInvite invites someone with these roles and accepts the invitation;
// returns their client and user id.
func gsAcceptInvite(t *testing.T, c *testkit.Clinic, roles ...string) (*testkit.Client, uuid.UUID) {
	t.Helper()
	inv := opInviteUser(t, srv.As(t, c, "owner"), uniq("adm")+"@"+c.Slug+".test", roles, nil)
	acc := authPost(t, "/auth/accept-invite", map[string]any{"token": opInviteToken(t, inv.InviteLink), "password": "Welcome#2026"}, "", "")
	if acc.Status != 200 || acc.Access == "" {
		t.Fatalf("accept invitation: HTTP %d %s", acc.Status, trimAuth(acc.Raw))
	}
	return authBearer(t, acc.Access), opUUID(t, id.PrefixUser, inv.ID)
}

// gsOwnerState is what the database says about the clinic's owner account.
func gsOwnerState(t *testing.T, c *testkit.Clinic) (roles, status string, deleted bool) {
	t.Helper()
	roles = opRoleCodes(t, c.TenantID, c.Owner.ID)
	one(t, `SELECT status FROM users WHERE id = $1`, &status, c.Owner.ID)
	one(t, `SELECT deleted_at IS NOT NULL FROM users WHERE id = $1`, &deleted, c.Owner.ID)
	return
}

// gsStream opens the live-queue stream and returns its status and error code (the
// connection is dropped straight away).
func gsStream(t *testing.T, token string) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.BaseURL+"/queue/stream?token="+url.QueryEscape(token), nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	defer res.Body.Close()
	code := ""
	if res.StatusCode != 200 {
		raw, _ := io.ReadAll(res.Body)
		var env struct {
			Error *struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Error != nil {
			code = env.Error.Code
		}
	}
	return res.StatusCode, code
}

// ---- REG_AUTH: a suspended clinic (SEC-10) ------------------------------------------

// TestREG_AUTH_020_SuspendedClinicCannotSignIn: Given a clinic the vendor has
// suspended, When its receptionist signs in with the right password, Then 403
// TENANT_INACTIVE, no token, and no session row is created.
func TestREG_AUTH_020_SuspendedClinicCannotSignIn(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	gsSuspend(t, c)
	r := authLogin(t, c.Slug, st.Email, testkit.StaffPassword)
	if r.Status != 403 || r.Code != "TENANT_INACTIVE" || r.Access != "" || r.Refresh != "" {
		t.Fatalf("sign-in to a suspended clinic: HTTP %d %s access=%t refresh=%t", r.Status, r.Code, r.Access != "", r.Refresh != "")
	}
	if n := authLiveSessions(t, st.ID); n != 0 {
		t.Fatalf("a refused sign-in left %d live session(s)", n)
	}
	// Reactivated, the same login works again: the refusal was the suspension.
	xcExec(t, `UPDATE tenants SET status = 'active' WHERE id = $1`, c.TenantID)
	authMustLogin(t, c, st.Email)
}

// TestREG_AUTH_021_SuspendedClinicRefreshIsRefused: Given a receptionist signed in
// before her clinic was suspended, When her browser presents the refresh token, Then
// 401 and no new session is issued. SEC-10: Refresh never reads the clinic's status,
// so a suspended clinic stays signed in for the whole refresh lifetime.
func TestREG_AUTH_021_SuspendedClinicRefreshIsRefused(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	sess := authMustLogin(t, c, st.Email)
	gsSuspend(t, c)
	r := authRefresh(t, sess.Refresh)
	testkit.KnownBug(t, "SEC-10", r.Status == 200 || r.Access != "", fmt.Sprintf(
		"refresh for a suspended clinic answered %d with a new access token=%t: AuthService.Refresh "+
			"(identity/service/auth_service.go) never checks tenants.status", r.Status, r.Access != ""))
	if r.Status != 401 {
		t.Fatalf("refresh for a suspended clinic: HTTP %d %s, want 401", r.Status, r.Code)
	}
}

// TestREG_AUTH_022_SuspendedClinicAccessTokenStopsWorking: Given a receptionist with
// a live access token, When her clinic is suspended and she searches patients, Then
// the API refuses (401 or 403). SEC-10: the access token is checked only for its
// signature, so a suspended clinic keeps reading patient records until it expires.
func TestREG_AUTH_022_SuspendedClinicAccessTokenStopsWorking(t *testing.T) {
	c := newClinic(t)
	desk := srv.As(t, c, "receptionist")
	desk.Do("GET", "/patients?q=zz", nil).Expect(t, 200, "search before suspension")
	gsSuspend(t, c)
	r := desk.Do("GET", "/patients?q=zz", nil)
	testkit.KnownBug(t, "SEC-10", r.Status == 200, fmt.Sprintf(
		"a suspended clinic's access token still searches patients (HTTP %d): RequireAuth trusts the JWT "+
			"alone and never consults tenants.status", r.Status))
	if r.Status != 401 && r.Status != 403 {
		t.Fatalf("suspended clinic's token: HTTP %d %s, want 401/403", r.Status, r.Code)
	}
}

// ---- REG_PATIENT: deleting a patient --------------------------------------------------

// TestREG_PATIENT_046_DeletingAPatientIsAudited: Given a registered patient, When the
// receptionist deletes the record and the worker runs, Then the clinic's audit trail
// holds an entry for that patient other than the registration, naming her.
// NEW-AUDIT-3: patient Service.Delete publishes no event, so removing a record
// leaves no trace of who did it.
func TestREG_PATIENT_046_DeletingAPatientIsAudited(t *testing.T) {
	c := newClinic(t)
	desk := srv.As(t, c, "receptionist")
	p := createPatient(t, desk, uniq("Audit"), "Deleted")
	pid := patUUID(t, p.ID)
	desk.Do("DELETE", "/patients/"+p.ID, nil).Expect(t, 204, "delete patient")
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM patients WHERE id = $1`, &deleted, pid)
	if !deleted {
		t.Fatalf("patient not soft-deleted")
	}
	xcDrainAudit(t, c.TenantID)
	var n int
	one(t, `SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND target_id = $2
	          AND action <> 'patient.patient.registered' AND actor_id = $3`, &n, c.TenantID, pid, c.Staff["receptionist"].ID)
	testkit.KnownBug(t, "NEW-AUDIT-3", n == 0,
		"DELETE /patients/:id leaves no audit entry: patient/service/service.go Delete publishes no event")
}

// TestREG_PATIENT_047_DeletingADebtorKeepsTheDebtVisible: Given a patient with a 400
// ETB charge waiting at the cashier (Finance lists them as owing 400), When the
// receptionist deletes the patient, Then either the delete is refused (4xx, record
// kept) or Finance still reports the 400 owed. NEW-PAT-7: the delete succeeds and the
// debt silently disappears from receivables.
func TestREG_PATIENT_047_DeletingADebtorKeepsTheDebtVisible(t *testing.T) {
	c := payClinic(t)
	desk, owner := srv.As(t, c, "receptionist"), srv.As(t, c, "owner")
	p := createPatient(t, desk, uniq("Debtor"), "Owes")
	ch := payRaise(t, desk, c, p.ID, 400)
	if got := payOwedIn(payGetReceivables(t, owner), p.ID); !payEq(payNum(t, got), 400) {
		t.Fatalf("receivables before delete: owed %q, want 400", got)
	}
	r := desk.Do("DELETE", "/patients/"+p.ID, nil)
	var chStatus string
	one(t, `SELECT status FROM charges WHERE id = $1`, &chStatus, payChargeUUID(t, c, ch))
	if chStatus != "pending" {
		t.Fatalf("deleting the patient changed the charge to %q", chStatus)
	}
	if r.Status >= 400 && r.Status < 500 {
		var deleted bool
		one(t, `SELECT deleted_at IS NOT NULL FROM patients WHERE id = $1`, &deleted, patUUID(t, p.ID))
		if deleted {
			t.Fatalf("delete answered %d but the patient was deleted anyway", r.Status)
		}
		return
	}
	if r.Status != 204 {
		t.Fatalf("delete a debtor: HTTP %d %s", r.Status, r.Code)
	}
	got := payOwedIn(payGetReceivables(t, owner), p.ID)
	testkit.KnownBug(t, "NEW-PAT-7", got == "" || !payEq(payNum(t, got), 400), fmt.Sprintf(
		"a receptionist deleted a patient owing 400 (HTTP %d) and receivables now reports %q for them: "+
			"Delete has no debt check and receivables drops deleted patients", r.Status, got))
}

// TestREG_PATIENT_048_DeletedPatientGetsNoReminder: Given a dental clinic with SMS
// on and visit reminders enabled, and two patients each with a visit due today, When
// one patient is deleted and the reminder planner runs, Then the live patient has a
// reminder queued and the deleted one has none.
func TestREG_PATIENT_048_DeletedPatientGetsNoReminder(t *testing.T) {
	c := msgClinic(t)
	owner, desk, doc := srv.As(t, c, "owner"), srv.As(t, c, "receptionist"), srv.As(t, c, "doctor")
	msgOn(t, c, "en")
	owner.Do("PUT", "/messaging/templates", map[string]any{
		"kind": messaging.KindAppointment, "lang": "en", "body": "Hi {{name}}, your visit is on {{date}}"}).Expect(t, 204, "wording")
	owner.Do("PUT", "/messaging/rules", map[string]any{"kind": messaging.KindAppointment, "enabled": true,
		"offset_hours": -24, "send_at": "", "repeat_days": 0, "max_repeats": 0}).Expect(t, 204, "reminder rule on")
	live := msgPatient(t, desk, uniq("Live"), msgPhone())
	gone := msgPatient(t, desk, uniq("Gone"), msgPhone())
	createPlan(t, doc, live.ID, "1000", 1, "")
	createPlan(t, doc, gone.ID, "1000", 1, "")
	desk.Do("DELETE", "/patients/"+gone.ID, nil).Expect(t, 204, "delete patient")

	pl := dispatch.NewPlanner(super, 0.5, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := pl.PlanDentalAppointments(t.Context()); err != nil {
		t.Fatalf("plan dental reminders: %v", err)
	}
	if _, err := pl.PlanAppointments(t.Context()); err != nil {
		t.Fatalf("plan reminders: %v", err)
	}
	count := func(p patientRef) int {
		var n int
		one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1 AND patient_id = $2 AND kind = $3`,
			&n, c.TenantID, patUUID(t, p.ID), messaging.KindAppointment)
		return n
	}
	if n := count(live); n != 1 {
		t.Fatalf("live patient: %d reminders queued, want 1 (the control: planner did not run as expected)", n)
	}
	if n := count(gone); n != 0 {
		t.Fatalf("a deleted patient was queued %d reminder(s)", n)
	}
}

// TestREG_PATIENT_049_SameNationalIDIsAConflict: Given a patient registered with a
// national ID, When another patient is registered with the same national ID (past the
// duplicate prompt), Then 409 PATIENT_CONFLICT and only one live record holds it.
func TestREG_PATIENT_049_SameNationalIDIsAConflict(t *testing.T) {
	c := newClinic(t)
	desk := srv.As(t, c, "receptionist")
	nid := "ET" + uuid.NewString()[:10]
	patCreate(t, desk, map[string]any{"first_name": uniq("Nid"), "last_name": "One", "phone": patPhone(), "national_id": nid, "force": true})
	r := desk.Do("POST", "/patients", map[string]any{"first_name": uniq("Nid"), "last_name": "Two", "phone": patPhone(), "national_id": nid, "force": true})
	gsExpect(t, r, 409, "PATIENT_CONFLICT", "second patient with the same national id")
	var n int
	one(t, `SELECT count(*) FROM patients WHERE tenant_id = $1 AND national_id = $2 AND deleted_at IS NULL`, &n, c.TenantID, nid)
	if n != 1 {
		t.Fatalf("%d live patients hold national id %s, want 1", n, nid)
	}
}

// ---- REG_USER: the last owner -------------------------------------------------------

// TestREG_USER_017_OwnerCannotRemoveTheirOwnOwnership: Given a clinic whose only
// owner is signed in, When she replaces her own roles with none, or with receptionist,
// Then the API refuses (400/409) and she is still the owner. NEW-USER-1: AssignRoles
// has no last-owner guard, so the clinic can lose its only administrator.
func TestREG_USER_017_OwnerCannotRemoveTheirOwnOwnership(t *testing.T) {
	for name, roles := range map[string][]string{"no roles": {}, "receptionist": {"receptionist"}} {
		t.Run(name, func(t *testing.T) {
			c := newClinic(t)
			r := srv.As(t, c, "owner").Do("PUT", "/users/"+id.Encode(id.PrefixUser, c.Owner.ID)+"/roles", map[string]any{"roles": roles})
			got, _, _ := gsOwnerState(t, c)
			testkit.KnownBug(t, "NEW-USER-1", r.Status < 300 || got != "tenant_owner", fmt.Sprintf(
				"the only owner set her own roles to %v: HTTP %d, roles now %q (identity/service/user_service.go "+
					"AssignRoles has no last-owner guard)", roles, r.Status, got))
			opStatus(t, r, "owner removes her own ownership", 400, 409)
		})
	}
}

// TestREG_USER_018_ClinicAdminCannotRemoveTheOnlyOwner: Given a clinic administrator
// and a clinic with exactly one owner, When the administrator demotes, deactivates or
// deletes the owner, Then 400/409 and the owner keeps her role, stays active and is
// not deleted. NEW-USER-1: none of the three is guarded.
func TestREG_USER_018_ClinicAdminCannotRemoveTheOnlyOwner(t *testing.T) {
	acts := map[string]func(admin *testkit.Client, owner string) testkit.Resp{
		"demote": func(a *testkit.Client, o string) testkit.Resp {
			return a.Do("PUT", "/users/"+o+"/roles", map[string]any{"roles": []string{"receptionist"}})
		},
		"deactivate": func(a *testkit.Client, o string) testkit.Resp {
			return a.Do("POST", "/users/"+o+"/status", map[string]any{"status": "deactivated"})
		},
		"delete": func(a *testkit.Client, o string) testkit.Resp { return a.Do("DELETE", "/users/"+o, nil) },
	}
	for name, act := range acts {
		t.Run(name, func(t *testing.T) {
			c := newClinic(t)
			admin, _ := gsAcceptInvite(t, c, "clinic_admin")
			r := act(admin, id.Encode(id.PrefixUser, c.Owner.ID))
			if r.Status == 403 && r.Code == "FORBIDDEN_PERMISSION" {
				t.Fatalf("the clinic administrator lacks the permission to %s staff at all: the test arrangement is wrong", name)
			}
			roles, status, deleted := gsOwnerState(t, c)
			changed := roles != "tenant_owner" || status != "active" || deleted
			testkit.KnownBug(t, "NEW-USER-1", r.Status < 300 || changed, fmt.Sprintf(
				"a clinic admin could %s the only owner: HTTP %d, owner now roles=%q status=%s deleted=%v",
				name, r.Status, roles, status, deleted))
			opStatus(t, r, "admin "+name+"s the only owner", 400, 409)
		})
	}
}

// ---- REG_AUTHZ: holes in the role matrix ----------------------------------------------

// TestREG_AUTHZ_005_DentalMoneyImagesAndPatientDeleteMatrix: Given a dental clinic
// with one user per role, When each calls pay-later, reprice, delete a dental image
// (all dental.manage: the dentist) or delete a patient (patient.update: reception and
// branch manager), Then roles outside provision.RoleGrants are refused 403
// FORBIDDEN_PERMISSION, in particular the cashier repricing, and the nurse and the
// cashier deleting a patient; the rest reach the handler.
func TestREG_AUTHZ_005_DentalMoneyImagesAndPatientDeleteMatrix(t *testing.T) {
	roles := append([]string{"owner"}, testkit.Roles...)
	clients := map[string]*testkit.Client{}
	for _, r := range roles {
		clients[r] = srv.As(t, clinicA, r)
	}
	pat := "pat_fake"
	rows := []struct {
		name, method, path string
		allow              []string
	}{
		{"dental pay-later (dental.manage)", "POST", "/dental/patients/" + pat + "/sessions/tss_fake/pay-later", []string{"doctor"}},
		{"dental reprice (dental.manage)", "POST", "/dental/patients/" + pat + "/sessions/tss_fake/reprice", []string{"doctor"}},
		{"dental image delete (dental.manage)", "DELETE", "/dental/patients/" + pat + "/images/att_fake", []string{"doctor"}},
		{"patient delete (patient.update)", "DELETE", "/patients/" + pat, []string{"receptionist", "branch_manager"}},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			allow := map[string]bool{"owner": true}
			for _, a := range row.allow {
				allow[a] = true
			}
			for _, role := range roles {
				r := clients[role].Do(row.method, row.path, map[string]any{})
				switch {
				case allow[role] && !authAllowed(r):
					t.Errorf("%s should be allowed: HTTP %d %s", role, r.Status, r.Code)
				case !allow[role] && (r.Status != 403 || r.Code != "FORBIDDEN_PERMISSION"):
					t.Errorf("%s should be refused 403 FORBIDDEN_PERMISSION: HTTP %d %s %s", role, r.Status, r.Code, trimAuth(r.Raw))
				case r.Status >= 500:
					t.Errorf("%s: gate passed but handler answered %d: %s", role, r.Status, trimAuth(r.Raw))
				}
			}
		})
	}
	// A refused delete changes nothing: the nurse and the cashier against a real patient.
	p := createPatient(t, clients["receptionist"], uniq("Keep"), "Me")
	for _, role := range []string{"nurse", "cashier", "doctor"} {
		gsExpect(t, clients[role].Do("DELETE", "/patients/"+p.ID, nil), 403, "FORBIDDEN_PERMISSION", role+" deletes a patient")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM patients WHERE id = $1`, &deleted, patUUID(t, p.ID))
	if deleted {
		t.Fatalf("a refused role deleted the patient")
	}
}

// ---- REG_STREAM: the stream follows the queue permission (SEC-8) ----------------------

// TestREG_STREAM_005_CashierCannotWatchTheLiveQueue: Given a cashier, who may not
// open the queue board (GET /queue is queue.manage), When she opens the live queue
// stream with a valid token, Then 403 FORBIDDEN_PERMISSION, while the receptionist
// (queue.manage) still connects. SEC-8: the stream needs only a valid login.
func TestREG_STREAM_005_CashierCannotWatchTheLiveQueue(t *testing.T) {
	cashier := srv.As(t, clinicA, "cashier")
	gsExpect(t, cashier.Do("GET", "/queue", nil), 403, "FORBIDDEN_PERMISSION", "cashier opens the queue board")
	if st, code := gsStream(t, srv.As(t, clinicA, "receptionist").Token); st != 200 {
		t.Fatalf("receptionist stream: HTTP %d %s, want 200", st, code)
	}
	st, code := gsStream(t, cashier.Token)
	testkit.KnownBug(t, "SEC-8", st == 200, fmt.Sprintf(
		"a cashier opened the live queue stream (HTTP %d): GET /queue/stream is mounted with RequireAuthQuery "+
			"only (cmd/api/main.go), no queue.manage check", st))
	if st != 403 || code != "FORBIDDEN_PERMISSION" {
		t.Fatalf("cashier stream: HTTP %d %s, want 403 FORBIDDEN_PERMISSION", st, code)
	}
}

// ---- REG_APPT: a booking with a dentist who has left (APT-7) --------------------------

// TestREG_APPT_030_CheckInForADeactivatedDentistIsNotRoutedToThem: Given a booking
// with a dentist the owner has since deactivated, When the desk checks the patient
// in, Then the API either refuses (4xx, no queue entry) or routes the patient to
// someone who can see them (the queue entry is not assigned to the deactivated
// dentist). APT-7: CheckIn copies appt.ProviderID onto the queue entry unchecked, so
// the patient waits for nobody.
func TestREG_APPT_030_CheckInForADeactivatedDentistIsNotRoutedToThem(t *testing.T) {
	e := apptNewEnv(t)
	a := e.book(t, e.patient(t).ID, time.Now().Add(-time.Minute), 30)
	authSetStatus(t, srv.As(t, e.c, "owner"), e.c.Staff["doctor"].ID, "deactivated")
	r := e.checkIn(t, a.ID)
	n := apptQueueCount(t, a.ID)
	if r.Status >= 400 && r.Status < 500 {
		if n != 0 {
			t.Fatalf("check-in refused (%d) but %d queue entries exist", r.Status, n)
		}
		return
	}
	if r.Status != 200 || n != 1 {
		t.Fatalf("check-in: HTTP %d %s, %d queue entries", r.Status, r.Code, n)
	}
	var assigned *uuid.UUID
	one(t, `SELECT assigned_provider_id FROM queue_entries WHERE appointment_id = $1`, &assigned, apptUUID(t, a.ID))
	toLeaver := assigned != nil && *assigned == e.c.Staff["doctor"].ID
	testkit.KnownBug(t, "APT-7", toLeaver,
		"a booking with a deactivated dentist checks in and is queued for that dentist "+
			"(scheduling/service/service.go CheckIn copies appt.ProviderID without checking the user is active)")
}

// ---- REG_ORG: unasserted not-found codes -----------------------------------------------

// TestREG_ORG_022_UnknownPaymentRailIsRailNotFound: Given a payment-rail id the
// clinic does not have, When the owner edits or deletes it, Then 404 RAIL_NOT_FOUND
// and no rail is created.
func TestREG_ORG_022_UnknownPaymentRailIsRailNotFound(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	var before int
	one(t, `SELECT count(*) FROM payment_rails WHERE tenant_id = $1`, &before, c.TenantID)
	ghost := id.Encode(id.PrefixPaymentRail, uuid.New())
	gsExpect(t, owner.Do("PUT", "/org/payment-rails/"+ghost, map[string]any{"label": "Ghost", "kind": "cash"}),
		404, "RAIL_NOT_FOUND", "edit an unknown rail")
	gsExpect(t, owner.Do("DELETE", "/org/payment-rails/"+ghost, nil), 404, "RAIL_NOT_FOUND", "delete an unknown rail")
	var after int
	one(t, `SELECT count(*) FROM payment_rails WHERE tenant_id = $1`, &after, c.TenantID)
	if after != before {
		t.Fatalf("rails %d -> %d after edits of an unknown id", before, after)
	}
}

// TestREG_ORG_023_UnknownBranchIsBranchNotFound: Given a branch id the clinic does
// not have, When the owner renames it, Then 404 BRANCH_NOT_FOUND and no branch is
// created or renamed.
func TestREG_ORG_023_UnknownBranchIsBranchNotFound(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	ghost := id.Encode(id.PrefixBranch, uuid.New())
	gsExpect(t, owner.Do("PUT", "/org/branches/"+ghost, map[string]any{"name": "Ghost", "code": "GHO"}),
		404, "BRANCH_NOT_FOUND", "rename an unknown branch")
	var n int
	one(t, `SELECT count(*) FROM branches WHERE tenant_id = $1 AND (name = 'Ghost' OR code = 'GHO')`, &n, c.TenantID)
	if n != 0 {
		t.Fatalf("editing an unknown branch left %d Ghost branch row(s)", n)
	}
}

// TestREG_ORG_024_RemovedClinicWorkspaceIsWorkspaceNotFound: Given a clinic whose
// tenant row has been removed (soft-deleted by the vendor) while its owner still
// holds an access token, When the owner reads the workspace, Then 404
// WORKSPACE_NOT_FOUND, never another clinic's workspace.
func TestREG_ORG_024_RemovedClinicWorkspaceIsWorkspaceNotFound(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	var ws struct {
		Slug string `json:"slug"`
	}
	owner.Do("GET", "/org/workspace", nil).Expect(t, 200, "workspace").Decode(t, &ws)
	if ws.Slug != c.Slug {
		t.Fatalf("workspace slug %q, want %q", ws.Slug, c.Slug)
	}
	xcExec(t, `UPDATE tenants SET deleted_at = now() WHERE id = $1`, c.TenantID)
	gsExpect(t, owner.Do("GET", "/org/workspace", nil), 404, "WORKSPACE_NOT_FOUND", "workspace of a removed clinic")
}
