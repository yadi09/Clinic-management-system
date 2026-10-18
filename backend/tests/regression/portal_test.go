package regression

// The patient portal: a patient signs in with the card number and sees their own
// record — and nobody else's, and only what the clinic chose to show.

import (
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/reicb/clinicsaas/internal/testkit"
)

type portalMe struct {
	FirstName string `json:"first_name"`
	Clinic    struct {
		Name string `json:"name"`
	} `json:"clinic"`
	Treatments []struct {
		Title string `json:"title"`
		Of    int    `json:"of"`
		Done  int    `json:"done"`
	} `json:"treatments"`
	Money *struct {
		Paid     string  `json:"paid"`
		ToPay    string  `json:"to_pay"`
		Unbilled *string `json:"unbilled"`
	} `json:"money"`
	Chart *struct {
		Items []struct {
			Tooth     int     `json:"tooth"`
			Kind      string  `json:"kind"`
			Status    string  `json:"status"`
			CreatedBy *string `json:"created_by"`
		} `json:"items"`
	} `json:"chart"`
}

func portalOn(t *testing.T, c *testkit.Clinic, over map[string]any) {
	t.Helper()
	body := map[string]any{"enabled": true, "show_money": true, "show_unbilled": true, "show_teeth": true, "show_3d": true, "welcome_note": ""}
	for k, v := range over {
		body[k] = v
	}
	srv.As(t, c, "owner").Do("PUT", "/portal-settings", body).Expect(t, 200, "save portal settings")
}

func portalSignIn(t *testing.T, slug, card string) (string, testkit.Resp) {
	t.Helper()
	return portalSignInFrom(t, slug, card, "196.188."+strconv.Itoa(int(portalIP.Add(1)%250))+".7")
}

var portalIP atomic.Int32

func portalSignInFrom(t *testing.T, slug, card, ip string) (string, testkit.Resp) {
	t.Helper()
	cl := srv.Anon(t)
	cl.Header = map[string]string{"CF-Connecting-IP": ip}
	r := cl.Do("POST", "/portal/"+slug+"/login", map[string]any{"card": card})
	var s struct {
		Token string `json:"token"`
	}
	if r.Status == 200 {
		r.Decode(t, &s)
	}
	return s.Token, r
}

func portalMeOf(t *testing.T, slug, token string) (portalMe, testkit.Resp) {
	t.Helper()
	cl := srv.Anon(t)
	cl.Header = map[string]string{"X-Portal-Token": token}
	r := cl.Do("GET", "/portal/"+slug+"/me", nil)
	var me portalMe
	if r.Status == 200 {
		r.Decode(t, &me)
	}
	return me, r
}

// REG_PORTAL_001: off by default; once on, the card number opens the patient's own
// page, case and spaces ignored, with their treatment, money and chart.
func TestREG_PORTAL_001_CardNumberOpensOwnRecord(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := createPatient(t, srv.As(t, c, "receptionist"), "Meron", "Alem")
	createPlan(t, doc, p.ID, "4500", 3, "")
	put(t, doc, p.ID, map[string][]it{"36": {{"kind": "root_canal", "status": "planned"}}}).Expect(t, 200, "chart")

	if _, r := portalSignIn(t, c.Slug, p.MRN); r.Status != 403 || r.Code != "PORTAL_OFF" {
		t.Fatalf("portal is off by default, sign in = %d %s", r.Status, r.Code)
	}
	portalOn(t, c, nil)
	tok, r := portalSignIn(t, c.Slug, " "+strings.ToLower(p.MRN)+" ")
	r.Expect(t, 200, "sign in")
	me, r := portalMeOf(t, c.Slug, tok)
	r.Expect(t, 200, "me")
	if me.FirstName != "Meron" || me.Clinic.Name == "" {
		t.Fatalf("me = %+v", me)
	}
	if len(me.Treatments) != 1 || me.Treatments[0].Of != 3 {
		t.Fatalf("treatments = %+v", me.Treatments)
	}
	if me.Money == nil || me.Chart == nil || len(me.Chart.Items) != 1 || me.Chart.Items[0].Tooth != 36 || me.Chart.Items[0].Kind != "root_canal" || me.Chart.Items[0].Status != "planned" {
		t.Fatalf("money/chart = %+v %+v", me.Money, me.Chart)
	}
	if me.Chart.Items[0].CreatedBy != nil {
		t.Fatalf("a staff name reached the patient's page")
	}
}

// REG_PORTAL_002: every way of failing looks the same, and a made-up token opens nothing.
func TestREG_PORTAL_002_FailuresAreAllTheSame(t *testing.T) {
	c := newClinic(t)
	portalOn(t, c, nil)
	_, a := portalSignIn(t, c.Slug, "NOPE-999")
	_, b := portalSignIn(t, "no-such-clinic-xyz", "NOPE-999")
	if a.Status != 401 || b.Status != 401 || a.Message != b.Message {
		t.Fatalf("unknown card %d %q vs unknown clinic %d %q", a.Status, a.Message, b.Status, b.Message)
	}
	if _, r := portalMeOf(t, c.Slug, "garbage"); r.Status != 401 {
		t.Fatalf("garbage token = %d", r.Status)
	}
	if _, r := portalMeOf(t, c.Slug, ""); r.Status != 401 {
		t.Fatalf("no token = %d", r.Status)
	}
}

// REG_PORTAL_003: a patient of one clinic cannot read through another clinic's page,
// even carrying a genuine token.
func TestREG_PORTAL_003_TokenIsForOneClinic(t *testing.T) {
	a, b := newClinic(t), newClinic(t)
	portalOn(t, a, nil)
	portalOn(t, b, nil)
	p := createPatient(t, srv.As(t, a, "receptionist"), "Hana", "Girma")
	tok, r := portalSignIn(t, a.Slug, p.MRN)
	r.Expect(t, 200, "sign in")
	if _, r := portalMeOf(t, b.Slug, tok); r.Status != 401 {
		t.Fatalf("a token from clinic A opened clinic B: %d", r.Status)
	}
	// The same card number at clinic B is a different (or no) person.
	if tok2, r := portalSignIn(t, b.Slug, p.MRN); r.Status == 200 {
		if me, _ := portalMeOf(t, b.Slug, tok2); me.FirstName == "Hana" {
			t.Fatalf("clinic B showed clinic A's patient")
		}
	}
}

// REG_PORTAL_004: what the clinic hides is not in the answer at all.
func TestREG_PORTAL_004_ClinicChoosesWhatIsShown(t *testing.T) {
	c := newClinic(t)
	p := createPatient(t, srv.As(t, c, "receptionist"), "Sara", "Tesfaye")
	put(t, srv.As(t, c, "doctor"), p.ID, map[string][]it{"16": {{"kind": "caries", "surface": "O", "status": "existing"}}}).Expect(t, 200, "chart")
	portalOn(t, c, map[string]any{"show_money": false, "show_teeth": false})
	tok, r := portalSignIn(t, c.Slug, p.MRN)
	r.Expect(t, 200, "sign in")
	me, _ := portalMeOf(t, c.Slug, tok)
	if me.Money != nil || me.Chart != nil {
		t.Fatalf("hidden parts leaked: %+v %+v", me.Money, me.Chart)
	}
	portalOn(t, c, map[string]any{"show_unbilled": false})
	me, _ = portalMeOf(t, c.Slug, tok)
	if me.Money == nil || me.Money.Unbilled != nil {
		t.Fatalf("unbilled should be hidden: %+v", me.Money)
	}
}

// REG_PORTAL_005: turning the portal off closes it at once, even for a signed-in patient;
// a deleted patient can no longer sign in.
func TestREG_PORTAL_005_OffMeansOff(t *testing.T) {
	c := newClinic(t)
	p := createPatient(t, srv.As(t, c, "receptionist"), "Dawit", "Bekele")
	portalOn(t, c, nil)
	tok, r := portalSignIn(t, c.Slug, p.MRN)
	r.Expect(t, 200, "sign in")
	portalOn(t, c, map[string]any{"enabled": false})
	if _, r := portalMeOf(t, c.Slug, tok); r.Status != 401 {
		t.Fatalf("closed portal still answered: %d", r.Status)
	}
	portalOn(t, c, nil)
	exec(t, `UPDATE patients SET deleted_at = now() WHERE mrn = $1 AND tenant_id = (SELECT id FROM tenants WHERE slug = $2)`, p.MRN, c.Slug)
	if _, r := portalSignIn(t, c.Slug, p.MRN); r.Status != 401 {
		t.Fatalf("deleted patient signed in: %d", r.Status)
	}
}

// REG_PORTAL_006: only someone who manages the clinic can change the switches.
func TestREG_PORTAL_006_SettingsNeedClinicManage(t *testing.T) {
	c := newClinic(t)
	r := srv.As(t, c, "receptionist").Do("PUT", "/portal-settings", map[string]any{"enabled": true})
	if r.Status != 403 {
		t.Fatalf("receptionist changed portal settings: %d", r.Status)
	}
	srv.As(t, c, "owner").Do("GET", "/portal-settings", nil).Expect(t, 200, "read settings")
}

// REG_PORTAL_007: guessing card numbers is slow — one address gets a handful of tries.
func TestREG_PORTAL_007_GuessingIsLimited(t *testing.T) {
	c := newClinic(t)
	portalOn(t, c, nil)
	ip := "41.66.9." + strconv.Itoa(int(portalIP.Add(1)%250))
	limited := false
	for i := 0; i < 12; i++ {
		if _, r := portalSignInFrom(t, c.Slug, "GUESS-"+strconv.Itoa(i), ip); r.Status == 429 {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("twelve wrong guesses from one address were never slowed down")
	}
}
