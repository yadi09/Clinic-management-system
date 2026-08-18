// Package sms puts text on a phone.
//
// The gateway is SMSEthiopia (smsethiopia.com), connected directly to Ethio
// Telecom rather than through an aggregator. We speak its **v2** API: v1 returns
// no usable message id (`id` is literally always 0), which makes every message it
// sends permanently unobservable — there is no way to answer "did that arrive?".
// v2 returns a ULID, an authoritative segment count, and a status that can be
// looked up later.
//
// Three properties of this gateway shape everything above it:
//
//   - No batch endpoint. A hundred recipients is a hundred HTTP calls, under one
//     account-wide rate limit that every key shares. Fan-out is our worker pool's
//     problem, and 429 is the signal to slow down.
//   - No idempotency key. A retry after an ambiguous failure can deliver twice, so
//     deduplication is ours (messages.dedupe_key) and ambiguous retries are
//     deliberately limited rather than generous.
//   - No sender field. The identity comes from the campaign the API key is bound
//     to, permanently. One platform account means every clinic shares it, so the
//     clinic's name has to travel inside the text.
//
// Errors arrive in three different shapes and the difference matters: a 400 here
// is a business refusal (bad number, no balance, sender not approved) that will
// fail identically forever, so it must never be retried.
package sms

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Message is one text to one number. MSISDN is 251XXXXXXXXX — see kernel/phone.
type Message struct {
	MSISDN string
	Text   string
}

// Receipt is what the gateway said when it took the message.
type Receipt struct {
	// ID is the ULID. The only handle to the message; without it the message is
	// unobservable forever, so it is stored the moment it comes back.
	ID string
	// Segments is the gateway's own count of what it charged. Authoritative — our
	// pre-send estimate is for showing a price, this is what was actually deducted.
	Segments int
	Status   string
}

// Delivery is the state of a previously-sent message.
type Delivery struct {
	Status    string // ACCEPTED | SENT | DELIVERED
	Segments  int
	CreatedAt string
}

// Final reports whether a status can still change.
func (d Delivery) Final() bool { return strings.EqualFold(d.Status, "DELIVERED") }

// Error is a gateway failure, classified by whether trying again could ever help.
type Error struct {
	// Code is the gateway's business code (10000, 10005…) when it gave one.
	Code string
	// Message is what a person should read in the message log.
	Message string
	// Permanent means the same request will fail the same way forever. Retrying it
	// wastes attempts and, on an ambiguous failure, risks charging twice for a
	// message the patient already got.
	Permanent bool
	// RetryAfter is honoured for 429 when the gateway sends it.
	RetryAfter time.Duration
}

func (e *Error) Error() string { return e.Message }

// IsPermanent reports whether an error should stop the message rather than requeue
// it. Anything that is not a gateway Error is treated as transient — an unknown
// failure is more likely a blip than a verdict.
func IsPermanent(err error) bool {
	var e *Error
	if errors.As(err, &e) {
		return e.Permanent
	}
	return false
}

// RetryAfter extracts the gateway's requested pause, if it asked for one.
func RetryAfter(err error) time.Duration {
	var e *Error
	if errors.As(err, &e) {
		return e.RetryAfter
	}
	return 0
}

// Gateway delivers a message and can be asked what became of it.
type Gateway interface {
	Send(ctx context.Context, m Message) (*Receipt, error)
	// Status looks up a previously-sent message by its gateway id. Not every
	// gateway can answer; ErrNoStatus says so rather than pretending.
	Status(ctx context.Context, id string) (*Delivery, error)
	Name() string
	// Live says whether this gateway really reaches phones. False for the log
	// adapter, so nothing anywhere implies a patient was contacted.
	Live() bool
}

// ErrNoStatus is returned by gateways that cannot report delivery.
var ErrNoStatus = errors.New("this gateway cannot report delivery status")

// --- segment counting ---------------------------------------------------------
//
// An SMS is not a message, it is a number of 160-character units, and the count is
// what the package is charged. Anything outside the GSM-7 alphabet — which
// includes every Amharic character — forces the whole message into UCS-2, where a
// unit is 70 characters. A short, polite Amharic greeting is routinely three paid
// messages, and a clinic that cannot see that before pressing send finds out at
// the end of the month.
//
// This is our estimate, used to price a draft and to reserve quota. The gateway
// returns its own count on send, and that one wins.

const gsm7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
	"¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"

// These exist in GSM-7 only via an escape byte, so they cost two characters each.
const gsm7Extended = "^{}\\[~]|€"

// Segments returns how many SMS units the text occupies and whether it had to fall
// back to Unicode.
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
		// UCS-2 counts UTF-16 code units, so anything outside the Basic Multilingual
		// Plane (an emoji) is two. Ethiopic itself is one each.
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
// without spending a birr — and so a misconfigured production deploy reads as "not
// connected" rather than quietly pretending to message patients.
type LogGateway struct{ log *slog.Logger }

// NewLogGateway constructs the dev adapter.
func NewLogGateway(log *slog.Logger) *LogGateway { return &LogGateway{log: log} }

// Name implements Gateway.
func (g *LogGateway) Name() string { return "log" }

// Live implements Gateway.
func (g *LogGateway) Live() bool { return false }

// Send implements Gateway.
func (g *LogGateway) Send(_ context.Context, m Message) (*Receipt, error) {
	n, uni := Segments(m.Text)
	g.log.Info("sms (log gateway — not sent)", "to", m.MSISDN, "segments", n, "unicode", uni, "text", m.Text)
	return &Receipt{Segments: n, Status: "LOGGED"}, nil
}

// Status implements Gateway.
func (g *LogGateway) Status(context.Context, string) (*Delivery, error) { return nil, ErrNoStatus }

// --- SMSEthiopia v2 -----------------------------------------------------------

// EthiopiaGateway talks to smsethiopia.com's v2 API.
type EthiopiaGateway struct {
	key     string
	baseURL string
	client  *http.Client
	log     *slog.Logger
}

// NewEthiopiaGateway constructs the live adapter. baseURL is configurable only so
// a test can point it at a local server.
func NewEthiopiaGateway(key, baseURL string, log *slog.Logger) *EthiopiaGateway {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://smsethiopia.com"
	}
	return &EthiopiaGateway{
		key:     strings.TrimSpace(key),
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		// Generous but bounded. The dispatcher sends one at a time, so a hung
		// connection must not stall everything queued behind it.
		client: &http.Client{Timeout: 20 * time.Second},
		log:    log,
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
	Sent        bool            `json:"sent"`
	ID          json.RawMessage `json:"id"` // ULID on v2; a bare 0 on v1
	Description string          `json:"description"`
	Segments    int             `json:"segments"`
	Status      string          `json:"status"`
}

// Send posts one message and returns the gateway's receipt.
func (g *EthiopiaGateway) Send(ctx context.Context, m Message) (*Receipt, error) {
	if g.key == "" {
		return nil, &Error{Message: "no SMS API key configured", Permanent: true}
	}
	body, err := json.Marshal(sendReq{MSISDN: m.MSISDN, Text: m.Text})
	if err != nil {
		return nil, err
	}
	res, raw, err := g.do(ctx, http.MethodPost, "/api/v2/sms/send", body)
	if err != nil {
		return nil, err
	}
	if e := classify(res, raw); e != nil {
		return nil, e
	}

	var out sendResp
	if err := json.Unmarshal(raw, &out); err != nil {
		// A 2xx we cannot parse is not a success: we would have no message id, and
		// recording it as sent would lose the message silently.
		return nil, &Error{Message: fmt.Sprintf("unexpected reply from the SMS gateway: %s", snippet(raw))}
	}
	if !out.Sent {
		msg := strings.TrimSpace(out.Description)
		if msg == "" {
			msg = "the gateway refused the message"
		}
		// A refusal with a 200 is still a refusal, and the documented refusals are
		// all conditions a retry cannot change.
		return nil, &Error{Message: "gateway refused it: " + msg, Permanent: true}
	}
	return &Receipt{ID: parseID(out.ID), Segments: out.Segments, Status: defaultStr(out.Status, "ACCEPTED")}, nil
}

type statusResp struct {
	ID        string `json:"id"`
	MSISDN    string `json:"msisdn"`
	Segments  int    `json:"segments"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

// Status asks what became of a message.
//
// A 404 means "no such message, or not ours" — the gateway will not distinguish,
// and there is nothing useful to do with the difference. It is permanent either
// way: no amount of asking again will make it appear.
func (g *EthiopiaGateway) Status(ctx context.Context, id string) (*Delivery, error) {
	if g.key == "" {
		return nil, &Error{Message: "no SMS API key configured", Permanent: true}
	}
	if strings.TrimSpace(id) == "" {
		return nil, ErrNoStatus
	}
	res, raw, err := g.do(ctx, http.MethodGet, "/api/v2/sms/"+id, nil)
	if err != nil {
		return nil, err
	}
	if e := classify(res, raw); e != nil {
		return nil, e
	}
	var out statusResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, &Error{Message: fmt.Sprintf("unexpected status reply: %s", snippet(raw))}
	}
	return &Delivery{Status: strings.ToUpper(out.Status), Segments: out.Segments, CreatedAt: out.CreatedAt}, nil
}

// do performs the request and surfaces transport failures as transient errors.
func (g *EthiopiaGateway) do(ctx context.Context, method, path string, body []byte) (*http.Response, []byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.baseURL+path, rdr)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("KEY", g.key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := g.client.Do(req)
	if err != nil {
		// Transient, but ambiguous: the gateway may have taken the message and only
		// the reply was lost. There is no idempotency key to protect us, which is
		// why the dispatcher gives transport failures a much shorter leash than
		// failures the gateway explicitly reported.
		return nil, nil, &Error{Message: "could not reach the SMS gateway: " + err.Error()}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 16<<10))
	g.noteRateLimit(res)
	return res, raw, nil
}

// noteRateLimit logs when the account's shared budget is running down. The limit is
// per account, not per key, and its numeric value is not published — the headers
// are the only way to know where we stand.
func (g *EthiopiaGateway) noteRateLimit(res *http.Response) {
	rem := res.Header.Get("X-RateLimit-Remaining")
	if rem == "" || g.log == nil {
		return
	}
	if n, err := strconv.Atoi(rem); err == nil && n <= 10 {
		g.log.Warn("SMS rate limit nearly exhausted", "remaining", n, "limit", res.Header.Get("X-RateLimit-Limit"))
	}
}

// errCode pulls the business code out of the prose it is buried in:
// "...contact with system Administrator. Error Code :: 10005".
var errCode = regexp.MustCompile(`Error Code\s*::\s*(\d+)`)

// codeMeaning turns a gateway code into something a clinic can act on. Their own
// wording is addressed to a developer and mentions a "system Administrator" the
// clinic does not have.
var codeMeaning = map[string]string{
	"10000": "the gateway rejected the phone number",
	"10002": "the SMS account is not active — contact the provider",
	"10005": "the SMS package is out of credit — top it up to keep sending",
	"10006": "the sender name is not approved by Ethio Telecom yet",
	"10007": "this number is not on the test account's allowed list — verify it, or move to a paid package",
}

// classify turns an HTTP response into an Error, or nil when it succeeded.
//
// The gateway has three different failure shapes and they are not interchangeable:
// a business refusal arrives as a 400 with a code inside a sentence, a missing
// field arrives as a 400 keyed by field name with no code at all, and everything
// else is an HTTP status. Only 429 and 5xx are worth trying again.
func classify(res *http.Response, raw []byte) *Error {
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return &Error{Message: "the SMS gateway rejected the API key — it may have been deactivated", Permanent: true}
	case res.StatusCode == http.StatusNotFound:
		return &Error{Message: "the SMS gateway did not recognise that request", Permanent: true}
	case res.StatusCode == http.StatusTooManyRequests:
		e := &Error{Message: "the SMS gateway is rate-limiting us"}
		if v := res.Header.Get("Retry-After"); v != "" {
			if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
				e.RetryAfter = time.Duration(secs) * time.Second
			}
		}
		return e
	case res.StatusCode >= 500:
		return &Error{Message: fmt.Sprintf("the SMS gateway is unavailable (%d)", res.StatusCode)}
	case res.StatusCode == http.StatusBadRequest:
		return badRequest(raw)
	case res.StatusCode >= 300:
		return &Error{Message: fmt.Sprintf("the SMS gateway returned %d: %s", res.StatusCode, snippet(raw))}
	}
	return nil
}

// badRequest reads whichever of the two 400 shapes came back. Both are permanent:
// the same request will be refused the same way every time.
func badRequest(raw []byte) *Error {
	var withMsg struct {
		ErrorMessage string `json:"error_message"`
	}
	if json.Unmarshal(raw, &withMsg) == nil && strings.TrimSpace(withMsg.ErrorMessage) != "" {
		code := ""
		if m := errCode.FindStringSubmatch(withMsg.ErrorMessage); len(m) == 2 {
			code = m[1]
		}
		msg := codeMeaning[code]
		if msg == "" {
			// Strip the trailing "Error Code :: NNNNN" so the log reads as a sentence.
			msg = strings.TrimSpace(errCode.ReplaceAllString(withMsg.ErrorMessage, ""))
			msg = strings.TrimRight(msg, " .")
		}
		return &Error{Code: code, Message: msg, Permanent: true}
	}
	// The field-keyed shape: {"msisdn":"msisdn is mandatory"}.
	var fields map[string]string
	if json.Unmarshal(raw, &fields) == nil && len(fields) > 0 {
		parts := make([]string, 0, len(fields))
		for _, v := range fields {
			parts = append(parts, v)
		}
		return &Error{Message: "the gateway rejected the request: " + strings.Join(parts, "; "), Permanent: true}
	}
	return &Error{Message: "the gateway rejected the request: " + snippet(raw), Permanent: true}
}

// parseID reads the id field, which is a ULID string on v2 and a bare 0 on v1.
// A v1-shaped id is discarded rather than stored as "0" — a handle that identifies
// nothing is worse than an empty one, because it looks like it works.
func parseID(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return strings.TrimSpace(s)
	}
	return ""
}

func defaultStr(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		return s[:200] + "…"
	}
	return s
}
