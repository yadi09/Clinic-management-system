package service

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/verification"
)

type medicineT = verification.Medicine

func medicine(name, dose, freq, dur string) medicineT {
	return medicineT{Name: name, Dose: dose, Frequency: freq, Duration: dur}
}

func TestDerivedTokensAreStableUnguessableAndPerPaper(t *testing.T) {
	s := New(nil, []byte("0123456789abcdef0123456789abcdef"))
	tenant, subject := uuid.New(), uuid.New()
	tok, code := s.derive(tenant, "dental_rx", subject, "hash-a", 0)
	again, againCode := s.derive(tenant, "dental_rx", subject, "hash-a", 0)
	if tok != again || code != againCode {
		t.Fatal("the same paper must always get the same check, or a reprint would carry a new QR")
	}
	if !tokenRe.MatchString(tok) {
		t.Fatalf("token %q is not 26 base32 characters", tok)
	}
	if len(code) != 8 || strings.Trim(code, codeAlphabet) != "" {
		t.Fatalf("code %q uses characters a person cannot tell apart", code)
	}
	for name, other := range map[string][2]string{
		"another content": {func() string { x, _ := s.derive(tenant, "dental_rx", subject, "hash-b", 0); return x }(), tok},
		"another paper":   {func() string { x, _ := s.derive(tenant, "dental_rx", uuid.New(), "hash-a", 0); return x }(), tok},
		"another clinic":  {func() string { x, _ := s.derive(uuid.New(), "dental_rx", subject, "hash-a", 0); return x }(), tok},
		"another kind":    {func() string { x, _ := s.derive(tenant, "encounter_rx", subject, "hash-a", 0); return x }(), tok},
		"a redrawn code":  {func() string { x, _ := s.derive(tenant, "dental_rx", subject, "hash-a", 1); return x }(), tok},
	} {
		if other[0] == other[1] {
			t.Errorf("%s gave the same token", name)
		}
	}
	// A different secret is a different paper: tokens cannot be computed from the
	// public parts alone.
	other := New(nil, []byte("ffffffffffffffffffffffffffffffff"))
	if x, _ := other.derive(tenant, "dental_rx", subject, "hash-a", 0); x == tok {
		t.Fatal("the secret does not matter")
	}
}

func TestSmallHelpers(t *testing.T) {
	if pretty("K7MQ4XPR") != "K7MQ-4XPR" || pretty("ABC") != "ABC" {
		t.Error("pretty")
	}
	if displayName("Abebe", "Kebede") != "Abebe K." || displayName("Abebe", "") != "Abebe" || displayName(" Abebe ", " kebede ") != "Abebe K." {
		t.Error("displayName: a first name and a surname initial, nothing more")
	}
	if tail("rx_abcdef123456", 6) != "123456" || tail("ab", 6) != "ab" {
		t.Error("tail")
	}
	loc := time.FixedZone("EAT", 3*3600)
	from := time.Date(2026, 10, 11, 23, 30, 0, 0, loc)
	if calendarDays(from, time.Date(2026, 10, 12, 0, 10, 0, 0, loc)) != 1 {
		t.Error("forty minutes across midnight is a day later on the calendar")
	}
	if calendarDays(from, from.Add(-48*time.Hour)) != 0 {
		t.Error("a paper written 'in the future' is today, not negative")
	}
}

func TestAPaperThatChangesIsNotTheSamePaper(t *testing.T) {
	a := &source{patientID: uuid.New()}
	a.meds = append(a.meds, medicine("Amoxicillin", "1 cap", "3 times", "7 days"))
	b := *a
	if a.hash() != b.hash() {
		t.Fatal("the same lines must hash the same")
	}
	b.meds = append([]medicineT(nil), a.meds...)
	b.meds[0].Duration = "70 days"
	if a.hash() == b.hash() {
		t.Fatal("changing a duration must change the hash: that is what 'a newer version exists' rests on")
	}
	c := *a
	c.note = "a different note"
	c.writtenAt = time.Now()
	if a.hash() != c.hash() {
		t.Fatal("a note or the date is not part of what makes a prescription the same")
	}
}
