// Package notify abstracts outbound notifications (email/SMS/in-app) behind a
// provider interface. The MVP ships a log adapter (dev); a real email/SMS
// provider (Resend/SES/Twilio/local gateway) slots in later with no call-site
// changes (open question Q3). Invite flows also return a copyable link so the
// product works before a provider is configured.
package notify

import (
	"context"
	"log/slog"
)

// Channel identifies a delivery channel.
type Channel string

const (
	ChannelEmail Channel = "email"
	ChannelSMS   Channel = "sms"
	ChannelInApp Channel = "in_app"
)

// Message is an outbound notification.
type Message struct {
	Channel  Channel
	To       string
	Template string
	Vars     map[string]any
}

// Provider sends notifications.
type Provider interface {
	Send(ctx context.Context, msg Message) error
	Name() string
}

// LogProvider is the dev adapter: it logs instead of delivering.
type LogProvider struct{ log *slog.Logger }

// NewLogProvider constructs a log-only provider.
func NewLogProvider(log *slog.Logger) *LogProvider { return &LogProvider{log: log} }

// Name implements Provider.
func (p *LogProvider) Name() string { return "log" }

// Send logs the notification (no real delivery).
func (p *LogProvider) Send(_ context.Context, msg Message) error {
	p.log.Info("notification (log provider)", "channel", string(msg.Channel), "to", msg.To, "template", msg.Template)
	return nil
}
