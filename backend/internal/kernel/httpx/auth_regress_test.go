package httpx_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

const (
	testIssuer = "clinicos-test"
)

var testSecret = []byte("httpx-regress-secret-0123456789abcdef")

func tokenSvc() *auth.TokenService { return auth.NewTokenService(testSecret, testIssuer, time.Hour) }

// authRouter mounts RequireAuth (header) and RequireAuthQuery (query) in front of a
// handler that echoes the principal seen on both the gin context and request context.
func authRouter(ts *auth.TokenService) *gin.Engine {
	r := gin.New()
	r.Use(httpx.WithRequestID())
	echo := func(c *gin.Context) {
		p, ok := httpx.PrincipalFrom(c)
		cp, cok := tenancy.PrincipalFromContext(c.Request.Context())
		tid, tok := tenancy.TenantIDFromContext(c.Request.Context())
		if !ok || !cok || !tok || p != cp || tid != p.TenantID {
			c.JSON(http.StatusTeapot, gin.H{"err": "principal not propagated"})
			return
		}
		active := ""
		if p.ActiveBranchID != nil {
			active = p.ActiveBranchID.String()
		}
		c.JSON(http.StatusOK, gin.H{
			"user": p.UserID.String(), "tenant": p.TenantID.String(), "email": p.Email,
			"roles": p.Roles, "perms": p.Permissions, "flags": p.Flags,
			"branches": p.BranchIDs, "active": active,
		})
	}
	r.GET("/h", httpx.RequireAuth(ts), echo)
	r.GET("/q", httpx.RequireAuthQuery(ts), echo)
	return r
}

func bearer(path, tok string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return req
}

// signRaw signs arbitrary claims with the test secret (to forge malformed-but-valid tokens).
func signRaw(t *testing.T, claims auth.AccessClaims) string {
	t.Helper()
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(testSecret)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func baseClaims(sub, tid string) auth.AccessClaims {
	now := time.Now()
	return auth.AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: testIssuer, Subject: sub,
			IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
		},
		TenantID: tid, Type: "access",
	}
}

// Given no Authorization header (or a non-Bearer scheme), When a protected route is hit,
// Then 401 UNAUTHENTICATED "missing access token" with the request id, handler not run.
func TestREG_KERNEL_HTTPX_001_RequireAuthMissingToken401(t *testing.T) {
	r := authRouter(tokenSvc())
	for name, hdr := range map[string]string{
		"absent": "", "basic scheme": "Basic dXNlcjpwYXNz", "lowercase bearer": "bearer abc",
		"bearer no space": "Bearerabc", "bearer only": "Bearer ",
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/h", nil)
			req.Header.Set("X-Request-Id", "rid-"+name)
			if hdr != "" {
				req.Header.Set("Authorization", hdr)
			}
			e := expectError(t, do(r, req), http.StatusUnauthorized, "UNAUTHENTICATED", "missing access token")
			if e.Error.RequestID != "rid-"+name {
				t.Fatalf("request_id = %q want %q", e.Error.RequestID, "rid-"+name)
			}
		})
	}
}

// Given a token that is garbage, signed with another key, expired, from another issuer,
// or an MFA-challenge token, When used as an access token, Then 401 "invalid or expired token".
func TestREG_KERNEL_HTTPX_002_RequireAuthRejectsBadTokens401(t *testing.T) {
	uid, tid := uuid.New(), uuid.New()
	ts := tokenSvc()
	expired, _, _ := auth.NewTokenService(testSecret, testIssuer, -time.Minute).IssueAccess(uid, tid, "e@x", nil, nil, nil, nil, "")
	otherKey, _, _ := auth.NewTokenService([]byte("another-secret-entirely-0000000000"), testIssuer, time.Hour).IssueAccess(uid, tid, "e@x", nil, nil, nil, nil, "")
	otherIss, _, _ := auth.NewTokenService(testSecret, "someone-else", time.Hour).IssueAccess(uid, tid, "e@x", nil, nil, nil, nil, "")
	mfa, _ := ts.IssueMFAChallenge(uid, tid, "e@x")
	r := authRouter(ts)
	for name, tok := range map[string]string{
		"garbage": "not.a.jwt", "other key": otherKey, "expired": expired,
		"other issuer": otherIss, "mfa challenge": mfa,
	} {
		t.Run(name, func(t *testing.T) {
			expectError(t, do(r, bearer("/h", tok)), http.StatusUnauthorized, "UNAUTHENTICATED", "invalid or expired token")
		})
	}
}

// Given a correctly-signed access token whose subject or tenant is not a UUID, When used,
// Then 401 "malformed token claims" (no principal with a zero tenant is ever built).
func TestREG_KERNEL_HTTPX_003_RequireAuthMalformedClaims401(t *testing.T) {
	r := authRouter(tokenSvc())
	for name, c := range map[string]auth.AccessClaims{
		"bad subject": baseClaims("not-a-uuid", uuid.NewString()),
		"bad tenant":  baseClaims(uuid.NewString(), "tenant-1"),
		"empty both":  baseClaims("", ""),
	} {
		t.Run(name, func(t *testing.T) {
			expectError(t, do(r, bearer("/h", signRaw(t, c))), http.StatusUnauthorized, "UNAUTHENTICATED", "malformed token claims")
		})
	}
}

// Given a valid access token, When a protected route runs, Then the principal (user,
// tenant, email, roles, perms, flags, branches, active branch) reaches both the gin
// context and the request context; invalid branch ids are dropped, not trusted.
func TestREG_KERNEL_HTTPX_004_RequireAuthBuildsPrincipal(t *testing.T) {
	ts := tokenSvc()
	uid, tid, b1, b2 := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	tok, _, err := ts.IssueAccess(uid, tid, "doc@clinic.et", []string{"doctor"}, []string{"patient.read"},
		map[string]bool{"lab": true}, []string{b1.String(), "garbage", b2.String()}, b2.String())
	if err != nil {
		t.Fatal(err)
	}
	w := do(authRouter(ts), bearer("/h", tok))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	var got struct {
		User, Tenant, Email, Active string
		Roles, Perms                []string
		Flags                       map[string]bool
		Branches                    []uuid.UUID
	}
	if err := jsonUnmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.User != uid.String() || got.Tenant != tid.String() || got.Email != "doc@clinic.et" {
		t.Fatalf("identity wrong: %+v", got)
	}
	if len(got.Roles) != 1 || got.Roles[0] != "doctor" || len(got.Perms) != 1 || got.Perms[0] != "patient.read" || !got.Flags["lab"] {
		t.Fatalf("grants wrong: %+v", got)
	}
	if len(got.Branches) != 2 || got.Branches[0] != b1 || got.Branches[1] != b2 {
		t.Fatalf("branches = %v want [%s %s] (garbage dropped)", got.Branches, b1, b2)
	}
	if got.Active != b2.String() {
		t.Fatalf("active branch = %q want %s", got.Active, b2)
	}
}

// Given a token with no branches and an unparsable active branch, When used, Then the
// principal is tenant-wide with a nil active branch (consolidated view).
func TestREG_KERNEL_HTTPX_005_RequireAuthInvalidActiveBranchIsNil(t *testing.T) {
	ts := tokenSvc()
	for name, active := range map[string]string{"empty": "", "garbage": "branch-x"} {
		t.Run(name, func(t *testing.T) {
			tok, _, _ := ts.IssueAccess(uuid.New(), uuid.New(), "a@b", nil, nil, nil, nil, active)
			w := do(authRouter(ts), bearer("/h", tok))
			if w.Code != http.StatusOK {
				t.Fatalf("status %d", w.Code)
			}
			var got struct {
				Active   string
				Branches []uuid.UUID
			}
			_ = jsonUnmarshal(w.Body.Bytes(), &got)
			if got.Active != "" || len(got.Branches) != 0 {
				t.Fatalf("got active=%q branches=%v, want none", got.Active, got.Branches)
			}
		})
	}
}

// Given the SSE variant, When the token is in ?token=, Then it authenticates; the
// Authorization header is NOT consulted; a missing query token is 401.
func TestREG_KERNEL_HTTPX_006_RequireAuthQueryUsesQueryParamOnly(t *testing.T) {
	ts := tokenSvc()
	tok, _, _ := ts.IssueAccess(uuid.New(), uuid.New(), "a@b", nil, nil, nil, nil, "")
	r := authRouter(ts)
	if w := do(r, httptest.NewRequest(http.MethodGet, "/q?token="+tok, nil)); w.Code != http.StatusOK {
		t.Fatalf("query token: status %d body %s", w.Code, w.Body.String())
	}
	expectError(t, do(r, bearer("/q", tok)), http.StatusUnauthorized, "UNAUTHENTICATED", "missing access token")
	expectError(t, do(r, httptest.NewRequest(http.MethodGet, "/q?token=bogus", nil)), http.StatusUnauthorized, "UNAUTHENTICATED", "invalid or expired token")
}

// authzRouter installs an optional principal then the guard under test.
func authzRouter(p *tenancy.Principal, guard gin.HandlerFunc) *gin.Engine {
	r := gin.New()
	r.Use(httpx.WithRequestID())
	r.GET("/x", func(c *gin.Context) {
		if p != nil {
			c.Set("principal", p)
		}
	}, guard, okHandler)
	return r
}

// Given no authenticated principal, When any authorization guard runs, Then 401
// UNAUTHENTICATED "authentication required" (never 403, never the handler).
func TestREG_KERNEL_HTTPX_007_GuardsWithoutPrincipal401(t *testing.T) {
	guards := map[string]gin.HandlerFunc{
		"RequireRole":          httpx.RequireRole("owner"),
		"RequirePermission":    httpx.RequirePermission("patient.read"),
		"RequireAnyPermission": httpx.RequireAnyPermission("patient.read"),
		"RequireFlag":          httpx.RequireFlag("lab"),
	}
	for name, g := range guards {
		t.Run(name, func(t *testing.T) {
			w := do(authzRouter(nil, g), httptest.NewRequest(http.MethodGet, "/x", nil))
			e := expectError(t, w, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication required")
			if e.Error.RequestID == "" {
				t.Fatal("401 envelope missing request_id")
			}
		})
	}
	// A wrong-typed value under the principal key is not a principal.
	r := gin.New()
	r.GET("/x", func(c *gin.Context) { c.Set("principal", "not-a-principal") }, httpx.RequirePermission("p"), okHandler)
	expectError(t, do(r, httptest.NewRequest(http.MethodGet, "/x", nil)), http.StatusUnauthorized, "UNAUTHENTICATED", "")
}

// Given an authenticated principal lacking the grant, When each guard runs, Then 403 with
// the guard-specific code/message; holding the grant lets the request through.
func TestREG_KERNEL_HTTPX_008_GuardsForbiddenAndAllowed(t *testing.T) {
	p := &tenancy.Principal{
		UserID: uuid.New(), TenantID: uuid.New(),
		Roles: []string{"cashier"}, Permissions: []string{"payment.collect"},
		Flags: map[string]bool{"lab": true, "pharmacy": false},
	}
	cases := []struct {
		name   string
		guard  gin.HandlerFunc
		status int
		code   string
		msg    string
	}{
		{"role denied", httpx.RequireRole("owner", "doctor"), 403, "FORBIDDEN_ROLE", "you do not have the required role"},
		{"role allowed", httpx.RequireRole("owner", "cashier"), 200, "", ""},
		{"role none listed", httpx.RequireRole(), 403, "FORBIDDEN_ROLE", ""},
		{"perm denied", httpx.RequirePermission("payment.refund"), 403, "FORBIDDEN_PERMISSION", "you do not have permission to perform this action"},
		{"perm allowed", httpx.RequirePermission("payment.collect"), 200, "", ""},
		{"any perm denied", httpx.RequireAnyPermission("a", "b"), 403, "FORBIDDEN_PERMISSION", "you do not have permission to perform this action"},
		{"any perm empty list", httpx.RequireAnyPermission(), 403, "FORBIDDEN_PERMISSION", ""},
		{"any perm second hits", httpx.RequireAnyPermission("payment.refund", "payment.collect"), 200, "", ""},
		{"flag off", httpx.RequireFlag("pharmacy"), 403, "MODULE_DISABLED", "the pharmacy module is not enabled for this tenant"},
		{"flag missing", httpx.RequireFlag("dental"), 403, "MODULE_DISABLED", "the dental module is not enabled for this tenant"},
		{"flag on", httpx.RequireFlag("lab"), 200, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := do(authzRouter(p, c.guard), httptest.NewRequest(http.MethodGet, "/x", nil))
			if c.status == 200 {
				if w.Code != 200 || w.Body.String() != `{"ok":true}` {
					t.Fatalf("allowed request: status %d body %s", w.Code, w.Body.String())
				}
				return
			}
			expectError(t, w, c.status, c.code, c.msg)
		})
	}
}

// Given an account guard installed (cmd/api installs AuthService.CheckActive), When
// a valid token arrives, Then the guard is asked about that clinic and person: a
// refusal it gives is passed through as-is (403 TENANT_INACTIVE, 401), an
// unexpected error becomes 500 without its text, and a platform-admin token (no
// clinic) is never sent to it (SEC-2, SEC-10).
func TestREG_KERNEL_HTTPX_020_AccountGuardDecidesEveryRequest(t *testing.T) {
	ts := tokenSvc()
	r := authRouter(ts)
	uid, tid := uuid.New(), uuid.New()
	tok, _, err := ts.IssueAccess(uid, tid, "a@b.c", nil, nil, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	var verdict error
	var asked []uuid.UUID
	httpx.SetAccountGuard(func(_ context.Context, tenantID, userID uuid.UUID) error {
		asked = append(asked, tenantID, userID)
		return verdict
	})
	t.Cleanup(func() { httpx.SetAccountGuard(nil) })

	for _, c := range []struct {
		verdict error
		status  int
		code    string
	}{
		{nil, http.StatusOK, ""},
		{apperr.Forbidden("TENANT_INACTIVE", "this workspace is not active"), http.StatusForbidden, "TENANT_INACTIVE"},
		{apperr.Unauthenticated("account is not active"), http.StatusUnauthorized, "UNAUTHENTICATED"},
		{errors.New("connection reset: secret detail"), http.StatusInternalServerError, "INTERNAL_ERROR"},
	} {
		verdict = c.verdict
		w := httptest.NewRecorder()
		r.ServeHTTP(w, bearer("/h", tok))
		if w.Code != c.status || (c.code != "" && !strings.Contains(w.Body.String(), c.code)) {
			t.Fatalf("guard verdict %v: HTTP %d %s, want %d %s", c.verdict, w.Code, w.Body.String(), c.status, c.code)
		}
		if strings.Contains(w.Body.String(), "secret detail") {
			t.Fatalf("an internal error's text reached the client: %s", w.Body.String())
		}
	}
	if len(asked) != 8 || asked[0] != tid || asked[1] != uid {
		t.Fatalf("guard asked about %v, want (%s, %s) per request", asked, tid, uid)
	}

	// A platform admin's token carries no clinic: the guard is not consulted.
	asked = nil
	verdict = apperr.Forbidden("TENANT_INACTIVE", "x")
	ptok, _, err := ts.IssueAccess(uuid.New(), uuid.Nil, "admin@vendor", nil, []string{"platform.admin"}, nil, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, bearer("/h", ptok))
	if len(asked) != 0 {
		t.Fatalf("the guard was asked about a platform-admin token")
	}
}
