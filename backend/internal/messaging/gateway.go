package messaging

import (
	"context"
	"log/slog"
	"strings"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
)

// Credentials are one clinic's way onto the network.
//
// A sender ID belongs to a campaign, an API key is permanently bound to one
// campaign, and the campaign supplies both the approved sender name the patient
// sees and the SMS package that gets debited. So "which clinic is this" and "which
// key do we send with" are the same question, and a clinic with its own approved
// name necessarily has its own key.
type Credentials struct {
	// APIKeyEnc is AES-GCM(base64) as stored, or empty when the clinic has not
	// been given its own campaign yet.
	APIKeyEnc string
	// SenderID is the approved name, for display. The gateway derives the real one
	// from the campaign, so this records what we expect rather than controlling it.
	SenderID string
	// SenderStatus is none | pending | approved | rejected.
	SenderStatus string
	// SenderName is the in-body fallback prefix.
	SenderName string
}

// HasOwnSender reports whether patients will see this clinic's own name on their
// phone. When true the body needs no prefix — and every message it would have cost
// is saved, which on an Amharic template is often a whole extra segment.
func (c Credentials) HasOwnSender() bool {
	return c.SenderStatus == "approved" && strings.TrimSpace(c.APIKeyEnc) != ""
}

// Prefix is what should lead the message body: the clinic name when the patient
// would otherwise have no idea who is writing, and nothing once the sender name on
// their handset already says it.
func (c Credentials) Prefix() string {
	if c.HasOwnSender() {
		return ""
	}
	return strings.TrimSpace(c.SenderName)
}

// GatewayFactory builds the gateway a given clinic sends through.
//
// One process serves every tenant, so this is resolved per message rather than
// once at startup. It matters beyond sending: a message id is only meaningful to
// the campaign that produced it, so a delivery lookup made with the wrong clinic's
// key comes back 404 and the message would look lost.
type GatewayFactory struct {
	encKey   []byte
	baseURL  string
	fallback sms.Gateway
	log      *slog.Logger
}

// NewGatewayFactory constructs the factory. fallback is used by clinics that have
// no campaign of their own — the platform key when one is configured, otherwise the
// log adapter, which reports Live() == false so nothing claims to have sent.
func NewGatewayFactory(encKey []byte, baseURL string, fallback sms.Gateway, log *slog.Logger) *GatewayFactory {
	return &GatewayFactory{encKey: encKey, baseURL: baseURL, fallback: fallback, log: log}
}

// For returns the gateway for one clinic's credentials.
func (f *GatewayFactory) For(c Credentials) sms.Gateway {
	enc := strings.TrimSpace(c.APIKeyEnc)
	if enc == "" || len(f.encKey) == 0 {
		return f.fallback
	}
	key, err := auth.DecryptSecret(f.encKey, enc)
	if err != nil || strings.TrimSpace(key) == "" {
		// A key we cannot decrypt is a configuration fault, not a reason to quietly
		// send under someone else's identity and bill their package. Falling back to
		// the platform gateway here would put this clinic's messages on another
		// clinic's sender name.
		f.log.Error("could not decrypt a clinic's SMS key — messages will not be sent for it", "err", err)
		return brokenGateway{}
	}
	return sms.NewEthiopiaGateway(key, f.baseURL, f.log)
}

// Fallback is the gateway used when a clinic has no credentials of its own.
func (f *GatewayFactory) Fallback() sms.Gateway { return f.fallback }

// brokenGateway stands in for a clinic whose stored key cannot be read. It reports
// itself as not live, so the dispatcher records "not configured" — the same honest
// outcome as having no key at all, rather than a misleading success or a message
// sent under the wrong name.
type brokenGateway struct{}

func (brokenGateway) Name() string { return "unreadable-key" }
func (brokenGateway) Live() bool   { return false }
func (brokenGateway) Send(_ context.Context, _ sms.Message) (*sms.Receipt, error) {
	return nil, sms.ErrNoStatus
}
func (brokenGateway) Status(_ context.Context, _ string) (*sms.Delivery, error) {
	return nil, sms.ErrNoStatus
}
