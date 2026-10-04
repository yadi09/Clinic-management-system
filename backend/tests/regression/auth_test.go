package regression

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Authentication (REG_AUTH) and authorization (REG_AUTHZ).
//
// Sign-in, the refresh-token lifecycle and the permission gates are exercised over
// HTTP against the real API. Anything that changes a user's state (lockout, status,
// password, revoked sessions) runs in a private clinic from newClinic(t), so the
// shared clinics A and B are never locked out or signed out.
//
// The refresh token is an HttpOnly cookie scoped to /api/v1/auth. Most tests carry
// it by hand (authPost) so a test can present an OLD token after rotation, which a
// cookie jar would never do; TestREG_AUTH_005 proves the browser-style jar flow works
// over plain http://127.0.0.1 too.

// The values testkit.StartAPI gives the API, so the suite can mint tokens with the
// right secret (positive control) and with the wrong one (forgery).
const (
	authJWTSecret = "regression-suite-secret-0123456789abcdef"
	authJWTIssuer = "clinicsaas" // config default (JWT_ISSUER unset)
)

// authRaw is one auth call made without a cookie jar.
type authRaw struct {
	Status  int
	Code    string
	Access  string
	Refresh string // the refresh_token the server set ("" if none or cleared)
	Raw     string
}

// authPost POSTs to the API with an optional refresh cookie and bearer token, and
// reads back the access token and any refresh cookie set.
func authPost(t *testing.T, path string, body any, refresh, bearer string) authRaw {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest("POST", srv.BaseURL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if refresh != "" {
		req.AddCookie(&http.Cookie{Name: "refresh_token", Value: refresh})
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := authRaw{Status: res.StatusCode, Raw: string(raw)}
	var env struct {
		Data struct {
			AccessToken string `json:"access_token"`
		} `json:"data"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &env) == nil {
		out.Access = env.Data.AccessToken
		if env.Error != nil {
			out.Code = env.Error.Code
		}
	}
	for _, c := range res.Cookies() {
		if c.Name == "refresh_token" && c.MaxAge >= 0 && c.Value != "" {
			out.Refresh = c.Value
		}
	}
	return out
}

// authLogin signs in by hand and returns the access token and refresh cookie.
func authLogin(t *testing.T, workspace, email, password string) authRaw {
	t.Helper()
	return authPost(t, "/auth/login", map[string]any{"workspace": workspace, "email": email, "password": password}, "", "")
}

// authMustLogin is authLogin that fails the test unless both tokens came back.
func authMustLogin(t *testing.T, c *testkit.Clinic, email string) authRaw {
	t.Helper()
	r := authLogin(t, c.Slug, email, testkit.StaffPassword)
	if r.Status != 200 || r.Access == "" || r.Refresh == "" {
		t.Fatalf("login %s: HTTP %d %s access=%t refresh=%t\n%s", email, r.Status, r.Code, r.Access != "", r.Refresh != "", trimAuth(r.Raw))
	}
	return r
}

// authRefresh presents a refresh token.
func authRefresh(t *testing.T, refresh string) authRaw {
	t.Helper()
	return authPost(t, "/auth/refresh", nil, refresh, "")
}

// authBearer is a client holding a given access token (no login).
func authBearer(t *testing.T, token string) *testkit.Client {
	c := srv.Anon(t)
	c.Token = token
	return c
}

// authSessionRevoked reports whether the session behind a refresh token is revoked.
func authSessionRevoked(t *testing.T, refresh string) bool {
	t.Helper()
	i := strings.IndexByte(refresh, '.')
	if i <= 0 {
		t.Fatalf("refresh token %q has no tenant prefix", refresh)
	}
	var revoked bool
	one(t, `SELECT revoked_at IS NOT NULL FROM sessions WHERE refresh_token_hash = $1`, &revoked, auth.HashToken(refresh[i+1:]))
	return revoked
}

// authLiveSessions counts a user's sessions that are not revoked.
func authLiveSessions(t *testing.T, userID uuid.UUID) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, &n, userID)
	return n
}

// authSetStatus has the owner change a staff member's status.
func authSetStatus(t *testing.T, owner *testkit.Client, userID uuid.UUID, status string) {
	t.Helper()
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, userID)+"/status", map[string]any{"status": status}).
		Expect(t, 204, "set user status "+status)
}

func trimAuth(s string) string {
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

// ---- REG_AUTH: sign-in ----------------------------------------------------

// TestREG_AUTH_001_LoginReturnsAccessAndRefresh: Given an active receptionist, When
// they sign in with the right workspace, email and password, Then the API answers
// 200 with an access token, sets the refresh cookie, and the token opens /auth/me.
func TestREG_AUTH_001_LoginReturnsAccessAndRefresh(t *testing.T) {
	st := clinicA.Staff["receptionist"]
	r := authMustLogin(t, clinicA, st.Email)
	if !strings.HasPrefix(r.Refresh, id.Encode(id.PrefixTenant, clinicA.TenantID)+".") {
		t.Fatalf("refresh token is not bound to the clinic: %q", r.Refresh)
	}
	authBearer(t, r.Access).Do("GET", "/auth/me", nil).Expect(t, 200, "me with fresh token")
	// Upper-case and padded input is the same login.
	r2 := authLogin(t, "  "+strings.ToUpper(clinicA.Slug)+" ", strings.ToUpper(st.Email), testkit.StaffPassword)
	if r2.Status != 200 || r2.Access == "" {
		t.Fatalf("case/space-normalised login refused: HTTP %d %s", r2.Status, r2.Code)
	}
}

// TestREG_AUTH_002_WrongPasswordRefused: Given a real user, When the password is
// wrong, Then 401 UNAUTHENTICATED, no access token, no refresh cookie.
func TestREG_AUTH_002_WrongPasswordRefused(t *testing.T) {
	c := newClinic(t) // failed attempts count towards a lockout; never on shared users
	r := authLogin(t, c.Slug, c.Staff["doctor"].Email, "not-the-password")
	if r.Status != 401 || r.Code != "UNAUTHENTICATED" || r.Access != "" || r.Refresh != "" {
		t.Fatalf("wrong password: HTTP %d %s access=%t refresh=%t", r.Status, r.Code, r.Access != "", r.Refresh != "")
	}
	var fails int
	one(t, `SELECT failed_attempts FROM users WHERE id = $1`, &fails, c.Staff["doctor"].ID)
	if fails != 1 {
		t.Fatalf("failed attempt not counted: failed_attempts=%d", fails)
	}
}

// TestREG_AUTH_003_UnknownWorkspaceOrEmailRefused: Given a workspace or email that
// does not exist, When someone signs in, Then 401 with the same generic answer as a
// wrong password (no account enumeration), and no token.
func TestREG_AUTH_003_UnknownWorkspaceOrEmailRefused(t *testing.T) {
	cases := map[string][2]string{
		"unknown workspace":   {"no-such-clinic-" + uuid.NewString()[:8], clinicA.Owner.Email},
		"unknown email":       {clinicA.Slug, "nobody-" + uuid.NewString()[:6] + "@" + clinicA.Slug + ".test"},
		"other clinic's user": {clinicA.Slug, clinicB.Owner.Email},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			r := authLogin(t, in[0], in[1], testkit.StaffPassword)
			if r.Status != 401 || r.Code != "UNAUTHENTICATED" || r.Access != "" || r.Refresh != "" {
				t.Fatalf("HTTP %d %s access=%t\n%s", r.Status, r.Code, r.Access != "", trimAuth(r.Raw))
			}
		})
	}
	// Missing fields are a validation error, not a sign-in.
	if r := authPost(t, "/auth/login", map[string]any{"workspace": clinicA.Slug}, "", ""); r.Status != 400 || r.Access != "" {
		t.Fatalf("login without email/password: HTTP %d %s", r.Status, r.Code)
	}
}

// TestREG_AUTH_004_LockoutAfterFiveFailures: Given MAX_FAILED_LOGINS=5, When a user
// gets the password wrong five times, Then the account is locked in the database,
// the right password is refused with ACCOUNT_LOCKED and no token, and a colleague in
// the same clinic is unaffected.
func TestREG_AUTH_004_LockoutAfterFiveFailures(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	for i := 1; i <= 5; i++ {
		r := authLogin(t, c.Slug, st.Email, "wrong-"+uuid.NewString()[:4])
		if r.Status != 401 || r.Access != "" {
			t.Fatalf("attempt %d: HTTP %d %s", i, r.Status, r.Code)
		}
	}
	var fails int
	var locked bool
	one(t, `SELECT failed_attempts FROM users WHERE id = $1`, &fails, st.ID)
	one(t, `SELECT coalesce(locked_until > now(), false) FROM users WHERE id = $1`, &locked, st.ID)
	if fails != 5 || !locked {
		t.Fatalf("after 5 failures: failed_attempts=%d locked=%v", fails, locked)
	}
	r := authLogin(t, c.Slug, st.Email, testkit.StaffPassword)
	if r.Status != 401 || r.Code != "ACCOUNT_LOCKED" || r.Access != "" || r.Refresh != "" {
		t.Fatalf("correct password while locked: HTTP %d %s access=%t", r.Status, r.Code, r.Access != "")
	}
	authMustLogin(t, c, c.Staff["doctor"].Email)
}

// ---- REG_AUTH: refresh lifecycle ---------------------------------------------

// TestREG_AUTH_005_RefreshCookieWorksOverHTTPJar: Given a browser-like client with a
// cookie jar on http://127.0.0.1, When it signs in and then calls /auth/refresh with
// no body, Then the HttpOnly cookie (path /api/v1/auth, not Secure in dev) is sent
// back and a new access token is issued.
func TestREG_AUTH_005_RefreshCookieWorksOverHTTPJar(t *testing.T) {
	c := srv.Anon(t)
	c.Do("POST", "/auth/login", map[string]any{"workspace": clinicA.Slug, "email": clinicA.Staff["nurse"].Email, "password": testkit.StaffPassword}).
		Expect(t, 200, "login")
	r := c.Do("POST", "/auth/refresh", nil).Expect(t, 200, "refresh via cookie jar")
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	r.Decode(t, &tok)
	if tok.AccessToken == "" {
		t.Fatalf("refresh returned no access token: %s", r.Raw)
	}
	authBearer(t, tok.AccessToken).Do("GET", "/auth/me", nil).Expect(t, 200, "me with refreshed token")
	// The jar was given the rotated cookie, so a second refresh works too.
	c.Do("POST", "/auth/refresh", nil).Expect(t, 200, "second refresh via jar")
	// Without any cookie: 401.
	if r := srv.Anon(t).Do("POST", "/auth/refresh", nil); r.Status != 401 {
		t.Fatalf("refresh without cookie: HTTP %d", r.Status)
	}
}

// TestREG_AUTH_006_RefreshRotates: Given a signed-in session, When the refresh token
// is presented, Then a NEW refresh token and access token are issued, the old
// session row is revoked, and the new one records it as its predecessor.
func TestREG_AUTH_006_RefreshRotates(t *testing.T) {
	c := newClinic(t)
	l := authMustLogin(t, c, c.Staff["cashier"].Email)
	r := authRefresh(t, l.Refresh)
	if r.Status != 200 || r.Access == "" || r.Refresh == "" {
		t.Fatalf("refresh: HTTP %d %s\n%s", r.Status, r.Code, trimAuth(r.Raw))
	}
	if r.Refresh == l.Refresh {
		t.Fatalf("refresh token was not rotated")
	}
	if !authSessionRevoked(t, l.Refresh) || authSessionRevoked(t, r.Refresh) {
		t.Fatalf("after rotation: old revoked=%v new revoked=%v", authSessionRevoked(t, l.Refresh), authSessionRevoked(t, r.Refresh))
	}
	var linked bool
	i, j := strings.IndexByte(l.Refresh, '.'), strings.IndexByte(r.Refresh, '.')
	one(t, `SELECT n.rotated_from = o.id FROM sessions n, sessions o
	         WHERE n.refresh_token_hash = $1 AND o.refresh_token_hash = $2`, &linked,
		auth.HashToken(r.Refresh[j+1:]), auth.HashToken(l.Refresh[i+1:]))
	if !linked {
		t.Fatalf("new session does not record the rotated one")
	}
	authBearer(t, r.Access).Do("GET", "/auth/me", nil).Expect(t, 200, "me with rotated token")
}

// TestREG_AUTH_007_RefreshReuseRevokesFamily: Given a refresh token that was already
// rotated, When it is presented again (a replayed/stolen token), Then 401 and EVERY
// session of that user is revoked, so the successor token dies too.
func TestREG_AUTH_007_RefreshReuseRevokesFamily(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["doctor"]
	l := authMustLogin(t, c, st.Email)
	other := authMustLogin(t, c, st.Email) // a second device
	r := authRefresh(t, l.Refresh)
	if r.Status != 200 || r.Refresh == "" {
		t.Fatalf("first refresh: HTTP %d %s", r.Status, r.Code)
	}
	reuse := authRefresh(t, l.Refresh)
	if reuse.Status != 401 || reuse.Access != "" || reuse.Refresh != "" {
		t.Fatalf("reused refresh token: HTTP %d %s access=%t", reuse.Status, reuse.Code, reuse.Access != "")
	}
	if n := authLiveSessions(t, st.ID); n != 0 {
		t.Fatalf("token reuse left %d live session(s); the family must be revoked", n)
	}
	if s := authRefresh(t, r.Refresh); s.Status != 401 {
		t.Fatalf("successor token still refreshes after reuse: HTTP %d", s.Status)
	}
	if s := authRefresh(t, other.Refresh); s.Status != 401 {
		t.Fatalf("other device still refreshes after reuse: HTTP %d", s.Status)
	}
}

// TestREG_AUTH_008_LogoutRevokesOnlyThatSession: Given two devices signed in, When
// one logs out, Then its session is revoked in the database and its refresh token is
// refused, while the other device keeps refreshing (logout is not "reuse").
func TestREG_AUTH_008_LogoutRevokesOnlyThatSession(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["nurse"]
	a := authMustLogin(t, c, st.Email)
	b := authMustLogin(t, c, st.Email)
	if r := authPost(t, "/auth/logout", nil, a.Refresh, ""); r.Status != 204 {
		t.Fatalf("logout: HTTP %d %s", r.Status, r.Code)
	}
	if !authSessionRevoked(t, a.Refresh) {
		t.Fatalf("logout did not revoke the session row")
	}
	if r := authRefresh(t, a.Refresh); r.Status != 401 || r.Access != "" {
		t.Fatalf("logged-out refresh token still works: HTTP %d", r.Status)
	}
	if r := authRefresh(t, b.Refresh); r.Status != 200 || r.Access == "" {
		t.Fatalf("other device was signed out by a logout: HTTP %d %s", r.Status, r.Code)
	}
	// Logout without a cookie is harmless and idempotent.
	if r := authPost(t, "/auth/logout", nil, "", ""); r.Status != 204 {
		t.Fatalf("logout with no cookie: HTTP %d", r.Status)
	}
}

// TestREG_AUTH_009_GarbageRefreshTokensRefused: malformed, wrong-tenant and random
// refresh tokens are 401, never 500.
func TestREG_AUTH_009_GarbageRefreshTokensRefused(t *testing.T) {
	for name, tok := range map[string]string{
		"no dot":        "garbage",
		"bad tenant":    "ten_zzzz.abcdef",
		"random opaque": id.Encode(id.PrefixTenant, clinicA.TenantID) + "." + uuid.NewString(),
		"other tenant":  id.Encode(id.PrefixTenant, clinicB.TenantID) + ".x",
	} {
		t.Run(name, func(t *testing.T) {
			if r := authRefresh(t, tok); r.Status != 401 || r.Access != "" {
				t.Fatalf("HTTP %d %s", r.Status, r.Code)
			}
		})
	}
}

// ---- REG_AUTH: the principal and bearer tokens ---------------------------------

// TestREG_AUTH_010_MeReturnsTheSignedInUser: Given each role, When it calls
// /auth/me, Then the user id, email and role code are its own, and the permissions
// are exactly what the role grants (spot checks).
func TestREG_AUTH_010_MeReturnsTheSignedInUser(t *testing.T) {
	type me struct {
		User struct {
			ID       string   `json:"id"`
			TenantID string   `json:"tenant_id"`
			Email    string   `json:"email"`
			Roles    []string `json:"roles"`
		} `json:"user"`
		Permissions []string `json:"permissions"`
	}
	for _, role := range append([]string{"owner"}, testkit.Roles...) {
		t.Run(role, func(t *testing.T) {
			var m me
			srv.As(t, clinicA, role).Do("GET", "/auth/me", nil).Expect(t, 200, "me").Decode(t, &m)
			want := clinicA.Owner
			if role != "owner" {
				want = clinicA.Staff[role]
			}
			if m.User.ID != id.Encode(id.PrefixUser, want.ID) || m.User.Email != want.Email ||
				m.User.TenantID != id.Encode(id.PrefixTenant, clinicA.TenantID) {
				t.Fatalf("me returned %+v, want %s %s", m.User, id.Encode(id.PrefixUser, want.ID), want.Email)
			}
			if len(m.User.Roles) != 1 || m.User.Roles[0] != want.Role {
				t.Fatalf("roles %v, want [%s]", m.User.Roles, want.Role)
			}
			has := map[string]bool{}
			for _, p := range m.Permissions {
				has[p] = true
			}
			if role != "owner" && has["billing.manage"] != (role == "branch_manager") {
				t.Fatalf("%s billing.manage=%v", role, has["billing.manage"])
			}
			if role == "owner" && !(has["billing.manage"] && has["user.invite"] && has["dental.manage"]) {
				t.Fatalf("owner lacks core permissions: %v", m.Permissions)
			}
		})
	}
}

// TestREG_AUTH_011_ProtectedRoutesNeedAToken: Given no Authorization header, When
// any protected route is called, Then 401 — never data, never 403/404/500.
func TestREG_AUTH_011_ProtectedRoutesNeedAToken(t *testing.T) {
	routes := [][2]string{
		{"GET", "/auth/me"}, {"POST", "/auth/switch-branch"}, {"POST", "/auth/password"},
		{"POST", "/auth/sessions/logout-others"},
		{"GET", "/users"}, {"POST", "/users"}, {"GET", "/roles"}, {"GET", "/providers"},
		{"GET", "/patients"}, {"POST", "/patients"}, {"GET", "/patients/pat_x"},
		{"GET", "/billing/charges/pending"}, {"POST", "/billing/charges/chg_x/settle"},
		{"POST", "/billing/charges/chg_x/refund"}, {"GET", "/billing/cash"},
		{"GET", "/finance/overview"}, {"GET", "/dashboard/today"}, {"GET", "/dashboard/takings"},
		{"GET", "/dental/outstanding"}, {"POST", "/dental/patients/pat_x/plans"},
		{"GET", "/notifications"},
	}
	anon := srv.Anon(t)
	for _, rt := range routes {
		r := anon.Do(rt[0], rt[1], map[string]any{})
		if r.Status != 401 {
			t.Errorf("%s %s without a token: HTTP %d %s", rt[0], rt[1], r.Status, trimAuth(r.Raw))
		}
	}
}

// TestREG_AUTH_012_BadBearerTokensRefused: Given tokens that are garbage, expired,
// signed with the wrong key, of the wrong issuer, unsigned (alg none), or an MFA
// challenge rather than an access token, When used as a bearer, Then 401. A token
// minted with the right key is accepted, so the refusals prove the checks.
func TestREG_AUTH_012_BadBearerTokensRefused(t *testing.T) {
	o := clinicA.Owner
	all := []string{"billing.manage", "user.invite", "patient.read"}
	mint := func(secret, issuer string, ttl time.Duration) string {
		tok, _, err := auth.NewTokenService([]byte(secret), issuer, ttl).
			IssueAccess(o.ID, clinicA.TenantID, o.Email, []string{"tenant_owner"}, all, nil, nil, "")
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	// Positive control: the right key, issuer and lifetime.
	authBearer(t, mint(authJWTSecret, authJWTIssuer, 5*time.Minute)).Do("GET", "/auth/me", nil).
		Expect(t, 200, "control token (right secret) — if this fails the suite's JWT settings drifted")

	mfa, err := auth.NewTokenService([]byte(authJWTSecret), authJWTIssuer, time.Minute).IssueMFAChallenge(o.ID, clinicA.TenantID, o.Email)
	if err != nil {
		t.Fatal(err)
	}
	none, err := jwt.NewWithClaims(jwt.SigningMethodNone, auth.AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{Issuer: authJWTIssuer, Subject: o.ID.String(),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))},
		TenantID: clinicA.TenantID.String(), Email: o.Email, Permissions: all, Type: "access",
	}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatal(err)
	}
	bad := map[string]string{
		"garbage":       "not.a.jwt",
		"random":        uuid.NewString(),
		"expired":       mint(authJWTSecret, authJWTIssuer, -10*time.Minute),
		"wrong secret":  mint("some-other-secret-0123456789abcdef!!", authJWTIssuer, time.Hour),
		"wrong issuer":  mint(authJWTSecret, "evil-issuer", time.Hour),
		"alg none":      none,
		"mfa challenge": mfa,
	}
	for name, tok := range bad {
		t.Run(name, func(t *testing.T) {
			for _, p := range []string{"/auth/me", "/finance/overview", "/users"} {
				if r := authBearer(t, tok).Do("GET", p, nil); r.Status != 401 {
					t.Fatalf("GET %s with %s token: HTTP %d %s", p, name, r.Status, r.Code)
				}
			}
		})
	}
}

// ---- REG_AUTH: account status ----------------------------------------------------

// authStatusCase runs the "staff member taken off the rota" scenario for one status.
// The parts that work are asserted; SEC-2 (the existing refresh session survives) is
// reported last so it never hides a regression in the parts before it.
func authStatusCase(t *testing.T, status string) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	sess := authMustLogin(t, c, st.Email) // their phone, signed in before the change
	owner := srv.As(t, c, "owner")
	authSetStatus(t, owner, st.ID, status)

	var got string
	one(t, `SELECT status FROM users WHERE id = $1`, &got, st.ID)
	if got != status {
		t.Fatalf("status in DB %q, want %q", got, status)
	}
	// A fresh sign-in with the right password is refused, with no token.
	r := authLogin(t, c.Slug, st.Email, testkit.StaffPassword)
	if r.Status == 200 || r.Access != "" || r.Refresh != "" {
		t.Fatalf("%s user signed in: HTTP %d", status, r.Status)
	}
	if r.Status != 403 || r.Code != "ACCOUNT_INACTIVE" {
		t.Fatalf("%s user login: HTTP %d %s, want 403 ACCOUNT_INACTIVE", status, r.Status, r.Code)
	}

	// Correct: the old phone's refresh token is dead too.
	// (SEC-2, fixed 2026-10-03: the status change revokes every session.)
	if live := authLiveSessions(t, st.ID); live != 0 {
		t.Fatalf("%s user still has %d live session(s)", status, live)
	}
	if ref := authRefresh(t, sess.Refresh); ref.Status != 401 || ref.Access != "" {
		t.Fatalf("refresh after %s: HTTP %d %s, want 401 and no token", status, ref.Status, ref.Code)
	}

	// Reactivated, they sign in again with their own password: the lock-out was a
	// status, not damage to the account.
	authSetStatus(t, owner, st.ID, "active")
	if r := authLogin(t, c.Slug, st.Email, testkit.StaffPassword); r.Status != 200 || r.Access == "" {
		t.Fatalf("reactivated %s user cannot sign in: HTTP %d %s", status, r.Status, r.Code)
	}
}

// TestREG_AUTH_013_DeactivatedUserCannotSignInOrRefresh: Given a receptionist signed
// in on their phone, When the owner deactivates them, Then they cannot sign in again
// AND their existing refresh session stops working (SEC-2).
func TestREG_AUTH_013_DeactivatedUserCannotSignInOrRefresh(t *testing.T) {
	authStatusCase(t, "deactivated")
}

// TestREG_AUTH_014_SuspendedUserCannotSignInOrRefresh: the same for "suspended".
func TestREG_AUTH_014_SuspendedUserCannotSignInOrRefresh(t *testing.T) {
	authStatusCase(t, "suspended")
}

// TestREG_AUTH_015_DeactivatedUserCannotReactivateWithOldResetLink: Given a reset
// link issued while a user was active, When the owner then deactivates them and the
// user opens the old link, Then the link is refused and the account stays
// deactivated (SEC-2: SetPasswordAndActivate sets status='active').
func TestREG_AUTH_015_DeactivatedUserCannotReactivateWithOldResetLink(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["cashier"]
	owner := srv.As(t, c, "owner")
	var link struct {
		InviteLink string `json:"invite_link"`
	}
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, st.ID)+"/reset-link", nil).Expect(t, 201, "reset link").Decode(t, &link)
	u, err := url.Parse(link.InviteLink)
	if err != nil || u.Query().Get("token") == "" {
		t.Fatalf("reset link has no token: %q", link.InviteLink)
	}
	authSetStatus(t, owner, st.ID, "deactivated")

	acc := authPost(t, "/auth/accept-invite", map[string]any{"token": u.Query().Get("token"), "password": "Reactivate#2026"}, "", "")
	var status string
	one(t, `SELECT status FROM users WHERE id = $1`, &status, st.ID)
	if acc.Access != "" || acc.Refresh != "" {
		t.Fatalf("a reset link signed somebody in: %s", trimAuth(acc.Raw))
	}
	// (SEC-2, fixed 2026-10-03: deactivating retires the link, and a link can no
	// longer switch a locked-out account back on.)
	if status != "deactivated" {
		t.Fatalf("an old reset link changed a deactivated account to %q", status)
	}
	if acc.Status < 400 {
		t.Fatalf("accept-invite of an old reset link answered %d, want a refusal", acc.Status)
	}
	// And the owner cannot hand them a fresh one while they are deactivated.
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, st.ID)+"/reset-link", nil).Expect(t, 400, "reset link for a deactivated account")
}

// TestREG_AUTH_024_RenewalChecksTheAccountItself: Given a signed-in receptionist
// whose account is switched off without going through the Staff page (so nothing
// revoked her session), When her phone renews its sign-in, Then the renewal is
// refused and her sessions are ended: the second lock of SEC-2.
func TestREG_AUTH_024_RenewalChecksTheAccountItself(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	sess := authMustLogin(t, c, st.Email)
	if _, err := super.Pool.Exec(t.Context(), `UPDATE users SET status = 'suspended' WHERE id = $1`, st.ID); err != nil {
		t.Fatal(err)
	}
	if r := authRefresh(t, sess.Refresh); r.Status != 401 || r.Access != "" {
		t.Fatalf("renewal for a suspended account: HTTP %d %s, want 401 and no token", r.Status, r.Code)
	}
	if n := authLiveSessions(t, st.ID); n != 0 {
		t.Fatalf("the refused renewal left %d live session(s)", n)
	}
}

// TestREG_AUTH_025_UnexpiredLinkCannotSwitchALockedOutAccountOn: Given a reset link
// that is still valid, When the account is switched off without the Staff page
// retiring the link, and the link is opened, Then it is refused with ACCOUNT_INACTIVE
// and the account stays off; an invitation link likewise only completes an invited
// account (SEC-2).
func TestREG_AUTH_025_UnexpiredLinkCannotSwitchALockedOutAccountOn(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["cashier"]
	owner := srv.As(t, c, "owner")
	var link struct {
		InviteLink string `json:"invite_link"`
	}
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, st.ID)+"/reset-link", nil).Expect(t, 201, "reset link").Decode(t, &link)
	u, err := url.Parse(link.InviteLink)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := super.Pool.Exec(t.Context(), `UPDATE users SET status = 'suspended' WHERE id = $1`, st.ID); err != nil {
		t.Fatal(err)
	}
	acc := authPost(t, "/auth/accept-invite", map[string]any{"token": u.Query().Get("token"), "password": "Comeback#2026"}, "", "")
	if acc.Status != 403 || acc.Code != "ACCOUNT_INACTIVE" || acc.Access != "" {
		t.Fatalf("live reset link on a suspended account: HTTP %d %s, want 403 ACCOUNT_INACTIVE", acc.Status, acc.Code)
	}
	var status string
	one(t, `SELECT status FROM users WHERE id = $1`, &status, st.ID)
	if status != "suspended" {
		t.Fatalf("status after the refused link: %q, want suspended", status)
	}
	// An invitation-purpose link on an account that is already active is refused too.
	if _, err := super.Pool.Exec(t.Context(),
		`UPDATE users SET status = 'active' WHERE id = $1;`, st.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := super.Pool.Exec(t.Context(),
		`UPDATE user_invitations SET purpose = 'invite' WHERE user_id = $1 AND accepted_at IS NULL`, st.ID); err != nil {
		t.Fatal(err)
	}
	inv := authPost(t, "/auth/accept-invite", map[string]any{"token": u.Query().Get("token"), "password": "Comeback#2026"}, "", "")
	if inv.Status != 403 || inv.Code != "ACCOUNT_INACTIVE" {
		t.Fatalf("invitation link on an active account: HTTP %d %s, want 403 ACCOUNT_INACTIVE", inv.Status, inv.Code)
	}
}

// TestREG_AUTH_027_SignInEdgesAreRefusedCleanly: the sign-in rules nobody had pinned
// down. A renewal past its 30 days is refused; signing out with an unknown or
// garbled token is a harmless no-op that ends nobody else's session; a new password
// under 8 characters, a blank new email, and an invitation to an address with no @
// are each refused with 400 before anything is stored.
func TestREG_AUTH_027_SignInEdgesAreRefusedCleanly(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	old := authMustLogin(t, c, st.Email)
	if _, err := super.Pool.Exec(t.Context(),
		`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND revoked_at IS NULL`, st.ID); err != nil {
		t.Fatal(err)
	}
	if r := authRefresh(t, old.Refresh); r.Status != 401 || r.Access != "" {
		t.Fatalf("renewal past its expiry: HTTP %d %s, want 401", r.Status, r.Code)
	}

	live := authMustLogin(t, c, st.Email)
	for _, tok := range []string{"not-a-token", id.Encode(id.PrefixTenant, c.TenantID) + ".no-such-session"} {
		if r := authPost(t, "/auth/logout", nil, tok, ""); r.Status >= 400 {
			t.Fatalf("logout with %q: HTTP %d, want a quiet success", tok, r.Status)
		}
	}
	if authSessionRevoked(t, live.Refresh) {
		t.Fatalf("a logout with an unknown token ended someone else's session")
	}

	me := authBearer(t, live.Access)
	me.Do("POST", "/auth/password", map[string]any{"current_password": testkit.StaffPassword, "new_password": "short"}).
		Expect(t, 400, "a 5-character new password")
	me.Do("POST", "/auth/email", map[string]any{"new_email": "   ", "current_password": testkit.StaffPassword}).
		Expect(t, 400, "a blank new email")
	if r := authLogin(t, c.Slug, st.Email, testkit.StaffPassword); r.Status != 200 {
		t.Fatalf("the refused changes altered the sign-in: HTTP %d", r.Status)
	}

	srv.As(t, c, "owner").Do("POST", "/users", map[string]any{"email": "no-at-sign", "full_name": "Bad Address", "roles": []string{"nurse"}}).
		Expect(t, 400, "an invitation to an address with no @")
}

// TestREG_AUTH_023_ResetLinkStillCompletesAnUnacceptedInvitation: Given someone
// invited who never accepted, When the owner issues a reset link instead and they
// open it, Then the account becomes active (the SEC-2 lock must not break the
// "send the invitation again" path).
func TestREG_AUTH_023_ResetLinkStillCompletesAnUnacceptedInvitation(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["nurse"]
	if _, err := super.Pool.Exec(t.Context(), `UPDATE users SET status = 'invited' WHERE id = $1`, st.ID); err != nil {
		t.Fatal(err)
	}
	owner := srv.As(t, c, "owner")
	var link struct {
		InviteLink string `json:"invite_link"`
	}
	owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, st.ID)+"/reset-link", nil).Expect(t, 201, "reset link").Decode(t, &link)
	u, err := url.Parse(link.InviteLink)
	if err != nil {
		t.Fatal(err)
	}
	acc := authPost(t, "/auth/accept-invite", map[string]any{"token": u.Query().Get("token"), "password": "Welcome#2026"}, "", "")
	if acc.Status >= 400 {
		t.Fatalf("an invited person's reset link was refused: HTTP %d %s", acc.Status, acc.Code)
	}
	var status string
	one(t, `SELECT status FROM users WHERE id = $1`, &status, st.ID)
	if status != "active" {
		t.Fatalf("after accepting, status %q, want active", status)
	}
}

// TestREG_AUTH_016_DeletedUserLosesSessionsAndLogin: Given a signed-in user, When the
// owner removes them, Then every session is revoked, the refresh token is refused
// and they cannot sign in (the delete path does what SEC-2 asks of deactivate).
func TestREG_AUTH_016_DeletedUserLosesSessionsAndLogin(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["nurse"]
	sess := authMustLogin(t, c, st.Email)
	srv.As(t, c, "owner").Do("DELETE", "/users/"+id.Encode(id.PrefixUser, st.ID), nil).Expect(t, 204, "delete user")
	if n := authLiveSessions(t, st.ID); n != 0 {
		t.Fatalf("deleted user has %d live session(s)", n)
	}
	if r := authRefresh(t, sess.Refresh); r.Status != 401 {
		t.Fatalf("deleted user's refresh: HTTP %d", r.Status)
	}
	if r := authLogin(t, c.Slug, st.Email, testkit.StaffPassword); r.Status != 401 || r.Access != "" {
		t.Fatalf("deleted user login: HTTP %d %s", r.Status, r.Code)
	}
}

// TestREG_AUTH_017_PasswordChangeSignsOutOtherDevices: Given a user on two devices,
// When they change their password on device A (wrong current password first: 403),
// Then device B's refresh is refused, device A keeps working, the old password no
// longer signs in and the new one does.
func TestREG_AUTH_017_PasswordChangeSignsOutOtherDevices(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["doctor"]
	a := authMustLogin(t, c, st.Email)
	b := authMustLogin(t, c, st.Email)
	if r := authPost(t, "/auth/password", map[string]any{"current_password": "wrong-one", "new_password": "Changed#2026x"}, a.Refresh, a.Access); r.Status != 403 || r.Code != "WRONG_PASSWORD" {
		t.Fatalf("password change with wrong current: HTTP %d %s", r.Status, r.Code)
	}
	if r := authPost(t, "/auth/password", map[string]any{"current_password": testkit.StaffPassword, "new_password": "Changed#2026x"}, a.Refresh, a.Access); r.Status != 204 {
		t.Fatalf("password change: HTTP %d %s", r.Status, r.Code)
	}
	if r := authRefresh(t, b.Refresh); r.Status != 401 {
		t.Fatalf("other device survived a password change: HTTP %d", r.Status)
	}
	if r := authRefresh(t, a.Refresh); r.Status != 200 {
		t.Fatalf("the device that changed the password was signed out: HTTP %d %s", r.Status, r.Code)
	}
	if r := authLogin(t, c.Slug, st.Email, testkit.StaffPassword); r.Status != 401 {
		t.Fatalf("old password still signs in: HTTP %d", r.Status)
	}
	if r := authLogin(t, c.Slug, st.Email, "Changed#2026x"); r.Status != 200 || r.Access == "" {
		t.Fatalf("new password refused: HTTP %d %s", r.Status, r.Code)
	}
}

// TestREG_AUTH_018_SignOutOtherDevices: Given three devices, When device A asks to
// sign out the others, Then exactly two sessions are revoked and A still refreshes.
func TestREG_AUTH_018_SignOutOtherDevices(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["cashier"]
	a := authMustLogin(t, c, st.Email)
	b := authMustLogin(t, c, st.Email)
	d := authMustLogin(t, c, st.Email)
	r := authPost(t, "/auth/sessions/logout-others", nil, a.Refresh, a.Access)
	if r.Status != 200 || !strings.Contains(r.Raw, `"revoked":2`) {
		t.Fatalf("logout-others: HTTP %d %s", r.Status, trimAuth(r.Raw))
	}
	if !authSessionRevoked(t, b.Refresh) || !authSessionRevoked(t, d.Refresh) || authSessionRevoked(t, a.Refresh) {
		t.Fatalf("wrong sessions revoked")
	}
	if r := authRefresh(t, a.Refresh); r.Status != 200 {
		t.Fatalf("current device signed out: HTTP %d", r.Status)
	}
}

// TestREG_AUTH_019_OwnerCannotDeactivateThemselves: Given the clinic's only owner,
// When they set their own status to deactivated, Then the API refuses (as it does
// for deleting your own account), so a mis-click cannot lock the whole clinic out.
func TestREG_AUTH_019_OwnerCannotDeactivateThemselves(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	// Deleting yourself is refused (user_service.go DeleteUser); deactivating is not.
	// Checked first: once the owner has deactivated themself, every request of
	// theirs is refused at the door (SEC-2), so the guard could no longer be reached.
	if d := owner.Do("DELETE", "/users/"+id.Encode(id.PrefixUser, c.Owner.ID), nil); d.Status != 400 {
		t.Fatalf("self-delete guard changed: HTTP %d", d.Status)
	}
	r := owner.Do("POST", "/users/"+id.Encode(id.PrefixUser, c.Owner.ID)+"/status", map[string]any{"status": "deactivated"})
	var status string
	one(t, `SELECT status FROM users WHERE id = $1`, &status, c.Owner.ID)
	present := r.Status == 204 && status == "deactivated"
	if !present && r.Status < 400 {
		t.Fatalf("self-deactivate answered %d, status %q", r.Status, status)
	}
	testkit.KnownBug(t, "NEW-AUTH-1", present,
		"the only owner deactivated their own account (HTTP 204) and the clinic now has no one who can sign in "+
			"to reactivate it; UpdateUserStatus has no self/last-owner guard, unlike DeleteUser")
}

// ---- REG_AUTHZ: the role matrix ----------------------------------------------------

// authAllowed: the permission gate passed. A 400/404/409/422 for a fake id or empty
// body proves the request reached the handler.
func authAllowed(r testkit.Resp) bool {
	return r.Status != 401 && !(r.Status == 403 && r.Code == "FORBIDDEN_PERMISSION")
}

// TestREG_AUTHZ_001_RoleMatrix: Given a dental clinic with one user per role, When
// each calls each important endpoint, Then it is refused with 403
// FORBIDDEN_PERMISSION exactly when provision.RoleGrants does not give the role the
// permission the route needs, and otherwise reaches the handler.
func TestREG_AUTHZ_001_RoleMatrix(t *testing.T) {
	roles := append([]string{"owner"}, testkit.Roles...)
	clients := map[string]*testkit.Client{}
	for _, r := range roles {
		clients[r] = srv.As(t, clinicA, r)
	}
	const (
		pat = "pat_fake"
		chg = "chg_fake"
	)
	fakeUser := id.Encode(id.PrefixUser, uuid.New())
	rows := []struct {
		name, method, path string
		allow              []string // roles that may (owner implied)
	}{
		{"finance overview (billing.manage)", "GET", "/finance/overview", []string{"branch_manager"}},
		{"cash view (billing.manage)", "GET", "/billing/cash", []string{"branch_manager"}},
		{"invite staff (user.invite)", "POST", "/users", nil},
		{"list staff (user.read)", "GET", "/users", []string{"branch_manager"}},
		{"change staff status (user.update)", "POST", "/users/" + fakeUser + "/status", nil},
		{"assign roles (role.assign)", "PUT", "/users/" + fakeUser + "/roles", nil},
		{"raise a charge (payment.charge)", "POST", "/billing/charges", []string{"receptionist", "cashier", "branch_manager"}},
		{"settle a charge (payment.collect)", "POST", "/billing/charges/" + chg + "/settle", []string{"cashier", "branch_manager"}},
		{"checkout a visit (payment.collect)", "POST", "/billing/checkout", []string{"cashier", "branch_manager"}},
		{"cashier worklist (payment.collect)", "GET", "/billing/charges/pending", []string{"cashier", "branch_manager"}},
		{"waive a charge (payment.waive)", "POST", "/billing/charges/" + chg + "/waive", []string{"cashier", "branch_manager"}},
		{"refund a charge (billing.manage)", "POST", "/billing/charges/" + chg + "/refund", []string{"branch_manager"}},
		{"refund a visit (billing.manage)", "POST", "/billing/refund-visit", []string{"branch_manager"}},
		{"register a patient (patient.create)", "POST", "/patients", []string{"receptionist", "branch_manager", "doctor" /* dental: doctor registers */}},
		{"search patients (patient.search)", "GET", "/patients?q=zz", []string{"receptionist", "doctor", "nurse", "cashier", "branch_manager"}},
		{"create a dental plan (dental.manage)", "POST", "/dental/patients/" + pat + "/plans", []string{"doctor"}},
		{"record a dental visit (dental.manage)", "PUT", "/dental/patients/" + pat + "/sessions/tss_fake", []string{"doctor"}},
		{"dental exam (dental.manage)", "POST", "/dental/patients/" + pat + "/exams", []string{"doctor"}},
		{"dental medical history (dental.manage)", "GET", "/dental/patients/" + pat + "/medical-history", []string{"doctor"}},
		{"dental write-off (payment.waive)", "POST", "/dental/patients/" + pat + "/sessions/tss_fake/write-off", []string{"cashier", "branch_manager"}},
		{"dental summary (dental.read)", "GET", "/dental/patients/" + pat + "/summary", []string{"doctor", "receptionist", "cashier", "branch_manager"}},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			allow := map[string]bool{"owner": true}
			for _, a := range row.allow {
				allow[a] = true
			}
			for _, role := range roles {
				var body any
				if row.method != "GET" {
					body = map[string]any{}
				}
				r := clients[role].Do(row.method, row.path, body)
				switch {
				case allow[role] && !authAllowed(r):
					t.Errorf("%s should be allowed: HTTP %d %s", role, r.Status, r.Code)
				case !allow[role] && (r.Status != 403 || r.Code != "FORBIDDEN_PERMISSION"):
					t.Errorf("%s should be refused 403 FORBIDDEN_PERMISSION: HTTP %d %s %s", role, r.Status, r.Code, trimAuth(r.Raw))
				case r.Status >= 500:
					t.Errorf("%s: gate passed but handler answered %d for a fake id/empty body: %s", role, r.Status, trimAuth(r.Raw))
				}
			}
		})
	}
}

// TestREG_AUTHZ_002_RefusedWritesChangeNothing: Given a real pending charge and a real
// patient, When roles without the permission try to settle it, refund it or create a
// dental plan, Then nothing changes in the database.
func TestREG_AUTHZ_002_RefusedWritesChangeNothing(t *testing.T) {
	owner := srv.As(t, clinicA, "owner")
	p := createPatient(t, owner, uniq("Authz"), "Matrix")
	for _, role := range []string{"receptionist", "cashier", "nurse"} {
		r := srv.As(t, clinicA, role).Do("POST", "/dental/patients/"+p.ID+"/plans", map[string]any{
			"title": "Crown", "tooth": "UL6", "total_amount": "3000", "start_date": payAddisToday(),
			"interval_unit": "week", "interval_count": 1, "session_count": 2,
		})
		if r.Status != 403 || r.Code != "FORBIDDEN_PERMISSION" {
			t.Fatalf("%s create plan: HTTP %d %s", role, r.Status, r.Code)
		}
	}
	pid, err := id.Decode(id.PrefixPatient, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	var plans int
	one(t, `SELECT count(*) FROM treatment_plans WHERE patient_id = $1`, &plans, pid)
	if plans != 0 {
		t.Fatalf("a refused role created %d plan(s)", plans)
	}
	// The doctor (dental.manage) can, with the same body: the gate is the difference.
	createPlan(t, srv.As(t, clinicA, "doctor"), p.ID, "3000", 2, "")
}

// TestREG_AUTHZ_003_DashboardMoneyIsServerDecided: Given the home screen, When each
// role opens /dashboard/today, Then `money` is present only for roles with
// billing.manage or payment.collect (owner, cashier, branch manager), and the takings
// chart is empty for the others. The client cannot ask for it.
func TestREG_AUTHZ_003_DashboardMoneyIsServerDecided(t *testing.T) {
	seesMoney := map[string]bool{"owner": true, "cashier": true, "branch_manager": true}
	for _, role := range append([]string{"owner"}, testkit.Roles...) {
		t.Run(role, func(t *testing.T) {
			c := srv.As(t, clinicA, role)
			var m map[string]json.RawMessage
			c.Do("GET", "/dashboard/today?money=1", nil).Expect(t, 200, "dashboard").Decode(t, &m)
			raw, has := m["money"]
			has = has && string(raw) != "null"
			if has != seesMoney[role] {
				t.Fatalf("%s: money present=%v, want %v", role, has, seesMoney[role])
			}
			tk := c.Do("GET", "/dashboard/takings?days=7", nil).Expect(t, 200, "takings")
			empty := len(tk.Data) == 0 || string(tk.Data) == "null"
			if empty == seesMoney[role] {
				t.Fatalf("%s: takings empty=%v (%s)", role, empty, trimAuth(tk.Raw))
			}
		})
	}
}

// TestREG_AUTHZ_004_PermissionsComeFromTheServerNotTheToken: Given a role change made
// by the owner (receptionist -> cashier), When the user refreshes, Then the new access
// token carries the new role's permissions: settle is now allowed and patient
// registration refused.
func TestREG_AUTHZ_004_PermissionsComeFromTheServerNotTheToken(t *testing.T) {
	c := newClinic(t)
	st := c.Staff["receptionist"]
	sess := authMustLogin(t, c, st.Email)
	if r := authBearer(t, sess.Access).Do("POST", "/billing/charges/chg_fake/settle", map[string]any{}); r.Code != "FORBIDDEN_PERMISSION" {
		t.Fatalf("receptionist settle before change: HTTP %d %s", r.Status, r.Code)
	}
	srv.As(t, c, "owner").Do("PUT", "/users/"+id.Encode(id.PrefixUser, st.ID)+"/roles", map[string]any{"roles": []string{"cashier"}}).
		Expect(t, 204, "assign roles")
	ref := authRefresh(t, sess.Refresh)
	if ref.Status != 200 {
		t.Fatalf("refresh: HTTP %d", ref.Status)
	}
	nc := authBearer(t, ref.Access)
	if r := nc.Do("POST", "/billing/charges/chg_fake/settle", map[string]any{}); !authAllowed(r) {
		t.Fatalf("after becoming cashier, settle refused: HTTP %d %s", r.Status, r.Code)
	}
	if r := nc.Do("POST", "/patients", map[string]any{}); r.Code != "FORBIDDEN_PERMISSION" {
		t.Fatalf("after becoming cashier, patient.create still granted: HTTP %d %s", r.Status, r.Code)
	}
}
