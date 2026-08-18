// Package sms puts text on a phone.
//
// The gateway is SMSEthiopia (smsethiopia.com), which connects directly to Ethio
// Telecom rather than through an aggregator. Its API is one endpoint and two
// fields, which is pleasant, but three absences shape everything above it:
//
//   - No delivery receipts. The send response carries no usable message id and
//     there is no status endpoint or callback, so the furthest we can honestly
//     know is that the network accepted the message. Nothing in this system
//     claims a message was "delivered", because nothing could check.
//   - No sender field. The identity the patient sees belongs to the account, and
//     one platform account serves every clinic — so the clinic's name has to be
//     inside the text or the patient has no idea who is writing to them.
//   - No batch send. A hundred recipients is a hundred HTTP calls, which is why
//     the dispatcher paces itself instead of looping as fast as it can.
package sms

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Message is one text to one number. MSISDN is 251XXXXXXXXX — see kernel/phone.
type Message struct {
	MSISDN string
	Text   string
}

// Gateway delivers a message, or explains why it could not.
type Gateway interface {
	Send(ctx context.Context, m Message) error
	Name() string
	// Live says whether this gateway really reaches phones. False for the log
	// adapter, so the UI can say "not configured" instead of implying it sent.
	Live() bool
}

// --- segment counting ---------------------------------------------------------
//
// An SMS is not a message, it is a number of 160-character units, and the count
// is what the clinic is billed for. Anything outside the GSM-7 alphabet — which
// includes every Amharic character — forces the whole message into UCS-2, where a
// unit is 70 characters. So a short, polite Amharic greeting is routinely three
// paid messages, and a clinic that cannot see that before pressing send finds out
// at the end of the month.

const gsm7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
	"¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"

// These exist in GSM-7 only via an escape byte, so they cost two characters each.
const gsm7Extended = "^{}\\[~]|€"

// Segments returns how many SMS units the text occupies and whether it had to
// fall back to Unicode.
func Segments(text string) (count int, unicode bool) {
	chars := 0
	for _, r := range text {
		switch {
		case strings.ContainsRune(gsm7, r):
			chars++
		case strings.ContainsRune(gsm7Extended, r):
			chars += 2
		default:
			unicode = true
		}
	}
	if unicode {
		// UCS-2 counts UTF-16 code units, so anything outside the Basic
		// Multilingual Plane (an emoji) is two. Ethiopic itself is one each.
		units := 0
		for _, r := range text {
			units++
			if r > 0xFFFF {
				units++
			}
		}
		return ceilDiv(units, 70, 67), true
	}
	return ceilDiv(chars, 160, 153), false
}

// ceilDiv splits n into segments, using the smaller concatenated size once a
// message needs more than one part (the header eats into every part).
func ceilDiv(n, single, multi int) int {
	if n == 0 {
		return 1 // an empty message still costs one; nothing should send it anyway
	}
	if n <= single {
		return 1
	}
	return (n + multi - 1) / multi
}

// --- the log adapter ----------------------------------------------------------

// LogGateway writes messages to the log instead of sending them. It is what runs
// before an API key is configured, so every surface can be built and demonstrated
// without spending a birr — and so a misconfigured production deploy fails loudly
// as "not configured" rather than quietly pretending to message patients.
type LogGateway struct{ log *slog.Logger }

// NewLogGateway constructs the dev adapter.
func NewLogGateway(log *slog.Logger) *LogGateway { return &LogGateway{log: log} }

// Name implements Gateway.
func (g *LogGateway) Name() string { return "log" }

// Live implements Gateway.
func (g *LogGateway) Live() bool { return false }

// Send implements Gateway.
func (g *LogGateway) Send(_ context.Context, m Message) error {
	n, uni := Segments(m.Text)
	g.log.Info("sms (log gateway — not sent)", "to", m.MSISDN, "segments", n, "unicode", uni, "text", m.Text)
	return nil
}

// --- SMSEthiopia --------------------------------------------------------------

// EthiopiaGateway talks to smsethiopia.com.
type EthiopiaGateway struct {
	key     string
	baseURL string
	client  *http.Client
}

// NewEthiopiaGateway constructs the live adapter. baseURL is configurable only so
// a test can point it at a local server.
func NewEthiopiaGateway(key, baseURL string) *EthiopiaGateway {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://smsethiopia.com"
	}
	return &EthiopiaGateway{
		key:     strings.TrimSpace(key),
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		// Generous but bounded: the dispatcher is sending one at a time and a hung
		// connection must not stall the queue behind it.
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

// Name implements Gateway.
func (g *EthiopiaGateway) Name() string { return "smsethiopia" }

// Live implements Gateway.
func (g *EthiopiaGateway) Live() bool { return g.key != "" }

type sendReq struct {
	MSISDN string `json:"msisdn"`
	Text   string `json:"text"`
}

type sendResp struct {
	Sent        bool   `json:"sent"`
	Description string `json:"description"`
}

// Send posts one message. The error it returns is the one a human will read in
// the message log, so it says what happened rather than quoting a status code.
func (g *EthiopiaGateway) Send(ctx context.Context, m Message) error {
	if g.key == "" {
		return fmt.Errorf("no SMS API key configured")
	}
	body, err := json.Marshal(sendReq{MSISDN: m.MSISDN, Text: m.Text})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+"/api/sms/send", bytes.NewReader(body))
	if err != nil {
		return err
	}
	// The key goes in a bare KEY header — not Bearer, not basic auth.
	req.Header.Set("KEY", g.key)
	req.Header.Set("Content-Type", "application/json")

	res, err := g.client.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach the SMS gateway: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<10))

	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return fmt.Errorf("the SMS gateway rejected the API key")
	}
	if res.StatusCode >= 500 {
		return fmt.Errorf("the SMS gateway is unavailable (%d)", res.StatusCode)
	}

	var out sendResp
	if e := json.Unmarshal(raw, &out); e != nil {
		// A non-JSON body from a 2xx is still a failure: we cannot confirm it was
		// accepted, and assuming success would lose the message silently.
		return fmt.Errorf("unexpected reply from the SMS gateway (%d): %s", res.StatusCode, snippet(raw))
	}
	if !out.Sent {
		if strings.TrimSpace(out.Description) != "" {
			return fmt.Errorf("gateway refused it: %s", out.Description)
		}
		return fmt.Errorf("gateway refused it (%d)", res.StatusCode)
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("gateway returned %d: %s", res.StatusCode, snippet(raw))
	}
	return nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
