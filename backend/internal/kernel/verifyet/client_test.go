package verifyet

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeVET is a stand-in for Verify.ET. It never talks to the real service: every
// test points the client's baseURL at this httptest server.
type fakeVET struct {
	mu    sync.Mutex
	calls []seen
	reply func(w http.ResponseWriter, r *http.Request)
}

type seen struct {
	Method, Path, Query, Key, Idem, CT string
	Body                               map[string]any
}

func newFake(t *testing.T, reply func(w http.ResponseWriter, r *http.Request)) (*fakeVET, *httptest.Server) {
	t.Helper()
	f := &fakeVET{reply: reply}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		f.mu.Lock()
		f.calls = append(f.calls, seen{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("x-api-key"),
			r.Header.Get("Idempotency-Key"), r.Header.Get("content-type"), body})
		f.mu.Unlock()
		f.reply(w, r)
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeVET) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }
func (f *fakeVET) last() seen { f.mu.Lock(); defer f.mu.Unlock(); return f.calls[len(f.calls)-1] }

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func jsonReply(status int, body string, hdr ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(hdr); i += 2 {
			w.Header().Set(hdr[i], hdr[i+1])
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

// A verified, matched, first-time receipt for 1000 ETB, as POST /api/verify returns it.
const verifiedSubmit = `{
 "requestId":"req-1",
 "verification":{"requestId":"req-1","processingStatus":"completed","status":"success","verified":true},
 "data":[{"bank":"telebirr","status":"success","verified":true,"amount":1000,"currency":"ETB",
   "senderName":"Abebe","receiverName":"Clinic","receiverAccount":"0911****41","referenceNumber":"ABC123",
   "accountSuffix":"00012345","timestamp":"2026-10-01T10:00:00Z",
   "settlementAccountMatch":{"matched":true,"matchType":"exact","matchConfidence":"high","reason":"receiver_account_exact_match"},
   "confirmationHistory":{"scope":"platform","isFirstConfirmation":true,"confirmedBefore":false,"confirmationCount":1}}]}`

func submitWith(item string) string {
	return `{"requestId":"req-x","verification":{"processingStatus":"completed","status":"success","verified":true},"data":[` + item + `]}`
}

// Given a configured key and a fake vendor, When Verify is called, Then the request carries the key, idempotency key, JSON body and waitMs, and the decoded result keeps strings as strings.
func TestREG_KERNEL_VERIFYET_001_VerifySendsTheContractAndDecodesTheResult(t *testing.T) {
	f, srv := newFake(t, jsonReply(200, verifiedSubmit, "x-request-id", "trace-9"))
	c := New("  secret-key ", srv.URL+"/", quiet())
	res, err := c.Verify(context.Background(), Request{
		Bank: "cbe", Reference: "FT123", Suffix: "00012345", Phone: "0911000000",
		SettlementAccount: "1000123456789", IdempotencyKey: "idem-1", WaitMs: 2500,
	})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	got := f.last()
	if got.Method != http.MethodPost || got.Path != "/api/verify" || got.Query != "waitMs=2500" {
		t.Fatalf("wrong request line: %+v", got)
	}
	if got.Key != "secret-key" || got.Idem != "idem-1" || got.CT != "application/json" {
		t.Fatalf("wrong headers: key=%q idem=%q ct=%q", got.Key, got.Idem, got.CT)
	}
	// accountSuffix must travel as a STRING: leading zeros are the transaction.
	want := map[string]any{"reference": "FT123", "bank": "cbe", "accountSuffix": "00012345",
		"phoneNumber": "0911000000", "settlementAccount": "1000123456789"}
	for k, v := range want {
		if got.Body[k] != v {
			t.Errorf("body[%s] = %#v, want %#v", k, got.Body[k], v)
		}
	}
	if res.RequestID != "req-1" || res.VendorRequestID != "trace-9" || !res.Done() || !res.Verified ||
		res.Amount != "1000" || res.AccountSuffix != "00012345" || res.Settlement == nil || !res.Settlement.Matched ||
		res.Confirmation == nil || !res.Confirmation.IsFirstConfirmation || res.SenderName != "Abebe" {
		t.Fatalf("decoded result wrong: %+v", res)
	}
	if v := Decide(res, "1000.00"); v.State != Accept {
		t.Fatalf("a clean receipt must be accepted, got %s (%s)", v.State, v.Reason)
	}
}

// Given a minimal request, When Verify is called, Then optional fields are omitted and no waitMs/idempotency is sent.
func TestREG_KERNEL_VERIFYET_002_VerifyOmitsEmptyOptionalFields(t *testing.T) {
	f, srv := newFake(t, jsonReply(202, `{"requestId":"q1","verification":{"processingStatus":"queued","status":"pending"}}`))
	res, err := New("k", srv.URL, quiet()).Verify(context.Background(), Request{Reference: "R1"})
	if err != nil {
		t.Fatal(err)
	}
	got := f.last()
	if got.Query != "" || got.Idem != "" || len(got.Body) != 1 || got.Body["reference"] != "R1" {
		t.Fatalf("unexpected request %+v", got)
	}
	if res.Done() || res.ProcessingStatus != "queued" {
		t.Fatalf("queued must not be done: %+v", res)
	}
	if v := Decide(res, "100"); v.State != Pending {
		t.Fatalf("queued must be pending, got %s", v.State)
	}
}

// Given no key, When Verify or Status is called, Then nothing is sent and an auth error is returned.
func TestREG_KERNEL_VERIFYET_003_NoKeyNeverCallsOut(t *testing.T) {
	f, srv := newFake(t, jsonReply(200, verifiedSubmit))
	c := New("   ", srv.URL, quiet())
	if c.Live() {
		t.Fatal("blank key must not be live")
	}
	if _, err := c.Verify(context.Background(), Request{Reference: "x"}); KindOf(err) != KindAuth {
		t.Fatalf("verify: want auth, got %v", err)
	}
	if _, err := c.Status(context.Background(), "x"); KindOf(err) != KindAuth {
		t.Fatalf("status: want auth, got %v", err)
	}
	if f.count() != 0 {
		t.Fatalf("no request may be made without a key, made %d", f.count())
	}
}

// Given the GET shape where data is an OBJECT, When Status is called, Then it is decoded and the path carries the id.
func TestREG_KERNEL_VERIFYET_004_StatusDecodesObjectData(t *testing.T) {
	body := `{"verification":{"requestId":"req-7","processingStatus":"completed","status":"success","verified":true},
	 "data":{"status":"success","verified":true,"amount":"250.50","currency":"ETB",
	  "settlementAccountMatch":{"matched":true,"matchConfidence":"high"}}}`
	f, srv := newFake(t, jsonReply(200, body))
	res, err := New("k", srv.URL, quiet()).Status(context.Background(), "req-7")
	if err != nil {
		t.Fatal(err)
	}
	if got := f.last(); got.Method != http.MethodGet || got.Path != "/api/verify/req-7" || got.CT != "" {
		t.Fatalf("wrong request %+v", got)
	}
	if res.RequestID != "req-7" || res.Amount != "250.50" || !res.Verified {
		t.Fatalf("decoded wrong: %+v", res)
	}
	if v := Decide(res, "250.5"); v.State != Accept {
		t.Fatalf("want accept, got %s %s", v.State, v.Reason)
	}
}

// Given the documented shapes swapped (object on POST, array on GET), When decoded, Then both are tolerated.
func TestREG_KERNEL_VERIFYET_005_ShapesAreToleratedBothWays(t *testing.T) {
	obj := `{"requestId":"a","data":{"status":"success","verified":true,"amount":5}}`
	arr := `{"requestId":"b","data":[{"status":"success","verified":true,"amount":6}]}`
	_, srvObj := newFake(t, jsonReply(200, obj))
	_, srvArr := newFake(t, jsonReply(200, arr))
	r1, err := New("k", srvObj.URL, quiet()).Verify(context.Background(), Request{Reference: "a"})
	if err != nil || r1.Amount != "5" || r1.ProcessingStatus != "completed" {
		t.Fatalf("POST with object data: %+v %v", r1, err)
	}
	r2, err := New("k", srvArr.URL, quiet()).Status(context.Background(), "b")
	if err != nil || r2.Amount != "6" || r2.RequestID != "b" {
		t.Fatalf("GET with array data: %+v %v", r2, err)
	}
	// Neither carries settlement data, so neither may be accepted.
	for _, r := range []*Result{r1, r2} {
		if v := Decide(r, ""); v.State == Accept {
			t.Fatalf("no settlement data must not be accepted: %+v", v)
		}
	}
}

// Given malformed JSON from the vendor, When Verify/Status decode it, Then a transport error is returned and nothing is accepted.
func TestREG_KERNEL_VERIFYET_006_MalformedJSONIsAnErrorNotAnAnswer(t *testing.T) {
	_, srv := newFake(t, jsonReply(200, `{"requestId": "x", "verification": {`, "x-request-id", "tr-1"))
	c := New("k", srv.URL, quiet())
	res, err := c.Verify(context.Background(), Request{Reference: "x"})
	var e *Error
	if res != nil || !errors.As(err, &e) || e.Kind != KindTransport || e.RequestID != "tr-1" {
		t.Fatalf("verify: want transport error with trace, got %+v %v", res, err)
	}
	if _, err := c.Status(context.Background(), "x"); KindOf(err) != KindTransport {
		t.Fatalf("status: want transport, got %v", err)
	}
	// Garbage inside `data` (valid envelope) leaves no item, so no settlement: review.
	_, srv2 := newFake(t, jsonReply(200, `{"verification":{"processingStatus":"completed","status":"success","verified":true},"data":"garbage"}`))
	for _, call := range []func() (*Result, error){
		func() (*Result, error) {
			return New("k", srv2.URL, quiet()).Verify(context.Background(), Request{Reference: "x"})
		},
		func() (*Result, error) { return New("k", srv2.URL, quiet()).Status(context.Background(), "x") },
	} {
		r, err := call()
		if err != nil {
			t.Fatal(err)
		}
		if v := Decide(r, "100"); v.State != Review {
			t.Fatalf("unreadable data must review, got %s", v.State)
		}
	}
}

// Given every vendor HTTP failure status, When called, Then each maps to its kind, with retry-after and trace captured.
func TestREG_KERNEL_VERIFYET_007_HTTPFailuresMapToKinds(t *testing.T) {
	cases := []struct {
		status int
		body   string
		kind   string
		msg    string
	}{
		{401, `{"message":"bad key sk_live_123"}`, KindAuth, "the verification service rejected our key"},
		{403, `{}`, KindForbidden, "our verification key lacks permission for this"},
		{409, `{"message":"request in flight"}`, KindConflict, "request in flight"},
		{402, `{}`, KindNoCredit, "verification credits are exhausted"},
		{429, `{}`, KindRateLimited, "the verification service is rate limiting us"},
		{500, `{"error":"boom"}`, KindTransport, "boom"},
		{500, `not json`, KindTransport, "the verification service returned an unexpected error"},
		{502, ``, KindUnavailable, "the verification service is unavailable"},
		{503, ``, KindUnavailable, "the verification service is unavailable"},
		{504, ``, KindUnavailable, "the verification service is unavailable"},
		{400, `{"message":"invalid reference"}`, KindInvalid, "invalid reference"},
		{422, `{}`, KindInvalid, "the bank could not accept those details"},
		{400, `{"message":"Error Code :: 10005 insufficient"}`, KindNoCredit, "verification credits are exhausted"},
	}
	for _, tc := range cases {
		_, srv := newFake(t, jsonReply(tc.status, tc.body, "x-request-id", "tr", "Retry-After", " 7 "))
		res, err := New("k", srv.URL, quiet()).Verify(context.Background(), Request{Reference: "x"})
		var e *Error
		if res != nil || !errors.As(err, &e) {
			t.Fatalf("%d: want *Error, got %+v %v", tc.status, res, err)
		}
		if e.Kind != tc.kind || e.Message != tc.msg || e.Error() != tc.msg || e.Status != tc.status ||
			e.RequestID != "tr" || e.RetryAfter != 7*time.Second {
			t.Errorf("%d %s: got %+v", tc.status, tc.body, e)
		}
		// The credential never leaks into a screen-bound message.
		if strings.Contains(e.Message, "sk_live") {
			t.Errorf("credential leaked: %q", e.Message)
		}
	}
	// Non-numeric Retry-After is ignored rather than invented.
	_, srv := newFake(t, jsonReply(429, `{}`, "Retry-After", "Wed, 21 Oct 2026 07:28:00 GMT"))
	_, err := New("k", srv.URL, quiet()).Status(context.Background(), "x")
	var e *Error
	if !errors.As(err, &e) || e.RetryAfter != 0 || e.Kind != KindRateLimited {
		t.Fatalf("date retry-after: %+v", e)
	}
}

// Given a slow vendor, When the caller's context deadline passes, Then a transport error is returned (no hang, no answer).
func TestREG_KERNEL_VERIFYET_008_TimeoutIsATransportFailure(t *testing.T) {
	release := make(chan struct{})
	_, srv := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
		jsonReply(200, verifiedSubmit)(w, r)
	})
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	res, err := New("k", srv.URL, quiet()).Verify(ctx, Request{Reference: "slow"})
	if res != nil || KindOf(err) != KindTransport {
		t.Fatalf("want transport error on deadline, got %+v %v", res, err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("deadline not honoured: took %s", time.Since(start))
	}
	if !strings.Contains(err.Error(), "could not reach") {
		t.Fatalf("message: %q", err.Error())
	}
}

// Given an unreachable vendor or an unbuildable URL, When called, Then a transport error is returned.
func TestREG_KERNEL_VERIFYET_009_UnreachableAndBadURL(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	if _, err := New("k", url, quiet()).Verify(context.Background(), Request{Reference: "x"}); KindOf(err) != KindTransport {
		t.Fatalf("closed server: %v", err)
	}
	_, err := New("k", "http://bad\x7fhost", quiet()).Status(context.Background(), "x")
	if KindOf(err) != KindTransport || !strings.Contains(err.Error(), "could not build") {
		t.Fatalf("bad url: %v", err)
	}
	if KindOf(errors.New("plain")) != "" || KindOf(nil) != "" {
		t.Fatal("KindOf must be empty for non-vendor errors")
	}
}

// Given vendor answers that are verified-but-not-ours, wrong amount, reused, rejected, When decoded and decided, Then none is accepted.
func TestREG_KERNEL_VERIFYET_010_VendorAnswersThroughDecideFailClosed(t *testing.T) {
	cases := []struct {
		name, item, expected, state, detail string
	}{
		{"wrong receiver", `{"status":"success","verified":true,"amount":100,"currency":"ETB","receiverAccount":"2519****4531",
			"settlementAccountMatch":{"matched":false,"reason":"candidate_account_mismatch"}}`, "100", Reject, "candidate_account_mismatch"},
		{"wrong amount", `{"status":"success","verified":true,"amount":"90.00","currency":"ETB",
			"settlementAccountMatch":{"matched":true,"matchConfidence":"high"}}`, "100", Review, "amount_mismatch"},
		{"reused reference", `{"status":"success","verified":true,"amount":100,"currency":"ETB",
			"settlementAccountMatch":{"matched":true,"matchConfidence":"high"},
			"confirmationHistory":{"scope":"platform","isFirstConfirmation":false,"confirmedBefore":true,"confirmationCount":3}}`, "100", Review, "confirmed_before"},
		{"not found", `{"status":"not_found","verified":false}`, "100", Reject, "not_found"},
		{"needs review ambiguous", `{"status":"success","verified":true,"amount":100,
			"settlementAccountMatch":{"matched":false,"ambiguous":true,"candidateCount":2}}`, "100", Review, "ambiguous"},
		{"verification_not_successful", `{"status":"success","verified":true,"amount":100,
			"settlementAccountMatch":{"matched":false,"reason":"verification_not_successful"}}`, "100", Reject, "verification_not_successful"},
	}
	for _, tc := range cases {
		_, srv := newFake(t, jsonReply(200, submitWith(tc.item)))
		res, err := New("k", srv.URL, quiet()).Verify(context.Background(), Request{Reference: "x"})
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		v := Decide(res, tc.expected)
		if v.State != tc.state || !strings.Contains(v.Detail, tc.detail) {
			t.Errorf("%s: got %s/%s (%s)", tc.name, v.State, v.Detail, v.Reason)
		}
	}
	// A vendor-level failure envelope is never accepted.
	_, srv := newFake(t, jsonReply(200, `{"verification":{"processingStatus":"failed","status":"failed"}}`))
	res, _ := New("k", srv.URL, quiet()).Verify(context.Background(), Request{Reference: "x"})
	if v := Decide(res, "1"); v.State != Review || v.Detail != "processing_failed" {
		t.Fatalf("failed processing: %+v", v)
	}
}
