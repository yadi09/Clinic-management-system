package payments

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Given receipt numbers of every sign, When rendered, Then they read as plain integers.
func TestREG_KERNEL_PAY_040_ItoaRendersReceiptNumbers(t *testing.T) {
	for n, want := range map[int64]string{0: "0", 7: "7", 1234567890: "1234567890", -42: "-42"} {
		if got := itoa(n); got != want {
			t.Errorf("itoa(%d) = %q, want %q", n, got, want)
		}
	}
}

// Given the same claim typed differently, When the idempotency key is built, Then it is stable; a different reference or clinic gets a different key.
func TestREG_KERNEL_PAY_041_IdempotencyKeyIsStablePerClaim(t *testing.T) {
	tid, rail := uuid.New(), uuid.New()
	a, b := idemKey(tid, rail, " ft-1 "), idemKey(tid, rail, "FT-1")
	if a != b || !strings.HasPrefix(a, "clinicos:"+tid.String()+":"+rail.String()+":") {
		t.Fatalf("not stable: %q %q", a, b)
	}
	if a == idemKey(tid, rail, "FT-2") || a == idemKey(uuid.New(), rail, "FT-1") {
		t.Fatal("different claims must not share a key")
	}
	if nullif("  ") != nil || *nullif("x") != "x" || deref(nil) != "" {
		t.Fatal("nullif/deref")
	}
}
