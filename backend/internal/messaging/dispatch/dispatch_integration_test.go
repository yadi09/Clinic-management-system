package dispatch

// Worker-side patient SMS against a real Postgres: the planner turning dental
// visits, appointments and debts into queued rows, the dispatcher's gates and its
// handling of every kind of gateway answer, the reconciler, and recovery of rows
// stranded mid-send.
//
// No test here can reach a phone. Every gateway is fakeGateway (below), handed to
// the code through messaging.GatewayFactory with no encryption key, so no clinic
// credential can ever resolve to the real SMSEthiopia adapter.
//
// The planner and dispatcher read ONE queue across every tenant, so running them
// against the shared regression database would send (fake) other tests' messages
// and change rows those tests are asserting on. These tests therefore use a private
// database of their own (<test db>_msgdispatch), created and migrated on first use,
// and reset before each test.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
	"github.com/reicb/clinicsaas/internal/messaging"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// ---- private database -------------------------------------------------------

var (
	msgDBOnce sync.Once
	msgDBDSN  string
	msgDBErr  error
)

// msgPrivateDSN creates (once) and migrates a database beside the test database.
// Its name keeps the test database's name, so testkit's guard rules still hold.
func msgPrivateDSN(shared string) (string, error) {
	u, err := url.Parse(shared)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(u.Path, "/") + "_msgdispatch"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, shared)
	if err != nil {
		return "", err
	}
	defer conn.Close(ctx)
	// Two test processes may get here at once.
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(7262102)`); err != nil {
		return "", err
	}
	defer conn.Exec(ctx, `SELECT pg_advisory_unlock(7262102)`) //nolint:errcheck
	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		if _, err := conn.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize()); err != nil {
			return "", err
		}
	}
	u.Path = "/" + name
	dsn := u.String()
	sdb, err := sql.Open("pgx", dsn)
	if err != nil {
		return "", err
	}
	defer sdb.Close()
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return "", err
	}
	goose.SetLogger(goose.NopLogger())
	if err := goose.UpContext(ctx, sdb, "."); err != nil {
		return "", err
	}
	return dsn, nil
}

// msgDB is the private database, reset so the only due work is the test's own:
// nothing waiting or mid-send, no clinic sending, no automation on, nothing left
// for the reconciler.
func msgDB(t *testing.T) *kerneldb.DB {
	t.Helper()
	shared := testkit.RequireDB(t)
	msgDBOnce.Do(func() { msgDBDSN, msgDBErr = msgPrivateDSN(shared) })
	if msgDBErr != nil {
		t.Fatalf("private messaging database: %v", msgDBErr)
	}
	db := testkit.SuperDB(t, msgDBDSN)
	for _, q := range []string{
		`UPDATE messages SET status = 'cancelled' WHERE status IN ('scheduled','sending')`,
		`UPDATE messages SET status_checks = 12 WHERE status = 'sent'`,
		`UPDATE clinics SET sms_enabled = false, timezone = 'Africa/Addis_Ababa'`,
		`UPDATE message_rules SET enabled = false`,
	} {
		if _, err := db.Pool.Exec(context.Background(), q); err != nil {
			t.Fatalf("reset: %v", err)
		}
	}
	return db
}

// ---- fakes and fixtures -----------------------------------------------------

// fakeGateway records what it was asked to send and answers as scripted.
type fakeGateway struct {
	mu        sync.Mutex
	notLive   bool
	sent      []sms.Message
	errs      []error // popped per Send; nil entries mean success
	receipt   *sms.Receipt
	delivery  *sms.Delivery
	statusErr error
	asked     []string
}

func (g *fakeGateway) Name() string { return "fake" }
func (g *fakeGateway) Live() bool   { return !g.notLive }
func (g *fakeGateway) Send(_ context.Context, m sms.Message) (*sms.Receipt, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sent = append(g.sent, m)
	if len(g.errs) > 0 {
		e := g.errs[0]
		g.errs = g.errs[1:]
		if e != nil {
			return nil, e
		}
	}
	if g.receipt != nil {
		return g.receipt, nil
	}
	return &sms.Receipt{ID: fmt.Sprintf("gw-%d", len(g.sent))}, nil
}
func (g *fakeGateway) Status(_ context.Context, id string) (*sms.Delivery, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.asked = append(g.asked, id)
	return g.delivery, g.statusErr
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// factory never has an encryption key, so every clinic resolves to the fake.
func factory(g sms.Gateway) *messaging.GatewayFactory {
	return messaging.NewGatewayFactory(nil, "", g, quiet())
}

type fx struct {
	t   *testing.T
	ctx context.Context
	db  *kerneldb.DB
}

func newFx(t *testing.T) *fx {
	return &fx{t: t, ctx: context.Background(), db: msgDB(t)}
}

func (f *fx) exec(q string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Pool.Exec(f.ctx, q, args...); err != nil {
		f.t.Fatalf("%v\n%s", err, q)
	}
}

func (f *fx) scan(q string, args []any, dst ...any) {
	f.t.Helper()
	if err := f.db.Pool.QueryRow(f.ctx, q, args...).Scan(dst...); err != nil {
		f.t.Fatalf("%v\n%s", err, q)
	}
}

func (f *fx) id(q string, args ...any) uuid.UUID {
	f.t.Helper()
	var u uuid.UUID
	f.scan(q, args, &u)
	return u
}

// clinic is a sending dental clinic on the Practice plan, with no quiet hours (so
// the time of day the suite runs at cannot change an outcome) unless a test sets
// them.
func (f *fx) clinic() *testkit.Clinic {
	f.t.Helper()
	c := testkit.NewClinic(f.t, f.db, testkit.ClinicOpts{PlanCode: "dental-practice"})
	f.exec(`UPDATE clinics SET sms_enabled = true, sms_sender_name = 'Smile', sms_lang = 'en',
	                          sms_quiet_from = '00:00', sms_quiet_to = '00:00'
	         WHERE tenant_id = $1`, c.TenantID)
	return c
}

func (f *fx) template(c *testkit.Clinic, kind, lang, body string) {
	f.exec(`INSERT INTO message_templates (tenant_id, kind, lang, body) VALUES ($1,$2,$3,$4)
	        ON CONFLICT (tenant_id, kind, lang) DO UPDATE SET body = EXCLUDED.body`, c.TenantID, kind, lang, body)
}

func (f *fx) rule(c *testkit.Clinic, kind string, offset int, sendAt string, repeatDays, maxRepeats int) {
	f.exec(`INSERT INTO message_rules (tenant_id, kind, enabled, offset_hours, send_at, repeat_days, max_repeats)
	        VALUES ($1,$2,true,$3,NULLIF($4,'')::time,$5,$6)
	        ON CONFLICT (tenant_id, kind) DO UPDATE SET enabled = true, offset_hours = EXCLUDED.offset_hours,
	          send_at = EXCLUDED.send_at, repeat_days = EXCLUDED.repeat_days, max_repeats = EXCLUDED.max_repeats`,
		c.TenantID, kind, offset, sendAt, repeatDays, maxRepeats)
}

// patient with a phone exactly as given ("" for none).
func (f *fx) patient(c *testkit.Clinic, first, phone string) uuid.UUID {
	return f.id(`INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender, phone)
	             VALUES ($1,$2,$3,'Fx','female',NULLIF($4,'')) RETURNING id`,
		c.TenantID, "M-"+uuid.NewString()[:8], first, phone)
}

func (f *fx) plan(c *testkit.Clinic, pid uuid.UUID, status string) uuid.UUID {
	return f.id(`INSERT INTO treatment_plans (tenant_id, patient_id, title, total_amount, start_date,
	                                          interval_unit, interval_count, session_count, status)
	             VALUES ($1,$2,'Root canal',0,current_date,'week',1,3,$3) RETURNING id`, c.TenantID, pid, status)
}

// session dated `days` from today in Addis.
func (f *fx) session(c *testkit.Clinic, plan, pid uuid.UUID, seq, days int, status, kind string, amount int) uuid.UUID {
	return f.id(`INSERT INTO treatment_sessions (tenant_id, plan_id, patient_id, seq, scheduled_date, amount_due, status, kind)
	             VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'Africa/Addis_Ababa')::date + $5::int,$6,$7,$8) RETURNING id`,
		c.TenantID, plan, pid, seq, days, amount, status, kind)
}

// queue puts one due message on the queue.
func (f *fx) queue(c *testkit.Clinic, msisdn, body string) uuid.UUID {
	return f.id(`INSERT INTO messages (tenant_id, kind, lang, msisdn, body, segments, cost, status, scheduled_for)
	             VALUES ($1,'custom','en',$2,$3,1,0.5,'scheduled',now() - interval '1 second') RETURNING id`,
		c.TenantID, msisdn, body)
}

type msgRow struct {
	Status, Skip, LastError, GatewayID, Body, MSISDN string
	Attempts, Segments                               int
	Cost                                             float64
	DueIn                                            time.Duration
	Sent                                             bool
}

func (f *fx) row(mid uuid.UUID) msgRow {
	f.t.Helper()
	var r msgRow
	var due float64
	f.scan(`SELECT status, coalesce(skip_reason,''), coalesce(last_error,''), coalesce(gateway_id,''), body, msisdn,
	               attempts, segments, cost::float8, extract(epoch from scheduled_for - now()), sent_at IS NOT NULL
	          FROM messages WHERE id = $1`, []any{mid},
		&r.Status, &r.Skip, &r.LastError, &r.GatewayID, &r.Body, &r.MSISDN,
		&r.Attempts, &r.Segments, &r.Cost, &due, &r.Sent)
	r.DueIn = time.Duration(due * float64(time.Second))
	return r
}

// rowsFor lists one clinic's messages by dedupe key.
func (f *fx) rowsFor(c *testkit.Clinic) map[string]msgRow {
	f.t.Helper()
	out := map[string]msgRow{}
	rows, err := f.db.Pool.Query(f.ctx,
		`SELECT coalesce(dedupe_key,''), status, coalesce(skip_reason,''), body, msisdn
		   FROM messages WHERE tenant_id = $1`, c.TenantID)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var r msgRow
		if err := rows.Scan(&k, &r.Status, &r.Skip, &r.Body, &r.MSISDN); err != nil {
			f.t.Fatal(err)
		}
		out[k] = r
	}
	return out
}

// due makes a deferred message due again, as time passing would.
func (f *fx) due(mid uuid.UUID) {
	f.exec(`UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE id = $1`, mid)
}

func addis(days int) time.Time {
	loc, err := time.LoadLocation("Africa/Addis_Ababa")
	if err != nil {
		loc = time.FixedZone("EAT", 3*3600)
	}
	return time.Now().In(loc).AddDate(0, 0, days)
}

// ---- dispatcher -------------------------------------------------------------

// Given a due message, When the dispatcher runs, Then the gateway gets exactly that
// number and text once, and the row records the gateway's id and status and is
// re-priced at the segment count the gateway actually charged.
func TestIntegrationDispatchSendsAndRecordsTheGatewaysBill(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	mid := f.queue(c, "251911000101", "Smile: hello")
	gw := &fakeGateway{receipt: &sms.Receipt{ID: "01JGW", Segments: 2, Status: "ACCEPTED"}}
	n, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx)
	if err != nil || n != 1 {
		t.Fatalf("RunOnce: n=%d err=%v", n, err)
	}
	if len(gw.sent) != 1 || gw.sent[0].MSISDN != "251911000101" || gw.sent[0].Text != "Smile: hello" {
		t.Fatalf("gateway got %+v", gw.sent)
	}
	r := f.row(mid)
	if r.Status != "sent" || r.GatewayID != "01JGW" || r.Segments != 2 || r.Cost != 1.0 || r.Attempts != 1 || !r.Sent {
		t.Fatalf("sent row: %+v", r)
	}
	var gs string
	f.scan(`SELECT gateway_status FROM messages WHERE id = $1`, []any{mid}, &gs)
	if gs != "ACCEPTED" {
		t.Fatalf("gateway status %q", gs)
	}
	// Nothing left: a second pass sends nothing.
	if n, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx); err != nil || n != 0 || len(gw.sent) != 1 {
		t.Fatalf("second pass: n=%d err=%v sent=%d", n, err, len(gw.sent))
	}
}

// Given messages a gate must stop, When the dispatcher runs, Then none reaches the
// gateway and each is written back as skipped with the reason a person will read:
// sending switched off after queueing, no way onto the network (no key, or a stored
// key that cannot be decrypted), and the monthly allowance used up.
func TestIntegrationDispatchGatesSkipWithAReason(t *testing.T) {
	f := newFx(t)
	gw := &fakeGateway{}

	off := f.clinic()
	mOff := f.queue(off, "251911000102", "a")
	f.exec(`UPDATE clinics SET sms_enabled = false WHERE tenant_id = $1`, off.TenantID)

	broke := f.clinic()
	mBroke := f.queue(broke, "251911000103", "b")
	f.exec(`UPDATE clinics SET sms_api_key_enc = 'not-decryptable' WHERE tenant_id = $1`, broke.TenantID)

	over := f.clinic()
	mOver := f.queue(over, "251911000104", "c")
	f.exec(`UPDATE tenants SET sms_monthly_override = 0 WHERE id = $1`, over.TenantID)

	// A factory WITH a key, so the broken credential is actually tried (and refused),
	// while every clinic without a key still resolves to the fake.
	key := []byte("0123456789abcdef0123456789abcdef")
	d := New(f.db, messaging.NewGatewayFactory(key, "", gw, quiet()), quiet())
	if _, err := d.RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[uuid.UUID]string{mOff: "sending_off", mBroke: "not_configured", mOver: "quota"} {
		if r := f.row(name); r.Status != "skipped" || r.Skip != want {
			t.Fatalf("want skipped/%s, got %+v", want, r)
		}
	}
	// The log gateway (no platform key) is not live either.
	plain := f.clinic()
	mPlain := f.queue(plain, "251911000105", "d")
	if _, err := New(f.db, factory(&fakeGateway{notLive: true}), quiet()).RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if r := f.row(mPlain); r.Status != "skipped" || r.Skip != "not_configured" {
		t.Fatalf("not live: %+v", r)
	}
	if len(gw.sent) != 0 {
		t.Fatalf("a gated message reached the gateway: %+v", gw.sent)
	}
}

// Given the clinic's quiet hours cover the present moment, When the dispatcher
// runs, Then an ordinary reminder is held (still scheduled, moved to when quiet
// hours end) and never dropped, while a message somebody is waiting on (welcome,
// test, send-now) goes immediately.
func TestIntegrationDispatchQuietHoursDeferNotDrop(t *testing.T) {
	f := newFx(t)
	for _, wrap := range []bool{false, true} {
		c := f.clinic()
		if wrap {
			// 21:00-style window that runs through midnight: from > to.
			f.exec(`UPDATE clinics SET sms_quiet_from = ((now() AT TIME ZONE timezone) - interval '1 hour')::time,
			                          sms_quiet_to   = ((now() AT TIME ZONE timezone) - interval '2 hours')::time
			         WHERE tenant_id = $1`, c.TenantID)
		} else {
			f.exec(`UPDATE clinics SET sms_quiet_from = ((now() AT TIME ZONE timezone) - interval '1 minute')::time,
			                          sms_quiet_to   = ((now() AT TIME ZONE timezone) + interval '2 minutes')::time
			         WHERE tenant_id = $1`, c.TenantID)
		}
		held := f.queue(c, "251911000106", "held")
		urgent := f.queue(c, "251911000107", "urgent")
		f.exec(`UPDATE messages SET bypass_quiet_hours = true WHERE id = $1`, urgent)
		gw := &fakeGateway{}
		if _, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx); err != nil {
			t.Fatal(err)
		}
		h := f.row(held)
		if h.Status != "scheduled" || h.DueIn <= 0 || h.DueIn > 25*time.Hour || h.Attempts != 0 {
			t.Fatalf("wrap=%v held: %+v", wrap, h)
		}
		if u := f.row(urgent); u.Status != "sent" {
			t.Fatalf("wrap=%v urgent: %+v", wrap, u)
		}
		if len(gw.sent) != 1 || gw.sent[0].Text != "urgent" {
			t.Fatalf("wrap=%v gateway got %+v", wrap, gw.sent)
		}
		f.exec(`UPDATE clinics SET sms_quiet_from = '00:00', sms_quiet_to = '00:00' WHERE tenant_id = $1`, c.TenantID)
		f.exec(`UPDATE messages SET status = 'cancelled' WHERE id = $1`, held)
	}
}

// Given the gateway refuses a message outright (bad number, no credit), When the
// dispatcher runs, Then it fails at once with the gateway's words and is never
// retried.
func TestIntegrationDispatchPermanentRefusalFailsAtOnce(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	mid := f.queue(c, "251911000108", "x")
	gw := &fakeGateway{errs: []error{&sms.Error{Code: "10000", Message: "invalid phone number", Permanent: true}}}
	if _, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if r := f.row(mid); r.Status != "failed" || r.LastError != "invalid phone number" || r.Attempts != 1 {
		t.Fatalf("permanent: %+v", r)
	}
}

// Given the gateway is rate-limiting and says "retry after 90 seconds", When the
// dispatcher runs, Then the message is requeued for exactly that pause.
func TestIntegrationDispatchHonoursRetryAfter(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	mid := f.queue(c, "251911000109", "x")
	gw := &fakeGateway{errs: []error{&sms.Error{Message: "slow down", RetryAfter: 90 * time.Second}}}
	if _, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	r := f.row(mid)
	if r.Status != "scheduled" || r.Attempts != 1 || r.LastError != "slow down" ||
		r.DueIn < 80*time.Second || r.DueIn > 95*time.Second {
		t.Fatalf("retry-after: %+v", r)
	}
}

// Given an ordinary transient failure every time, When the dispatcher keeps
// trying, Then the retries back off 1, 5 and 20 minutes and the fourth failure gives
// up; and given silence (the gateway could not be reached, so it may have taken the
// message), Then it is tried only twice, to avoid charging and buzzing twice.
func TestIntegrationDispatchRetriesBackOffThenGiveUp(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	mid := f.queue(c, "251911000110", "x")
	boom := errors.New("gateway 502")
	gw := &fakeGateway{errs: []error{boom, boom, boom, boom}}
	d := New(f.db, factory(gw), quiet())
	for i, want := range []time.Duration{time.Minute, 5 * time.Minute, 20 * time.Minute} {
		if _, err := d.RunOnce(f.ctx); err != nil {
			t.Fatal(err)
		}
		r := f.row(mid)
		if r.Status != "scheduled" || r.Attempts != i+1 || r.DueIn < want-15*time.Second || r.DueIn > want+5*time.Second {
			t.Fatalf("attempt %d: %+v", i+1, r)
		}
		f.due(mid)
	}
	if _, err := d.RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if r := f.row(mid); r.Status != "failed" || r.Attempts != 4 {
		t.Fatalf("after 4 attempts: %+v", r)
	}

	silent := f.queue(c, "251911000111", "y")
	hush := errors.New("could not reach the SMS gateway: i/o timeout")
	gw2 := &fakeGateway{errs: []error{hush, hush}}
	d2 := New(f.db, factory(gw2), quiet())
	if _, err := d2.RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if r := f.row(silent); r.Status != "scheduled" {
		t.Fatalf("first silence: %+v", r)
	}
	f.due(silent)
	if _, err := d2.RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if r := f.row(silent); r.Status != "failed" || r.Attempts != 2 {
		t.Fatalf("second silence: %+v", r)
	}
}

// Given rows left in 'sending' for over five minutes by a worker that died, When the
// dispatcher runs, Then one with a gateway id is recorded as sent (the gateway took
// it), one without is failed with an explanation and NOT retried, and one only just
// claimed is left alone.
func TestIntegrationDispatchRecoversRowsStrandedMidSend(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	took := f.queue(c, "251911000112", "took")
	lost := f.queue(c, "251911000113", "lost")
	fresh := f.queue(c, "251911000114", "fresh")
	f.exec(`UPDATE messages SET status = 'sending', updated_at = now() - interval '10 minutes' WHERE id IN ($1,$2)`, took, lost)
	f.exec(`UPDATE messages SET gateway_id = 'gw-took' WHERE id = $1`, took)
	f.exec(`UPDATE messages SET status = 'sending' WHERE id = $1`, fresh)
	gw := &fakeGateway{}
	if _, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if r := f.row(took); r.Status != "sent" || !r.Sent {
		t.Fatalf("with gateway id: %+v", r)
	}
	if r := f.row(lost); r.Status != "failed" || !strings.Contains(r.LastError, "interrupted while sending") {
		t.Fatalf("without gateway id: %+v", r)
	}
	if r := f.row(fresh); r.Status != "sending" {
		t.Fatalf("fresh claim touched: %+v", r)
	}
	if len(gw.sent) != 0 {
		t.Fatalf("a stranded row was re-sent: %+v", gw.sent)
	}
}

// Given another worker holds the lock on the earliest due message, When this
// dispatcher runs, Then it skips that row (SKIP LOCKED) and sends the next, so two
// workers never send one message twice; once released, the first goes too.
func TestIntegrationDispatchSkipsRowsAnotherWorkerHolds(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	first := f.queue(c, "251911000115", "first")
	f.exec(`UPDATE messages SET scheduled_for = now() - interval '1 hour' WHERE id = $1`, first)
	second := f.queue(c, "251911000116", "second")
	tx, err := f.db.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(f.ctx, `SELECT 1 FROM messages WHERE id = $1 FOR UPDATE`, first); err != nil {
		t.Fatal(err)
	}
	gw := &fakeGateway{}
	d := New(f.db, factory(gw), quiet())
	n, err := d.RunOnce(f.ctx)
	if err != nil || n != 1 {
		t.Fatalf("with a held row: n=%d err=%v", n, err)
	}
	if f.row(first).Status != "scheduled" || f.row(second).Status != "sent" {
		t.Fatalf("first=%+v second=%+v", f.row(first), f.row(second))
	}
	_ = tx.Rollback(f.ctx)
	if n, err := d.RunOnce(f.ctx); err != nil || n != 1 || f.row(first).Status != "sent" {
		t.Fatalf("after release: n=%d err=%v first=%+v", n, err, f.row(first))
	}
	if len(gw.sent) != 2 {
		t.Fatalf("want each message sent once, gateway got %d", len(gw.sent))
	}
}

// Given the worker loop, When it runs for a moment, Then it sends what is due and
// stops when told to.
func TestIntegrationDispatchRunLoop(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	mid := f.queue(c, "251911000117", "loop")
	gw := &fakeGateway{}
	ctx, cancel := context.WithTimeout(f.ctx, 1200*time.Millisecond)
	defer cancel()
	New(f.db, factory(gw), quiet()).Run(ctx, 100*time.Millisecond)
	if r := f.row(mid); r.Status != "sent" {
		t.Fatalf("loop: %+v", r)
	}
	// A pass that fails is logged, not fatal: a cancelled context makes RunOnce fail.
	dead, stop := context.WithCancel(f.ctx)
	stop()
	New(f.db, factory(gw), quiet()).Run(dead, time.Millisecond)
}

// APT-13 — Given one clinic with a time zone Postgres does not know, When the
// shared dispatcher and planner run, Then every OTHER clinic's messages still go out
// and its reminders are still planned: one clinic's bad setting must not stop the
// queue for all of them.
func TestIntegrationDispatchOneBadTimezoneDoesNotStopEveryClinic(t *testing.T) {
	f := newFx(t)
	bad := f.clinic()
	good := f.clinic()
	f.queue(bad, "251911000118", "bad clinic")
	f.exec(`UPDATE messages SET scheduled_for = now() - interval '1 hour' WHERE tenant_id = $1`, bad.TenantID)
	mGood := f.queue(good, "251911000119", "good clinic")
	f.exec(`UPDATE clinics SET timezone = 'Mars/Olympus_Mons' WHERE tenant_id = $1`, bad.TenantID)
	t.Cleanup(func() {
		_, _ = f.db.Pool.Exec(context.Background(),
			`UPDATE clinics SET timezone = 'Africa/Addis_Ababa' WHERE tenant_id = $1`, bad.TenantID)
	})
	_, err := New(f.db, factory(&fakeGateway{}), quiet()).RunOnce(f.ctx)
	sentGood := f.row(mGood).Status == "sent"

	// The planner reads the same way: a bad zone in its WHERE fails the whole pass.
	f.template(good, "appointment_reminder", "en", "Visit {{date}}")
	f.rule(good, "appointment_reminder", -24, "", 0, 0)
	f.template(bad, "appointment_reminder", "en", "Visit {{date}}")
	f.rule(bad, "appointment_reminder", -24, "", 0, 0)
	pid := f.patient(good, "Hana", "0911000120")
	f.session(good, f.plan(good, pid, "active"), pid, 1, 1, "planned", "visit", 0)
	bpid := f.patient(bad, "Bad", "0911000121")
	f.session(bad, f.plan(bad, bpid, "active"), bpid, 1, 1, "planned", "visit", 0)
	_, perr := NewPlanner(f.db, 0.5, quiet()).PlanDentalAppointments(f.ctx)
	planned := len(f.rowsFor(good)) > 1 // the queued message above plus the reminder

	testkit.KnownBug(t, "APT-13", err != nil || !sentGood || perr != nil || !planned,
		fmt.Sprintf("an unknown time zone in one clinic breaks the cross-tenant queries (dispatch.go:178, plan_dental.go:66): dispatch err=%v other clinic sent=%v; planner err=%v other clinic planned=%v",
			err, sentGood, perr, planned))
}

// ---- reconciler -------------------------------------------------------------

// Given sent messages awaiting confirmation, When the reconciler asks the gateway,
// Then a handset-confirmed one becomes 'delivered'; one still in flight records the
// gateway's latest word and is asked again later; a lookup the gateway refuses
// for good stops being asked; a transient lookup failure counts one check; a
// gateway that cannot report delivery leaves the row alone.
func TestIntegrationReconcilerRecordsDelivery(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	sent := func(gwID string) uuid.UUID {
		m := f.queue(c, "251911000130", gwID)
		f.exec(`UPDATE messages SET status = 'sent', sent_at = now(), gateway_id = $2, status_checks = 0 WHERE id = $1`, m, gwID)
		return m
	}
	checks := func(m uuid.UUID) (string, int, string) {
		var st, gs string
		var n int
		f.scan(`SELECT status, status_checks, coalesce(gateway_status,'') FROM messages WHERE id = $1`, []any{m}, &st, &n, &gs)
		return st, n, gs
	}
	run := func(gw *fakeGateway) int {
		n, err := NewReconciler(f.db, factory(gw), quiet()).RunOnce(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}

	m := sent("gw-delivered")
	if n := run(&fakeGateway{delivery: &sms.Delivery{Status: "DELIVERED"}}); n != 1 {
		t.Fatalf("delivered pass handled %d", n)
	}
	if st, n, gs := checks(m); st != "delivered" || n != 1 || gs != "DELIVERED" {
		t.Fatalf("delivered: %s %d %s", st, n, gs)
	}
	var delivered bool
	f.scan(`SELECT delivered_at IS NOT NULL FROM messages WHERE id = $1`, []any{m}, &delivered)
	if !delivered {
		t.Fatal("no delivered_at")
	}

	m = sent("gw-inflight")
	run(&fakeGateway{delivery: &sms.Delivery{Status: "SENT"}})
	if st, n, gs := checks(m); st != "sent" || n != 1 || gs != "SENT" {
		t.Fatalf("in flight: %s %d %s", st, n, gs)
	}
	// Asked again only after the back-off: an immediate pass leaves it.
	if n := run(&fakeGateway{delivery: &sms.Delivery{Status: "DELIVERED"}}); n != 0 {
		t.Fatalf("asked again inside the back-off: %d", n)
	}
	f.exec(`UPDATE messages SET status_checks = 12 WHERE id = $1`, m)

	m = sent("gw-unknown")
	run(&fakeGateway{statusErr: &sms.Error{Message: "not found", Permanent: true}})
	if _, n, _ := checks(m); n != 12 {
		t.Fatalf("permanent lookup failure: checks %d, want 12", n)
	}

	m = sent("gw-blip")
	run(&fakeGateway{statusErr: errors.New("timeout")})
	if st, n, _ := checks(m); st != "sent" || n != 1 {
		t.Fatalf("transient lookup failure: %s %d", st, n)
	}
	f.exec(`UPDATE messages SET status_checks = 12 WHERE id = $1`, m)

	m = sent("gw-nostatus")
	if n := run(&fakeGateway{statusErr: sms.ErrNoStatus}); n != 0 {
		t.Fatalf("no-status gateway handled %d", n)
	}
	if n := run(&fakeGateway{notLive: true}); n != 0 {
		t.Fatalf("not-live gateway handled %d", n)
	}
	if _, n, _ := checks(m); n != 0 {
		t.Fatalf("row touched by a gateway that cannot answer: %d", n)
	}
	// The loop runs and stops.
	ctx, cancel := context.WithTimeout(f.ctx, 300*time.Millisecond)
	defer cancel()
	NewReconciler(f.db, factory(&fakeGateway{delivery: &sms.Delivery{Status: "DELIVERED"}}), quiet()).Run(ctx, 50*time.Millisecond)
	if st, _, _ := checks(m); st != "delivered" {
		t.Fatalf("loop did not reconcile: %s", st)
	}
	dead, stop := context.WithCancel(f.ctx)
	stop()
	NewReconciler(f.db, factory(&fakeGateway{}), quiet()).Run(dead, time.Millisecond)
}

// ---- planner: dental visits ---------------------------------------------------

// Given a dental clinic with visit reminders on (a day before), When the planner
// runs, Then each patient with a planned visit tomorrow in an active course gets one
// reminder naming the date (no time: a dental visit has none, and the dangling
// "at" is dropped); patients who opted out or cannot be reached get a skipped row
// saying why; deposits, finished or cancelled visits, cancelled courses and visits a
// month out get nothing; and a second pass adds nothing.
func TestIntegrationPlannerDentalVisitReminders(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "appointment_reminder", "en", "Reminder: {{name}}, visit at {{clinic}} on {{date}} at {{time}}.")
	f.rule(c, "appointment_reminder", -24, "18:00", 0, 0)
	visit := func(first, phone string) (uuid.UUID, uuid.UUID) {
		pid := f.patient(c, first, phone)
		return pid, f.session(c, f.plan(c, pid, "active"), pid, 1, 1, "planned", "visit", 0)
	}
	_, ok := visit("Hana", "0911000201")
	optPid, opted := visit("Opt", "0911000202")
	f.exec(`UPDATE patients SET sms_opt_out = true WHERE id = $1`, optPid)
	_, none := visit("None", "")
	_, bad := visit("Bad", "12345")
	_, saf := visit("Saf", "0712345678")
	// Not reminders.
	pid := f.patient(c, "Other", "0911000203")
	pl := f.plan(c, pid, "active")
	f.session(c, pl, pid, 0, 1, "planned", "deposit", 500)
	f.session(c, pl, pid, 2, 1, "done", "visit", 0)
	f.session(c, pl, pid, 3, 1, "cancelled", "visit", 0)
	f.session(c, pl, pid, 4, 40, "planned", "visit", 0)
	f.session(c, f.plan(c, pid, "cancelled"), pid, 1, 1, "planned", "visit", 0)

	p := NewPlanner(f.db, 0.5, quiet())
	if _, err := p.PlanDentalAppointments(f.ctx); err != nil {
		t.Fatal(err)
	}
	rows := f.rowsFor(c)
	if len(rows) != 5 {
		t.Fatalf("want 5 rows, got %d: %+v", len(rows), rows)
	}
	want := map[uuid.UUID]string{ok: "scheduled/", opted: "skipped/no_consent", none: "skipped/no_phone",
		bad: "skipped/bad_phone", saf: "skipped/unsupported_network"}
	for sid, w := range want {
		r, found := rows["tss:"+sid.String()]
		if !found || r.Status+"/"+r.Skip != w {
			t.Fatalf("session %s: want %s, got %+v (found %v)", sid, w, r, found)
		}
	}
	r := rows["tss:"+ok.String()]
	date := addis(1).Format("2 Jan")
	if !strings.Contains(r.Body, "Hana") || !strings.Contains(r.Body, date) || strings.Contains(r.Body, "{{") ||
		strings.Contains(r.Body, " at .") || r.MSISDN != "251911000201" {
		t.Fatalf("reminder body %q (want date %s), msisdn %s", r.Body, date, r.MSISDN)
	}
	if n, err := p.PlanDentalAppointments(f.ctx); err != nil || n != 0 || len(f.rowsFor(c)) != 5 {
		t.Fatalf("second pass: n=%d err=%v rows=%d", n, err, len(f.rowsFor(c)))
	}
	// In Amharic with no Amharic wording, nothing is said at all.
	f.exec(`UPDATE clinics SET sms_lang = 'am' WHERE tenant_id = $1`, c.TenantID)
	pid2, _ := visit("Late", "0911000204")
	if _, err := p.PlanDentalAppointments(f.ctx); err != nil {
		t.Fatal(err)
	}
	var n int
	f.scan(`SELECT count(*) FROM messages WHERE patient_id = $1`, []any{pid2}, &n)
	if n != 0 {
		t.Fatalf("reminder queued with no wording in the clinic's language: %d", n)
	}
}

// APT-2 — Given a dental visit reminder already queued for tomorrow's visit, When the
// visit is moved to the day after and the planner and dispatcher run, Then the
// patient is told the NEW date and is never sent the old one.
func TestIntegrationPlannerRescheduledVisitGetsTheNewDate(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "appointment_reminder", "en", "Visit on {{date}}")
	f.rule(c, "appointment_reminder", -72, "", 0, 0)
	pid := f.patient(c, "Moved", "0911000210")
	sid := f.session(c, f.plan(c, pid, "active"), pid, 1, 1, "planned", "visit", 0)
	p := NewPlanner(f.db, 0.5, quiet())
	if _, err := p.PlanDentalAppointments(f.ctx); err != nil {
		t.Fatal(err)
	}
	// Held, as quiet hours or an 18:00 send time would hold it.
	f.exec(`UPDATE messages SET scheduled_for = now() + interval '1 hour' WHERE tenant_id = $1`, c.TenantID)
	f.exec(`UPDATE treatment_sessions SET scheduled_date = scheduled_date + 1 WHERE id = $1`, sid)
	if _, err := p.PlanDentalAppointments(f.ctx); err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'scheduled'`, c.TenantID)
	gw := &fakeGateway{}
	if _, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	oldDate, newDate := addis(1).Format("2 Jan"), addis(2).Format("2 Jan")
	toldOld, toldNew := false, false
	for _, m := range gw.sent {
		toldOld = toldOld || strings.Contains(m.Text, oldDate)
		toldNew = toldNew || strings.Contains(m.Text, newDate)
	}
	testkit.KnownBug(t, "APT-2", toldOld || !toldNew,
		fmt.Sprintf("reminder key is per visit not per date (plan_dental.go:111 \"tss:\"+id) and the dispatcher does not re-check the visit: sent %d message(s), old date %s told=%v, new date %s told=%v",
			len(gw.sent), oldDate, toldOld, newDate, toldNew))
}

// APT-2 — Given a reminder queued while the patient could be messaged, When she
// opts out before it goes, Then the dispatcher does not send it.
func TestIntegrationDispatchHonoursAnOptOutMadeAfterQueueing(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "appointment_reminder", "en", "Visit on {{date}}")
	f.rule(c, "appointment_reminder", -24, "", 0, 0)
	pid := f.patient(c, "Later", "0911000211")
	f.session(c, f.plan(c, pid, "active"), pid, 1, 1, "planned", "visit", 0)
	if _, err := NewPlanner(f.db, 0.5, quiet()).PlanDentalAppointments(f.ctx); err != nil {
		t.Fatal(err)
	}
	f.exec(`UPDATE messages SET scheduled_for = now() - interval '1 second' WHERE tenant_id = $1`, c.TenantID)
	f.exec(`UPDATE patients SET sms_opt_out = true WHERE id = $1`, pid)
	gw := &fakeGateway{}
	if _, err := New(f.db, factory(gw), quiet()).RunOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	testkit.KnownBug(t, "APT-2", len(gw.sent) > 0,
		"the dispatcher never re-checks opt-out at send time (dispatch.go:180-205): a patient who opted out after the reminder was queued was still texted")
}

// ---- planner: appointments, bills, dental debts, welcome --------------------

// Given a booked appointment 20 hours away with reminders a day before at 18:00,
// When the planner runs, Then one reminder is queued for it with the date and time,
// due no later than the appointment; a cancelled appointment gets none.
func TestIntegrationPlannerAppointmentReminders(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "appointment_reminder", "en", "Appointment {{date}} at {{time}} ({{date_ec}})")
	f.rule(c, "appointment_reminder", -24, "18:00", 0, 0)
	pid := f.patient(c, "Appt", "0911000220")
	appt := f.id(`INSERT INTO appointments (tenant_id, branch_id, patient_id, provider_id, starts_at, ends_at, status)
	              VALUES ($1,$2,$3,$4, now() + interval '20 hours', now() + interval '21 hours', 'booked') RETURNING id`,
		c.TenantID, c.BranchID, pid, c.Owner.ID)
	cancelled := f.id(`INSERT INTO appointments (tenant_id, branch_id, patient_id, provider_id, starts_at, ends_at, status)
	                   VALUES ($1,$2,$3,$4, now() + interval '20 hours', now() + interval '21 hours', 'cancelled') RETURNING id`,
		c.TenantID, c.BranchID, pid, c.Owner.ID)
	// A second clinic with no wording in its language: skipped without a row.
	c2 := f.clinic()
	f.rule(c2, "appointment_reminder", -24, "", 0, 0)
	f.exec(`UPDATE clinics SET sms_lang = 'am' WHERE tenant_id = $1`, c2.TenantID)
	f.template(c2, "appointment_reminder", "en", "x")
	p2 := f.patient(c2, "NoWords", "0911000221")
	f.id(`INSERT INTO appointments (tenant_id, branch_id, patient_id, provider_id, starts_at, ends_at, status)
	      VALUES ($1,$2,$3,$4, now() + interval '20 hours', now() + interval '21 hours', 'booked') RETURNING id`,
		c2.TenantID, c2.BranchID, p2, c2.Owner.ID)

	n, err := NewPlanner(f.db, 0.5, quiet()).PlanAppointments(f.ctx)
	if err != nil || n != 1 {
		t.Fatalf("PlanAppointments: n=%d err=%v", n, err)
	}
	rows := f.rowsFor(c)
	r, ok := rows["appt:"+appt.String()]
	if !ok || r.Status != "scheduled" || strings.Contains(r.Body, "{{") || !strings.Contains(r.Body, " at ") {
		t.Fatalf("appointment reminder: %+v (all %v)", r, rows)
	}
	if _, ok := rows["appt:"+cancelled.String()]; ok {
		t.Fatal("cancelled appointment reminded")
	}
	var beforeAppt bool
	f.scan(`SELECT m.scheduled_for <= a.starts_at FROM messages m JOIN appointments a ON a.id = $1
	         WHERE m.dedupe_key = 'appt:' || $1::text`, []any{appt}, &beforeAppt)
	if !beforeAppt {
		t.Fatal("reminder scheduled after the appointment")
	}
	if len(f.rowsFor(c2)) != 0 {
		t.Fatal("reminder queued with no wording in the clinic's language")
	}
}

// Given pending charges that have sat 10, 20 and 40 days (reminders a week after the
// debt, repeated weekly at most once) and one only 2 days old, When the planner runs,
// Then the first three are reminded with the amount and age — the 10-day one as the
// first reminder, the 20- and 40-day ones as the (capped) repeat — and the 2-day one
// is not yet due.
func TestIntegrationPlannerBillRemindersFromPendingCharges(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "bill_reminder", "en", "You owe {{amount}} ETB ({{days}} days)")
	f.rule(c, "bill_reminder", 168, "", 7, 1)
	charge := func(first string, daysAgo int) uuid.UUID {
		pid := f.patient(c, first, fmt.Sprintf("09110003%02d", daysAgo))
		f.exec(`INSERT INTO charges (tenant_id, patient_id, description, amount, status, created_at)
		        VALUES ($1,$2,'Consultation',300,'pending', now() - ($3 || ' days')::interval)`, c.TenantID, pid, fmt.Sprint(daysAgo))
		return pid
	}
	p10, p20, p40, p2 := charge("Ten", 10), charge("Twenty", 20), charge("Forty", 40), charge("Two", 2)
	if _, err := NewPlanner(f.db, 0.5, quiet()).PlanBills(f.ctx); err != nil {
		t.Fatal(err)
	}
	rows := f.rowsFor(c)
	nth := map[uuid.UUID]string{}
	for k, r := range rows {
		parts := strings.Split(k, ":")
		if len(parts) != 4 || parts[0] != "bill" {
			t.Fatalf("unexpected key %q", k)
		}
		pid := uuid.MustParse(parts[1])
		nth[pid] = parts[3]
		if !strings.Contains(r.Body, "300") || strings.Contains(r.Body, "{{") {
			t.Fatalf("bill body %q", r.Body)
		}
	}
	if nth[p10] != "0" || nth[p20] != "1" || nth[p40] != "1" {
		t.Fatalf("reminder numbers: %v", nth)
	}
	if _, ok := nth[p2]; ok {
		t.Fatal("a 2-day-old debt was chased before its week")
	}
}

// Given a dental patient whose finished visit (400) has gone unpaid 10 days, one
// whose visit was finished 2 days ago, and one who opted out, When the dental bill
// pass runs (reminders a week after the debt), Then the first is chased for 400, the
// second is not yet due, and the opted-out patient is recorded as skipped.
func TestIntegrationPlannerDentalDebtReminders(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "bill_reminder", "en", "{{name}}, you owe {{amount}} ETB ({{days}} days)")
	f.rule(c, "bill_reminder", 168, "10:00", 7, 1)
	owed := func(first, phone string, daysAgo int) uuid.UUID {
		pid := f.patient(c, first, phone)
		s := f.session(c, f.plan(c, pid, "active"), pid, 1, -daysAgo, "done", "visit", 400)
		f.exec(`UPDATE treatment_sessions SET completed_at = now() - ($2 || ' days')::interval WHERE id = $1`, s, fmt.Sprint(daysAgo))
		return pid
	}
	old := owed("Old", "0911000401", 10)
	recent := owed("Recent", "0911000402", 2)
	opted := owed("Opted", "0911000403", 20)
	f.exec(`UPDATE patients SET sms_opt_out = true WHERE id = $1`, opted)
	n, err := NewPlanner(f.db, 0.5, quiet()).PlanDentalBills(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("want 2 rows queued (one chase, one skip), got %d", n)
	}
	got := map[uuid.UUID]msgRow{}
	for k, r := range f.rowsFor(c) {
		got[uuid.MustParse(strings.Split(k, ":")[1])] = r
	}
	if r := got[old]; r.Status != "scheduled" || !strings.Contains(r.Body, "Old, you owe 400") {
		t.Fatalf("old debt: %+v", r)
	}
	if _, ok := got[recent]; ok {
		t.Fatal("a 2-day-old dental debt was chased")
	}
	if r := got[opted]; r.Status != "skipped" || r.Skip != "no_consent" {
		t.Fatalf("opted out: %+v", r)
	}
}

// Given a patient registered at the desk, When the registration event reaches the
// welcome handler, Then — only with both sending and the welcome automation on, and
// wording in the clinic's language — one welcome with her card number is queued,
// exempt from quiet hours, and a redelivered event adds nothing. A legacy import, an
// event without a tenant, an unreadable payload, no patient id and an unknown
// patient queue nothing.
func TestIntegrationWelcomeOnRegistration(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "welcome", "en", "Welcome to {{clinic}}. Card {{card}}.")
	pid := f.patient(c, "New", "0911000501")
	var mrn string
	f.scan(`SELECT mrn FROM patients WHERE id = $1`, []any{pid}, &mrn)
	h := WelcomeOnRegistration(NewPlanner(f.db, 0.5, quiet()))
	ev := func(tenant *uuid.UUID, payload string) events.Event {
		return events.Event{ID: uuid.New(), TenantID: tenant, EventType: "patient.patient.registered",
			Payload: json.RawMessage(payload)}
	}
	good := fmt.Sprintf(`{"patient_id":%q,"mrn":%q}`, pid, mrn)
	count := func() int {
		var n int
		f.scan(`SELECT count(*) FROM messages WHERE tenant_id = $1 AND kind = 'welcome'`, []any{c.TenantID}, &n)
		return n
	}
	tid := c.TenantID
	// Rule off (no row at all), then off explicitly: nothing.
	if err := h(f.ctx, ev(&tid, good)); err != nil || count() != 0 {
		t.Fatalf("rule absent: err=%v n=%d", err, count())
	}
	f.rule(c, "welcome", 0, "", 0, 0)
	for name, e := range map[string]events.Event{
		"legacy import": ev(&tid, fmt.Sprintf(`{"patient_id":%q,"source":"legacy_import"}`, pid)),
		"no tenant":     ev(nil, good),
		"unreadable":    ev(&tid, `not json`),
		"no patient":    ev(&tid, `{}`),
		"unknown":       ev(&tid, fmt.Sprintf(`{"patient_id":%q}`, uuid.New())),
	} {
		if err := h(f.ctx, e); err != nil || count() != 0 {
			t.Fatalf("%s: err=%v n=%d", name, err, count())
		}
	}
	if err := h(f.ctx, ev(&tid, good)); err != nil {
		t.Fatal(err)
	}
	if err := h(f.ctx, ev(&tid, good)); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatalf("want one welcome after a redelivered event, got %d", count())
	}
	var body string
	var bypass bool
	f.scan(`SELECT body, bypass_quiet_hours FROM messages WHERE tenant_id = $1 AND kind = 'welcome'`, []any{c.TenantID}, &body, &bypass)
	if !strings.Contains(body, mrn) || !bypass {
		t.Fatalf("welcome body %q bypass %v", body, bypass)
	}
	// Sending switched off: a new patient is not welcomed.
	f.exec(`UPDATE clinics SET sms_enabled = false WHERE tenant_id = $1`, c.TenantID)
	p2 := f.patient(c, "Off", "0911000502")
	if err := h(f.ctx, ev(&tid, fmt.Sprintf(`{"patient_id":%q}`, p2))); err != nil || count() != 1 {
		t.Fatalf("sending off: err=%v n=%d", err, count())
	}
}

// Given the planner's loop, When it is started with a context that is already
// done, Then it still makes its first pass (a clinic that just switched an
// automation on sees something happen) and returns.
func TestIntegrationPlannerRunMakesAnImmediatePass(t *testing.T) {
	f := newFx(t)
	c := f.clinic()
	f.template(c, "appointment_reminder", "en", "Visit {{date}}")
	f.template(c, "bill_reminder", "en", "Owe {{amount}}")
	f.rule(c, "appointment_reminder", -24, "", 0, 0)
	f.rule(c, "bill_reminder", 0, "", 0, 0)
	pid := f.patient(c, "Run", "0911000601")
	f.session(c, f.plan(c, pid, "active"), pid, 1, 1, "planned", "visit", 0)
	f.exec(`INSERT INTO charges (tenant_id, patient_id, description, amount, status, created_at)
	        VALUES ($1,$2,'x',50,'pending', now() - interval '1 day')`, c.TenantID, pid)
	ctx, cancel := context.WithTimeout(f.ctx, 300*time.Millisecond)
	defer cancel()
	NewPlanner(f.db, 0.5, quiet()).Run(ctx, 100*time.Millisecond)
	if n := len(f.rowsFor(c)); n < 2 {
		t.Fatalf("first pass queued %d rows, want the visit and the bill", n)
	}
	// Errors in a pass are logged and the loop carries on.
	dead, stop := context.WithCancel(f.ctx)
	stop()
	NewPlanner(f.db, 0.5, quiet()).once(dead)
}

// sendMoment: "the day it falls due, at the clinic's clock time", never in the past
// and never in a zone the server cannot load.
func TestIntegrationSendMoment(t *testing.T) {
	due := time.Now().Add(48 * time.Hour)
	if got := sendMoment(due, nil, "Africa/Addis_Ababa"); !got.Equal(due) {
		t.Fatalf("no clock time: %v", got)
	}
	at := time.Date(2000, 1, 1, 18, 0, 0, 0, time.UTC)
	got := sendMoment(due, &at, "Africa/Addis_Ababa")
	loc, _ := time.LoadLocation("Africa/Addis_Ababa")
	if l := got.In(loc); l.Hour() != 18 || l.Minute() != 0 {
		t.Fatalf("18:00 Addis: %v", l)
	}
	if got := sendMoment(due, &at, "Not/AZone"); got.UTC().Hour() != 18 {
		t.Fatalf("unknown zone should fall back to UTC: %v", got)
	}
	past := time.Now().Add(-48 * time.Hour)
	if got := sendMoment(past, &at, "Africa/Addis_Ababa"); time.Since(got) > time.Minute {
		t.Fatalf("a passed hour should mean now: %v", got)
	}
}

// OPS-10 — Given no SMS key (the log gateway), When a message is "sent", Then the
// patient's phone number and the message text do not end up in the server log.
func TestIntegrationLogGatewayDoesNotLogPatientData(t *testing.T) {
	var buf bytes.Buffer
	g := sms.NewLogGateway(slog.New(slog.NewTextHandler(&buf, nil)))
	if _, err := g.Send(context.Background(), sms.Message{MSISDN: "251911223344", Text: "Almaz, you owe 4,500 ETB for your root canal"}); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	testkit.KnownBug(t, "OPS-10", strings.Contains(out, "251911223344") || strings.Contains(out, "root canal"),
		"kernel/sms/sms.go:199 logs the patient's number and the full text: "+out)
}
