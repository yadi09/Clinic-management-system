package regression

// The devices a user is signed in on: seen with their browser, real IP and country,
// named, renewed without losing their start, and signed out one at a time.

import (
	"strings"
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/testkit"
)

type deviceOut struct {
	ID         string    `json:"id"`
	UserAgent  string    `json:"user_agent"`
	IP         string    `json:"ip"`
	Country    string    `json:"country"`
	Label      string    `json:"label"`
	StartedAt  time.Time `json:"started_at"`
	LastActive time.Time `json:"last_active"`
	Current    bool      `json:"current"`
}

func deviceLogin(t *testing.T, c *testkit.Clinic, ua, ip, country string) *testkit.Client {
	t.Helper()
	cl := srv.Anon(t)
	cl.Header = map[string]string{"User-Agent": ua, "CF-Connecting-IP": ip, "CF-IPCountry": country}
	r := cl.Do("POST", "/auth/login", map[string]any{"workspace": c.Slug, "email": c.Owner.Email, "password": testkit.StaffPassword})
	r.Expect(t, 200, "sign in")
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	r.Decode(t, &tok)
	cl.Token = tok.AccessToken
	return cl
}

func devices(t *testing.T, cl *testkit.Client) []deviceOut {
	t.Helper()
	var out []deviceOut
	cl.Do("GET", "/auth/sessions", nil).Expect(t, 200, "list devices").Decode(t, &out)
	return out
}

func byUA(ds []deviceOut, frag string) *deviceOut {
	for i := range ds {
		if strings.Contains(ds[i].UserAgent, frag) {
			return &ds[i]
		}
	}
	return nil
}

// TestREG_AUTH_SESS_001_EveryDeviceIsListedWithItsFacts: two devices; each shows its
// browser string, the real visitor IP and country (not the proxy's), when it signed
// in; the one asking is marked current.
func TestREG_AUTH_SESS_001_EveryDeviceIsListedWithItsFacts(t *testing.T) {
	c := newClinic(t)
	pc := deviceLogin(t, c, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0 Safari/537.36", "196.188.10.20", "ET")
	phone := deviceLogin(t, c, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", "41.77.1.2", "KE")
	ds := devices(t, pc)
	if len(ds) != 2 {
		t.Fatalf("devices = %d, want 2: %+v", len(ds), ds)
	}
	a, b := byUA(ds, "Windows"), byUA(ds, "iPhone")
	if a == nil || b == nil {
		t.Fatalf("a device is missing: %+v", ds)
	}
	if a.IP != "196.188.10.20" || a.Country != "ET" || b.IP != "41.77.1.2" || b.Country != "KE" {
		t.Fatalf("ip/country: %+v %+v", a, b)
	}
	if !a.Current || b.Current {
		t.Fatalf("current flags: pc=%v phone=%v", a.Current, b.Current)
	}
	if got := byUA(devices(t, phone), "iPhone"); got == nil || !got.Current {
		t.Fatalf("from the phone, the phone is current: %+v", got)
	}
	if a.StartedAt.IsZero() || a.LastActive.Before(a.StartedAt) {
		t.Fatalf("times: %+v", a)
	}
}

// TestREG_AUTH_SESS_002_NameAndRenewalKeepTheDevice: a name is shown; renewing the
// sign-in keeps the original start and the name and moves "last active" on.
func TestREG_AUTH_SESS_002_NameAndRenewalKeepTheDevice(t *testing.T) {
	c := newClinic(t)
	pc := deviceLogin(t, c, "Mozilla/5.0 (Windows NT 10.0) Chrome/155.0", "196.188.10.20", "ET")
	before := byUA(devices(t, pc), "Windows")
	pc.Do("PUT", "/auth/sessions/"+before.ID+"/label", map[string]any{"label": "  Reception PC  "}).Expect(t, 204, "name it")
	if got := byUA(devices(t, pc), "Windows"); got.Label != "Reception PC" {
		t.Fatalf("label = %q", got.Label)
	}
	time.Sleep(1100 * time.Millisecond)
	pc.Do("POST", "/auth/refresh", nil).Expect(t, 200, "renew the sign-in")
	after := byUA(devices(t, pc), "Windows")
	if after == nil || after.ID == before.ID {
		t.Fatalf("a renewal replaces the session row: %+v", after)
	}
	if !after.StartedAt.Equal(before.StartedAt) || after.Label != "Reception PC" || !after.LastActive.After(before.LastActive) || after.Country != "ET" {
		t.Fatalf("after renewal: before %+v after %+v", before, after)
	}
	pc.Do("PUT", "/auth/sessions/"+after.ID+"/label", map[string]any{"label": ""}).Expect(t, 204, "unname")
	if byUA(devices(t, pc), "Windows").Label != "" {
		t.Fatal("the name was not removed")
	}
	pc.Do("PUT", "/auth/sessions/"+after.ID+"/label", map[string]any{"label": strings.Repeat("x", 61)}).Expect(t, 400, "name too long")
}

// TestREG_AUTH_SESS_003_OneDeviceCanBeSignedOutAndOnlyOthers: signing one device out
// ends it (its renewal is refused), keeps the rest; the current device cannot be
// signed out this way; unknown ids are 404; another clinic cannot reach them.
func TestREG_AUTH_SESS_003_OneDeviceCanBeSignedOutAndOnlyOthers(t *testing.T) {
	c := newClinic(t)
	pc := deviceLogin(t, c, "Mozilla/5.0 (Windows NT 10.0) Chrome/155.0", "196.188.10.20", "ET")
	phone := deviceLogin(t, c, "Mozilla/5.0 (iPhone) Safari/604.1", "41.77.1.2", "KE")
	ds := devices(t, pc)
	me, other := byUA(ds, "Windows"), byUA(ds, "iPhone")

	pc.Do("DELETE", "/auth/sessions/"+me.ID, nil).Expect(t, 400, "not this device")
	pc.Do("DELETE", "/auth/sessions/ses_00000000000000000000000000", nil).Expect(t, 404, "no such device")
	pc.Do("DELETE", "/auth/sessions/nonsense", nil).Expect(t, 400, "bad id")
	pc.Do("PUT", "/auth/sessions/ses_00000000000000000000000000/label", map[string]any{"label": "x"}).Expect(t, 404, "no such device")
	pc.Do("PUT", "/auth/sessions/nonsense/label", map[string]any{"label": "x"}).Expect(t, 400, "bad id")
	pc.Do("PUT", "/auth/sessions/"+me.ID+"/label", map[string]any{"label": 5}).Expect(t, 400, "name not text")

	// Another clinic's owner cannot sign this device out or name it.
	stranger := srv.As(t, clinicB, "owner")
	stranger.Do("DELETE", "/auth/sessions/"+other.ID, nil).Expect(t, 404, "another clinic")
	stranger.Do("PUT", "/auth/sessions/"+other.ID+"/label", map[string]any{"label": "x"}).Expect(t, 404, "another clinic")
	if len(devices(t, pc)) != 2 {
		t.Fatal("a stranger changed the devices")
	}

	pc.Do("DELETE", "/auth/sessions/"+other.ID, nil).Expect(t, 204, "sign the phone out")
	if ds := devices(t, pc); len(ds) != 1 || !ds[0].Current {
		t.Fatalf("after signing out the phone: %+v", ds)
	}
	phone.Do("POST", "/auth/refresh", nil).Expect(t, 401, "a signed-out device cannot renew")
	pc.Do("DELETE", "/auth/sessions/"+other.ID, nil).Expect(t, 404, "already signed out")
	var events int
	one(t, `SELECT count(*) FROM event_outbox WHERE event_type = 'auth.user.session_revoked' AND tenant_id = $1`, &events, c.TenantID)
	if events != 1 {
		t.Fatalf("recorded %d sign-outs, want 1", events)
	}
}
