package sms

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// The adapter is the only thing that knows the wire contract, so the contract is
// asserted here rather than discovered in production.
func TestSendUsesV2Contract(t *testing.T) {
	var gotKey, gotPath, gotCT string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotPath, gotCT = r.Header.Get("KEY"), r.URL.Path, r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sent":true,"id":"01JZX5M8Q3T5V0X8YW9RCB2K7D","description":"Accepted for delivery","segments":2,"status":"ACCEPTED"}`))
	}))
	defer srv.Close()

	rec, err := NewEthiopiaGateway("k-123", srv.URL, quiet()).Send(context.Background(),
		Message{MSISDN: "251911223344", Text: "hi"})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if gotPath != "/api/v2/sms/send" {
		t.Errorf("path = %q, want /api/v2/sms/send — v1 gives no usable message id", gotPath)
	}
	if gotKey != "k-123" || !strings.HasPrefix(gotCT, "application/json") {
		t.Errorf("headers: KEY=%q CT=%q", gotKey, gotCT)
	}
	if len(body) != 2 || body["msisdn"] != "251911223344" || body["text"] != "hi" {
		t.Errorf("body = %v, want exactly msisdn+text", body)
	}
	if rec.ID != "01JZX5M8Q3T5V0X8YW9RCB2K7D" {
		t.Errorf("id = %q — the ULID is the only handle to the message", rec.ID)
	}
	if rec.Segments != 2 {
		t.Errorf("segments = %d, want the gateway's own count (2)", rec.Segments)
	}
}

// v1's `id: 0` identifies nothing. Storing "0" would look like a working handle,
// so it must come back empty instead.
func TestNumericIDIsDiscarded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"sent":true,"id":0,"description":"Accepted for delivery"}`))
	}))
	defer srv.Close()
	rec, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{MSISDN: "2519", Text: "x"})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if rec.ID != "" {
		t.Fatalf("id = %q, want empty — 0 is not a handle", rec.ID)
	}
}

// The three failure shapes, and — the point of the whole taxonomy — which of them
// may be retried. A 400 retried is a wasted attempt every time.
func TestErrorClassification(t *testing.T) {
	cases := []struct {
		name      string
		status    int
		body      string
		wantCode  string
		permanent bool
		contains  string
	}{
		{"no balance", 400, `{"error_message":"You don't have enough package to send sms please contact with system Administrator. Error Code :: 10005"}`,
			"10005", true, "out of credit"},
		{"bad msisdn", 400, `{"error_message":"invalid. Error Code :: 10000"}`, "10000", true, "rejected the phone number"},
		{"campaign inactive", 400, `{"error_message":"nope. Error Code :: 10002"}`, "10002", true, "not active"},
		{"sender unapproved", 400, `{"error_message":"nope. Error Code :: 10006"}`, "10006", true, "not approved"},
		{"not whitelisted", 400, `{"error_message":"nope. Error Code :: 10007"}`, "10007", true, "allowed list"},
		{"unknown code kept as prose", 400, `{"error_message":"Something odd. Error Code :: 19999"}`, "19999", true, "Something odd"},
		{"missing fields", 400, `{"msisdn":"msisdn is mandatory"}`, "", true, "mandatory"},
		{"bad key", 401, ``, "", true, "API key"},
		{"unknown path", 404, ``, "", true, "did not recognise"},
		{"rate limited", 429, ``, "", false, "rate-limiting"},
		{"server error", 503, ``, "", false, "unavailable"},
		{"refused with 200", 200, `{"sent":false,"description":"blocked"}`, "", true, "blocked"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()
			_, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{MSISDN: "2519", Text: "x"})
			if err == nil {
				t.Fatal("want an error")
			}
			if IsPermanent(err) != c.permanent {
				t.Errorf("permanent = %v, want %v (%v)", IsPermanent(err), c.permanent, err)
			}
			if !strings.Contains(err.Error(), c.contains) {
				t.Errorf("message %q does not mention %q", err.Error(), c.contains)
			}
			var e *Error
			if c.wantCode != "" {
				if !asErr(err, &e) || e.Code != c.wantCode {
					t.Errorf("code = %v, want %s", e, c.wantCode)
				}
			}
		})
	}
}

// The gateway's rate limit is shared by every clinic on the account, so when it
// asks us to wait we honour the number rather than guessing.
func TestRetryAfterHonoured(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "42")
		w.WriteHeader(429)
	}))
	defer srv.Close()
	_, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{MSISDN: "2519", Text: "x"})
	if got := RetryAfter(err).Seconds(); got != 42 {
		t.Fatalf("RetryAfter = %v, want 42s", got)
	}
}

func TestStatusLookup(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"01J","resourceId":1042,"msisdn":"251911639555","segments":1,"status":"DELIVERED","createdAt":"2026-07-18T09:30:12"}`))
	}))
	defer srv.Close()
	d, err := NewEthiopiaGateway("k", srv.URL, quiet()).Status(context.Background(), "01J")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if path != "/api/v2/sms/01J" {
		t.Errorf("path = %q", path)
	}
	if !d.Final() || d.Status != "DELIVERED" {
		t.Errorf("status = %+v, want a final DELIVERED", d)
	}
}

// An id belonging to another campaign is indistinguishable from one that never
// existed, and neither will ever resolve — so asking again is pointless.
func TestStatus404IsPermanent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }))
	defer srv.Close()
	_, err := NewEthiopiaGateway("k", srv.URL, quiet()).Status(context.Background(), "nope")
	if err == nil || !IsPermanent(err) {
		t.Fatalf("want a permanent error, got %v", err)
	}
}

// A transport failure is transient but ambiguous — the gateway may have taken the
// message and only the reply was lost. It must not be classified permanent (we
// would lose real messages) nor be silently swallowed.
func TestTransportFailureIsTransient(t *testing.T) {
	g := NewEthiopiaGateway("k", "http://127.0.0.1:1", quiet())
	_, err := g.Send(context.Background(), Message{MSISDN: "2519", Text: "x"})
	if err == nil || IsPermanent(err) {
		t.Fatalf("want a transient error, got %v", err)
	}
	if !strings.Contains(err.Error(), "could not reach") {
		t.Errorf("message %q must be recognisable as silence, not a refusal", err)
	}
}

func TestUnconfigured(t *testing.T) {
	g := NewEthiopiaGateway("", "", quiet())
	if g.Live() {
		t.Error("a keyless gateway must not report Live")
	}
	if _, err := g.Send(context.Background(), Message{}); err == nil {
		t.Error("a keyless send must fail rather than silently succeed")
	}
	if _, err := NewLogGateway(quiet()).Status(context.Background(), "x"); err != ErrNoStatus {
		t.Error("the log gateway must admit it cannot report delivery")
	}
}

func asErr(err error, target **Error) bool {
	e, ok := err.(*Error)
	if ok {
		*target = e
	}
	return ok
}
