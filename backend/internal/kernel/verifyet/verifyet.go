// Package verifyet talks to Verify.ET, the Ethiopian bank and wallet receipt
// verification service.
//
// It answers one question: does this transaction reference exist at the bank, and
// what does it say? It moves no money and settles nothing — a patient hands over a
// reference as proof of payment, and this checks the claim.
//
// Three things about the vendor's contract shape this code, all read from their
// documentation rather than guessed:
//
//   - `data` is an ARRAY on POST /api/verify and an OBJECT on GET /api/verify/:id.
//     Code that assumes one breaks on the other, so both are decoded explicitly.
//   - `amount` arrives as a NUMBER in the synchronous example and a STRING in the
//     webhook example. It is decoded as json.Number and kept as a decimal string;
//     money never touches a float here.
//   - `accountSuffix` and every reference are digit STRINGS. Coercing them to an
//     integer destroys leading zeros, which is the difference between finding a
//     transaction and not.
//
// There is no sandbox. The vendor points integrations at production, so every call
// with a real key spends a real credit from a shared, non-rolling balance. With no
// key configured the client reports Live() == false and refuses to call out at all.
package verifyet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Request is one verification submission.
type Request struct {
	// Bank is the provider key (cbe, telebirr, …). Empty asks the vendor's universal
	// router to work it out, which the docs say is weaker than telling it: an
	// explicit bank always wins and gets strict per-bank validation.
	Bank      string
	Reference string
	// Suffix is the account suffix CBE (8 digits) and BOA (5) require. A string, always.
	Suffix string
	Phone  string
	// SettlementAccount is the account the money should have reached — ours. Sent
	// explicitly rather than relying on the vendor's saved-account fallback, because
	// this is a multi-tenant product and "any account we own" is the wrong question.
	SettlementAccount string
	// IdempotencyKey must be stable across retries of the same claim and different
	// for genuinely different ones, so a double-click never spends two credits.
	IdempotencyKey string
	// WaitMs asks the vendor to hold the request open for an immediate answer. Purely
	// a latency optimisation: a queued reply is still a valid reply.
	WaitMs int
}

// Result is a verification, whether it finished or not.
type Result struct {
	RequestID        string
	ProcessingStatus string // queued | running | completed | failed
	Status           string // pending | success
	Verified         bool

	Amount       string // decimal string, never a float
	Currency     string
	SenderName   string
	ReceiverName string
	// ReceiverAccount may be masked by the provider ("1****7441").
	ReceiverAccount string
	ReferenceNumber string
	AccountSuffix   string
	Timestamp       string

	Settlement   *Settlement
	Confirmation *Confirmation

	// VendorRequestID is the x-request-id response header — what their support asks
	// for. Captured on every call, including failures.
	VendorRequestID string
	// Raw is the untouched result object, kept as the evidence trail.
	Raw json.RawMessage
}

// Done reports whether the vendor has finished with this request.
func (r *Result) Done() bool {
	return r != nil && (r.ProcessingStatus == "completed" || r.ProcessingStatus == "failed")
}

// Settlement answers "was it paid to US?" — the single most important field here.
// A receipt can be entirely genuine and still be a payment to somebody else.
type Settlement struct {
	Matched         bool   `json:"matched"`
	MatchType       string `json:"matchType"`
	MatchConfidence string `json:"matchConfidence"`
	ReceiverAccount string `json:"receiverAccount"`
	CandidateCount  int    `json:"candidateCount"`
	// Ambiguous means the vendor refused to guess between several saved accounts.
	// It is not a failure and not a pass: it is a question for a human.
	Ambiguous bool   `json:"ambiguous"`
	Reason    string `json:"reason"`
}

// Confirmation is the replay signal: has this receipt been claimed before? Scope is
// "platform", so a prior confirmation may be another merchant, or our own retry — it
// raises suspicion, it does not prove fraud.
type Confirmation struct {
	Scope               string `json:"scope"`
	IsFirstConfirmation bool   `json:"isFirstConfirmation"`
	ConfirmedBefore     bool   `json:"confirmedBefore"`
	FirstConfirmedAt    string `json:"firstConfirmedAt"`
	LastConfirmedAt     string `json:"lastConfirmedAt"`
	ConfirmationCount   int    `json:"confirmationCount"`
}

// Error is a typed vendor failure. Kind drives what the caller does about it; the
// distinction that matters most is permanent versus worth retrying.
type Error struct {
	Kind       string // auth | forbidden | conflict | invalid | rate_limited | no_credit | unavailable | transport
	Status     int
	Message    string
	RetryAfter time.Duration
	RequestID  string
}

func (e *Error) Error() string { return e.Message }

// Kind constants, so callers match on a value rather than a string literal.
const (
	KindAuth        = "auth"
	KindForbidden   = "forbidden"
	KindConflict    = "conflict"
	KindInvalid     = "invalid"
	KindRateLimited = "rate_limited"
	KindNoCredit    = "no_credit"
	KindUnavailable = "unavailable"
	KindTransport   = "transport"
)

// KindOf reports the vendor failure kind, or "" if err is not one.
func KindOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return ""
}

// Client is a Verify.ET API client.
type Client struct {
	key     string
	baseURL string
	http    *http.Client
	log     *slog.Logger
}

func New(key, baseURL string, log *slog.Logger) *Client {
	return &Client{
		key:     strings.TrimSpace(key),
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		// Generous but bounded: the vendor may hold a request open for waitMs, and a
		// hung call at the cashier is worse than a refused one.
		http: &http.Client{Timeout: 30 * time.Second},
		log:  log,
	}
}

// Live reports whether a key is configured. With no key nothing is ever sent.
func (c *Client) Live() bool { return c.key != "" }

// Verify submits a reference and returns whatever the vendor knows so far. A 202
// (queued) is a normal outcome, not an error: the result carries the request id and
// the caller polls.
func (c *Client) Verify(ctx context.Context, in Request) (*Result, error) {
	if !c.Live() {
		return nil, &Error{Kind: KindAuth, Message: "receipt verification is not configured"}
	}
	body := map[string]any{"reference": in.Reference}
	if in.Bank != "" {
		body["bank"] = in.Bank
	}
	if in.Suffix != "" {
		// Both spellings are documented; sending the explicit one avoids relying on
		// the router's aliasing.
		body["accountSuffix"] = in.Suffix
	}
	if in.Phone != "" {
		body["phoneNumber"] = in.Phone
	}
	if in.SettlementAccount != "" {
		body["settlementAccount"] = in.SettlementAccount
	}
	raw, _ := json.Marshal(body)

	path := "/api/verify"
	if in.WaitMs > 0 {
		path += "?waitMs=" + strconv.Itoa(in.WaitMs)
	}
	resp, err := c.do(ctx, http.MethodPost, path, raw, in.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	return parseSubmit(resp)
}

// Status re-reads a verification. Also the authoritative read after any asynchronous
// notice: never decide about money from a payload somebody else sent us.
func (c *Client) Status(ctx context.Context, requestID string) (*Result, error) {
	if !c.Live() {
		return nil, &Error{Kind: KindAuth, Message: "receipt verification is not configured"}
	}
	resp, err := c.do(ctx, http.MethodGet, "/api/verify/"+requestID, nil, "")
	if err != nil {
		return nil, err
	}
	return parseStatus(resp)
}

// --- transport ---------------------------------------------------------------

type rawResponse struct {
	status    int
	body      []byte
	requestID string
	retry     time.Duration
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, idem string) (*rawResponse, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil {
		return nil, &Error{Kind: KindTransport, Message: "could not build the request"}
	}
	req.Header.Set("x-api-key", c.key)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if idem != "" {
		req.Header.Set("Idempotency-Key", idem)
	}

	res, err := c.http.Do(req)
	if err != nil {
		// Deliberately vague to the caller and specific in the log: an error message
		// that reaches a screen must never be able to carry a credential.
		c.log.Warn("verify.et transport failure", "err", err, "path", path)
		return nil, &Error{Kind: KindTransport, Message: "could not reach the verification service"}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))

	out := &rawResponse{status: res.StatusCode, body: b, requestID: res.Header.Get("x-request-id")}
	if ra := res.Header.Get("Retry-After"); ra != "" {
		if secs, e := strconv.Atoi(strings.TrimSpace(ra)); e == nil {
			out.retry = time.Duration(secs) * time.Second
		}
	}
	if res.StatusCode >= 400 {
		return nil, c.asError(out)
	}
	return out, nil
}

// asError maps a vendor status onto something the caller can act on. The business
// code the docs bury in prose ("Error Code :: 10005") is read where it changes the
// answer — credit exhaustion is an ops emergency, not a bad request.
func (c *Client) asError(r *rawResponse) *Error {
	msg := vendorMessage(r.body)
	e := &Error{Status: r.status, Message: msg, RetryAfter: r.retry, RequestID: r.requestID}
	switch r.status {
	case http.StatusUnauthorized:
		e.Kind, e.Message = KindAuth, "the verification service rejected our key"
	case http.StatusForbidden:
		e.Kind, e.Message = KindForbidden, "our verification key lacks permission for this"
	case http.StatusConflict:
		e.Kind = KindConflict
	case http.StatusPaymentRequired:
		e.Kind, e.Message = KindNoCredit, "verification credits are exhausted"
	case http.StatusTooManyRequests:
		e.Kind, e.Message = KindRateLimited, "the verification service is rate limiting us"
	case http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
		e.Kind, e.Message = KindUnavailable, "the verification service is unavailable"
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		e.Kind = KindInvalid
		// 10005 is "no credit" wearing a 400. Treating it as a bad reference would
		// have the desk retyping a perfectly good number while the balance is empty.
		if strings.Contains(msg, "10005") {
			e.Kind, e.Message = KindNoCredit, "verification credits are exhausted"
		}
		if e.Message == "" {
			e.Message = "the bank could not accept those details"
		}
	default:
		e.Kind = KindTransport
		if e.Message == "" {
			e.Message = "the verification service returned an unexpected error"
		}
	}
	return e
}

func vendorMessage(b []byte) string {
	var env struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal(b, &env)
	if env.Message != "" {
		return env.Message
	}
	return env.Error
}

// --- decoding the two shapes --------------------------------------------------

type item struct {
	Bank            string          `json:"bank"`
	Status          string          `json:"status"`
	Verified        bool            `json:"verified"`
	Amount          json.Number     `json:"amount"`
	Currency        string          `json:"currency"`
	SenderName      string          `json:"senderName"`
	ReceiverName    string          `json:"receiverName"`
	ReceiverAccount string          `json:"receiverAccount"`
	ReferenceNumber string          `json:"referenceNumber"`
	AccountSuffix   string          `json:"accountSuffix"`
	Timestamp       string          `json:"timestamp"`
	Settlement      *Settlement     `json:"settlementAccountMatch"`
	Confirmation    *Confirmation   `json:"confirmationHistory"`
	Raw             json.RawMessage `json:"-"`
}

type verification struct {
	RequestID        string `json:"requestId"`
	Bank             string `json:"bank"`
	ProcessingStatus string `json:"processingStatus"`
	Status           string `json:"status"`
	Verified         bool   `json:"verified"`
}

// parseSubmit reads POST /api/verify, where `data` is an ARRAY.
func parseSubmit(r *rawResponse) (*Result, error) {
	var env struct {
		RequestID    string          `json:"requestId"`
		Verification *verification   `json:"verification"`
		Data         json.RawMessage `json:"data"`
	}
	if e := json.Unmarshal(r.body, &env); e != nil {
		return nil, &Error{Kind: KindTransport, Message: "the verification service sent something we could not read", RequestID: r.requestID}
	}
	var items []item
	if len(env.Data) > 0 {
		// Tolerant on purpose: documented as an array here, but accepting the object
		// shape too costs one branch and removes a whole class of outage.
		if e := json.Unmarshal(env.Data, &items); e != nil {
			var one item
			if e2 := json.Unmarshal(env.Data, &one); e2 == nil {
				items = []item{one}
			}
		}
	}
	return assemble(env.RequestID, env.Verification, items, env.Data, r.requestID), nil
}

// parseStatus reads GET /api/verify/:id, where `data` is an OBJECT.
func parseStatus(r *rawResponse) (*Result, error) {
	var env struct {
		RequestID    string          `json:"requestId"`
		Verification *verification   `json:"verification"`
		Data         json.RawMessage `json:"data"`
	}
	if e := json.Unmarshal(r.body, &env); e != nil {
		return nil, &Error{Kind: KindTransport, Message: "the verification service sent something we could not read", RequestID: r.requestID}
	}
	var items []item
	if len(env.Data) > 0 {
		var one item
		if e := json.Unmarshal(env.Data, &one); e == nil {
			items = []item{one}
		} else {
			_ = json.Unmarshal(env.Data, &items)
		}
	}
	return assemble(env.RequestID, env.Verification, items, env.Data, r.requestID), nil
}

func assemble(reqID string, v *verification, items []item, raw json.RawMessage, xReqID string) *Result {
	out := &Result{RequestID: reqID, VendorRequestID: xReqID, Raw: raw}
	if v != nil {
		if v.RequestID != "" {
			out.RequestID = v.RequestID
		}
		out.ProcessingStatus, out.Status, out.Verified = v.ProcessingStatus, v.Status, v.Verified
	}
	if len(items) == 0 {
		return out
	}
	it := items[0]
	if it.Status != "" {
		out.Status = it.Status
	}
	// A completed item that says verified outranks a stale envelope flag.
	if it.Verified {
		out.Verified = true
	}
	out.Amount = decimalOf(it.Amount)
	out.Currency, out.SenderName, out.ReceiverName = it.Currency, it.SenderName, it.ReceiverName
	out.ReceiverAccount, out.ReferenceNumber = it.ReceiverAccount, it.ReferenceNumber
	out.AccountSuffix, out.Timestamp = it.AccountSuffix, it.Timestamp
	out.Settlement, out.Confirmation = it.Settlement, it.Confirmation
	// An item present with a terminal status means the work is done even if the
	// envelope did not say so.
	if out.ProcessingStatus == "" && (it.Status == "success" || it.Verified) {
		out.ProcessingStatus = "completed"
	}
	return out
}

// decimalOf normalises the vendor's number-or-string amount to a decimal string.
// Never a float: 1500.1 is not a value this system is allowed to invent.
func decimalOf(n json.Number) string {
	s := strings.TrimSpace(n.String())
	if s == "" {
		return ""
	}
	if _, err := strconv.ParseFloat(s, 64); err != nil {
		return ""
	}
	return s
}

// Fmt renders a decimal string to two places for comparison and display.
func Fmt(s string) string {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return s
	}
	return fmt.Sprintf("%.2f", f)
}
