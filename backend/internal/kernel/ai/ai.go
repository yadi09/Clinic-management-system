// Package ai is a thin client for an OpenAI-compatible chat-completions API
// (NVIDIA's build platform — integrate.api.nvidia.com — by default). It powers
// "ClinicOS Assist", the clinical decision-support co-pilot. The API key is held
// server-side only; an empty key yields a client whose Suggest returns
// ErrNotConfigured (the feature is disabled, never exposed to the browser).
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrNotConfigured is returned when no API key is set (feature disabled).
var ErrNotConfigured = errors.New("ai co-pilot is not configured")

// ErrUnauthorized is returned when the provider rejects the API key.
var ErrUnauthorized = errors.New("ai provider rejected the API key")

// Client calls an OpenAI-compatible /chat/completions endpoint.
type Client struct {
	apiKey  string
	model   string
	baseURL string
	http    *http.Client
}

// New builds a client. An empty apiKey yields a client whose Suggest returns
// ErrNotConfigured. model/baseURL fall back to sensible NVIDIA defaults.
func New(apiKey, model, baseURL string) *Client {
	if strings.TrimSpace(model) == "" {
		model = "meta/llama-3.3-70b-instruct"
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://integrate.api.nvidia.com/v1"
	}
	return &Client{
		apiKey:  strings.TrimSpace(apiKey),
		model:   model,
		baseURL: strings.TrimRight(baseURL, "/"),
		// Per-call timeouts are enforced via context in Suggest; this is only a
		// hard backstop for a connection that never returns.
		http: &http.Client{Timeout: 95 * time.Second},
	}
}

// Configured reports whether an API key is present.
func (c *Client) Configured() bool { return c != nil && c.apiKey != "" }

// AssistInput is the clinical context assembled for one analysis.
type AssistInput struct {
	Age         int
	Gender      string
	BloodGroup  string
	Allergies   []string
	Vitals      []string
	Note        string
	Diagnoses   []string
	Medications []string
	PastHistory []string
}

// Differential is one candidate condition, most-likely first.
type Differential struct {
	Condition  string `json:"condition"`
	Why        string `json:"why"`
	Likelihood string `json:"likelihood"` // high | moderate | low
}

// ManagementItem is a treatment consideration (a direction, not a prescription).
type ManagementItem struct {
	Suggestion string `json:"suggestion"`
	Caution    string `json:"caution,omitempty"`
}

// AssistResult is the structured decision-support output rendered in the panel.
type AssistResult struct {
	Differentials []Differential   `json:"differentials"`
	RedFlags      []string         `json:"red_flags"`
	Workup        []string         `json:"workup"`
	Management    []ManagementItem `json:"management"`
	Questions     []string         `json:"questions"`
	Summary       string           `json:"summary,omitempty"`
	Model         string           `json:"model,omitempty"`
}

const systemPrompt = `You are ClinicOS Assist, a clinical decision-support assistant for a licensed doctor in an outpatient clinic in Ethiopia. You are NOT the treating clinician and you never make the final decision — the doctor does. Your job is to help the doctor think, catch what they might miss, and move faster.

Given the patient's context (demographics, allergies, vitals, the doctor's note, any working diagnoses/medications this visit, and relevant past history), return concise, provisional decision support:
- differentials: the most likely conditions for THIS presentation. Each has "condition", a one-line clinical "why" tied to the actual findings, and "likelihood" of exactly "high", "moderate", or "low". Order most-likely first. 3-6 items.
- red_flags: danger signs or findings warranting urgent attention, escalation, or referral. Err toward caution — if something could be serious, flag it. Empty array if none.
- workup: the most useful next tests, exams, or checks to narrow the diagnosis.
- management: general treatment considerations — drug CLASSES or directions, NOT exact doses. If a consideration conflicts with a listed allergy, avoid it or put the warning in "caution".
- questions: the few history questions that would most change the diagnosis.
- summary: one short sentence; if the note is too sparse to be useful, say so here and focus "questions" on what to gather.

Rules:
- Weigh conditions common in Ethiopia / low-resource settings where relevant (malaria, typhoid, TB, respiratory and diarrheal infections) alongside the general differential.
- Treat listed allergies as HARD constraints for any medication suggestion.
- Never invent findings not present in the context.
- Be specific and brief. Do not include disclaimers in the content — the interface shows them.
- Return ONLY a single JSON object matching the schema. No markdown fences, no prose before or after.`

// chat request/response (OpenAI-compatible subset).
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
}
type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
}

// Suggest builds the prompt from the clinical context, calls the model, and
// parses its JSON reply into an AssistResult. It retries transient upstream
// errors (5xx / network) and model-output that fails to parse — the free tier is
// flaky and the model's JSON shape varies, so a retry usually succeeds.
func (c *Client) Suggest(ctx context.Context, in AssistInput) (*AssistResult, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	reqBody, err := json.Marshal(chatRequest{
		Model:       c.model,
		Temperature: 0.2,
		MaxTokens:   1100,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: buildUserPrompt(in)},
		},
	})
	if err != nil {
		return nil, err
	}

	// The free NVIDIA tier is slow and variable — a single completion often needs
	// 30-50s under load. Give each call a generous window, retry only once (a
	// too-short window that always times out just wastes the budget), and cap the
	// whole operation safely under the ~100s edge/proxy limit.
	const (
		attempts       = 2
		perCallTimeout = 50 * time.Second
		overallBudget  = 88 * time.Second
	)
	ctx, cancel := context.WithTimeout(ctx, overallBudget)
	defer cancel()

	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(700 * time.Millisecond):
			}
		}
		// The per-call timeout is bounded by whatever remains of overallBudget.
		callCtx, callCancel := context.WithTimeout(ctx, perCallTimeout)
		body, status, cerr := c.call(callCtx, reqBody)
		callCancel()
		if cerr != nil {
			lastErr = cerr // network/timeout — retry if budget remains
			continue
		}
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			return nil, ErrUnauthorized
		}
		if status >= 500 {
			lastErr = fmt.Errorf("ai provider returned %d: %s", status, snippet(body)) // transient — retry
			continue
		}
		if status < 200 || status >= 300 {
			return nil, fmt.Errorf("ai provider returned %d: %s", status, snippet(body)) // 4xx — don't retry
		}
		res, perr := parseAssist(body)
		if perr != nil {
			lastErr = perr // model returned junk/unparseable — retry for a cleaner shape
			continue
		}
		res.Model = c.model
		return res, nil
	}
	return nil, lastErr
}

// call performs one POST to the chat-completions endpoint.
func (c *Client) call(ctx context.Context, reqBody []byte) (body []byte, status int, err error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		return nil, 0, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, _ = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return body, resp.StatusCode, nil
}

// parseAssist extracts the model's JSON reply and leniently coerces it into an
// AssistResult. The model's field shapes drift (strings vs objects, alternate
// keys), so each field is coerced defensively rather than strict-unmarshalled.
func parseAssist(respBody []byte) (*AssistResult, error) {
	var cr chatResponse
	if err := json.Unmarshal(respBody, &cr); err != nil {
		return nil, fmt.Errorf("decode ai response: %w", err)
	}
	if len(cr.Choices) == 0 || strings.TrimSpace(cr.Choices[0].Message.Content) == "" {
		return nil, errors.New("ai response had no content")
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(extractJSON(cr.Choices[0].Message.Content)), &doc); err != nil {
		return nil, fmt.Errorf("parse ai suggestions: %w", err)
	}
	out := &AssistResult{
		Differentials: parseDifferentials(doc["differentials"]),
		RedFlags:      parseStringList(doc["red_flags"]),
		Workup:        parseStringList(doc["workup"]),
		Management:    parseManagement(doc["management"]),
		Questions:     parseStringList(doc["questions"]),
		Summary:       rawString(doc["summary"]),
	}
	if len(out.Differentials) == 0 && len(out.RedFlags) == 0 && len(out.Workup) == 0 && len(out.Questions) == 0 && out.Summary == "" {
		return nil, errors.New("ai response had no usable suggestions")
	}
	return out, nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// --- lenient coercion helpers (accept string-or-object, alternate keys) ---

func rawList(rm json.RawMessage) []json.RawMessage {
	var l []json.RawMessage
	_ = json.Unmarshal(rm, &l)
	return l
}
func rawString(rm json.RawMessage) string {
	var s string
	_ = json.Unmarshal(rm, &s)
	return strings.TrimSpace(s)
}
func rawMap(rm json.RawMessage) (map[string]any, bool) {
	var m map[string]any
	if err := json.Unmarshal(rm, &m); err == nil {
		return m, true
	}
	return nil, false
}
func firstStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
}
func parseStringList(rm json.RawMessage) []string {
	var out []string
	for _, e := range rawList(rm) {
		if s := rawString(e); s != "" {
			out = append(out, s)
			continue
		}
		if m, ok := rawMap(e); ok {
			s := firstStr(m, "text", "description", "name", "value", "item", "flag", "finding", "question", "test", "action", "detail")
			if s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}
func parseDifferentials(rm json.RawMessage) []Differential {
	var out []Differential
	for _, e := range rawList(rm) {
		if s := rawString(e); s != "" {
			out = append(out, Differential{Condition: s})
			continue
		}
		if m, ok := rawMap(e); ok {
			cond := firstStr(m, "condition", "diagnosis", "name", "disease")
			if cond == "" {
				continue
			}
			out = append(out, Differential{
				Condition:  cond,
				Why:        firstStr(m, "why", "rationale", "reason", "explanation", "justification"),
				Likelihood: firstStr(m, "likelihood", "probability", "confidence"),
			})
		}
	}
	return out
}
func parseManagement(rm json.RawMessage) []ManagementItem {
	var out []ManagementItem
	for _, e := range rawList(rm) {
		if s := rawString(e); s != "" {
			out = append(out, ManagementItem{Suggestion: s})
			continue
		}
		if m, ok := rawMap(e); ok {
			sug := firstStr(m, "suggestion", "consideration", "recommendation", "treatment", "action", "text", "plan", "management")
			if sug == "" {
				continue
			}
			out = append(out, ManagementItem{
				Suggestion: sug,
				Caution:    firstStr(m, "caution", "warning", "note", "alert"),
			})
		}
	}
	return out
}

func buildUserPrompt(in AssistInput) string {
	var b strings.Builder
	gender := in.Gender
	if gender == "" {
		gender = "patient"
	}
	fmt.Fprintf(&b, "PATIENT: %d-year-old %s", in.Age, gender)
	if in.BloodGroup != "" {
		fmt.Fprintf(&b, ", blood group %s", in.BloodGroup)
	}

	b.WriteString("\n\nALLERGIES: ")
	if len(in.Allergies) == 0 {
		b.WriteString("none recorded")
	} else {
		b.WriteString(strings.Join(in.Allergies, "; "))
	}

	b.WriteString("\n\nVITALS: ")
	if len(in.Vitals) == 0 {
		b.WriteString("not recorded")
	} else {
		b.WriteString(strings.Join(in.Vitals, ", "))
	}

	if strings.TrimSpace(in.Note) != "" {
		fmt.Fprintf(&b, "\n\nDOCTOR'S NOTE:\n%s", strings.TrimSpace(in.Note))
	}
	if len(in.Diagnoses) > 0 {
		fmt.Fprintf(&b, "\n\nWORKING DIAGNOSES THIS VISIT: %s", strings.Join(in.Diagnoses, "; "))
	}
	if len(in.Medications) > 0 {
		fmt.Fprintf(&b, "\n\nPRESCRIBED THIS VISIT: %s", strings.Join(in.Medications, "; "))
	}
	if len(in.PastHistory) > 0 {
		fmt.Fprintf(&b, "\n\nRELEVANT PAST HISTORY (most recent first):\n- %s", strings.Join(in.PastHistory, "\n- "))
	}
	b.WriteString("\n\nReturn the decision support as the specified JSON object only.")
	return b.String()
}

// extractJSON returns the outermost {...} object from a model reply, tolerating
// markdown fences or stray prose around it.
func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}
