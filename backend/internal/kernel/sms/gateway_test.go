package sms

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The adapter is the only thing that knows the gateway's wire contract, so the
// contract is asserted here rather than discovered in production: the key travels
// in a bare KEY header, the body is msisdn+text, and nothing else is sent.
func TestSendUsesTheDocumentedContract(t *testing.T) {
	var gotKey, gotPath, gotCT string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey, gotPath, gotCT = r.Header.Get("KEY"), r.URL.Path, r.Header.Get("Content-Type")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sent":true,"id":0,"description":"Accepted for delivery"}`))
	}))
	defer srv.Close()

	g := NewEthiopiaGateway("k-123", srv.URL)
	if !g.Live() {
		t.Fatal("a gateway with a key must report Live")
	}
	if err := g.Send(context.Background(), Message{MSISDN: "251911223344", Text: "hi"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if gotPath != "/api/sms/send" {
		t.Errorf("path = %q, want /api/sms/send", gotPath)
	}
	if gotKey != "k-123" {
		t.Errorf("KEY header = %q, want k-123", gotKey)
	}
	if !strings.HasPrefix(gotCT, "application/json") {
		t.Errorf("content-type = %q", gotCT)
	}
	if body["msisdn"] != "251911223344" || body["text"] != "hi" {
		t.Errorf("body = %v, want msisdn+text only", body)
	}
	if len(body) != 2 {
		t.Errorf("body has %d fields, want exactly 2 — the API takes no others", len(body))
	}
}

// A 200 that says sent:false is a refusal, not a success. Treating it as success
// is how a clinic's log fills with messages nobody received.
func TestSendRefusalIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"sent":false,"description":"insufficient balance"}`))
	}))
	defer srv.Close()
	err := NewEthiopiaGateway("k", srv.URL).Send(context.Background(), Message{MSISDN: "251911223344", Text: "x"})
	if err == nil || !strings.Contains(err.Error(), "insufficient balance") {
		t.Fatalf("want the gateway's reason surfaced, got %v", err)
	}
}

// A 200 with an HTML error page must not be read as success either.
func TestSendNonJSONIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<html>maintenance</html>`))
	}))
	defer srv.Close()
	if err := NewEthiopiaGateway("k", srv.URL).Send(context.Background(), Message{MSISDN: "2519", Text: "x"}); err == nil {
		t.Fatal("a non-JSON reply must be an error")
	}
}

func TestSendMapsAuthAndOutage(t *testing.T) {
	for _, c := range []struct {
		code int
		want string
	}{
		{http.StatusUnauthorized, "API key"},
		{http.StatusForbidden, "API key"},
		{http.StatusBadGateway, "unavailable"},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(c.code)
		}))
		err := NewEthiopiaGateway("k", srv.URL).Send(context.Background(), Message{MSISDN: "2519", Text: "x"})
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("status %d → %v, want a message mentioning %q", c.code, err, c.want)
		}
		srv.Close()
	}
}

// No key means no sending, and the log adapter must never claim to be live.
func TestUnconfigured(t *testing.T) {
	if NewEthiopiaGateway("", "").Live() {
		t.Error("a keyless gateway must not report Live")
	}
	if err := NewEthiopiaGateway("", "").Send(context.Background(), Message{}); err == nil {
		t.Error("a keyless send must fail rather than silently succeed")
	}
}
