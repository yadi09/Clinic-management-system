package testkit

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
)

// fakeBank stands in for the Verify.ET vendor so the regression suite can exercise the
// whole "the bank confirmed it" path without contacting anything real. What it answers
// is chosen by the transaction reference, so a test says what it wants in the number:
//
//	OK<amount>-…    confirmed, to the clinic's own account, for <amount> (e.g. OK1500-A1)
//	WRONGAMT…       confirmed, but for 1.00
//	ELSEWHERE…      confirmed, but to somebody else's account
//	NF…             the bank has no such transaction
//	SLOW…           the bank is still working on it
//	anything else   the vendor is unavailable (what an unconfigured service looked like)
func newFakeBank() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasPrefix(r.URL.Path, "/api/verify") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var in struct {
			Reference         string `json:"reference"`
			SettlementAccount string `json:"settlementAccount"`
		}
		_ = json.Unmarshal(raw, &in)
		ref := strings.ToUpper(in.Reference)
		reply := func(v any) {
			w.Header().Set("content-type", "application/json")
			w.Header().Set("x-request-id", "fake-"+ref)
			_ = json.NewEncoder(w).Encode(v)
		}
		env := func(processing, status string, verified bool, data []map[string]any) map[string]any {
			return map[string]any{
				"requestId":    "req-" + ref,
				"verification": map[string]any{"requestId": "req-" + ref, "processingStatus": processing, "status": status, "verified": verified},
				"data":         data,
			}
		}
		paid := func(amount string, account string) map[string]any {
			return map[string]any{
				"status": "success", "verified": true, "amount": json.Number(amount), "currency": "ETB",
				"senderName": "Test Sender", "receiverAccount": account,
				"settlementAccountMatch": map[string]any{
					"matched": account == in.SettlementAccount, "matchConfidence": "high", "receiverAccount": account,
					"reason": map[bool]string{true: "matched", false: "candidate_account_mismatch"}[account == in.SettlementAccount],
				},
				"confirmationHistory": map[string]any{"scope": "platform", "isFirstConfirmation": true, "confirmedBefore": false},
			}
		}
		switch {
		case strings.HasPrefix(ref, "OK"):
			amt := strings.SplitN(strings.TrimPrefix(ref, "OK"), "-", 2)[0]
			reply(env("completed", "success", true, []map[string]any{paid(amt, in.SettlementAccount)}))
		case strings.HasPrefix(ref, "WRONGAMT"):
			reply(env("completed", "success", true, []map[string]any{paid("1", in.SettlementAccount)}))
		case strings.HasPrefix(ref, "ELSEWHERE"):
			reply(env("completed", "success", true, []map[string]any{paid("500", "0000000000")}))
		case strings.HasPrefix(ref, "NF"):
			reply(env("completed", "not_found", false, nil))
		case strings.HasPrefix(ref, "SLOW"):
			reply(env("processing", "", false, nil))
		default:
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
}
