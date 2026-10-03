package verifyet_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/verifyet"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Given a fake Verify.ET that confirms a matched receipt but sends NO amount (absent or null),
// When Decide checks it against a 100.00 bill,
// Then it must not be accepted — an amount we could not read is not an amount that matched.
//
// NEW-KERNEL-VERIFYET-1: decide.go gates the amount with `expected != "" && r.Amount != ""`,
// so a missing/null amount silently skips the amount gate and the payment is ACCEPTED for
// an unknown sum (fail-open on the one gate that proves it is the right money).
func TestREG_KERNEL_VERIFYET_040_MissingAmountIsNotAccepted(t *testing.T) {
	for _, amount := range []string{``, `"amount":null,`} {
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
		if v.State != verifyet.Accept {
			continue // correct behaviour
		}
		testkit.KnownBug(t, "NEW-KERNEL-VERIFYET-1", true,
			"a verified receipt with no amount is ACCEPTED against a 100.00 bill (decide.go amount gate skips when r.Amount==\"\")")
		return
	}
	testkit.KnownBug(t, "NEW-KERNEL-VERIFYET-1", false, "missing amount now reviewed")
}
