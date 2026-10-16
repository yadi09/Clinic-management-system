package http

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/identity"
)

func ctxWith(h map[string]string) *gin.Context {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET", "/", nil)
	c.Request.RemoteAddr = "104.23.208.134:443" // the proxy's own address
	for k, v := range h {
		c.Request.Header.Set(k, v)
	}
	return c
}

// TestClientIPPrefersTheAddressTheProxyReports: behind Cloudflare the connection's own
// address is the proxy's, so the address it reports is used; a missing or malformed
// header falls back to the connection's own.
func TestClientIPPrefersTheAddressTheProxyReports(t *testing.T) {
	for _, tc := range []struct {
		name string
		h    map[string]string
		want string
	}{
		{"reported", map[string]string{"CF-Connecting-IP": "196.188.10.20"}, "196.188.10.20"},
		{"v6", map[string]string{"CF-Connecting-IP": "2001:db8::1"}, "2001:db8::1"},
		{"malformed", map[string]string{"CF-Connecting-IP": "not-an-ip"}, "104.23.208.134"},
		{"absent", nil, "104.23.208.134"},
	} {
		if got := clientIP(ctxWith(tc.h)); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
}

// TestSignInCtxCarriesOnlyARealCountry: two letters, upper-cased; the proxy's "unknown"
// and "Tor" markers and anything else mean no country.
func TestSignInCtxCarriesOnlyARealCountry(t *testing.T) {
	for in, want := range map[string]string{"ET": "ET", " ke ": "KE", "XX": "", "T1": "", "": "", "ETH": ""} {
		if got := identity.ClientCountry(signInCtx(ctxWith(map[string]string{"CF-IPCountry": in}))); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

// TestSessionHandlersRefuseWithoutASignedInUser: the three device handlers answer 401
// when no principal is on the request (the route's own guard normally prevents it).
func TestSessionHandlersRefuseWithoutASignedInUser(t *testing.T) {
	h := &Handlers{}
	for name, call := range map[string]func(*gin.Context){"list": h.ListSessions, "revoke": h.RevokeSession, "label": h.LabelSession} {
		w := httptest.NewRecorder()
		gin.SetMode(gin.TestMode)
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("GET", "/", nil)
		call(c)
		if w.Code != 401 {
			t.Errorf("%s: %d, want 401", name, w.Code)
		}
	}
}
