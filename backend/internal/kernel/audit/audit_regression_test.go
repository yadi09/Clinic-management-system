package audit_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/audit"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/testkit"
)

type logRow struct {
	ActorID, BranchID, TargetID *uuid.UUID
	Action, TargetType          string
	Payload                     *string
	IP                          *string
}

func setup(t *testing.T) (*kerneldb.DB, *testkit.Clinic) {
	t.Helper()
	dsn := testkit.RequireDB(t)
	d := testkit.SuperDB(t, dsn)
	return d, testkit.NewClinic(t, d, testkit.ClinicOpts{})
}

func rowsFor(t *testing.T, d *kerneldb.DB, tenant, target uuid.UUID) []logRow {
	t.Helper()
	rows, err := d.Pool.Query(context.Background(),
		`SELECT actor_id, branch_id, target_id, action, target_type, payload::text, ip
		   FROM audit_logs WHERE tenant_id = $1 AND target_id = $2 ORDER BY created_at`, tenant, target)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []logRow
	for rows.Next() {
		var r logRow
		if err := rows.Scan(&r.ActorID, &r.BranchID, &r.TargetID, &r.Action, &r.TargetType, &r.Payload, &r.IP); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func jsonEq(t *testing.T, got *string, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("payload is NULL, want %s", want)
	}
	var a, b any
	if err := json.Unmarshal([]byte(*got), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatal(err)
	}
	ab, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	if string(ab) != string(bb) {
		t.Fatalf("payload = %s, want %s", ab, bb)
	}
}

// Given a full entry, When Write is called, Then one audit_logs row holds every field (actor, branch, action, target, JSON payload, ip).
func TestREG_KERNEL_AUDIT_001_WritePersistsEveryField(t *testing.T) {
	d, c := setup(t)
	target := uuid.New()
	actor := c.Staff["cashier"].ID
	if err := audit.NewWriter(d).Write(context.Background(), audit.Entry{
		TenantID: c.TenantID, ActorID: &actor, BranchID: &c.BranchID, Action: "billing.charge.voided",
		TargetType: "charge", TargetID: &target, Payload: map[string]any{"reason": "dup", "amount": 150}, IP: "10.0.0.7",
	}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	rs := rowsFor(t, d, c.TenantID, target)
	if len(rs) != 1 {
		t.Fatalf("%d rows, want 1", len(rs))
	}
	r := rs[0]
	if r.ActorID == nil || *r.ActorID != actor || r.BranchID == nil || *r.BranchID != c.BranchID ||
		r.Action != "billing.charge.voided" || r.TargetType != "charge" || r.IP == nil || *r.IP != "10.0.0.7" {
		t.Fatalf("row = %+v", r)
	}
	jsonEq(t, r.Payload, `{"reason":"dup","amount":150}`)
}

// Given an entry with no actor, branch, payload or IP (a system action), When written, Then those columns are NULL rather than empty values.
func TestREG_KERNEL_AUDIT_002_OptionalFieldsStoredAsNull(t *testing.T) {
	d, c := setup(t)
	target := uuid.New()
	if err := audit.NewWriter(d).Write(context.Background(), audit.Entry{
		TenantID: c.TenantID, Action: "system.retention.purged", TargetType: "tenant", TargetID: &target,
	}); err != nil {
		t.Fatal(err)
	}
	rs := rowsFor(t, d, c.TenantID, target)
	if len(rs) != 1 || rs[0].ActorID != nil || rs[0].BranchID != nil || rs[0].Payload != nil || rs[0].IP != nil {
		t.Fatalf("rows = %+v, want one row with NULL actor/branch/payload/ip", rs)
	}
}

// Given an unmarshalable payload or an unknown tenant, When Write is called, Then it returns an error and writes nothing.
func TestREG_KERNEL_AUDIT_003_WriteRejectsBadInput(t *testing.T) {
	d, c := setup(t)
	w := audit.NewWriter(d)
	target := uuid.New()
	if err := w.Write(context.Background(), audit.Entry{
		TenantID: c.TenantID, Action: "x", TargetType: "y", TargetID: &target, Payload: func() {},
	}); err == nil {
		t.Fatal("unmarshalable payload accepted")
	}
	ghost := uuid.New()
	if err := w.Write(context.Background(), audit.Entry{TenantID: ghost, Action: "x", TargetType: "y", TargetID: &target}); err == nil {
		t.Fatal("audit entry for a non-existent tenant accepted")
	}
	if rs := rowsFor(t, d, c.TenantID, target); len(rs) != 0 {
		t.Fatalf("%d rows written by rejected entries", len(rs))
	}
}

// Given a dispatched tenant event with actor and branch, When the audit EventHandler runs, Then audit_logs records actor_id, branch_id, action = event type, target = aggregate, payload = event payload.
func TestREG_KERNEL_AUDIT_004_EventHandlerRecordsActorBranchEntity(t *testing.T) {
	d, c := setup(t)
	agg := uuid.New()
	actor := c.Staff["doctor"].ID
	tenant := c.TenantID
	e := events.Event{
		ID: uuid.New(), TenantID: &tenant, AggregateType: "encounter", AggregateID: agg,
		EventType: "clinical.encounter.signed", Payload: json.RawMessage(`{"dx":"K02.1"}`),
		ActorID: &actor, BranchID: &c.BranchID,
	}
	if err := audit.NewWriter(d).EventHandler()(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	rs := rowsFor(t, d, c.TenantID, agg)
	if len(rs) != 1 {
		t.Fatalf("%d rows, want 1", len(rs))
	}
	r := rs[0]
	if r.ActorID == nil || *r.ActorID != actor || r.BranchID == nil || *r.BranchID != c.BranchID ||
		r.Action != "clinical.encounter.signed" || r.TargetType != "encounter" || r.TargetID == nil || *r.TargetID != agg {
		t.Fatalf("row = %+v", r)
	}
	jsonEq(t, r.Payload, `{"dx":"K02.1"}`)
}

// Given a system event without a tenant, When the audit EventHandler runs, Then it succeeds without writing (system events are not tenant-audited); a tenant event with no actor is audited with a NULL actor.
func TestREG_KERNEL_AUDIT_005_EventHandlerSystemAndActorlessEvents(t *testing.T) {
	d, c := setup(t)
	h := audit.NewWriter(d).EventHandler()
	agg := uuid.New()
	if err := h(context.Background(), events.Event{AggregateType: "x", AggregateID: agg, EventType: "system.x", Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("system event: %v", err)
	}
	var n int
	if err := d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs WHERE target_id = $1`, agg).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("system event produced %d audit rows", n)
	}
	tenant := c.TenantID
	if err := h(context.Background(), events.Event{TenantID: &tenant, AggregateType: "x", AggregateID: agg, EventType: "worker.x", Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	rs := rowsFor(t, d, c.TenantID, agg)
	if len(rs) != 1 || rs[0].ActorID != nil || rs[0].BranchID != nil {
		t.Fatalf("actorless tenant event rows = %+v", rs)
	}
}

// Given the same outbox event delivered twice (the relay is at-least-once and retries every handler after any one fails), When the audit EventHandler handles both, Then there is still exactly one audit entry.
func TestREG_KERNEL_AUDIT_006_EventHandlerIsIdempotent(t *testing.T) {
	d, c := setup(t)
	h := audit.NewWriter(d).EventHandler()
	tenant := c.TenantID
	e := events.Event{ID: uuid.New(), TenantID: &tenant, AggregateType: "patient", AggregateID: uuid.New(),
		EventType: "patient.patient.updated", Payload: json.RawMessage(`{}`)}
	for i := 0; i < 2; i++ {
		if err := h(context.Background(), e); err != nil {
			t.Fatal(err)
		}
	}
	rs := rowsFor(t, d, c.TenantID, e.AggregateID)
	if len(rs) == 0 {
		t.Fatal("no audit entry written")
	}
	if len(rs) > 1 {
		testkit.KnownBug(t, "NEW-KERNEL-AUDIT-1", true,
			"audit EventHandler is not idempotent: a redelivered outbox event (same event ID) writes a second audit_logs row; "+
				"events.Handler requires idempotency and the relay re-runs every handler when a later one fails")
	}
}
