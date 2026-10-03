package notify_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/notify"
)

// Given the log provider, When asked its name and to send, Then it is "log", never fails, and records channel/recipient/template as one structured line.
func TestREG_KERNEL_NOTIFY_001_LogProviderLogsInsteadOfSending(t *testing.T) {
	var buf bytes.Buffer
	var p notify.Provider = notify.NewLogProvider(slog.New(slog.NewJSONHandler(&buf, nil)))
	if p.Name() != "log" {
		t.Fatalf("Name = %q, want log", p.Name())
	}
	err := p.Send(context.Background(), notify.Message{
		Channel: notify.ChannelEmail, To: "owner@clinic.test", Template: "invite",
		Vars: map[string]any{"link": "https://app.test/accept?token=SECRET-TOKEN", "patient": "Abebe Kebede"},
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("want exactly one log line, got %d: %q", len(lines), buf.String())
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &rec); err != nil {
		t.Fatalf("log line is not JSON: %v", err)
	}
	if rec["level"] != "INFO" || rec["channel"] != "email" || rec["to"] != "owner@clinic.test" || rec["template"] != "invite" {
		t.Errorf("log record = %v", rec)
	}
	// Template variables carry invite tokens and patient names; they must not be logged.
	if strings.Contains(buf.String(), "SECRET-TOKEN") || strings.Contains(buf.String(), "Abebe") {
		t.Errorf("template vars leaked into the log: %s", buf.String())
	}
}

// Given each channel constant, When sent, Then its wire value is logged unchanged (call sites and stored rows key on it).
func TestREG_KERNEL_NOTIFY_002_ChannelValues(t *testing.T) {
	want := map[notify.Channel]string{notify.ChannelEmail: "email", notify.ChannelSMS: "sms", notify.ChannelInApp: "in_app"}
	for ch, s := range want {
		if string(ch) != s {
			t.Errorf("channel %q, want %q", ch, s)
		}
		var buf bytes.Buffer
		p := notify.NewLogProvider(slog.New(slog.NewTextHandler(&buf, nil)))
		if err := p.Send(context.Background(), notify.Message{Channel: ch, To: "x"}); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(buf.String(), "channel="+s) {
			t.Errorf("log for %s = %q", s, buf.String())
		}
	}
}

// Given a cancelled context, When the log provider sends, Then it still succeeds (it does no I/O that could be cancelled).
func TestREG_KERNEL_NOTIFY_003_CancelledContextHarmless(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var buf bytes.Buffer
	if err := notify.NewLogProvider(slog.New(slog.NewTextHandler(&buf, nil))).Send(ctx, notify.Message{}); err != nil {
		t.Errorf("Send with cancelled ctx = %v, want nil", err)
	}
}
