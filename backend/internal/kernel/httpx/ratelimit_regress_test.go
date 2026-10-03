package httpx_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/ratelimit"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// recLimiter records the keys it is asked about and refuses keys in deny.
type recLimiter struct {
	keys []string
	deny map[string]bool
}

func (l *recLimiter) Allow(k string) bool { l.keys = append(l.keys, k); return !l.deny[k] }

func reqFrom(remote string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.RemoteAddr = remote
	return req
}

// Given an anonymous request, When RateLimit runs, Then it keys on "ip:<client ip>";
// with a principal already set it keys on "t:<tenant>".
func TestREG_KERNEL_HTTPX_016_RateLimitKeySelection(t *testing.T) {
	lim := &recLimiter{}
	tid := uuid.New()

	anon := gin.New()
	anon.GET("/x", httpx.RateLimit(lim), okHandler)
	do(anon, reqFrom("203.0.113.7:5555"))

	authed := gin.New()
	authed.GET("/x", func(c *gin.Context) { c.Set("principal", &tenancy.Principal{TenantID: tid}) }, httpx.RateLimit(lim), okHandler)
	do(authed, reqFrom("203.0.113.7:5555"))

	want := []string{"ip:203.0.113.7", "t:" + tid.String()}
	if len(lim.keys) != 2 || lim.keys[0] != want[0] || lim.keys[1] != want[1] {
		t.Fatalf("keys = %v want %v", lim.keys, want)
	}
}

// Given a budget of 2, When a 3rd request arrives, Then 429 RATE_LIMITED in the standard
// envelope (with request id) and the handler does not run; a different client is unaffected.
func TestREG_KERNEL_HTTPX_017_RateLimit429Envelope(t *testing.T) {
	hits := 0
	r := gin.New()
	r.Use(httpx.WithRequestID(), httpx.RateLimit(ratelimit.NewInProcess(0.001, 2)))
	r.GET("/x", func(c *gin.Context) { hits++; c.Status(200) })
	for i := 0; i < 2; i++ {
		if w := do(r, reqFrom("198.51.100.1:1")); w.Code != 200 {
			t.Fatalf("request %d within budget: %d", i+1, w.Code)
		}
	}
	w := do(r, reqFrom("198.51.100.1:1"))
	e := expectError(t, w, http.StatusTooManyRequests, "RATE_LIMITED", "too many requests")
	if e.Error.RequestID == "" || hits != 2 {
		t.Fatalf("request_id=%q hits=%d", e.Error.RequestID, hits)
	}
	if w := do(r, reqFrom("198.51.100.2:1")); w.Code != 200 {
		t.Fatalf("another client was throttled: %d", w.Code)
	}
}

// Given a throttled request, When 429 is returned, Then a Retry-After header (whole
// seconds >= 1) tells the client when to retry.
func TestREG_KERNEL_HTTPX_018_RateLimit429HasRetryAfter(t *testing.T) {
	r := gin.New()
	r.Use(httpx.RateLimit(ratelimit.NewInProcess(0.001, 1)))
	r.GET("/x", okHandler)
	do(r, reqFrom("198.51.100.9:1"))
	w := do(r, reqFrom("198.51.100.9:1"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("setup: want 429, got %d", w.Code)
	}
	n, err := strconv.Atoi(w.Header().Get("Retry-After"))
	testkit.KnownBug(t, "NEW-KERNEL-HTTPX-1", err != nil || n < 1,
		"429 RATE_LIMITED has no Retry-After header (middleware.go:101-104 RateLimit calls Fail only); clients/pollers cannot back off correctly")
}

// SEC-4. Given production wiring (gin.New default proxy trust, RateLimit on /api/v1
// BEFORE RequireAuth) behind Cloudflare, so every request arrives from the same edge
// address, When clinic A's user exhausts the budget, Then a user of clinic B — a
// different real client (own CF-Connecting-IP) with their own valid token — still gets
// through: buckets must be per real client / per principal, not per proxy address.
func TestREG_KERNEL_HTTPX_019_SEC4_UsersBehindSameProxyShareBucket(t *testing.T) {
	ts := tokenSvc()
	tokA, _, _ := ts.IssueAccess(uuid.New(), uuid.New(), "a@clinic-a", nil, nil, nil, nil, "")
	tokB, _, _ := ts.IssueAccess(uuid.New(), uuid.New(), "b@clinic-b", nil, nil, nil, nil, "")

	r := gin.New() // as cmd/api/main.go: no SetTrustedProxies / TrustedPlatform
	v1 := r.Group("/api/v1")
	v1.Use(httpx.RateLimit(ratelimit.NewInProcess(0.001, 3))) // main.go:267 — before auth
	v1.GET("/queue", httpx.RequireAuth(ts), okHandler)

	const cfEdge = "172.70.1.1" // Cloudflare edge, as Caddy forwards it
	call := func(tok, realIP string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/queue", nil)
		req.RemoteAddr = "127.0.0.1:40000" // Caddy on the VPS
		req.Header.Set("X-Forwarded-For", cfEdge)
		req.Header.Set("CF-Connecting-IP", realIP)
		req.Header.Set("Authorization", "Bearer "+tok)
		return do(r, req).Code
	}
	for i := 0; i < 3; i++ {
		if c := call(tokA, "196.188.10.1"); c != 200 {
			t.Fatalf("clinic A request %d: %d", i+1, c)
		}
	}
	if c := call(tokA, "196.188.10.1"); c != http.StatusTooManyRequests {
		t.Fatalf("setup: clinic A should be throttled after its budget, got %d", c)
	}
	codeB := call(tokB, "196.188.20.2")
	if codeB != 200 && codeB != http.StatusTooManyRequests {
		t.Fatalf("clinic B request: unexpected %d", codeB)
	}
	testkit.KnownBug(t, "SEC-4", codeB == http.StatusTooManyRequests,
		"RateLimit runs before RequireAuth (cmd/api/main.go:267) and keys on ClientIP = the Cloudflare edge "+
			"(middleware.go:97-101): a different clinic's user with a different CF-Connecting-IP got 429 from clinic A's bucket")
}
