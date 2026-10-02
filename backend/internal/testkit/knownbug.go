package testkit

import (
	"os"
	"testing"
)

// KnownBug records a regression test whose correct expectation is CURRENTLY violated
// by a known, catalogued bug (an ID from docs/production-readiness-audit-2026-10-02.html).
//
//   - present == true  → the bug is still there. The test is SKIPPED with a
//     "KNOWN BUG" message: visible in every run, never hiding a new regression.
//   - present == false → the bug is gone. The test FAILS and asks for the marker to
//     be removed, so the catalogue never claims a bug that was fixed (or keeps a
//     test that silently stopped checking anything).
//
// Set REGRESSION_STRICT=1 to make known bugs fail instead of skip (e.g. to list
// every open product bug as a red run).
func KnownBug(t testing.TB, id string, present bool, what string) {
	t.Helper()
	switch {
	case present && os.Getenv("REGRESSION_STRICT") == "1":
		t.Fatalf("KNOWN BUG %s (strict mode): %s", id, what)
	case present:
		t.Skipf("KNOWN BUG %s still present: %s", id, what)
	default:
		t.Fatalf("KNOWN BUG %s now passes — the bug looks fixed. Remove the KnownBug marker so this "+
			"test protects the fix: %s", id, what)
	}
}
