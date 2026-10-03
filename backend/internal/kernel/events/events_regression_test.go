package events_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/audit"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/testkit"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type outboxRow struct {
	TenantID, ActorID, BranchID *uuid.UUID
	AggType, EvType             string
	AggID                       uuid.UUID
	Payload                     map[string]any // set when the payload is a JSON object
	Attempts                    int
	Dead                        bool
	LastErr                     *string
	Dispatched                  bool
}

func readRow(t *testing.T, d *kerneldb.DB, aggID uuid.UUID) outboxRow {
	t.Helper()
	var r outboxRow
	var raw []byte
	err := d.Pool.QueryRow(context.Background(),
		`SELECT tenant_id, actor_id, branch_id, aggregate_type, event_type, aggregate_id, payload,
		        attempts, dead_lettered, last_error, dispatched_at IS NOT NULL
		   FROM event_outbox WHERE aggregate_id = $1`, aggID).Scan(
		&r.TenantID, &r.ActorID, &r.BranchID, &r.AggType, &r.EvType, &r.AggID, &raw,
		&r.Attempts, &r.Dead, &r.LastErr, &r.Dispatched)
	if err != nil {
		t.Fatalf("read outbox row: %v", err)
	}
	_ = json.Unmarshal(raw, &r.Payload) // scalar payloads leave it nil
	return r
}

// publish commits one event and returns its aggregate id.
func publish(t *testing.T, d *kerneldb.DB, ctx context.Context, tenant *uuid.UUID, evType string, payload any) uuid.UUID {
	t.Helper()
	agg := uuid.New()
	if err := d.WithTx(ctx, func(tx pgx.Tx) error {
		return events.NewOutboxPublisher().Publish(ctx, tx, tenant, "thing", agg, evType, payload)
	}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return agg
}

func ptr(u uuid.UUID) *uuid.UUID { return &u }

// Given a signed-in principal with an active branch, When an event is published, Then the outbox row carries tenant, actor, branch, aggregate, type and payload, pending.
func TestREG_KERNEL_EVENTS_001_PublishRecordsActorBranchTenant(t *testing.T) {
	d := outboxDB(t)
	tenant, user, branch := uuid.New(), uuid.New(), uuid.New()
	ctx := tenancy.WithPrincipal(context.Background(), &tenancy.Principal{UserID: user, TenantID: tenant, ActiveBranchID: &branch})
	agg := publish(t, d, ctx, &tenant, "patient.patient.created", map[string]any{"mrn": "A-1", "n": 2})

	r := readRow(t, d, agg)
	if r.TenantID == nil || *r.TenantID != tenant {
		t.Fatalf("tenant_id = %v, want %v", r.TenantID, tenant)
	}
	if r.ActorID == nil || *r.ActorID != user {
		t.Fatalf("actor_id = %v, want %v", r.ActorID, user)
	}
	if r.BranchID == nil || *r.BranchID != branch {
		t.Fatalf("branch_id = %v, want %v", r.BranchID, branch)
	}
	if r.AggType != "thing" || r.EvType != "patient.patient.created" || r.AggID != agg {
		t.Fatalf("row = %+v", r)
	}
	if r.Payload["mrn"] != "A-1" || r.Payload["n"] != float64(2) {
		t.Fatalf("payload = %v", r.Payload)
	}
	if r.Dispatched || r.Attempts != 0 || r.Dead {
		t.Fatalf("a fresh event must be pending: %+v", r)
	}
}

// Given no principal, a principal with a nil user, or one with no active branch, When published, Then actor/branch are NULL as appropriate and a nil tenant is stored as NULL (system event).
func TestREG_KERNEL_EVENTS_002_PublishWithoutActor(t *testing.T) {
	d := outboxDB(t)
	tenant := uuid.New()

	sys := publish(t, d, context.Background(), nil, "system.tick", struct{}{})
	r := readRow(t, d, sys)
	if r.TenantID != nil || r.ActorID != nil || r.BranchID != nil {
		t.Fatalf("system event: tenant/actor/branch = %v/%v/%v, want all NULL", r.TenantID, r.ActorID, r.BranchID)
	}

	nilUser := tenancy.WithPrincipal(context.Background(), &tenancy.Principal{UserID: uuid.Nil, ActiveBranchID: ptr(uuid.New())})
	r = readRow(t, d, publish(t, d, nilUser, &tenant, "x.y.z", 1))
	if r.ActorID != nil || r.BranchID != nil {
		t.Fatalf("nil-user principal: actor/branch = %v/%v, want NULL", r.ActorID, r.BranchID)
	}

	user := uuid.New()
	allBranches := tenancy.WithPrincipal(context.Background(), &tenancy.Principal{UserID: user})
	r = readRow(t, d, publish(t, d, allBranches, &tenant, "x.y.z", 1))
	if r.ActorID == nil || *r.ActorID != user || r.BranchID != nil {
		t.Fatalf("all-branches principal: actor/branch = %v/%v, want %v/NULL", r.ActorID, r.BranchID, user)
	}
}

// Given an unmarshalable payload, When published, Then Publish errors and writes nothing; Given the surrounding tx rolls back, Then the event is gone too.
func TestREG_KERNEL_EVENTS_003_PublishIsAtomicWithTheTransaction(t *testing.T) {
	d := outboxDB(t)
	ctx := context.Background()
	agg := uuid.New()
	err := d.WithTx(ctx, func(tx pgx.Tx) error {
		return events.NewOutboxPublisher().Publish(ctx, tx, nil, "thing", agg, "bad", make(chan int))
	})
	if err == nil {
		t.Fatal("publishing an unmarshalable payload succeeded")
	}
	agg2 := uuid.New()
	_ = d.WithTx(ctx, func(tx pgx.Tx) error {
		if err := events.NewOutboxPublisher().Publish(ctx, tx, nil, "thing", agg2, "ok", 1); err != nil {
			t.Fatalf("publish: %v", err)
		}
		return errors.New("state change failed")
	})
	var n int
	if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM event_outbox WHERE aggregate_id IN ($1, $2)`, agg, agg2).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d outbox rows survived a failed publish / rolled-back tx", n)
	}
}

// Given pending events, When RunOnce runs, Then wildcard then exact handlers receive the full event in publish order, rows are marked dispatched, and the count is returned.
func TestREG_KERNEL_EVENTS_004_RelayDispatchesAndMarksProcessed(t *testing.T) {
	d := outboxDB(t)
	tenant, user, branch := uuid.New(), uuid.New(), uuid.New()
	ctx := tenancy.WithPrincipal(context.Background(), &tenancy.Principal{UserID: user, ActiveBranchID: &branch})
	a1 := publish(t, d, ctx, &tenant, "mod.agg.created", map[string]string{"k": "v1"})
	a2 := publish(t, d, ctx, &tenant, "mod.agg.updated", map[string]string{"k": "v2"})
	a3 := publish(t, d, ctx, &tenant, "mod.agg.created", map[string]string{"k": "v3"})

	var log []string
	var got []events.Event
	reg := events.NewRegistry()
	reg.On("mod.agg.created", func(_ context.Context, e events.Event) error {
		log = append(log, "created:"+e.AggregateID.String())
		return nil
	})
	reg.On("mod.agg.created", func(_ context.Context, e events.Event) error {
		log = append(log, "created2:"+e.AggregateID.String())
		return nil
	})
	reg.OnAny(func(_ context.Context, e events.Event) error {
		log = append(log, "any:"+e.AggregateID.String())
		got = append(got, e)
		return nil
	})
	n, err := events.NewRelay(d, reg, quiet()).RunOnce(context.Background())
	if err != nil || n != 3 {
		t.Fatalf("RunOnce = %d, %v; want 3, nil", n, err)
	}
	want := []string{
		"any:" + a1.String(), "created:" + a1.String(), "created2:" + a1.String(),
		"any:" + a2.String(),
		"any:" + a3.String(), "created:" + a3.String(), "created2:" + a3.String(),
	}
	if strings.Join(log, ",") != strings.Join(want, ",") {
		t.Fatalf("dispatch order\n got %v\nwant %v", log, want)
	}
	e := got[0]
	if e.TenantID == nil || *e.TenantID != tenant || e.ActorID == nil || *e.ActorID != user ||
		e.BranchID == nil || *e.BranchID != branch || e.AggregateType != "thing" || e.EventType != "mod.agg.created" ||
		e.ID == uuid.Nil || string(e.Payload) != `{"k": "v1"}` {
		t.Fatalf("dispatched event lost fields: %+v payload=%s", e, e.Payload)
	}
	for _, a := range []uuid.UUID{a1, a2, a3} {
		if r := readRow(t, d, a); !r.Dispatched || r.Attempts != 0 {
			t.Fatalf("event %v not marked dispatched: %+v", a, r)
		}
	}
}

// Given events already dispatched, When the relay runs again, Then nothing is re-delivered.
func TestREG_KERNEL_EVENTS_005_DispatchedEventsAreNotRedelivered(t *testing.T) {
	d := outboxDB(t)
	tenant := uuid.New()
	publish(t, d, context.Background(), &tenant, "a.b.c", 1)
	calls := 0
	reg := events.NewRegistry()
	reg.OnAny(func(context.Context, events.Event) error { calls++; return nil })
	r := events.NewRelay(d, reg, quiet())
	for i := 0; i < 3; i++ {
		if _, err := r.RunOnce(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("handler called %d times across three relay passes, want exactly 1", calls)
	}
	if n, _ := r.RunOnce(context.Background()); n != 0 {
		t.Fatalf("empty outbox: RunOnce = %d, want 0", n)
	}
}

// Given an event with no subscribed handler (or only handlers for other types), When relayed, Then it is marked dispatched and unrelated handlers are not called.
func TestREG_KERNEL_EVENTS_006_UnhandledEventIsStillConsumed(t *testing.T) {
	d := outboxDB(t)
	agg := publish(t, d, context.Background(), nil, "nobody.listens.here", 1)
	other := 0
	reg := events.NewRegistry()
	reg.On("some.other.type", func(context.Context, events.Event) error { other++; return nil })
	if n, err := events.NewRelay(d, reg, quiet()).RunOnce(context.Background()); err != nil || n != 1 {
		t.Fatalf("RunOnce = %d, %v", n, err)
	}
	if other != 0 {
		t.Fatal("a handler for a different event type was invoked")
	}
	if !readRow(t, d, agg).Dispatched {
		t.Fatal("unhandled event left pending")
	}
}

// Given a handler that fails once then succeeds, When relayed, Then the failure is recorded (attempts, last_error) and the retry delivers and marks it dispatched.
func TestREG_KERNEL_EVENTS_007_HandlerErrorIsRetried(t *testing.T) {
	d := outboxDB(t)
	agg := publish(t, d, context.Background(), nil, "flaky.thing.happened", 1)
	calls := 0
	reg := events.NewRegistry()
	reg.On("flaky.thing.happened", func(context.Context, events.Event) error {
		calls++
		if calls == 1 {
			return errors.New("transient: db busy")
		}
		return nil
	})
	n, err := events.NewRelay(d, reg, quiet()).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	r := readRow(t, d, agg)
	if calls != 2 || n != 2 {
		t.Fatalf("calls=%d processed=%d, want 2/2 (fail then retry)", calls, n)
	}
	if !r.Dispatched || r.Attempts != 1 || r.Dead || r.LastErr == nil || *r.LastErr != "transient: db busy" {
		t.Fatalf("row after retry = %+v (last_error %v)", r, r.LastErr)
	}
}

// Given a handler that always fails, When relayed, Then after 5 attempts the event is dead-lettered with the last error, never dispatched, and never handed out again.
func TestREG_KERNEL_EVENTS_008_PoisonEventIsDeadLettered(t *testing.T) {
	d := outboxDB(t)
	poison := publish(t, d, context.Background(), nil, "poison.event.x", 1)
	good := publish(t, d, context.Background(), nil, "good.event.x", 1)
	calls, goodCalls := 0, 0
	reg := events.NewRegistry()
	reg.On("poison.event.x", func(context.Context, events.Event) error {
		calls++
		return fmt.Errorf("attempt %d failed", calls)
	})
	reg.On("good.event.x", func(context.Context, events.Event) error { goodCalls++; return nil })
	rl := events.NewRelay(d, reg, quiet())
	if _, err := rl.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := readRow(t, d, poison)
	if !r.Dead || r.Attempts != 5 || r.Dispatched || r.LastErr == nil || *r.LastErr != "attempt 5 failed" {
		t.Fatalf("poison row = %+v last_error=%v; want dead-lettered after 5 attempts", r, r.LastErr)
	}
	if calls != 5 {
		t.Fatalf("poison handler called %d times, want 5", calls)
	}
	if goodCalls != 1 || !readRow(t, d, good).Dispatched {
		t.Fatal("a poison message blocked the event behind it")
	}
	if _, err := rl.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 5 {
		t.Fatal("a dead-lettered event was re-delivered")
	}
}

// Given several handlers for one event where a later one fails, When relayed, Then handlers after the failing one are not run for that attempt and the event stays pending.
func TestREG_KERNEL_EVENTS_009_FirstHandlerErrorStopsTheChain(t *testing.T) {
	d := outboxDB(t)
	agg := publish(t, d, context.Background(), nil, "chain.x.y", 1)
	var order []string
	reg := events.NewRegistry()
	reg.OnAny(func(context.Context, events.Event) error { order = append(order, "any"); return nil })
	reg.On("chain.x.y", func(context.Context, events.Event) error { order = append(order, "fail"); return errors.New("no") })
	reg.On("chain.x.y", func(context.Context, events.Event) error { order = append(order, "after"); return nil })
	rl := events.NewRelay(d, reg, quiet())
	if _, err := rl.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, s := range order {
		if s == "after" {
			t.Fatalf("handler after a failing one ran: %v", order)
		}
	}
	if len(order) != 10 { // 5 attempts × (any, fail)
		t.Fatalf("order = %v, want 5 × [any fail]", order)
	}
	if r := readRow(t, d, agg); r.Dispatched || !r.Dead {
		t.Fatalf("row = %+v, want dead-lettered and not dispatched", r)
	}
}

// Given more pending events than one batch (100), When RunOnce runs, Then it processes exactly 100 and leaves the rest for the next pass.
func TestREG_KERNEL_EVENTS_010_RunOnceIsBoundedByBatchSize(t *testing.T) {
	d := outboxDB(t)
	ctx := context.Background()
	if _, err := d.Pool.Exec(ctx,
		`INSERT INTO event_outbox (aggregate_type, aggregate_id, event_type, payload)
		 SELECT 'thing', gen_random_uuid(), 'bulk.e.v', '{}'::jsonb FROM generate_series(1, 101)`); err != nil {
		t.Fatal(err)
	}
	calls := 0
	reg := events.NewRegistry()
	reg.OnAny(func(context.Context, events.Event) error { calls++; return nil })
	rl := events.NewRelay(d, reg, quiet())
	if n, err := rl.RunOnce(ctx); err != nil || n != 100 {
		t.Fatalf("first pass = %d, %v; want 100", n, err)
	}
	if n, err := rl.RunOnce(ctx); err != nil || n != 1 {
		t.Fatalf("second pass = %d, %v; want 1", n, err)
	}
	if calls != 101 {
		t.Fatalf("handler calls = %d, want 101", calls)
	}
}

// Given an event row locked by another worker's transaction, When this relay runs, Then it skips the row (SKIP LOCKED) and delivers it only once the lock is released.
func TestREG_KERNEL_EVENTS_011_LockedEventIsSkippedByConcurrentWorker(t *testing.T) {
	d := outboxDB(t)
	ctx := context.Background()
	agg := publish(t, d, ctx, nil, "locked.e.v", 1)
	calls := 0
	reg := events.NewRegistry()
	reg.OnAny(func(context.Context, events.Event) error { calls++; return nil })
	rl := events.NewRelay(d, reg, quiet())

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT 1 FROM event_outbox WHERE aggregate_id = $1 FOR UPDATE`, agg); err != nil {
		t.Fatal(err)
	}
	if n, err := rl.RunOnce(ctx); err != nil || n != 0 || calls != 0 {
		t.Fatalf("while locked: n=%d err=%v calls=%d; want nothing processed", n, err, calls)
	}
	_ = tx.Rollback(ctx)
	if n, err := rl.RunOnce(ctx); err != nil || n != 1 || calls != 1 {
		t.Fatalf("after unlock: n=%d err=%v calls=%d; want 1 delivery", n, err, calls)
	}
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// Given a running relay loop, When an event is published, Then it is delivered on a tick; When the context is cancelled, Then Run returns.
func TestREG_KERNEL_EVENTS_012_RunPollsUntilCancelled(t *testing.T) {
	d := outboxDB(t)
	delivered := make(chan uuid.UUID, 1)
	reg := events.NewRegistry()
	reg.OnAny(func(_ context.Context, e events.Event) error { delivered <- e.AggregateID; return nil })
	var buf syncBuf
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { events.NewRelay(d, reg, log).Run(ctx, 20*time.Millisecond); close(done) }()

	agg := publish(t, d, context.Background(), nil, "loop.e.v", 1)
	select {
	case got := <-delivered:
		if got != agg {
			t.Fatalf("delivered %v, want %v", got, agg)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay loop never delivered the event")
	}
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(buf.String(), "outbox relay dispatched") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	if !strings.Contains(buf.String(), "outbox relay dispatched") {
		t.Fatalf("expected a dispatch log line, got %q", buf.String())
	}
}

// Given the database is unreachable, When RunOnce / the Run loop executes, Then the error is returned / logged rather than swallowed or crashing.
func TestREG_KERNEL_EVENTS_013_RelayReportsDatabaseErrors(t *testing.T) {
	dsn := siblingDSN(t)
	d, err := kerneldb.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	reg := events.NewRegistry()
	rl := events.NewRelay(d, reg, quiet())
	if n, err := rl.RunOnce(context.Background()); err == nil || n != 0 {
		t.Fatalf("RunOnce on a closed pool = %d, %v; want 0 and an error", n, err)
	}
	var buf syncBuf
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		events.NewRelay(d, reg, slog.New(slog.NewTextHandler(&buf, nil))).Run(ctx, 10*time.Millisecond)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(buf.String(), "outbox relay error") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if !strings.Contains(buf.String(), "outbox relay error") {
		t.Fatalf("relay loop did not log the database error: %q", buf.String())
	}
}

// Given a signed-in user's event, When relayed to the audit consumer, Then audit_logs gets one entry naming that actor and branch (outbox → audit end to end).
func TestREG_KERNEL_EVENTS_014_RelayToAuditCarriesActorAndBranch(t *testing.T) {
	d := outboxDB(t)
	c := testkit.NewClinic(t, d, testkit.ClinicOpts{})
	doctor := c.Staff["doctor"]
	ctx := tenancy.WithPrincipal(context.Background(), &tenancy.Principal{UserID: doctor.ID, TenantID: c.TenantID, ActiveBranchID: &c.BranchID})
	tenant := c.TenantID
	agg := publish(t, d, ctx, &tenant, "clinical.encounter.signed", map[string]string{"by": "doctor"})

	reg := events.NewRegistry()
	reg.OnAny(audit.NewWriter(d).EventHandler())
	if _, err := events.NewRelay(d, reg, quiet()).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	var actor, branch *uuid.UUID
	var action, ttype string
	var n int
	err := d.Pool.QueryRow(context.Background(),
		`SELECT count(*) OVER (), actor_id, branch_id, action, target_type FROM audit_logs WHERE tenant_id = $1 AND target_id = $2`,
		c.TenantID, agg).Scan(&n, &actor, &branch, &action, &ttype)
	if err != nil {
		t.Fatalf("audit row: %v", err)
	}
	if n != 1 || actor == nil || *actor != doctor.ID || branch == nil || *branch != c.BranchID ||
		action != "clinical.encounter.signed" || ttype != "thing" {
		t.Fatalf("audit = n:%d actor:%v branch:%v action:%s type:%s", n, actor, branch, action, ttype)
	}
}
