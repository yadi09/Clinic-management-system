package regression

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Patient SMS and the staff inbox, through the API, as a dental clinic uses them:
// how the clinic sends (settings, wording, timing), who it can reach, one-off
// messages, chasing unbilled treatment, the log the front desk answers "did you
// tell me?" from, and the bell. Nothing here can reach a phone: the API under test
// has no SMS key, so it runs the log gateway, and the API never sends — it only
// queues. Sending is the worker's job and is covered in
// internal/messaging/dispatch/*_integration_test.go.

// ---- helpers (prefixed msg: other files share this package) -----------------

// msgClinic is a dental clinic on the Practice plan, which includes Patient SMS,
// recall lists and a 2,000-segment monthly allowance.
func msgClinic(t *testing.T) *testkit.Clinic {
	t.Helper()
	return testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-practice"})
}

// msgPhone is a fresh, valid Ethio Telecom mobile in the local form.
func msgPhone() string { return fmt.Sprintf("09%08d", rand.Intn(100000000)) }

// msgMSISDN is what the gateway is given for a local 09… number.
func msgMSISDN(local string) string { return "251" + local[1:] }

func msgExec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := super.Pool.Exec(t.Context(), q, args...); err != nil {
		t.Fatalf("%v\n%s", err, q)
	}
}

func msgID(t *testing.T, prefix, s string) uuid.UUID {
	t.Helper()
	u, err := id.Decode(prefix, s)
	if err != nil {
		t.Fatalf("decode %s id %q: %v", prefix, s, err)
	}
	return u
}

// msgPatient registers a patient with exactly this phone ("" for none).
func msgPatient(t *testing.T, c *testkit.Client, first, phone string) patientRef {
	t.Helper()
	body := map[string]any{"first_name": first, "last_name": "Msg", "gender": "female",
		"dob": "1988-03-02", "force": true}
	if phone != "" {
		body["phone"] = phone
	}
	r := c.Do("POST", "/patients", body).Expect(t, 201, "create patient")
	var p patientRef
	r.Decode(t, &p)
	return p
}

// msgOn switches sending on as the owner, under a short sender name.
func msgOn(t *testing.T, c *testkit.Clinic, lang string) {
	t.Helper()
	srv.As(t, c, "owner").Do("PUT", "/messaging/settings", map[string]any{
		"enabled": true, "lang": lang, "sender_name": "Smile", "quiet_from": "21:00", "quiet_to": "07:00",
	}).Expect(t, 200, "switch sending on")
}

// msgInsert puts a message on the log directly — the shape a worker leaves behind
// (sent, failed, skipped), which the API itself never writes.
func msgInsert(t *testing.T, c *testkit.Clinic, patient *uuid.UUID, kind, status, msisdn, body, skip string) uuid.UUID {
	t.Helper()
	var mid uuid.UUID
	var skipArg any
	if skip != "" {
		skipArg = skip
	}
	if err := super.Pool.QueryRow(t.Context(),
		`INSERT INTO messages (tenant_id, patient_id, kind, lang, msisdn, body, segments, cost, status,
		                       skip_reason, scheduled_for, sent_at)
		 VALUES ($1,$2,$3,'en',$4,$5,1,0.5,$6,$7, now() - interval '1 hour',
		         CASE WHEN $6 IN ('sent','delivered') THEN now() END)
		 RETURNING id`,
		c.TenantID, patient, kind, msisdn, body, status, skipArg).Scan(&mid); err != nil {
		t.Fatalf("insert message: %v", err)
	}
	return mid
}

type msgLogRow struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	MSISDN     string `json:"msisdn"`
	Body       string `json:"body"`
	Status     string `json:"status"`
	SkipReason string `json:"skip_reason"`
	CanResend  bool   `json:"can_resend"`
	CanSendNow bool   `json:"can_send_now"`
	Retried    bool   `json:"retried"`
	PatientID  string `json:"patient_id"`
	MRN        string `json:"mrn"`
}

func msgLog(t *testing.T, c *testkit.Client, query string) []msgLogRow {
	t.Helper()
	var rows []msgLogRow
	c.Do("GET", "/messaging/log"+query, nil).Expect(t, 200, "message log").Decode(t, &rows)
	return rows
}

type msgSettings struct {
	Enabled      bool    `json:"enabled"`
	Lang         string  `json:"lang"`
	QuietFrom    string  `json:"quiet_from"`
	QuietTo      string  `json:"quiet_to"`
	SenderName   string  `json:"sender_name"`
	SenderID     string  `json:"sender_id"`
	SenderStatus string  `json:"sender_status"`
	HasOwnKey    bool    `json:"has_own_key"`
	BodyPrefix   string  `json:"body_prefix"`
	GatewayLive  bool    `json:"gateway_live"`
	GatewayName  string  `json:"gateway_name"`
	Cost         float64 `json:"cost_per_segment"`
}

// ---- gate and permissions ---------------------------------------------------

// TestREG_MSG_001_PatientSMSIsAPlanFeature: Given a clinic whose plan does not
// include Patient SMS (the default plan, and the dental Chair plan), When anyone
// opens the messaging screens, Then they are refused as a module the clinic does not
// have; and a signed-out caller is refused outright.
func TestREG_MSG_001_PatientSMSIsAPlanFeature(t *testing.T) {
	for _, plan := range []string{"", "dental-chair"} {
		c := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: plan})
		owner := srv.As(t, c, "owner")
		for _, path := range []string{"/messaging/settings", "/messaging/log", "/messaging/templates"} {
			r := owner.Do("GET", path, nil).Expect(t, 403, "plan "+plan+" "+path)
			if r.Code != "MODULE_DISABLED" {
				t.Fatalf("plan %q %s: want MODULE_DISABLED, got %s", plan, path, r.Code)
			}
		}
	}
	srv.Anon(t).Do("GET", "/messaging/settings", nil).Expect(t, 401, "signed out")
	srv.Anon(t).Do("GET", "/notifications", nil).Expect(t, 401, "signed out inbox")
}

// TestREG_MSG_002_WhoMaySendAndWhoMayConfigure: Given a Practice clinic, When each
// role touches messaging, Then the front desk (message.send) can read and send but
// not change policy, the branch manager and owner (message.manage) can do both, and
// a doctor, nurse or cashier (neither permission) is refused everything.
func TestREG_MSG_002_WhoMaySendAndWhoMayConfigure(t *testing.T) {
	c := msgClinic(t)
	desk := srv.As(t, c, "receptionist")
	desk.Do("GET", "/messaging/settings", nil).Expect(t, 200, "desk reads settings")
	desk.Do("GET", "/messaging/usage", nil).Expect(t, 200, "desk reads usage")
	desk.Do("GET", "/messaging/variables", nil).Expect(t, 200, "desk reads variables")
	for _, rq := range []struct{ method, path string }{
		{"PUT", "/messaging/settings"}, {"PUT", "/messaging/templates"}, {"PUT", "/messaging/rules"},
	} {
		r := desk.Do(rq.method, rq.path, map[string]any{}).Expect(t, 403, "desk "+rq.path)
		if r.Code != "FORBIDDEN_PERMISSION" {
			t.Fatalf("desk %s: want FORBIDDEN_PERMISSION, got %s", rq.path, r.Code)
		}
	}
	for _, role := range []string{"doctor", "nurse", "cashier"} {
		cl := srv.As(t, c, role)
		for _, rq := range []struct{ method, path string }{
			{"GET", "/messaging/settings"}, {"GET", "/messaging/log"}, {"POST", "/messaging/test"},
			{"POST", "/messaging/campaigns"}, {"GET", "/messaging/audience"},
			{"POST", "/messaging/unbilled-reminders"}, {"POST", "/messaging/preview"},
			{"POST", "/messaging/messages/msg_x/resend"}, {"POST", "/messaging/messages/msg_x/send-now"},
		} {
			cl.Do(rq.method, rq.path, map[string]any{}).Expect(t, 403, role+" "+rq.method+" "+rq.path)
		}
	}
	srv.As(t, c, "branch_manager").Do("PUT", "/messaging/settings", map[string]any{
		"enabled": false, "sender_name": "Branch"}).Expect(t, 200, "branch manager configures")
}

// ---- settings ---------------------------------------------------------------

// TestREG_MSG_003_SettingsSaveAndReadBack: Given a new Practice clinic, When the
// owner reads the settings, Then sending is off, the gateway is honestly "not live"
// (no key: the log gateway) and the sender name defaults to the clinic's name; When
// the owner switches sending on in Amharic with quiet hours 22:00–06:30, Then that is
// what is stored and what every later read returns.
func TestREG_MSG_003_SettingsSaveAndReadBack(t *testing.T) {
	c := msgClinic(t)
	owner := srv.As(t, c, "owner")
	var s msgSettings
	owner.Do("GET", "/messaging/settings", nil).Expect(t, 200, "read").Decode(t, &s)
	if s.Enabled || s.GatewayLive || s.GatewayName != "log" || s.SenderStatus != "none" || s.HasOwnKey {
		t.Fatalf("fresh settings: %+v", s)
	}
	if !strings.Contains(s.SenderName, c.Slug) || s.BodyPrefix != s.SenderName {
		t.Fatalf("sender should default to the clinic name and lead the body: %+v", s)
	}
	owner.Do("PUT", "/messaging/settings", map[string]any{
		"enabled": true, "lang": "am", "quiet_from": "22:00", "quiet_to": "06:30:00",
		"sender_name": "  Smile Dental ", "sender_status": "pending",
	}).Expect(t, 200, "save").Decode(t, &s)
	if !s.Enabled || s.Lang != "am" || s.QuietFrom != "22:00" || s.QuietTo != "06:30" ||
		s.SenderName != "Smile Dental" || s.SenderStatus != "pending" || s.BodyPrefix != "Smile Dental" {
		t.Fatalf("saved settings: %+v", s)
	}
	var on bool
	var lang, from string
	if err := super.Pool.QueryRow(t.Context(),
		`SELECT sms_enabled, sms_lang, to_char(sms_quiet_from,'HH24:MI') FROM clinics WHERE tenant_id = $1`,
		c.TenantID).Scan(&on, &lang, &from); err != nil {
		t.Fatal(err)
	}
	if !on || lang != "am" || from != "22:00" {
		t.Fatalf("db: enabled=%v lang=%s from=%s", on, lang, from)
	}
	// An unknown language falls back to English rather than storing nonsense, and
	// blank quiet hours fall back to the defaults.
	owner.Do("PUT", "/messaging/settings", map[string]any{
		"enabled": true, "lang": "fr", "sender_name": "Smile"}).Expect(t, 200, "fr").Decode(t, &s)
	if s.Lang != "en" || s.QuietFrom != "21:00" || s.QuietTo != "07:00" {
		t.Fatalf("defaults not applied: %+v", s)
	}
	// Clinic B's settings are untouched by A's save.
	var bOn bool
	one(t, `SELECT sms_enabled FROM clinics WHERE tenant_id = $1`, &bOn, clinicB.TenantID)
	if bOn {
		t.Fatal("clinic B's sending switched on by clinic A")
	}
}

// TestREG_MSG_004_SettingsRefuseWhatCannotWork: Given the settings form, When the
// owner saves something that cannot work, Then it is refused with 400 and nothing is
// stored.
func TestREG_MSG_004_SettingsRefuseWhatCannotWork(t *testing.T) {
	c := msgClinic(t)
	owner := srv.As(t, c, "owner")
	cases := map[string]map[string]any{
		"hour 25":           {"quiet_from": "25:00", "sender_name": "S"},
		"not a clock":       {"quiet_to": "abc", "sender_name": "S"},
		"too many parts":    {"quiet_to": "1:2:3:4", "sender_name": "S"},
		"minute 61":         {"quiet_to": "07:61", "sender_name": "S"},
		"sender too long":   {"sender_name": strings.Repeat("x", 21)},
		"on without sender": {"enabled": true, "sender_name": "  "},
		"unknown approval":  {"sender_name": "S", "sender_status": "maybe"},
		"approved, no name": {"sender_name": "S", "sender_status": "approved"},
	}
	for name, body := range cases {
		owner.Do("PUT", "/messaging/settings", body).Expect(t, 400, name)
	}
	owner.Do("PUT", "/messaging/settings", "not an object").Expect(t, 400, "unreadable body")
	var on bool
	one(t, `SELECT sms_enabled FROM clinics WHERE tenant_id = $1`, &on, c.TenantID)
	if on {
		t.Fatal("a refused save switched sending on")
	}
}

// TestREG_MSG_005_OwnSMSKeyIsKeptSecret: Given a clinic connecting its own SMS
// account, When the owner saves the key, Then it is stored encrypted, never handed
// back, survives a later save that leaves the field blank, makes the gateway "live"
// under the clinic's own approved name (so the body needs no prefix), and is
// removed only by an explicit clear.
func TestREG_MSG_005_OwnSMSKeyIsKeptSecret(t *testing.T) {
	c := msgClinic(t)
	owner := srv.As(t, c, "owner")
	const key = "regress-not-a-real-key-123"
	r := owner.Do("PUT", "/messaging/settings", map[string]any{
		"sender_name": "Smile", "sender_status": "approved", "sender_id": "SMILE", "api_key": key,
	}).Expect(t, 200, "save key")
	if strings.Contains(r.Raw, key) {
		t.Fatal("the key came back in the response")
	}
	var s msgSettings
	r.Decode(t, &s)
	if !s.HasOwnKey || !s.GatewayLive || s.GatewayName != "smsethiopia" || s.BodyPrefix != "" || s.SenderID != "SMILE" {
		t.Fatalf("with own approved key: %+v", s)
	}
	var enc string
	one(t, `SELECT coalesce(sms_api_key_enc,'') FROM clinics WHERE tenant_id = $1`, &enc, c.TenantID)
	if enc == "" || strings.Contains(enc, key) {
		t.Fatalf("key not stored encrypted: %q", enc)
	}
	// A save that does not mention the key keeps it.
	owner.Do("PUT", "/messaging/settings", map[string]any{
		"sender_name": "Smile", "sender_status": "approved", "sender_id": "SMILE", "quiet_from": "20:00",
	}).Expect(t, 200, "save without key").Decode(t, &s)
	if !s.HasOwnKey {
		t.Fatal("a blank key field wiped the stored credential")
	}
	// Preview: no prefix once the handset shows the clinic's own name.
	var pv struct {
		Body string `json:"body"`
	}
	owner.Do("POST", "/messaging/preview", map[string]any{"body": "Hello {{name}}"}).Expect(t, 200, "preview").Decode(t, &pv)
	if strings.HasPrefix(pv.Body, "Smile") {
		t.Fatalf("prefix added although the sender is approved: %q", pv.Body)
	}
	owner.Do("PUT", "/messaging/settings", map[string]any{
		"sender_name": "Smile", "clear_api_key": true}).Expect(t, 200, "clear").Decode(t, &s)
	if s.HasOwnKey || s.GatewayLive {
		t.Fatalf("after clear: %+v", s)
	}
	one(t, `SELECT coalesce(sms_api_key_enc,'') FROM clinics WHERE tenant_id = $1`, &enc, c.TenantID)
	if enc != "" {
		t.Fatal("key still stored after clear")
	}
}

// ---- usage, preview, variables ----------------------------------------------

// TestREG_MSG_006_UsageCountsThisMonthsSpend: Given this month's log holds a sent
// and a delivered message (one segment each), a failure and a skip, When the desk
// opens usage, Then two segments are used of the Practice plan's 2,000, sent counts
// delivered too, and only what went out is charged.
func TestREG_MSG_006_UsageCountsThisMonthsSpend(t *testing.T) {
	c := msgClinic(t)
	msgInsert(t, c, nil, "custom", "sent", "251911000001", "a", "")
	msgInsert(t, c, nil, "custom", "delivered", "251911000002", "b", "")
	msgInsert(t, c, nil, "custom", "failed", "251911000003", "c", "")
	msgInsert(t, c, nil, "custom", "skipped", "", "d", "no_phone")
	var u struct {
		Used    int64  `json:"used_segments"`
		Limit   *int64 `json:"limit"`
		Sent    int64  `json:"sent"`
		Failed  int64  `json:"failed"`
		Skipped int64  `json:"skipped"`
		Cost    string `json:"cost"`
	}
	srv.As(t, c, "receptionist").Do("GET", "/messaging/usage", nil).Expect(t, 200, "usage").Decode(t, &u)
	if u.Used != 2 || u.Limit == nil || *u.Limit != 2000 || u.Sent != 2 || u.Failed != 1 || u.Skipped != 1 {
		t.Fatalf("usage: %+v (limit %v)", u, u.Limit)
	}
	if !strings.HasPrefix(u.Cost, "1.0") {
		t.Fatalf("cost: want 1.00 (two sent at 0.50), got %s", u.Cost)
	}
}

// TestREG_MSG_007_PreviewPricesWhatThePatientGets: Given the sender name "Smile",
// When the desk previews a draft, Then the preview is the rendered body with the
// sender in front, priced in GSM-7 (160 a segment) or, with any Amharic, UCS-2 (70),
// and a long message is priced in the smaller multi-part segments.
func TestREG_MSG_007_PreviewPricesWhatThePatientGets(t *testing.T) {
	c := msgClinic(t)
	msgOn(t, c, "en")
	desk := srv.As(t, c, "receptionist")
	type pv struct {
		Body       string `json:"body"`
		Segments   int    `json:"segments"`
		Unicode    bool   `json:"unicode"`
		PerSegment int    `json:"per_segment"`
		Cost       string `json:"cost"`
	}
	var p pv
	desk.Do("POST", "/messaging/preview", map[string]any{"body": "Hello {{name}}"}).Expect(t, 200, "latin").Decode(t, &p)
	if !strings.HasPrefix(p.Body, "Smile: Hello ") || strings.Contains(p.Body, "{{") || p.Segments != 1 || p.Unicode || p.PerSegment != 160 {
		t.Fatalf("latin preview: %+v", p)
	}
	desk.Do("POST", "/messaging/preview", map[string]any{"body": "ሰላም {{name}}"}).Expect(t, 200, "amharic").Decode(t, &p)
	if !p.Unicode || p.PerSegment != 70 {
		t.Fatalf("amharic preview: %+v", p)
	}
	desk.Do("POST", "/messaging/preview", map[string]any{"body": strings.Repeat("a", 200)}).Expect(t, 200, "long").Decode(t, &p)
	if p.Segments != 2 || p.PerSegment != 153 {
		t.Fatalf("long latin: %+v", p)
	}
	desk.Do("POST", "/messaging/preview", map[string]any{"body": strings.Repeat("ሰ", 100)}).Expect(t, 200, "long am").Decode(t, &p)
	if p.Segments < 2 || p.PerSegment != 67 {
		t.Fatalf("long amharic: %+v", p)
	}
	// A body that already opens with the sender is not charged for it twice.
	desk.Do("POST", "/messaging/preview", map[string]any{"body": "smile here"}).Expect(t, 200, "own prefix").Decode(t, &p)
	if p.Body != "smile here" {
		t.Fatalf("sender repeated: %q", p.Body)
	}
	var vars []struct {
		Name      string `json:"name"`
		Describes string `json:"describes"`
	}
	desk.Do("GET", "/messaging/variables", nil).Expect(t, 200, "variables").Decode(t, &vars)
	names := map[string]bool{}
	for _, v := range vars {
		names[v.Name] = true
	}
	for _, want := range []string{"name", "card", "clinic", "amount", "date"} {
		if !names[want] {
			t.Fatalf("variable %s missing from %v", want, names)
		}
	}
}

// ---- test send --------------------------------------------------------------

// TestREG_MSG_008_TestSendQueuesOneRealMessage: Given a clinic switched on, When
// the desk sends a test to a staff phone, Then one 'custom' message is queued to that
// number (as 2519…), prefixed with the sender, exempt from quiet hours — and nothing
// is queued for a missing, invalid or Safaricom number, an empty message, or while
// sending is off.
func TestREG_MSG_008_TestSendQueuesOneRealMessage(t *testing.T) {
	c := msgClinic(t)
	desk := srv.As(t, c, "receptionist")
	ph := msgPhone()
	desk.Do("POST", "/messaging/test", map[string]any{"phone": ph, "body": "ping"}).Expect(t, 400, "while off")
	msgOn(t, c, "en")
	for name, body := range map[string]map[string]any{
		"empty body": {"phone": ph, "body": "  "},
		"no phone":   {"phone": "", "body": "x"},
		"invalid":    {"phone": "12", "body": "x"},
		"safaricom":  {"phone": "0712345678", "body": "x"},
	} {
		desk.Do("POST", "/messaging/test", body).Expect(t, 400, name)
	}
	desk.Do("POST", "/messaging/test", "nope").Expect(t, 400, "unreadable")
	desk.Do("POST", "/messaging/test", map[string]any{"phone": ph, "body": "ping"}).Expect(t, 204, "test send")
	var kind, msisdn, body, status string
	var bypass bool
	var n int
	one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 1 {
		t.Fatalf("want exactly one queued message, got %d", n)
	}
	if err := super.Pool.QueryRow(t.Context(),
		`SELECT kind, msisdn, body, status, bypass_quiet_hours FROM messages WHERE tenant_id = $1`,
		c.TenantID).Scan(&kind, &msisdn, &body, &status, &bypass); err != nil {
		t.Fatal(err)
	}
	if kind != "custom" || msisdn != msgMSISDN(ph) || body != "Smile: ping" || status != "scheduled" || !bypass {
		t.Fatalf("queued test: kind=%s msisdn=%s body=%q status=%s bypass=%v", kind, msisdn, body, status, bypass)
	}
}

// TestREG_MSG_009_AllowanceRefusesBeforeQueueing: Given a clinic whose monthly
// allowance is used up (override 1 segment, one already sent), When the desk sends a
// test, Then it is refused (403 SMS_LIMIT_REACHED) and nothing is queued; and a plan
// with no allowance at all says so.
func TestREG_MSG_009_AllowanceRefusesBeforeQueueing(t *testing.T) {
	c := msgClinic(t)
	msgOn(t, c, "en")
	msgExec(t, `UPDATE tenants SET sms_monthly_override = 1 WHERE id = $1`, c.TenantID)
	msgInsert(t, c, nil, "custom", "sent", "251911000009", "used", "")
	desk := srv.As(t, c, "receptionist")
	r := desk.Do("POST", "/messaging/test", map[string]any{"phone": msgPhone(), "body": "x"}).Expect(t, 403, "over allowance")
	if r.Code != "SMS_LIMIT_REACHED" {
		t.Fatalf("want SMS_LIMIT_REACHED, got %s", r.Code)
	}
	msgExec(t, `UPDATE tenants SET sms_monthly_override = 0 WHERE id = $1`, c.TenantID)
	r = desk.Do("POST", "/messaging/test", map[string]any{"phone": msgPhone(), "body": "x"}).Expect(t, 403, "no allowance")
	if r.Code != "SMS_LIMIT_REACHED" {
		t.Fatalf("want SMS_LIMIT_REACHED, got %s", r.Code)
	}
	var n int
	one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1 AND status = 'scheduled'`, &n, c.TenantID)
	if n != 0 {
		t.Fatalf("refused sends queued %d messages", n)
	}
}

// ---- templates and rules ----------------------------------------------------

// TestREG_MSG_010_TemplatesSaveValidatedWording: Given a new clinic, When the owner
// saves the appointment reminder wording, Then it is stored, listed with a rendered
// preview and its real price, and a second save replaces it; wording with an
// unknown or half-typed placeholder, an empty body, a 'custom' kind or a language
// other than English/Amharic is refused.
func TestREG_MSG_010_TemplatesSaveValidatedWording(t *testing.T) {
	c := msgClinic(t)
	owner := srv.As(t, c, "owner")
	owner.Do("PUT", "/messaging/templates", map[string]any{
		"kind": "appointment_reminder", "lang": "en", "body": "Hi {{name}}, see you {{date}}"}).Expect(t, 204, "save")
	owner.Do("PUT", "/messaging/templates", map[string]any{
		"kind": "appointment_reminder", "lang": "en", "body": "  Hi {{name}}, visit on {{date}} at {{clinic}} "}).Expect(t, 204, "replace")
	for name, body := range map[string]map[string]any{
		"unknown placeholder": {"kind": "welcome", "lang": "en", "body": "Hi {{nickname}}"},
		"unfinished":          {"kind": "welcome", "lang": "en", "body": "Hi {{name"},
		"empty":               {"kind": "welcome", "lang": "en", "body": " "},
		"custom kind":         {"kind": "custom", "lang": "en", "body": "x"},
		"unknown kind":        {"kind": "birthday", "lang": "en", "body": "x"},
		"french":              {"kind": "welcome", "lang": "fr", "body": "x"},
	} {
		owner.Do("PUT", "/messaging/templates", body).Expect(t, 400, name)
	}
	owner.Do("PUT", "/messaging/templates", "x").Expect(t, 400, "unreadable")
	var list []struct {
		Kind, Lang, Body, Preview string
		Segments                  int
	}
	srv.As(t, c, "receptionist").Do("GET", "/messaging/templates", nil).Expect(t, 200, "list").Decode(t, &list)
	if len(list) != 1 || list[0].Body != "Hi {{name}}, visit on {{date}} at {{clinic}}" ||
		strings.Contains(list[0].Preview, "{{") || list[0].Segments != 1 {
		t.Fatalf("templates: %+v", list)
	}
	var stored int
	one(t, `SELECT count(*) FROM message_templates WHERE tenant_id = $1`, &stored, c.TenantID)
	if stored != 1 {
		t.Fatalf("want one stored template, got %d", stored)
	}
	// Clinic B sees none of A's wording.
	var bl []json.RawMessage
	b := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-practice"})
	srv.As(t, b, "owner").Do("GET", "/messaging/templates", nil).Expect(t, 200, "B list").Decode(t, &bl)
	if len(bl) != 0 {
		t.Fatalf("clinic B sees %d templates", len(bl))
	}
}

// TestREG_MSG_011_RulesNeedWordingAndSaneTiming: Given an automation, When the
// owner switches it on with no wording in the clinic's language, Then it is refused;
// with wording it is stored with its timing; and timing outside two weeks, more than
// 5 repeats, repeats without a gap, an unreadable send time or a 'custom' kind is
// refused. The list reports how many of each kind went out this month.
func TestREG_MSG_011_RulesNeedWordingAndSaneTiming(t *testing.T) {
	c := msgClinic(t)
	owner := srv.As(t, c, "owner")
	rule := func(over map[string]any) map[string]any {
		b := map[string]any{"kind": "bill_reminder", "enabled": true, "offset_hours": 168,
			"send_at": "10:00", "repeat_days": 7, "max_repeats": 1}
		for k, v := range over {
			b[k] = v
		}
		return b
	}
	owner.Do("PUT", "/messaging/rules", rule(nil)).Expect(t, 400, "on without wording")
	owner.Do("PUT", "/messaging/templates", map[string]any{
		"kind": "bill_reminder", "lang": "en", "body": "You owe {{amount}} ETB"}).Expect(t, 204, "wording")
	owner.Do("PUT", "/messaging/rules", rule(nil)).Expect(t, 204, "on")
	owner.Do("PUT", "/messaging/rules", rule(map[string]any{"kind": "welcome", "enabled": false,
		"offset_hours": 0, "send_at": "", "repeat_days": 0, "max_repeats": 0})).Expect(t, 204, "welcome off")
	for name, over := range map[string]map[string]any{
		"too early":       {"offset_hours": -337},
		"too late":        {"offset_hours": 337},
		"six repeats":     {"max_repeats": 6},
		"negative repeat": {"max_repeats": -1},
		"no gap":          {"repeat_days": 0},
		"bad send time":   {"send_at": "7pm"},
		"custom":          {"kind": "custom"},
	} {
		owner.Do("PUT", "/messaging/rules", rule(over)).Expect(t, 400, name)
	}
	owner.Do("PUT", "/messaging/rules", "x").Expect(t, 400, "unreadable")
	msgInsert(t, c, nil, "bill_reminder", "sent", "251911000011", "owed", "")
	var rules []struct {
		Kind       string `json:"kind"`
		Enabled    bool   `json:"enabled"`
		Offset     int    `json:"offset_hours"`
		SendAt     string `json:"send_at"`
		RepeatDays int    `json:"repeat_days"`
		MaxRepeats int    `json:"max_repeats"`
		Sent       int64  `json:"sent"`
	}
	srv.As(t, c, "receptionist").Do("GET", "/messaging/rules", nil).Expect(t, 200, "list").Decode(t, &rules)
	if len(rules) != 2 || rules[0].Kind != "welcome" || rules[1].Kind != "bill_reminder" {
		t.Fatalf("rules: %+v", rules)
	}
	b := rules[1]
	if !b.Enabled || b.Offset != 168 || b.SendAt != "10:00" || b.RepeatDays != 7 || b.MaxRepeats != 1 || b.Sent != 1 {
		t.Fatalf("bill rule: %+v", b)
	}
}

// ---- audience and campaigns --------------------------------------------------

type msgAudience struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Reachable  bool   `json:"reachable"`
	PhoneIssue string `json:"phone_issue"`
	OptedOut   bool   `json:"opted_out"`
	Owes       string `json:"owes"`
}

// msgFour registers four patients sharing a search tag: one reachable, one who
// opted out, one with no phone and one on Safaricom.
func msgFour(t *testing.T, c *testkit.Clinic) (tag string, ok, opted, none, safaricom patientRef) {
	t.Helper()
	desk := srv.As(t, c, "receptionist")
	tag = uniq("Aud")
	ok = msgPatient(t, desk, tag+"Ok", msgPhone())
	opted = msgPatient(t, desk, tag+"Opt", msgPhone())
	none = msgPatient(t, desk, tag+"None", "")
	safaricom = msgPatient(t, desk, tag+"Saf", msgPhone())
	msgExec(t, `UPDATE patients SET sms_opt_out = true WHERE id = $1`, msgID(t, id.PrefixPatient, opted.ID))
	msgExec(t, `UPDATE patients SET phone = '0712345678' WHERE id = $1`, msgID(t, id.PrefixPatient, safaricom.ID))
	return
}

// TestREG_MSG_012_AudienceShowsWhoCannotBeReached: Given four patients — reachable,
// opted out, no phone, Safaricom — When the desk searches the audience, Then all four
// are listed, each with whether and why they cannot be reached; a recall search
// (not seen for N days) works on a plan with recall lists; nonsense day counts are
// refused; and clinic B's audience never includes A's patients.
func TestREG_MSG_012_AudienceShowsWhoCannotBeReached(t *testing.T) {
	c := msgClinic(t)
	tag, ok, opted, none, saf := msgFour(t, c)
	desk := srv.As(t, c, "receptionist")
	var rows []msgAudience
	desk.Do("GET", "/messaging/audience?q="+tag, nil).Expect(t, 200, "audience").Decode(t, &rows)
	got := map[string]msgAudience{}
	for _, r := range rows {
		got[r.ID] = r
	}
	if len(rows) != 4 {
		t.Fatalf("want 4 candidates, got %d: %+v", len(rows), rows)
	}
	if r := got[ok.ID]; !r.Reachable || r.PhoneIssue != "" || r.OptedOut {
		t.Fatalf("reachable patient: %+v", r)
	}
	if r := got[opted.ID]; !r.OptedOut {
		t.Fatalf("opted-out patient: %+v", r)
	}
	if r := got[none.ID]; r.Reachable || r.PhoneIssue != "missing" {
		t.Fatalf("no-phone patient: %+v", r)
	}
	if r := got[saf.ID]; r.Reachable || r.PhoneIssue != "unsupported" {
		t.Fatalf("safaricom patient: %+v", r)
	}
	// Recall: nobody here has been seen, so all four have "not been in for 30 days".
	desk.Do("GET", "/messaging/audience?q="+tag+"&not_seen_days=30", nil).Expect(t, 200, "recall").Decode(t, &rows)
	if len(rows) != 4 {
		t.Fatalf("recall list: want 4, got %d", len(rows))
	}
	desk.Do("GET", "/messaging/audience?q="+tag+"&seen_days=30", nil).Expect(t, 200, "seen").Decode(t, &rows)
	if len(rows) != 0 {
		t.Fatalf("seen in 30 days: want 0, got %d", len(rows))
	}
	desk.Do("GET", "/messaging/audience?q="+tag+"&owing=1", nil).Expect(t, 200, "owing").Decode(t, &rows)
	if len(rows) != 0 {
		t.Fatalf("owing: want 0, got %d", len(rows))
	}
	for _, q := range []string{"seen_days=abc", "seen_days=-1", "not_seen_days=x", "not_seen_days=-2"} {
		desk.Do("GET", "/messaging/audience?"+q, nil).Expect(t, 400, q)
	}
	// Clinic B (another Practice clinic) searching the same tag finds nobody.
	b := msgClinic(t)
	srv.As(t, b, "receptionist").Do("GET", "/messaging/audience?q="+tag, nil).Expect(t, 200, "B").Decode(t, &rows)
	if len(rows) != 0 {
		t.Fatalf("clinic B sees %d of clinic A's patients", len(rows))
	}
}

// TestREG_MSG_013_RecallListIsItsOwnPaidFeature: Given a clinic entitled to Patient
// SMS but not to recall lists, When the desk asks who has not been in, Then that
// question is refused as a module the clinic does not have, while an ordinary
// audience search still works.
func TestREG_MSG_013_RecallListIsItsOwnPaidFeature(t *testing.T) {
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{PlanCode: "dental-chair"})
	msgExec(t, `INSERT INTO tenant_entitlements (tenant_id, feature, enabled, note) VALUES ($1,'messaging',true,'regress')`, c.TenantID)
	desk := srv.As(t, c, "receptionist")
	desk.Do("GET", "/messaging/audience", nil).Expect(t, 200, "ordinary search")
	r := desk.Do("GET", "/messaging/audience?not_seen_days=180", nil).Expect(t, 403, "recall without the feature")
	if r.Code != "MODULE_DISABLED" {
		t.Fatalf("want MODULE_DISABLED, got %s", r.Code)
	}
}

// TestREG_MSG_014_CampaignQueuesOnlyWhoCanBeReached: Given four chosen patients
// (reachable, opted out, no phone, Safaricom), When the desk sends "Hi {{name}}" to
// them, Then one message is queued with her name in it, three are recorded as skipped
// with the reason, the campaign is recorded, and the price is the queued segments
// only.
func TestREG_MSG_014_CampaignQueuesOnlyWhoCanBeReached(t *testing.T) {
	c := msgClinic(t)
	_, ok, opted, none, saf := msgFour(t, c)
	desk := srv.As(t, c, "receptionist")
	ids := []string{ok.ID, opted.ID, none.ID, saf.ID}
	desk.Do("POST", "/messaging/campaigns", map[string]any{"body": "Hi", "patient_ids": ids}).Expect(t, 400, "while off")
	msgOn(t, c, "en")
	var res struct {
		ID       string `json:"id"`
		Queued   int    `json:"queued"`
		Skipped  int    `json:"skipped"`
		Segments int    `json:"segments"`
	}
	desk.Do("POST", "/messaging/campaigns", map[string]any{
		"title": "Holiday", "body": "Hi {{name}}, we are closed Monday", "patient_ids": ids,
	}).Expect(t, 201, "campaign").Decode(t, &res)
	if res.Queued != 1 || res.Skipped != 3 || res.Segments != 1 || !strings.HasPrefix(res.ID, "cmp_") {
		t.Fatalf("campaign result: %+v", res)
	}
	reasons := map[string]string{}
	rows, err := super.Pool.Query(t.Context(),
		`SELECT patient_id, status, coalesce(skip_reason,''), body, campaign_id IS NOT NULL
		   FROM messages WHERE tenant_id = $1`, c.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var pid uuid.UUID
		var status, skip, body string
		var inCampaign bool
		if err := rows.Scan(&pid, &status, &skip, &body, &inCampaign); err != nil {
			t.Fatal(err)
		}
		if !inCampaign {
			t.Fatal("message not linked to its campaign")
		}
		reasons[id.Encode(id.PrefixPatient, pid)] = status + "/" + skip
		if pid == msgID(t, id.PrefixPatient, ok.ID) && !strings.Contains(body, ok.FirstName) {
			t.Fatalf("name not rendered: %q", body)
		}
	}
	rows.Close()
	want := map[string]string{ok.ID: "scheduled/", opted.ID: "skipped/no_consent",
		none.ID: "skipped/no_phone", saf.ID: "skipped/unsupported_network"}
	for k, v := range want {
		if reasons[k] != v {
			t.Fatalf("patient %s: want %s, got %s (all %v)", k, v, reasons[k], reasons)
		}
	}
	var total int
	one(t, `SELECT total FROM message_campaigns WHERE tenant_id = $1`, &total, c.TenantID)
	if total != 4 {
		t.Fatalf("campaign total: %d", total)
	}
	// A scheduled send is queued for that moment.
	later := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	desk.Do("POST", "/messaging/campaigns", map[string]any{"body": "Later", "patient_ids": []string{ok.ID},
		"scheduled_for": later.Format(time.RFC3339)}).Expect(t, 201, "scheduled")
	var when time.Time
	one(t, `SELECT scheduled_for FROM messages WHERE tenant_id = $1 AND body = 'Smile: Later'`, &when, c.TenantID)
	if !when.Equal(later) {
		t.Fatalf("scheduled for %v, want %v", when, later)
	}
}

// TestREG_MSG_015_CampaignRefusals: Given a clinic switched on, When a campaign has
// no body, no patients, an unrecognised patient id, an unreadable send time, more
// than 2,000 patients, or only unreachable patients, Then it is refused and nothing
// is queued; and a patient of another clinic cannot be messaged by naming her id.
func TestREG_MSG_015_CampaignRefusals(t *testing.T) {
	c := msgClinic(t)
	msgOn(t, c, "en")
	_, ok, opted, none, _ := msgFour(t, c)
	desk := srv.As(t, c, "receptionist")
	many := make([]string, 2001)
	for i := range many {
		many[i] = id.Encode(id.PrefixPatient, uuid.New())
	}
	for name, body := range map[string]map[string]any{
		"no body":          {"body": " ", "patient_ids": []string{ok.ID}},
		"no patients":      {"body": "x", "patient_ids": []string{}},
		"bad id":           {"body": "x", "patient_ids": []string{"pat_nope"}},
		"bad time":         {"body": "x", "patient_ids": []string{ok.ID}, "scheduled_for": "tomorrow"},
		"over 2000":        {"body": "x", "patient_ids": many},
		"only unreachable": {"body": "x", "patient_ids": []string{opted.ID, none.ID}},
	} {
		desk.Do("POST", "/messaging/campaigns", body).Expect(t, 400, name)
	}
	desk.Do("POST", "/messaging/campaigns", "x").Expect(t, 400, "unreadable")
	// Isolation: clinic B's patient named in A's campaign is not found, so there is
	// nobody to send to.
	bp := msgPatient(t, srv.As(t, clinicB, "receptionist"), uniq("Bpt"), msgPhone())
	desk.Do("POST", "/messaging/campaigns", map[string]any{"body": "x", "patient_ids": []string{bp.ID}}).Expect(t, 400, "other clinic's patient")
	var n int
	one(t, `SELECT count(*) FROM messages WHERE patient_id = $1`, &n, msgID(t, id.PrefixPatient, bp.ID))
	if n != 0 {
		t.Fatal("clinic A queued a message to clinic B's patient")
	}
	one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 0 {
		t.Fatalf("refused campaigns queued %d messages", n)
	}
}

// ---- the log, resend, send now -----------------------------------------------

// TestREG_MSG_016_LogAnswersDidWeTellHer: Given a patient with a sent reminder, a
// failure and a skip for no consent, When the desk opens the log (all, by patient,
// by kind, by status), Then it lists exactly those, offers "resend" only where it
// would be accepted and "send now" only on a waiting message; an unknown patient
// filter is refused; and clinic B's log shows none of it.
func TestREG_MSG_016_LogAnswersDidWeTellHer(t *testing.T) {
	c := msgClinic(t)
	desk := srv.As(t, c, "receptionist")
	p := msgPatient(t, desk, uniq("Log"), msgPhone())
	pid := msgID(t, id.PrefixPatient, p.ID)
	msgInsert(t, c, &pid, "appointment_reminder", "sent", "251911000016", "see you", "")
	failed := msgInsert(t, c, &pid, "custom", "failed", "251911000016", "failed one", "")
	msgInsert(t, c, &pid, "custom", "skipped", "", "no", "no_consent")
	waiting := msgInsert(t, c, nil, "custom", "scheduled", "251911000099", "waiting", "")
	msgExec(t, `UPDATE messages SET scheduled_for = now() + interval '1 day' WHERE id = $1`, waiting)

	all := msgLog(t, desk, "")
	if len(all) != 4 {
		t.Fatalf("log: want 4, got %d", len(all))
	}
	mine := msgLog(t, desk, "?patient="+p.ID)
	if len(mine) != 3 {
		t.Fatalf("patient log: want 3, got %d", len(mine))
	}
	for _, r := range mine {
		if r.PatientID != p.ID || r.MRN != p.MRN {
			t.Fatalf("patient fields: %+v", r)
		}
		switch r.Status {
		case "sent", "failed":
			if !r.CanResend || r.CanSendNow {
				t.Fatalf("%s row offers: %+v", r.Status, r)
			}
		case "skipped":
			if r.CanResend {
				t.Fatalf("no-consent row offers resend: %+v", r)
			}
		}
	}
	if rows := msgLog(t, desk, "?kind=appointment_reminder"); len(rows) != 1 || rows[0].Body != "see you" {
		t.Fatalf("kind filter: %+v", rows)
	}
	if rows := msgLog(t, desk, "?status=scheduled"); len(rows) != 1 || !rows[0].CanSendNow || rows[0].CanResend {
		t.Fatalf("status filter: %+v", rows)
	}
	desk.Do("GET", "/messaging/log?patient=nope", nil).Expect(t, 400, "bad patient filter")
	// Once retried, the failure says so.
	msgOn(t, c, "en")
	desk.Do("POST", "/messaging/messages/"+id.Encode(id.PrefixMessage, failed)+"/resend", nil).Expect(t, 204, "resend")
	for _, r := range msgLog(t, desk, "?status=failed") {
		if !r.Retried {
			t.Fatalf("failed row not marked retried: %+v", r)
		}
	}
	b := msgClinic(t)
	if rows := msgLog(t, srv.As(t, b, "owner"), ""); len(rows) != 0 {
		t.Fatalf("clinic B sees %d of A's messages", len(rows))
	}
	if rows := msgLog(t, srv.As(t, b, "owner"), "?patient="+p.ID); len(rows) != 0 {
		t.Fatalf("clinic B reads A's patient log: %d", len(rows))
	}
}

// TestREG_MSG_017_ResendUsesTheCorrectedNumber: Given a message that failed because
// the number on file was wrong, When the desk corrects the patient's phone and
// presses resend, Then a NEW message is queued to the corrected number with the same
// text, linked to the first; a second press while it waits is refused as a
// double-click.
func TestREG_MSG_017_ResendUsesTheCorrectedNumber(t *testing.T) {
	c := msgClinic(t)
	msgOn(t, c, "en")
	desk := srv.As(t, c, "receptionist")
	good := msgPhone()
	p := msgPatient(t, desk, uniq("Res"), good)
	pid := msgID(t, id.PrefixPatient, p.ID)
	old := msgInsert(t, c, &pid, "appointment_reminder", "failed", "251900000000", "Smile: see you", "")
	path := "/messaging/messages/" + id.Encode(id.PrefixMessage, old) + "/resend"
	desk.Do("POST", path, nil).Expect(t, 204, "resend")
	var msisdn, body, status, kind string
	var from uuid.UUID
	if err := super.Pool.QueryRow(t.Context(),
		`SELECT msisdn, body, status, kind, resent_from FROM messages WHERE tenant_id = $1 AND resent_from IS NOT NULL`,
		c.TenantID).Scan(&msisdn, &body, &status, &kind, &from); err != nil {
		t.Fatal(err)
	}
	if msisdn != msgMSISDN(good) || body != "Smile: see you" || status != "scheduled" || kind != "appointment_reminder" || from != old {
		t.Fatalf("resent row: msisdn=%s body=%q status=%s kind=%s from=%v", msisdn, body, status, kind, from)
	}
	r := desk.Do("POST", path, nil).Expect(t, 409, "double click")
	if r.Code != "ALREADY_QUEUED" {
		t.Fatalf("want ALREADY_QUEUED, got %s", r.Code)
	}
	var origStatus string
	one(t, `SELECT status FROM messages WHERE id = $1`, &origStatus, old)
	if origStatus != "failed" {
		t.Fatalf("the first attempt's record changed to %s", origStatus)
	}
}

// TestREG_MSG_018_ResendRefusals: Given messages in states a resend must not touch,
// When the desk presses resend, Then: not yet tried → 409; skipped for no consent →
// 400; the patient has since opted out, has no phone, a Safaricom or an invalid
// number → 400; the patient was removed → 404; a message with no patient and no
// number → 400; an unknown or malformed id → 404/400; another clinic's message →
// 404; and while sending is off → 400. Nothing is queued by any of them.
func TestREG_MSG_018_ResendRefusals(t *testing.T) {
	c := msgClinic(t)
	desk := srv.As(t, c, "receptionist")
	mk := func(phone string) uuid.UUID {
		p := msgPatient(t, desk, uniq("Rr"), msgPhone())
		pid := msgID(t, id.PrefixPatient, p.ID)
		if phone != "-" {
			msgExec(t, `UPDATE patients SET phone = NULLIF($2,'') WHERE id = $1`, pid, phone)
		}
		return pid
	}
	resend := func(m uuid.UUID) testkit.Resp {
		return desk.Do("POST", "/messaging/messages/"+id.Encode(id.PrefixMessage, m)+"/resend", nil)
	}
	p0 := mk("-")
	failed := msgInsert(t, c, &p0, "custom", "failed", "251911000018", "x", "")
	resend(failed).Expect(t, 400, "sending off")
	msgOn(t, c, "en")

	queued := msgInsert(t, c, &p0, "custom", "scheduled", "251911000018", "q", "")
	if r := resend(queued).Expect(t, 409, "not tried yet"); r.Code != "MESSAGE_NOT_TRIED_YET" {
		t.Fatalf("code %s", r.Code)
	}
	resend(msgInsert(t, c, &p0, "custom", "skipped", "", "nc", "no_consent")).Expect(t, 400, "no consent")

	pOpt := mk("-")
	msgExec(t, `UPDATE patients SET sms_opt_out = true WHERE id = $1`, pOpt)
	resend(msgInsert(t, c, &pOpt, "custom", "failed", "251911000018", "o", "")).Expect(t, 400, "opted out since")
	pNone := mk("")
	resend(msgInsert(t, c, &pNone, "custom", "skipped", "", "n", "no_phone")).Expect(t, 400, "still no phone")
	pSaf := mk("0712345678")
	resend(msgInsert(t, c, &pSaf, "custom", "skipped", "", "s", "unsupported_network")).Expect(t, 400, "safaricom")
	pBad := mk("12345")
	resend(msgInsert(t, c, &pBad, "custom", "skipped", "", "b", "bad_phone")).Expect(t, 400, "invalid")
	pGone := mk("-")
	gone := msgInsert(t, c, &pGone, "custom", "failed", "251911000018", "g", "")
	msgExec(t, `UPDATE patients SET deleted_at = now() WHERE id = $1`, pGone)
	if r := resend(gone).Expect(t, 404, "patient removed"); r.Code != "PATIENT_NOT_FOUND" {
		t.Fatalf("code %s", r.Code)
	}
	resend(msgInsert(t, c, nil, "custom", "failed", "", "nobody", "")).Expect(t, 400, "no number at all")
	if r := resend(uuid.New()).Expect(t, 404, "unknown"); r.Code != "MESSAGE_NOT_FOUND" {
		t.Fatalf("code %s", r.Code)
	}
	desk.Do("POST", "/messaging/messages/nope/resend", nil).Expect(t, 400, "malformed")
	// Clinic B cannot resend A's message, even knowing its id.
	b := msgClinic(t)
	msgOn(t, b, "en")
	srv.As(t, b, "receptionist").Do("POST", "/messaging/messages/"+id.Encode(id.PrefixMessage, failed)+"/resend", nil).
		Expect(t, 404, "other clinic's message")
	var n int
	one(t, `SELECT count(*) FROM messages WHERE resent_from IS NOT NULL AND tenant_id IN ($1,$2)`, &n, c.TenantID, b.TenantID)
	if n != 0 {
		t.Fatalf("refused resends queued %d", n)
	}
}

// TestREG_MSG_019_SendNowReleasesAWaitingMessage: Given a bill reminder held until
// morning by quiet hours, When the desk presses send now, Then it is due immediately
// and exempt from quiet hours; pressing it on a message that already went is a 409;
// and another clinic's message cannot be released.
func TestREG_MSG_019_SendNowReleasesAWaitingMessage(t *testing.T) {
	c := msgClinic(t)
	desk := srv.As(t, c, "receptionist")
	held := msgInsert(t, c, nil, "bill_reminder", "scheduled", "251911000019", "owed", "")
	msgExec(t, `UPDATE messages SET scheduled_for = now() + interval '9 hours' WHERE id = $1`, held)
	path := "/messaging/messages/" + id.Encode(id.PrefixMessage, held) + "/send-now"
	// Clinic B first: refused, and the message stays held.
	b := msgClinic(t)
	if r := srv.As(t, b, "receptionist").Do("POST", path, nil).Expect(t, 409, "other clinic"); r.Code != "NOT_WAITING" {
		t.Fatalf("code %s", r.Code)
	}
	var due bool
	one(t, `SELECT scheduled_for > now() FROM messages WHERE id = $1`, &due, held)
	if !due {
		t.Fatal("clinic B released clinic A's message")
	}
	desk.Do("POST", path, nil).Expect(t, 204, "send now")
	var bypass bool
	if err := super.Pool.QueryRow(t.Context(),
		`SELECT scheduled_for <= now(), bypass_quiet_hours FROM messages WHERE id = $1`, held).Scan(&due, &bypass); err != nil {
		t.Fatal(err)
	}
	if !due || !bypass {
		t.Fatalf("after send now: due=%v bypass=%v", due, bypass)
	}
	sent := msgInsert(t, c, nil, "custom", "sent", "251911000019", "gone", "")
	desk.Do("POST", "/messaging/messages/"+id.Encode(id.PrefixMessage, sent)+"/send-now", nil).Expect(t, 409, "already sent")
	desk.Do("POST", "/messaging/messages/nope/send-now", nil).Expect(t, 400, "malformed")
}

// ---- unbilled treatment reminders (dental) -----------------------------------

type msgUnbilled struct {
	Rows []struct {
		PatientID      string `json:"patient_id"`
		Body           string `json:"body"`
		Segments       int    `json:"segments"`
		SkipReason     string `json:"skip_reason"`
		LastRemindedAt string `json:"last_reminded_at"`
	} `json:"rows"`
	Segments int `json:"segments"`
	Queued   int `json:"queued"`
	Skipped  int `json:"skipped"`
}

// msgOwedCourse gives a patient a dental course with an unpaid deposit and visits
// 1 and 2 done and unpaid, and returns the session ids of all three.
func msgOwedCourse(t *testing.T, c *testkit.Clinic, phone string) (patientRef, []string) {
	t.Helper()
	p := msgPatient(t, srv.As(t, c, "receptionist"), uniq("Unb"), phone)
	plan := createPlan(t, srv.As(t, c, "doctor"), p.ID, "3000", 3, "500")
	if plan.Deposit == nil || len(plan.Sessions) < 2 {
		t.Fatalf("plan without deposit/sessions: %+v", plan)
	}
	for _, s := range plan.Sessions[:2] {
		msgExec(t, `UPDATE treatment_sessions SET status = 'done', completed_at = now() - interval '3 days' WHERE id = $1`,
			msgID(t, id.PrefixTreatmentSession, s.ID))
	}
	return p, []string{plan.Deposit.ID, plan.Sessions[0].ID, plan.Sessions[1].ID}
}

// TestREG_MSG_020_UnbilledReminderNamesWhatIsOwed: Given a patient owing a deposit
// and visits 1 and 2 of a course, When the desk previews a reminder for those rows,
// Then ONE message is rendered for her naming the down payment and both visits with
// the amount, and nothing is queued; When the desk sends it, Then one bill reminder
// is queued; a second send while it waits queues nothing more, and the preview then
// shows she was reminded.
func TestREG_MSG_020_UnbilledReminderNamesWhatIsOwed(t *testing.T) {
	c := msgClinic(t)
	msgOn(t, c, "en")
	p, sessions := msgOwedCourse(t, c, msgPhone())
	desk := srv.As(t, c, "receptionist")
	body := map[string]any{"session_ids": sessions, "preview": true,
		"body": "Dear {{name}}, you owe {{amount}} ETB for {{treatment}} ({{visit}}); paid {{paid}}, {{days}} days."}
	var res msgUnbilled
	desk.Do("POST", "/messaging/unbilled-reminders", body).Expect(t, 200, "preview").Decode(t, &res)
	if len(res.Rows) != 1 || res.Rows[0].PatientID != p.ID || res.Rows[0].SkipReason != "" || res.Queued != 0 {
		t.Fatalf("preview: %+v", res)
	}
	got := res.Rows[0].Body
	for _, want := range []string{"Smile: Dear " + p.FirstName, "down payment", "visits 1 and 2", "Root canal"} {
		if !strings.Contains(got, want) {
			t.Fatalf("preview body %q lacks %q", got, want)
		}
	}
	var n int
	one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 0 {
		t.Fatal("a preview queued a message")
	}
	body["preview"] = false
	desk.Do("POST", "/messaging/unbilled-reminders", body).Expect(t, 200, "send").Decode(t, &res)
	if res.Queued != 1 {
		t.Fatalf("send: %+v", res)
	}
	desk.Do("POST", "/messaging/unbilled-reminders", body).Expect(t, 200, "double click").Decode(t, &res)
	if res.Queued != 0 {
		t.Fatalf("double click queued again: %+v", res)
	}
	one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1 AND kind = 'bill_reminder' AND status = 'scheduled'`, &n, c.TenantID)
	if n != 1 {
		t.Fatalf("want one queued bill reminder, got %d", n)
	}
	body["preview"] = true
	desk.Do("POST", "/messaging/unbilled-reminders", body).Expect(t, 200, "preview again").Decode(t, &res)
	if res.Rows[0].LastRemindedAt == "" {
		t.Fatal("preview does not show she was just reminded")
	}
}

// TestREG_MSG_021_UnbilledReminderWordingInAmharicAndForExtras: Given a clinic
// writing in Amharic and a patient owing one visit plus extras added at visits, When
// the desk previews, Then "what is owed" is phrased in Amharic, and in English an
// extra is named by the visit it was added at rather than as a visit of its own.
func TestREG_MSG_021_UnbilledReminderWordingInAmharicAndForExtras(t *testing.T) {
	c := msgClinic(t)
	msgOn(t, c, "am")
	p := msgPatient(t, srv.As(t, c, "receptionist"), uniq("Ext"), msgPhone())
	plan := createPlan(t, srv.As(t, c, "doctor"), p.ID, "3000", 3, "")
	s1 := msgID(t, id.PrefixTreatmentSession, plan.Sessions[0].ID)
	msgExec(t, `UPDATE treatment_sessions SET status = 'done', completed_at = now() WHERE id = $1`, s1)
	desk := srv.As(t, c, "receptionist")
	req := map[string]any{"session_ids": []string{plan.Sessions[0].ID}, "preview": true, "body": "{{visit}}"}
	var res msgUnbilled
	desk.Do("POST", "/messaging/unbilled-reminders", req).Expect(t, 200, "am").Decode(t, &res)
	if !strings.Contains(res.Rows[0].Body, "ጉብኝት 1 ከ 3") {
		t.Fatalf("amharic visit wording: %q", res.Rows[0].Body)
	}
	// Two extras performed at visit 1, delivered and unpaid.
	var planID, pid uuid.UUID
	one(t, `SELECT plan_id FROM treatment_sessions WHERE id = $1`, &planID, s1)
	pid = msgID(t, id.PrefixPatient, p.ID)
	var extras []string
	for i := 0; i < 2; i++ {
		var e uuid.UUID
		if err := super.Pool.QueryRow(t.Context(),
			`INSERT INTO treatment_sessions (tenant_id, plan_id, patient_id, seq, scheduled_date, amount_due, status, kind, completed_at)
			 VALUES ($1,$2,$3,1,current_date,150,'done','extra',now()) RETURNING id`,
			c.TenantID, planID, pid).Scan(&e); err != nil {
			t.Fatalf("insert extra: %v", err)
		}
		extras = append(extras, id.Encode(id.PrefixTreatmentSession, e))
	}
	msgOn(t, c, "en")
	req["session_ids"] = []string{extras[0]}
	desk.Do("POST", "/messaging/unbilled-reminders", req).Expect(t, 200, "one extra").Decode(t, &res)
	if !strings.Contains(res.Rows[0].Body, "extra treatment at visit 1") {
		t.Fatalf("one extra: %q", res.Rows[0].Body)
	}
	req["session_ids"] = extras
	desk.Do("POST", "/messaging/unbilled-reminders", req).Expect(t, 200, "two extras").Decode(t, &res)
	if !strings.Contains(res.Rows[0].Body, "2 extra treatments") {
		t.Fatalf("two extras: %q", res.Rows[0].Body)
	}
	msgOn(t, c, "am")
	req["session_ids"] = extras
	desk.Do("POST", "/messaging/unbilled-reminders", req).Expect(t, 200, "am extras").Decode(t, &res)
	if !strings.Contains(res.Rows[0].Body, "2 ተጨማሪ ሕክምናዎች") {
		t.Fatalf("amharic extras: %q", res.Rows[0].Body)
	}
}

// TestREG_MSG_022_UnbilledReminderRefusals: Given the unbilled-treatment page, When
// the desk asks with no message, an unknown placeholder, no rows, more than 500
// rows, an unrecognised row id, rows already settled, rows of another clinic, or
// while sending is off, Then it is refused; an opted-out patient is shown as not
// reachable and, if she is the only one, nothing is sent.
func TestREG_MSG_022_UnbilledReminderRefusals(t *testing.T) {
	c := msgClinic(t)
	p, sessions := msgOwedCourse(t, c, msgPhone())
	desk := srv.As(t, c, "receptionist")
	send := func(b map[string]any) testkit.Resp { return desk.Do("POST", "/messaging/unbilled-reminders", b) }
	send(map[string]any{"session_ids": sessions, "body": "x"}).Expect(t, 400, "sending off")
	msgOn(t, c, "en")
	many := make([]string, 501)
	for i := range many {
		many[i] = id.Encode(id.PrefixTreatmentSession, uuid.New())
	}
	for name, b := range map[string]map[string]any{
		"no body":     {"session_ids": sessions, "body": " "},
		"placeholder": {"session_ids": sessions, "body": "{{nickname}}"},
		"no rows":     {"session_ids": []string{}, "body": "x"},
		"over 500":    {"session_ids": many, "body": "x"},
		"bad id":      {"session_ids": []string{"tss_nope"}, "body": "x"},
		"unknown ids": {"session_ids": many[:3], "body": "x"},
	} {
		send(b).Expect(t, 400, name)
	}
	desk.Do("POST", "/messaging/unbilled-reminders", "x").Expect(t, 400, "unreadable")
	// Another clinic cannot chase A's patient by naming A's rows.
	b := msgClinic(t)
	msgOn(t, b, "en")
	srv.As(t, b, "receptionist").Do("POST", "/messaging/unbilled-reminders",
		map[string]any{"session_ids": sessions, "body": "x"}).Expect(t, 400, "other clinic's rows")
	// Opted out: shown, priced at nothing, and not sent.
	msgExec(t, `UPDATE patients SET sms_opt_out = true WHERE id = $1`, msgID(t, id.PrefixPatient, p.ID))
	var res msgUnbilled
	send(map[string]any{"session_ids": sessions, "body": "x", "preview": true}).Expect(t, 200, "preview").Decode(t, &res)
	if len(res.Rows) != 1 || res.Rows[0].SkipReason != "no_consent" || res.Segments != 0 {
		t.Fatalf("opted-out preview: %+v", res)
	}
	send(map[string]any{"session_ids": sessions, "body": "x"}).Expect(t, 400, "nobody reachable")
	// Phone problems are named too.
	for phone, reason := range map[string]string{"": "no_phone", "0712345678": "unsupported_network", "123": "bad_phone"} {
		msgExec(t, `UPDATE patients SET sms_opt_out = false, phone = NULLIF($2,'') WHERE id = $1`, msgID(t, id.PrefixPatient, p.ID), phone)
		send(map[string]any{"session_ids": sessions, "body": "x", "preview": true}).Expect(t, 200, reason).Decode(t, &res)
		if res.Rows[0].SkipReason != reason {
			t.Fatalf("phone %q: want %s, got %s", phone, reason, res.Rows[0].SkipReason)
		}
	}
	// Settled since the page loaded: nothing is owed, so nothing is chased.
	for _, s := range sessions {
		msgExec(t, `UPDATE treatment_sessions SET status = 'cancelled' WHERE id = $1`, msgID(t, id.PrefixTreatmentSession, s))
	}
	send(map[string]any{"session_ids": sessions, "body": "x", "preview": true}).Expect(t, 400, "no longer owed")
	var n int
	one(t, `SELECT count(*) FROM messages WHERE tenant_id IN ($1,$2)`, &n, c.TenantID, b.TenantID)
	if n != 0 {
		t.Fatalf("refused reminders queued %d", n)
	}
}

// TestREG_MSG_023_UnbilledReminderRespectsTheAllowance: Given a clinic with no SMS
// allowance left, When the desk sends an unbilled reminder, Then the whole batch is
// refused before anything is queued.
func TestREG_MSG_023_UnbilledReminderRespectsTheAllowance(t *testing.T) {
	c := msgClinic(t)
	msgOn(t, c, "en")
	_, sessions := msgOwedCourse(t, c, msgPhone())
	msgExec(t, `UPDATE tenants SET sms_monthly_override = 0 WHERE id = $1`, c.TenantID)
	r := srv.As(t, c, "receptionist").Do("POST", "/messaging/unbilled-reminders",
		map[string]any{"session_ids": sessions, "body": "x"}).Expect(t, 403, "no allowance")
	if r.Code != "SMS_LIMIT_REACHED" {
		t.Fatalf("code %s", r.Code)
	}
	var n int
	one(t, `SELECT count(*) FROM messages WHERE tenant_id = $1`, &n, c.TenantID)
	if n != 0 {
		t.Fatalf("queued %d over the allowance", n)
	}
}

// ---- the staff inbox (bell) --------------------------------------------------

// msgNotify writes one notification for a user, as a producer would.
func msgNotify(t *testing.T, tenant, user uuid.UUID, kind string, patient *uuid.UUID, data string, minutesAgo int) uuid.UUID {
	t.Helper()
	var nid uuid.UUID
	if err := super.Pool.QueryRow(t.Context(),
		`INSERT INTO notifications (tenant_id, user_id, kind, title, body, patient_id, dedupe_key, data, created_at)
		 VALUES ($1,$2,$3,'Title','Body',$4,$5,$6::jsonb, now() - ($7 || ' minutes')::interval) RETURNING id`,
		tenant, user, kind, patient, uuid.NewString(), data, fmt.Sprint(minutesAgo)).Scan(&nid); err != nil {
		t.Fatalf("insert notification: %v", err)
	}
	return nid
}

type msgInbox struct {
	Items []struct {
		ID     string  `json:"id"`
		Kind   string  `json:"kind"`
		Href   string  `json:"href"`
		ReadAt *string `json:"read_at"`
	} `json:"items"`
	Unread int     `json:"unread"`
	Next   *string `json:"next"`
}

// TestREG_MSG_024_InboxIsPersonal: Given notifications for the receptionist, for
// the owner of the same clinic and for a user of clinic B, When the receptionist
// opens the bell, Then she sees only her own, newest first, each opening the right
// screen (a missed visit opens the patient, a waiting patient opens Chairside or My
// day); filters by read state and kind work; and paging continues exactly where the
// last page ended.
func TestREG_MSG_024_InboxIsPersonal(t *testing.T) {
	c := msgClinic(t)
	me := c.Staff["receptionist"].ID
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Ntf"), "Test")
	pid := msgID(t, id.PrefixPatient, p.ID)
	missed := msgNotify(t, c.TenantID, me, "missed_visit", &pid, `{}`, 1)
	chair := msgNotify(t, c.TenantID, me, "patient_waiting", nil, `{"screen":"chairside"}`, 2)
	work := msgNotify(t, c.TenantID, me, "patient_waiting", nil, `{}`, 3)
	other := msgNotify(t, c.TenantID, me, "something_new", nil, `{}`, 4)
	msgExec(t, `UPDATE notifications SET read_at = now() WHERE id = $1`, other)
	msgNotify(t, c.TenantID, c.Owner.ID, "missed_visit", nil, `{}`, 1)
	msgNotify(t, clinicB.TenantID, clinicB.Staff["receptionist"].ID, "missed_visit", nil, `{}`, 1)

	desk := srv.As(t, c, "receptionist")
	var in msgInbox
	desk.Do("GET", "/notifications", nil).Expect(t, 200, "inbox").Decode(t, &in)
	if len(in.Items) != 4 || in.Unread != 3 || in.Next != nil {
		t.Fatalf("inbox: %d items, unread %d, next %v", len(in.Items), in.Unread, in.Next)
	}
	wantHref := map[string]string{
		id.Encode(id.PrefixNotification, missed): "/patients/" + p.ID,
		id.Encode(id.PrefixNotification, chair):  "/chairside",
		id.Encode(id.PrefixNotification, work):   "/worklist",
		id.Encode(id.PrefixNotification, other):  "",
	}
	for i, it := range in.Items {
		if it.Href != wantHref[it.ID] {
			t.Fatalf("item %d (%s): href %q, want %q", i, it.Kind, it.Href, wantHref[it.ID])
		}
	}
	if in.Items[0].ID != id.Encode(id.PrefixNotification, missed) {
		t.Fatal("not newest first")
	}
	count := func(q string) int {
		var x msgInbox
		desk.Do("GET", "/notifications"+q, nil).Expect(t, 200, q).Decode(t, &x)
		return len(x.Items)
	}
	for q, want := range map[string]int{"?status=unread": 3, "?status=read": 1, "?status=all": 4,
		"?unread=1": 3, "?unread=true": 3, "?kind=patient_waiting": 2, "?kind=missed_visit&status=unread": 1} {
		if got := count(q); got != want {
			t.Fatalf("%s: want %d, got %d", q, want, got)
		}
	}
	// Paging: two at a time.
	var page msgInbox
	desk.Do("GET", "/notifications?limit=2", nil).Expect(t, 200, "page 1").Decode(t, &page)
	if len(page.Items) != 2 || page.Next == nil {
		t.Fatalf("page 1: %+v", page)
	}
	seen := map[string]bool{page.Items[0].ID: true, page.Items[1].ID: true}
	desk.Do("GET", "/notifications?limit=2&before="+*page.Next, nil).Expect(t, 200, "page 2").Decode(t, &page)
	if len(page.Items) != 2 || page.Next != nil || seen[page.Items[0].ID] || seen[page.Items[1].ID] {
		t.Fatalf("page 2 repeats or is short: %+v", page)
	}
	for _, q := range []string{"?status=bogus", "?kind=Bad-Kind", "?before=nope", "?limit=0", "?limit=x"} {
		desk.Do("GET", "/notifications"+q, nil).Expect(t, 400, q)
	}
	// The owner's inbox holds only the owner's one.
	var own msgInbox
	srv.As(t, c, "owner").Do("GET", "/notifications", nil).Expect(t, 200, "owner").Decode(t, &own)
	if len(own.Items) != 1 {
		t.Fatalf("owner sees %d", len(own.Items))
	}
}

// TestREG_MSG_025_BellCountsByKind: Given three unread notifications (two waiting
// patients, one missed visit) and one read, When the bell asks for its count, Then it
// says 3, split by kind; a colleague's count is not affected.
func TestREG_MSG_025_BellCountsByKind(t *testing.T) {
	c := msgClinic(t)
	me := c.Staff["doctor"].ID
	msgNotify(t, c.TenantID, me, "patient_waiting", nil, `{}`, 1)
	msgNotify(t, c.TenantID, me, "patient_waiting", nil, `{}`, 2)
	msgNotify(t, c.TenantID, me, "missed_visit", nil, `{}`, 3)
	r := msgNotify(t, c.TenantID, me, "missed_visit", nil, `{}`, 4)
	msgExec(t, `UPDATE notifications SET read_at = now() WHERE id = $1`, r)
	var cnt struct {
		Unread int            `json:"unread"`
		ByKind map[string]int `json:"by_kind"`
	}
	srv.As(t, c, "doctor").Do("GET", "/notifications/count", nil).Expect(t, 200, "count").Decode(t, &cnt)
	if cnt.Unread != 3 || cnt.ByKind["patient_waiting"] != 2 || cnt.ByKind["missed_visit"] != 1 {
		t.Fatalf("count: %+v", cnt)
	}
	srv.As(t, c, "nurse").Do("GET", "/notifications/count", nil).Expect(t, 200, "colleague").Decode(t, &cnt)
	if cnt.Unread != 0 {
		t.Fatalf("colleague count: %+v", cnt)
	}
}

// TestREG_MSG_026_OpeningANotificationIsPersonalAndIdempotent: Given a notification
// of mine, When I open it twice, Then it is read and keeps the first read time; When
// I try a colleague's or another clinic's notification, Then it is "not found" and
// stays unread; a malformed id is refused.
func TestREG_MSG_026_OpeningANotificationIsPersonalAndIdempotent(t *testing.T) {
	c := msgClinic(t)
	mine := msgNotify(t, c.TenantID, c.Staff["receptionist"].ID, "missed_visit", nil, `{}`, 1)
	theirs := msgNotify(t, c.TenantID, c.Owner.ID, "missed_visit", nil, `{}`, 1)
	otherClinic := msgNotify(t, clinicB.TenantID, clinicB.Staff["receptionist"].ID, "missed_visit", nil, `{}`, 1)
	desk := srv.As(t, c, "receptionist")
	path := func(n uuid.UUID) string { return "/notifications/" + id.Encode(id.PrefixNotification, n) + "/read" }
	desk.Do("POST", path(mine), nil).Expect(t, 204, "open")
	var first time.Time
	one(t, `SELECT read_at FROM notifications WHERE id = $1`, &first, mine)
	time.Sleep(20 * time.Millisecond)
	desk.Do("POST", path(mine), nil).Expect(t, 204, "open again")
	var again time.Time
	one(t, `SELECT read_at FROM notifications WHERE id = $1`, &again, mine)
	if !again.Equal(first) {
		t.Fatalf("read time moved: %v → %v", first, again)
	}
	for name, n := range map[string]uuid.UUID{"colleague's": theirs, "other clinic's": otherClinic, "unknown": uuid.New()} {
		if r := desk.Do("POST", path(n), nil).Expect(t, 404, name); r.Code != "NOTIFICATION_NOT_FOUND" {
			t.Fatalf("%s: code %s", name, r.Code)
		}
	}
	var unread bool
	one(t, `SELECT read_at IS NULL FROM notifications WHERE id = $1`, &unread, theirs)
	if !unread {
		t.Fatal("a colleague's notification was marked read")
	}
	one(t, `SELECT read_at IS NULL FROM notifications WHERE id = $1`, &unread, otherClinic)
	if !unread {
		t.Fatal("another clinic's notification was marked read")
	}
	desk.Do("POST", "/notifications/nope/read", nil).Expect(t, 400, "malformed")
}

// TestREG_MSG_027_MarkAllReadOnlyTouchesMine: Given two waiting-patient and one
// missed-visit notification of mine and one of a colleague, When I mark all waiting
// patients read, Then exactly two are marked; When I mark everything read, Then the
// last one is; the colleague's stays unread; an unreadable kind is refused.
func TestREG_MSG_027_MarkAllReadOnlyTouchesMine(t *testing.T) {
	c := msgClinic(t)
	me := c.Staff["doctor"].ID
	msgNotify(t, c.TenantID, me, "patient_waiting", nil, `{}`, 1)
	msgNotify(t, c.TenantID, me, "patient_waiting", nil, `{}`, 2)
	msgNotify(t, c.TenantID, me, "missed_visit", nil, `{}`, 3)
	col := msgNotify(t, c.TenantID, c.Owner.ID, "patient_waiting", nil, `{}`, 1)
	doc := srv.As(t, c, "doctor")
	var res struct {
		Marked int `json:"marked"`
	}
	doc.Do("POST", "/notifications/read-all?kind=patient_waiting", nil).Expect(t, 200, "by kind").Decode(t, &res)
	if res.Marked != 2 {
		t.Fatalf("by kind: marked %d", res.Marked)
	}
	doc.Do("POST", "/notifications/read-all", nil).Expect(t, 200, "all").Decode(t, &res)
	if res.Marked != 1 {
		t.Fatalf("all: marked %d", res.Marked)
	}
	var unread bool
	one(t, `SELECT read_at IS NULL FROM notifications WHERE id = $1`, &unread, col)
	if !unread {
		t.Fatal("mark-all-read reached a colleague's notification")
	}
	doc.Do("POST", "/notifications/read-all?kind=DROP%20TABLE", nil).Expect(t, 400, "bad kind")
}

// TestREG_MSG_028_MissedVisitMeansTheSameOnTheBellAndTheDashboard: Given a dental
// visit missed 10 days ago and never rebooked, When the owner opens the home page,
// Then its "missed a treatment visit" alert counts that patient — the bell tells the
// same owner about any miss in the last 14 days (missed_visit.go lookbackDays), and
// one patient cannot be "missed" on one screen and not on the other.
func TestREG_MSG_028_MissedVisitMeansTheSameOnTheBellAndTheDashboard(t *testing.T) {
	c := msgClinic(t)
	desk := srv.As(t, c, "receptionist")
	miss := func(daysAgo int) {
		p := createPatient(t, desk, uniq("Mis"), "Test")
		pid := msgID(t, id.PrefixPatient, p.ID)
		var plan uuid.UUID
		if err := super.Pool.QueryRow(t.Context(),
			`INSERT INTO treatment_plans (tenant_id, patient_id, title, total_amount, start_date,
			                              interval_unit, interval_count, session_count, status)
			 VALUES ($1,$2,'Root canal',0,current_date - $3::int,'week',1,1,'active') RETURNING id`,
			c.TenantID, pid, daysAgo).Scan(&plan); err != nil {
			t.Fatal(err)
		}
		msgExec(t, `INSERT INTO treatment_sessions (tenant_id, plan_id, patient_id, seq, scheduled_date, amount_due, status, kind)
		            VALUES ($1,$2,$3,1,(now() AT TIME ZONE 'Africa/Addis_Ababa')::date - $4::int,0,'planned','visit')`,
			c.TenantID, plan, pid, daysAgo)
	}
	miss(3)  // on every screen
	miss(10) // on the bell (14 days), not on the dashboard (7)
	var today struct {
		Attention []struct {
			Kind  string `json:"kind"`
			Count int    `json:"count"`
		} `json:"attention"`
	}
	srv.As(t, c, "owner").Do("GET", "/dashboard/today", nil).Expect(t, 200, "dashboard").Decode(t, &today)
	counted := 0
	for _, a := range today.Attention {
		if a.Kind == "missed_visit" {
			counted = a.Count
		}
	}
	if counted == 0 {
		t.Fatalf("the dashboard does not count even a 3-day-old miss: %+v", today.Attention)
	}
	testkit.KnownBug(t, "APT-8", counted != 2,
		fmt.Sprintf("dashboard counts %d of 2 missed patients: the one missed 10 days ago is on the bell (14-day window, missed_visit.go:24) but not on the dashboard (7 days, dashboard/service.go:345)", counted))
}
