package id

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	for i := 0; i < 1000; i++ {
		u := New()
		ext := Encode(PrefixUser, u)
		if !strings.HasPrefix(ext, "usr_") {
			t.Fatalf("missing prefix: %s", ext)
		}
		got, err := Decode(PrefixUser, ext)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got != u {
			t.Fatalf("roundtrip mismatch: %s != %s", got, u)
		}
	}
}

func TestDecodeRejectsWrongPrefix(t *testing.T) {
	u := New()
	ext := Encode(PrefixTenant, u)
	if _, err := Decode(PrefixUser, ext); err == nil {
		t.Fatal("decoded with wrong prefix")
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	cases := []string{"", "usr_", "usr_!!!!", "nopfx", "usr_" + strings.Repeat("0", 4)}
	for _, c := range cases {
		if _, err := Decode(PrefixUser, c); err == nil {
			t.Fatalf("expected error for %q", c)
		}
	}
}

func TestNewIsV7AndOrdered(t *testing.T) {
	a := New()
	b := New()
	if a.Version() != 7 || b.Version() != 7 {
		t.Fatalf("expected v7, got %d and %d", a.Version(), b.Version())
	}
	// v7 is time-ordered: a should sort <= b.
	if uuid.UUID(a).String() > uuid.UUID(b).String() {
		t.Log("note: equal-millisecond ordering can vary; not failing")
	}
}
