package sms

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fake(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// Given the log gateway, When it sends, Then it reports itself not live, returns a LOGGED receipt with our segment estimate, and logs the text.
func TestREG_KERNEL_SMS_001_LogGatewayNeverClaimsDelivery(t *testing.T) {
	var buf bytes.Buffer
	g := NewLogGateway(slog.New(slog.NewTextHandler(&buf, nil)))
	if g.Name() != "log" || g.Live() {
		t.Fatalf("Name/Live = %q/%v, want log/false", g.Name(), g.Live())
	}
	rec, err := g.Send(context.Background(), Message{MSISDN: "251911223344", Text: strings.Repeat("ሀ", 71)})
	if err != nil {
		t.Fatal(err)
	}
	if rec.Status != "LOGGED" || rec.Segments != 2 || rec.ID != "" {
		t.Errorf("receipt = %+v, want LOGGED/2 segments/no id", rec)
	}
	out := buf.String()
	if !strings.Contains(out, "not sent") || !strings.Contains(out, "251911223344") || !strings.Contains(out, "unicode=true") {
		t.Errorf("log = %q", out)
	}
}

// Given the live gateway constructed with padded key and URL, When it sends, Then the key is trimmed, the trailing slash dropped, and it reports live under its own name.
func TestREG_KERNEL_SMS_002_ConstructorTrims(t *testing.T) {
	var key, path string
	srv := fake(t, func(w http.ResponseWriter, r *http.Request) {
		key, path = r.Header.Get("KEY"), r.URL.Path
		_, _ = w.Write([]byte(`{"sent":true,"id":"01ABC"}`))
	})
	g := NewEthiopiaGateway("  k-1 \n", "  "+srv.URL+"/  ", quiet())
	if g.Name() != "smsethiopia" || !g.Live() {
		t.Fatalf("Name/Live = %q/%v", g.Name(), g.Live())
	}
	rec, err := g.Send(context.Background(), Message{MSISDN: "251911223344", Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	if key != "k-1" || path != "/api/v2/sms/send" {
		t.Errorf("KEY=%q path=%q", key, path)
	}
	// No status in the reply: the documented default is ACCEPTED; no segments → 0 (unknown), not our guess.
	if rec.ID != "01ABC" || rec.Status != "ACCEPTED" || rec.Segments != 0 {
		t.Errorf("receipt = %+v", rec)
	}
	if NewEthiopiaGateway("k", "", quiet()).baseURL != "https://smsethiopia.com" {
		t.Error("an empty base URL must default to the production gateway")
	}
}

// Given a 2xx the adapter cannot parse, When sending, Then it is a transient error, never a silent success without an id.
func TestREG_KERNEL_SMS_003_Unparseable2xxIsNotSuccess(t *testing.T) {
	srv := fake(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`<html>maintenance</html>`)) })
	rec, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{MSISDN: "2519", Text: "x"})
	if err == nil || rec != nil {
		t.Fatalf("got %+v/%v, want an error", rec, err)
	}
	if IsPermanent(err) || !strings.Contains(err.Error(), "unexpected reply") || !strings.Contains(err.Error(), "maintenance") {
		t.Errorf("err = %v (permanent=%v)", err, IsPermanent(err))
	}
}

// Given a 200 with sent=false and no description, When sending, Then it is a permanent refusal with a readable default reason.
func TestREG_KERNEL_SMS_004_SilentRefusalHasDefaultReason(t *testing.T) {
	srv := fake(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"sent":false,"description":"  "}`))
	})
	_, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{})
	if !IsPermanent(err) || err.Error() != "gateway refused it: the gateway refused the message" {
		t.Errorf("err = %v", err)
	}
}

// Given less common HTTP failures, When classified, Then 3xx is transient with a snippet, a bare-text 400 is permanent, and a 400 with an empty error_message falls back to the field shape.
func TestREG_KERNEL_SMS_005_OtherFailureShapes(t *testing.T) {
	cases := []struct {
		name      string
		status    int
		body      string
		permanent bool
		exact     string
	}{
		{"redirect", 302, "moved", false, "the SMS gateway returned 302: moved"},
		{"plain-text 400", 400, "Bad Request", true, "the gateway rejected the request: Bad Request"},
		{"empty error_message → field shape", 400, `{"error_message":"  "}`, true, "the gateway rejected the request:   "},
		{"empty 400 body", 400, ``, true, "the gateway rejected the request: "},
		{"500", 500, `oops`, false, "the SMS gateway is unavailable (500)"},
		{"code-less error_message keeps prose minus dots", 400, `{"error_message":"Message too long..."}`, true, "Message too long"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := fake(t, func(w http.ResponseWriter, _ *http.Request) {
				if c.status == 302 {
					w.Header().Set("Location", "/elsewhere")
				}
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			})
			g := NewEthiopiaGateway("k", srv.URL, quiet())
			g.client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			_, err := g.Send(context.Background(), Message{})
			if err == nil {
				t.Fatal("want error")
			}
			if IsPermanent(err) != c.permanent {
				t.Errorf("permanent = %v, want %v", IsPermanent(err), c.permanent)
			}
			if err.Error() != c.exact {
				t.Errorf("message = %q, want %q", err.Error(), c.exact)
			}
		})
	}
}

// Given a 429 with a missing, non-numeric, zero or negative Retry-After, When classified, Then it is transient with no pause invented.
func TestREG_KERNEL_SMS_006_RetryAfterOnlyWhenValid(t *testing.T) {
	for _, v := range []string{"", "soon", "0", "-5", "Wed, 21 Oct 2026 07:28:00 GMT"} {
		srv := fake(t, func(w http.ResponseWriter, _ *http.Request) {
			if v != "" {
				w.Header().Set("Retry-After", v)
			}
			w.WriteHeader(429)
		})
		_, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{})
		if IsPermanent(err) || RetryAfter(err) != 0 {
			t.Errorf("Retry-After %q: permanent=%v pause=%v, want transient/0", v, IsPermanent(err), RetryAfter(err))
		}
	}
}

// Given errors that are not gateway Errors (including wrapped ones), When asked, Then foreign errors are transient with no pause, and wrapped gateway errors keep their classification.
func TestREG_KERNEL_SMS_007_ErrorHelpersUnwrap(t *testing.T) {
	plain := errors.New("boom")
	if IsPermanent(plain) || RetryAfter(plain) != 0 || IsPermanent(nil) {
		t.Error("a non-gateway error must be transient with no pause")
	}
	wrapped := errors.Join(errors.New("ctx"), &Error{Message: "slow", RetryAfter: 3 * time.Second, Permanent: true})
	if !IsPermanent(wrapped) || RetryAfter(wrapped) != 3*time.Second {
		t.Errorf("wrapped gateway error lost its classification: %v/%v", IsPermanent(wrapped), RetryAfter(wrapped))
	}
	if (&Error{Message: "m"}).Error() != "m" {
		t.Error("Error() must be the readable message")
	}
}

// Given status look-ups, When the key is missing, the id blank, the reply unparseable or lower-case, Then each gives the documented result without misreporting delivery.
func TestREG_KERNEL_SMS_008_StatusEdgeCases(t *testing.T) {
	var hits atomic.Int32
	srv := fake(t, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/api/v2/sms/garbled":
			_, _ = w.Write([]byte(`not json`))
		case "/api/v2/sms/lower":
			_, _ = w.Write([]byte(`{"status":"sent","segments":3,"createdAt":"2026-10-01T10:00:00"}`))
		default:
			w.WriteHeader(503)
		}
	})
	ctx := context.Background()
	if _, err := NewEthiopiaGateway("", srv.URL, quiet()).Status(ctx, "x"); !IsPermanent(err) {
		t.Errorf("keyless status must be a permanent error, got %v", err)
	}
	g := NewEthiopiaGateway("k", srv.URL, quiet())
	if _, err := g.Status(ctx, "   "); err != ErrNoStatus {
		t.Errorf("blank id = %v, want ErrNoStatus", err)
	}
	if hits.Load() != 0 {
		t.Errorf("keyless/blank-id look-ups must not call the gateway (%d calls)", hits.Load())
	}
	if _, err := g.Status(ctx, "garbled"); err == nil || IsPermanent(err) || !strings.Contains(err.Error(), "unexpected status reply: not json") {
		t.Errorf("garbled = %v", err)
	}
	d, err := g.Status(ctx, "lower")
	if err != nil {
		t.Fatal(err)
	}
	if d.Status != "SENT" || d.Segments != 3 || d.CreatedAt != "2026-10-01T10:00:00" || d.Final() {
		t.Errorf("delivery = %+v (final=%v), want SENT/3, not final", d, d.Final())
	}
	if _, err := g.Status(ctx, "down"); err == nil || IsPermanent(err) {
		t.Errorf("5xx status = %v, want transient", err)
	}
}

// Given delivery states, When Final is asked, Then only DELIVERED (any case) is final.
func TestREG_KERNEL_SMS_009_FinalOnlyWhenDelivered(t *testing.T) {
	for s, want := range map[string]bool{"DELIVERED": true, "delivered": true, "SENT": false, "ACCEPTED": false, "": false, "FAILED": false} {
		if got := (Delivery{Status: s}).Final(); got != want {
			t.Errorf("Final(%q) = %v, want %v", s, got, want)
		}
	}
}

// Given the gateway's rate-limit headers, When few requests remain, Then a warning is logged; plenty, non-numeric or no logger stays quiet.
func TestREG_KERNEL_SMS_010_RateLimitWarning(t *testing.T) {
	for _, c := range []struct {
		remaining string
		warn      bool
	}{{"3", true}, {"10", true}, {"11", false}, {"lots", false}, {"", false}} {
		srv := fake(t, func(w http.ResponseWriter, _ *http.Request) {
			if c.remaining != "" {
				w.Header().Set("X-RateLimit-Remaining", c.remaining)
			}
			w.Header().Set("X-RateLimit-Limit", "100")
			_, _ = w.Write([]byte(`{"sent":true,"id":"x"}`))
		})
		var buf bytes.Buffer
		g := NewEthiopiaGateway("k", srv.URL, slog.New(slog.NewTextHandler(&buf, nil)))
		if _, err := g.Send(context.Background(), Message{}); err != nil {
			t.Fatal(err)
		}
		warned := strings.Contains(buf.String(), "level=WARN") && strings.Contains(buf.String(), "limit=100")
		if warned != c.warn {
			t.Errorf("remaining=%q: warned=%v, want %v (%q)", c.remaining, warned, c.warn, buf.String())
		}
		// A nil logger must not panic.
		if _, err := NewEthiopiaGateway("k", srv.URL, nil).Send(context.Background(), Message{}); err != nil {
			t.Fatal(err)
		}
	}
}

// Given a very long error body, When reported, Then it is cut to 200 characters plus an ellipsis.
func TestREG_KERNEL_SMS_011_LongBodiesAreSnipped(t *testing.T) {
	long := strings.Repeat("z", 500)
	srv := fake(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(long))
	})
	_, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{})
	want := "the gateway rejected the request: " + strings.Repeat("z", 200) + "…"
	if err == nil || err.Error() != want {
		t.Errorf("err = %v", err)
	}
}

// Given a base URL that cannot form a request, When sending, Then the error is returned rather than panicking or calling anything.
func TestREG_KERNEL_SMS_012_BadBaseURL(t *testing.T) {
	_, err := NewEthiopiaGateway("k", "http://bad host%zz", quiet()).Send(context.Background(), Message{})
	if err == nil {
		t.Fatal("want an error for an unparseable base URL")
	}
}

// Given a cancelled context, When sending, Then it fails fast as a transient "could not reach" error.
func TestREG_KERNEL_SMS_013_CancelledContext(t *testing.T) {
	var hits atomic.Int32
	srv := fake(t, func(w http.ResponseWriter, _ *http.Request) { hits.Add(1) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(ctx, Message{})
	if err == nil || IsPermanent(err) || !strings.Contains(err.Error(), "could not reach") {
		t.Errorf("err = %v", err)
	}
	if hits.Load() != 0 {
		t.Errorf("a cancelled send must not reach the gateway")
	}
}

// Given Amharic text and JSON-special characters, When sent, Then the body carries them intact (no HTML escaping mangling the message).
func TestREG_KERNEL_SMS_014_TextTravelsIntact(t *testing.T) {
	text := `Cure Dental: ቀጠሮዎ ነገ ነው <3 & "see you"`
	var got string
	srv := fake(t, func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		got = string(raw)
		_, _ = w.Write([]byte(`{"sent":true,"id":"x"}`))
	})
	if _, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{MSISDN: "251911223344", Text: text}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "ቀጠሮዎ ነገ ነው") {
		t.Errorf("body = %q, Amharic must be sent as UTF-8", got)
	}
}

// Given GSM-7 extended characters and mixed text, When segmented, Then escape characters cost two and one non-GSM char flips the whole message to UCS-2.
func TestREG_KERNEL_SMS_015_SegmentEdges(t *testing.T) {
	cases := []struct {
		text string
		n    int
		uni  bool
	}{
		{strings.Repeat("a", 159) + "{", 2, false}, // 159 + 2 = 161
		{strings.Repeat("a", 158) + "{", 1, false}, // 160
		{strings.Repeat("a", 459), 3, false},       // 3×153
		{strings.Repeat("a", 460), 4, false},
		{strings.Repeat("a", 69) + "ሀ", 1, true},  // 70 units
		{strings.Repeat("a", 134) + "ሀ", 3, true}, // 135 units → ceil(135/67)
		{strings.Repeat("ሀ", 134), 2, true},
		{strings.Repeat("ሀ", 135), 3, true},
		{"line1\nline2\r", 1, false}, // newline/CR are GSM-7
		{"`", 1, true},               // backtick is not GSM-7
	}
	for _, c := range cases {
		n, uni := Segments(c.text)
		if n != c.n || uni != c.uni {
			t.Errorf("Segments(len %d %q…) = %d/%v, want %d/%v", len([]rune(c.text)), firstN(c.text, 8), n, uni, c.n, c.uni)
		}
	}
}

func firstN(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// Given a v2-shaped success with no id at all, When sending, Then the receipt id is empty (not "null" or a guess).
func TestREG_KERNEL_SMS_016_MissingIDIsEmpty(t *testing.T) {
	srv := fake(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"sent":true,"segments":1}`)) })
	rec, err := NewEthiopiaGateway("k", srv.URL, quiet()).Send(context.Background(), Message{})
	if err != nil || rec.ID != "" || rec.Segments != 1 {
		t.Errorf("rec=%+v err=%v", rec, err)
	}
	srv2 := fake(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"sent":true,"id":"  01PADDED  "}`)) })
	if rec, _ := NewEthiopiaGateway("k", srv2.URL, quiet()).Send(context.Background(), Message{}); rec.ID != "01PADDED" {
		t.Errorf("id = %q, want trimmed", rec.ID)
	}
}

// Given an unreachable gateway, When looking up a status, Then it is a transient "could not reach" error.
func TestREG_KERNEL_SMS_017_StatusTransportFailure(t *testing.T) {
	_, err := NewEthiopiaGateway("k", "http://127.0.0.1:1", quiet()).Status(context.Background(), "01J")
	if err == nil || IsPermanent(err) || !strings.Contains(err.Error(), "could not reach") {
		t.Errorf("err = %v", err)
	}
}
