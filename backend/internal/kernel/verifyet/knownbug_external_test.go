package verifyet_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/verifyet"
)

// Given a fake Verify.ET that confirms a matched receipt but sends NO amount (absent or null),
// When Decide checks it against a 100.00 bill,
// Then it must not be accepted — an amount we could not read is not an amount that matched.
//
// NEW-KERNEL-VERIFYET-1: decide.go gates the amount with `expected != "" && r.Amount != ""`,
// so a missing/null amount silently skips the amount gate and the payment is ACCEPTED for
// an unknown sum (fail-open on the one gate that proves it is the right money).
func TestREG_KERNEL_VERIFYET_040_MissingAmountIsNotAccepted(t *testing.T) {
	// NEW-KERNEL-VERIFYET-1, fixed 2026-10-10: an absent, null or blank amount is "review",
	// never "verified"; when the caller gave no expected amount the gate is still skipped.
	for _, amount := range []string{``, `"amount":null,`, `"amount":"",`, `"amount":"  ",`} {
		body := `{"requestId":"r","verification":{"processingStatus":"completed","status":"success","verified":true},
		  "data":[{"status":"success","verified":true,` + amount + `"currency":"ETB",
		  "settlementAccountMatch":{"matched":true,"matchConfidence":"high","reason":"receiver_account_exact_match"},
		  "confirmationHistory":{"scope":"platform","isFirstConfirmation":true}}]}`
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, body)
		}))
		defer srv.Close()
		c := verifyet.New("k", srv.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
		res, err := c.Verify(context.Background(), verifyet.Request{Reference: "FT1"})
		if err != nil {
			t.Fatal(err)
		}
		v := verifyet.Decide(res, "100.00")
		if v.State != verifyet.Review || !strings.Contains(v.Detail, "no_amount") || !strings.Contains(v.Reason, "confirm it by hand") {
			t.Errorf("amount %q against a 100.00 bill: %+v, want review naming the missing amount and a hand check", amount, v)
		}
		// With no expected amount the gate is the caller's deliberate skip. Only the two
		// shapes whose settlement data still decodes can be accepted on the other gates;
		// a blank-string amount also loses the account details and stays in review.
		if skipped := verifyet.Decide(res, ""); strings.Contains(amount, `null`) || amount == `` {
			if skipped.State != verifyet.Accept {
				t.Errorf("amount %q with no expected amount: %+v, want accepted", amount, skipped)
			}
		} else if skipped.State == verifyet.Accept {
			t.Errorf("amount %q (blank text) was accepted with no expected amount", amount)
		}
	}
}
