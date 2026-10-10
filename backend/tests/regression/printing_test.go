package regression

import (
	"encoding/base64"
	"strings"
	"testing"
)

// How a clinic's printed papers look, and which papers have already been printed.
//
// The look is a JSON document the front end owns; the server keeps it valid and
// small, keeps the logo to a real small image, lets everyone who prints read it and
// only clinic.manage change it. The print log is what lets a reprint say DUPLICATE
// on every computer in the clinic, not just the one that printed the original.

const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

type prSettings struct {
	Settings map[string]any `json:"settings"`
	Logo     string         `json:"logo"`
}

// TestREG_PRINT_001_DefaultsThenSaveAndReadBack: Given a clinic that never
// customised its papers, When any staff member reads the settings, Then they get an
// empty document and no logo; When the owner saves a look and a logo, Then the next
// read (by another role) returns both.
func TestREG_PRINT_001_DefaultsThenSaveAndReadBack(t *testing.T) {
	c := newClinic(t)
	owner, cashier := srv.As(t, c, "owner"), srv.As(t, c, "cashier")

	var s prSettings
	cashier.Do("GET", "/org/print-settings", nil).Expect(t, 200, "read defaults").Decode(t, &s)
	if len(s.Settings) != 0 || s.Logo != "" {
		t.Fatalf("a never-customised clinic returned %+v", s)
	}

	body := map[string]any{
		"settings": map[string]any{"version": 1, "identity": map[string]any{"nameEn": "Abeba Dental Clinic", "tin": "0012345678"}},
		"logo":     "data:image/png;base64," + tinyPNG,
	}
	owner.Do("PUT", "/org/print-settings", body).Expect(t, 200, "save look")
	cashier.Do("GET", "/org/print-settings", nil).Expect(t, 200, "read back").Decode(t, &s)
	id, _ := s.Settings["identity"].(map[string]any)
	if id["tin"] != "0012345678" || !strings.HasPrefix(s.Logo, "data:image/png;base64,") {
		t.Fatalf("read back %+v", s)
	}
}

// TestREG_PRINT_002_LogoStaysUntilRemoved: Given a stored logo, When the settings
// are saved again WITHOUT a logo field, Then the logo is kept; When saved with "",
// Then it is removed.
func TestREG_PRINT_002_LogoStaysUntilRemoved(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": map[string]any{"a": 1}, "logo": "data:image/png;base64," + tinyPNG}).Expect(t, 200, "with logo")
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": map[string]any{"a": 2}}).Expect(t, 200, "without logo field")
	var s prSettings
	owner.Do("GET", "/org/print-settings", nil).Expect(t, 200, "read").Decode(t, &s)
	if s.Logo == "" || s.Settings["a"] != float64(2) {
		t.Fatalf("logo %q settings %+v, want the logo kept and the settings replaced", s.Logo, s.Settings)
	}
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": map[string]any{"a": 3}, "logo": ""}).Expect(t, 200, "remove logo")
	owner.Do("GET", "/org/print-settings", nil).Expect(t, 200, "read").Decode(t, &s)
	if s.Logo != "" {
		t.Fatalf("logo %q after removing it", s.Logo)
	}
}

// TestREG_PRINT_003_OnlyARealSmallImageIsAccepted: Then a logo that is not an image,
// is an image type we do not draw, claims one type and holds another, is not valid
// base64 or is over 400 KB is refused 400 and nothing is stored.
func TestREG_PRINT_003_OnlyARealSmallImageIsAccepted(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	big := "data:image/png;base64," + base64.StdEncoding.EncodeToString(append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 401*1024)...))
	for what, logo := range map[string]string{
		"plain text":           "hello",
		"an svg with a script": "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte("<svg><script>alert(1)</script></svg>")),
		"html as png":          "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("<html><script>alert(1)</script></html>")),
		"broken base64":        "data:image/png;base64,@@@@",
		"too large":            big,
	} {
		owner.Do("PUT", "/org/print-settings", map[string]any{"settings": map[string]any{}, "logo": logo}).Expect(t, 400, what)
	}
	var s prSettings
	owner.Do("GET", "/org/print-settings", nil).Expect(t, 200, "read").Decode(t, &s)
	if s.Logo != "" {
		t.Fatalf("a refused logo was stored: %q", s.Logo[:30])
	}
}

// TestREG_PRINT_004_SettingsMustBeASmallObject: A body with no settings, settings
// that are not an object, or a document over 64 KB is refused.
func TestREG_PRINT_004_SettingsMustBeASmallObject(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	owner.Do("PUT", "/org/print-settings", map[string]any{}).Expect(t, 400, "no settings")
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": "text"}).Expect(t, 400, "a string")
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": []int{1}}).Expect(t, 400, "an array")
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": map[string]any{"blob": strings.Repeat("x", 70*1024)}}).Expect(t, 400, "too large")
	owner.Do("PUT", "/org/print-settings", "not json").Expect(t, 400, "not an object at all")
}

// TestREG_PRINT_005_OnlyClinicManageChangesTheLook: Reception and the cashier can
// read the settings (they print) but cannot save them; another clinic never sees them.
func TestREG_PRINT_005_OnlyClinicManageChangesTheLook(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	owner.Do("PUT", "/org/print-settings", map[string]any{"settings": map[string]any{"identity": map[string]any{"nameEn": "Mine"}}}).Expect(t, 200, "save")
	for _, role := range []string{"receptionist", "cashier", "doctor"} {
		cl := srv.As(t, c, role)
		cl.Do("GET", "/org/print-settings", nil).Expect(t, 200, role+" reads")
		cl.Do("PUT", "/org/print-settings", map[string]any{"settings": map[string]any{"x": 1}}).Expect(t, 403, role+" saves")
	}
	var theirs prSettings
	srv.As(t, newClinic(t), "owner").Do("GET", "/org/print-settings", nil).Expect(t, 200, "other clinic").Decode(t, &theirs)
	if len(theirs.Settings) != 0 {
		t.Fatalf("another clinic sees %+v", theirs.Settings)
	}
}

type prMark struct {
	Count   int    `json:"count"`
	FirstBy string `json:"first_by"`
	LastBy  string `json:"last_by"`
}

// TestREG_PRINT_006_APrintIsCountedSoAReprintCanSayDuplicate: Given a receipt, When
// it is printed, Then it is the first (count 1); When printed again — by another
// person, from another computer — Then it is the second and names who printed first
// and last; a different receipt, and the same reference of another kind, start at 1.
func TestREG_PRINT_006_APrintIsCountedSoAReprintCanSayDuplicate(t *testing.T) {
	c := newClinic(t)
	cashier, recp := srv.As(t, c, "cashier"), srv.As(t, c, "receptionist")
	var m prMark
	cashier.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": "RCP-000010"}).Expect(t, 200, "first").Decode(t, &m)
	if m.Count != 1 {
		t.Fatalf("first print count = %d, want 1", m.Count)
	}
	recp.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": "RCP-000010"}).Expect(t, 200, "second").Decode(t, &m)
	if m.Count != 2 || m.FirstBy == "" || m.LastBy == "" || m.FirstBy == m.LastBy {
		t.Fatalf("second print = %+v, want count 2 and two different people", m)
	}
	cashier.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": "RCP-000011"}).Expect(t, 200, "other receipt").Decode(t, &m)
	if m.Count != 1 {
		t.Fatalf("another receipt count = %d, want 1", m.Count)
	}
	cashier.Do("POST", "/org/print-log", map[string]any{"kind": "statement", "ref": "RCP-000010"}).Expect(t, 200, "other kind").Decode(t, &m)
	if m.Count != 1 {
		t.Fatalf("same reference, other kind: count = %d, want 1", m.Count)
	}
}

// TestREG_PRINT_007_PrintLogRefusesNothingAndIsPerClinic: A kind or reference that is
// empty or absurdly long is refused; two clinics with the same receipt number are
// counted separately.
func TestREG_PRINT_007_PrintLogRefusesNothingAndIsPerClinic(t *testing.T) {
	a, b := newClinic(t), newClinic(t)
	ca, cb := srv.As(t, a, "cashier"), srv.As(t, b, "cashier")
	ca.Do("POST", "/org/print-log", map[string]any{"kind": "", "ref": "RCP-1"}).Expect(t, 400, "empty kind")
	ca.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": ""}).Expect(t, 400, "empty ref")
	ca.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": strings.Repeat("x", 65)}).Expect(t, 400, "long ref")
	ca.Do("POST", "/org/print-log", map[string]any{"kind": strings.Repeat("k", 33), "ref": "r"}).Expect(t, 400, "long kind")
	ca.Do("POST", "/org/print-log", "nope").Expect(t, 400, "not an object")

	var m prMark
	ca.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": "RCP-000001"}).Expect(t, 200, "a1")
	ca.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": "RCP-000001"}).Expect(t, 200, "a2")
	cb.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": "RCP-000001"}).Expect(t, 200, "b1").Decode(t, &m)
	if m.Count != 1 {
		t.Fatalf("another clinic's same receipt number counted %d, want 1", m.Count)
	}
}

// TestREG_PRINT_008_PeekDoesNotCount: Looking at a paper's count (the preview does
// this to decide whether to say DUPLICATE) never changes it; an unprinted paper is 0.
func TestREG_PRINT_008_PeekDoesNotCount(t *testing.T) {
	c := newClinic(t)
	cashier := srv.As(t, c, "cashier")
	var m prMark
	cashier.Do("GET", "/org/print-log?kind=receipt&ref=RCP-000077", nil).Expect(t, 200, "peek unprinted").Decode(t, &m)
	if m.Count != 0 {
		t.Fatalf("unprinted count = %d, want 0", m.Count)
	}
	cashier.Do("POST", "/org/print-log", map[string]any{"kind": "receipt", "ref": "RCP-000077"}).Expect(t, 200, "print")
	for i := 0; i < 3; i++ {
		cashier.Do("GET", "/org/print-log?kind=receipt&ref=RCP-000077", nil).Expect(t, 200, "peek").Decode(t, &m)
	}
	if m.Count != 1 || m.FirstBy == "" {
		t.Fatalf("after peeking: %+v, want count 1 with the first printer named", m)
	}
	cashier.Do("GET", "/org/print-log?kind=&ref=x", nil).Expect(t, 400, "peek without a kind")
}
