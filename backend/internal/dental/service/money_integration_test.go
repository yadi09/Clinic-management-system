package service

// Integration tests for the dental money rules (audit D1–D13). They run against a
// throwaway Postgres given by TEST_DATABASE_URL (a superuser; migrations are
// applied once) and are skipped without it or in -short mode. Each test gets its
// own tenant, so they never see each other's rows.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	billingsvc "github.com/reicb/clinicsaas/internal/billing/service"
	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/storage"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

var migrateOnce sync.Once

const validation = "VALIDATION_FAILED"

type fixture struct {
	t       *testing.T
	db      *kerneldb.DB
	svc     *Service
	tenant  uuid.UUID
	patient uuid.UUID
	dentist uuid.UUID // dental.manage only
	other   uuid.UUID // a second dentist
	owner   uuid.UUID // holds payment.waive
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	if testing.Short() {
		t.Skip("integration test")
	}
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres")
	}
	ctx := context.Background()
	migrateOnce.Do(func() {
		sdb, err := sql.Open("pgx", dsn)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		defer sdb.Close()
		goose.SetBaseFS(migrations.FS)
		if err := goose.SetDialect("postgres"); err != nil {
			t.Fatalf("dialect: %v", err)
		}
		if err := goose.UpContext(ctx, sdb, "."); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	})
	db, err := kerneldb.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Pool.Close)
	pub := events.NewOutboxPublisher()
	f := &fixture{t: t, db: db, svc: NewService(db, pub, billingsvc.NewService(db, pub), storage.NewNoop())}

	slug := "t-" + uuid.NewString()[:8]
	must(t, db.Pool.QueryRow(ctx,
		`INSERT INTO tenants (name, slug, status, plan_id, clinic_type)
		 VALUES ($1, $1, 'active', (SELECT id FROM plans ORDER BY created_at LIMIT 1), 'dental') RETURNING id`,
		slug).Scan(&f.tenant))
	must(t, db.Pool.QueryRow(ctx,
		`INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender, dob)
		 VALUES ($1, 'MRN-1', 'Test', 'Patient', 'female', '1990-01-01') RETURNING id`, f.tenant).Scan(&f.patient))
	for _, u := range []*uuid.UUID{&f.dentist, &f.other, &f.owner} {
		must(t, db.Pool.QueryRow(ctx,
			`INSERT INTO users (tenant_id, email, full_name, status) VALUES ($1, $2, 'Staff', 'active') RETURNING id`,
			f.tenant, uuid.NewString()+"@test").Scan(u))
	}
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// as returns a request context for one of the fixture's users.
func (f *fixture) as(user uuid.UUID) context.Context {
	perms := []string{"dental.manage", "dental.read"}
	if user == f.owner {
		perms = append(perms, "payment.waive", "payment.charge", "payment.collect", "billing.manage")
	}
	return tenancy.WithPrincipal(context.Background(), &tenancy.Principal{
		UserID: user, TenantID: f.tenant, Permissions: perms,
	})
}

// course creates a plan of n visits at fee each, with an optional deposit, and
// returns its sessions (visits in order).
func (f *fixture) course(n int, fee, deposit string) *dental.Plan {
	f.t.Helper()
	total := fmt.Sprint(n * atoi(fee))
	if deposit != "" {
		total = fmt.Sprint(n*atoi(fee) + atoi(deposit))
	}
	p, err := f.svc.CreatePlan(f.as(f.dentist), f.patient, dental.PlanInput{
		Title: "Root canal", TotalAmount: total, StartDate: time.Now().Format("2006-01-02"),
		IntervalUnit: "week", IntervalCount: 1, SessionCount: n, Deposit: deposit,
	})
	must(f.t, err)
	return p
}

func atoi(s string) int { var n int; fmt.Sscan(s, &n); return n }

// record marks a visit done as user — what the record form does.
func (f *fixture) record(user, sid uuid.UUID) {
	f.t.Helper()
	notes := "treated"
	must(f.t, f.svc.UpdateSession(f.as(user), f.patient, sid, dental.SessionUpdate{Status: "done", Notes: &notes}))
}

func (f *fixture) session(sid uuid.UUID) (status string, amount string, completedAt *time.Time) {
	f.t.Helper()
	must(f.t, f.db.Pool.QueryRow(context.Background(),
		`SELECT status, amount_due::text, completed_at FROM treatment_sessions WHERE id = $1`, sid).
		Scan(&status, &amount, &completedAt))
	return
}

// lastEvent returns the payload of the newest event of this type for sid.
func (f *fixture) lastEvent(eventType string, sid uuid.UUID) map[string]any {
	f.t.Helper()
	var raw []byte
	err := f.db.Pool.QueryRow(context.Background(),
		`SELECT payload FROM event_outbox WHERE tenant_id = $1 AND event_type = $2 AND aggregate_id = $3
		 ORDER BY created_at DESC LIMIT 1`, f.tenant, eventType, sid).Scan(&raw)
	if err != nil {
		return nil
	}
	var m map[string]any
	must(f.t, json.Unmarshal(raw, &m))
	return m
}

func code(err error) string {
	if ae, ok := apperr.As(err); ok {
		return ae.Code
	}
	if err != nil {
		return "internal: " + err.Error()
	}
	return ""
}

// --- D1: a given, owed visit cannot be quietly undone, cancelled or discounted ---

func TestD1_RecorderCanUndoOwnVisitSameDayWithReason(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)

	err := f.svc.UpdateSession(f.as(f.dentist), f.patient, v, dental.SessionUpdate{Status: "planned"})
	if err == nil {
		t.Fatal("undoing a given visit with no reason was allowed")
	}
	must(t, f.svc.UpdateSession(f.as(f.dentist), f.patient, v,
		dental.SessionUpdate{Status: "planned", Reason: "recorded the wrong visit"}))

	st, _, done := f.session(v)
	if st != "planned" || done != nil {
		t.Fatalf("after undo: status=%s completed_at=%v, want planned and cleared", st, done)
	}
	ev := f.lastEvent("dental.session.updated", v)
	if ev == nil || ev["reason"] != "recorded the wrong visit" || ev["by"] != f.dentist.String() {
		t.Fatalf("undo event = %v", ev)
	}
	ch, _ := ev["changes"].(map[string]any)
	if s, _ := ch["status"].(map[string]any); s["from"] != "done" || s["to"] != "planned" {
		t.Fatalf("event changes = %v", ch)
	}
}

func TestD1_AnotherDentistCannotUndoAnOwedVisit(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)
	for _, to := range []string{"planned", "cancelled"} {
		err := f.svc.UpdateSession(f.as(f.other), f.patient, v, dental.SessionUpdate{Status: to, Reason: "x"})
		if code(err) != "VISIT_OWED" {
			t.Fatalf("other dentist -> %s: got %q, want VISIT_OWED", to, code(err))
		}
	}
	if st, _, _ := f.session(v); st != "done" {
		t.Fatalf("status changed to %s", st)
	}
}

func TestD1_RecorderCannotUndoAfterTheDay(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)
	_, err := f.db.Pool.Exec(context.Background(),
		`UPDATE treatment_sessions SET completed_at = now() - interval '2 days' WHERE id = $1`, v)
	must(t, err)
	err = f.svc.UpdateSession(f.as(f.dentist), f.patient, v, dental.SessionUpdate{Status: "planned", Reason: "x"})
	if code(err) != "VISIT_OWED" {
		t.Fatalf("got %q, want VISIT_OWED", code(err))
	}
}

func TestD1_WaiveHolderCanUndoWithReason(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)
	must(t, f.svc.UpdateSession(f.as(f.owner), f.patient, v,
		dental.SessionUpdate{Status: "cancelled", Reason: "patient never sat in the chair"}))
	if st, _, _ := f.session(v); st != "cancelled" {
		t.Fatalf("status = %s", st)
	}
}

func TestD1_LoweringAGivenVisitsFeeIsGuarded(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)
	if err := f.svc.UpdateSession(f.as(f.other), f.patient, v, dental.SessionUpdate{AmountDue: "0", Reason: "x"}); code(err) != "VISIT_OWED" {
		t.Fatalf("zeroing by another dentist: got %q", code(err))
	}
	if err := f.svc.UpdateSession(f.as(f.dentist), f.patient, v, dental.SessionUpdate{AmountDue: "1500"}); code(err) != validation {
		t.Fatalf("lowering with no reason: got %q", code(err))
	}
	// Raising a fee forgives nothing, so it is not guarded.
	must(t, f.svc.UpdateSession(f.as(f.other), f.patient, v, dental.SessionUpdate{AmountDue: "2500"}))
	if _, amt, _ := f.session(v); amt != "2500.00" {
		t.Fatalf("amount = %s", amt)
	}
}

func TestD1_PlannedVisitsStayFreeToEdit(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[1].ID
	must(t, f.svc.UpdateSession(f.as(f.other), f.patient, v, dental.SessionUpdate{AmountDue: "1000"}))
	must(t, f.svc.UpdateSession(f.as(f.other), f.patient, v, dental.SessionUpdate{ScheduledDate: "2030-01-01"}))
	must(t, f.svc.UpdateSession(f.as(f.other), f.patient, v, dental.SessionUpdate{Status: "cancelled"}))
}

func TestD1_BilledVisitIsFrozen(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)
	must(t, f.svc.CollectSession(f.as(f.dentist), f.patient, v))
	for name, in := range map[string]dental.SessionUpdate{
		"undo":   {Status: "planned", Reason: "x"},
		"cancel": {Status: "cancelled", Reason: "x"},
		"fee":    {AmountDue: "100", Reason: "x"},
	} {
		// Even the owner: the bill must be dealt with first, at the cashier.
		if err := f.svc.UpdateSession(f.as(f.owner), f.patient, v, in); code(err) != "SESSION_HAS_BILL" {
			t.Fatalf("%s on a billed visit: got %q, want SESSION_HAS_BILL", name, code(err))
		}
	}
	// A prepaid planned visit cannot be cancelled while its bill is live either.
	p := f.course(2, "1000", "")
	must(t, f.svc.CollectSession(f.as(f.dentist), f.patient, p.Sessions[1].ID))
	if err := f.svc.UpdateSession(f.as(f.dentist), f.patient, p.Sessions[1].ID, dental.SessionUpdate{Status: "cancelled"}); code(err) != "SESSION_HAS_BILL" {
		t.Fatalf("cancel prepaid: got %q", code(err))
	}
}

func TestD1_OnlyAPlannedVisitCanBeRedated(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)
	if err := f.svc.UpdateSession(f.as(f.owner), f.patient, v, dental.SessionUpdate{ScheduledDate: "2020-01-01"}); code(err) != validation {
		t.Fatalf("redating a done visit: got %q", code(err))
	}
}

func TestD1_FeeMustBeAPlainNonNegativeNumber(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[1].ID
	for _, bad := range []string{"-500", "1,500", "1500 ETB", "abc", "NaN"} {
		if err := f.svc.UpdateSession(f.as(f.dentist), f.patient, v, dental.SessionUpdate{AmountDue: bad}); code(err) != validation {
			t.Fatalf("fee %q: got %q, want validation", bad, code(err))
		}
	}
	if _, amt, _ := f.session(v); amt != "2000.00" {
		t.Fatalf("amount changed to %s", amt)
	}
}

func TestD1_ResavingNotesKeepsTheCompletionStamp(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)
	_, _, first := f.session(v)
	notes := "treated; review in 2 weeks"
	must(t, f.svc.UpdateSession(f.as(f.other), f.patient, v, dental.SessionUpdate{Status: "done", Notes: &notes}))
	_, _, again := f.session(v)
	if first == nil || again == nil || !first.Equal(*again) {
		t.Fatalf("completed_at moved on a re-save: %v -> %v", first, again)
	}
	ch, _ := f.lastEvent("dental.session.updated", v)["changes"].(map[string]any)
	if n, _ := ch["notes"].(map[string]any); n["from"] != "treated" || n["to"] != notes {
		t.Fatalf("notes change not recorded: %v", ch)
	}
}

// --- D2: two people collecting the same visit at the same moment bill it once ---

// liveDentalCharges counts the patient's pending or paid dental charges.
func (f *fixture) liveDentalCharges() (n int, sum string) {
	f.t.Helper()
	must(f.t, f.db.Pool.QueryRow(context.Background(),
		`SELECT count(*), coalesce(sum(amount),0)::text FROM charges
		  WHERE tenant_id = $1 AND patient_id = $2 AND source = 'dental'
		    AND status IN ('pending','paid') AND deleted_at IS NULL`, f.tenant, f.patient).Scan(&n, &sum))
	return
}

// TestD2_CollectWaitingOnALockSeesTheOtherBill reproduces the race exactly rather
// than hoping two goroutines collide: A locks the visit and bills it, B's collect
// starts and blocks on the lock, then A commits. Before the fix B re-read only the
// session row, kept its stale "no charge" view, and raised a second bill.
func TestD2_CollectWaitingOnALockSeesTheOtherBill(t *testing.T) {
	f := newFixture(t)
	v := f.course(3, "2000", "").Sessions[0].ID
	f.record(f.dentist, v)

	billed, release := make(chan struct{}), make(chan struct{})
	aDone := make(chan error, 1)
	go func() {
		aDone <- f.db.WithTx(f.as(f.owner), func(tx pgx.Tx) error {
			if _, err := f.svc.collectInTx(f.as(f.owner), tx, f.patient, v); err != nil {
				return err
			}
			close(billed)
			<-release
			return nil
		})
	}()
	<-billed
	bDone := make(chan error, 1)
	go func() { _, err := f.svc.collectOne(f.as(f.dentist), f.patient, v); bDone <- err }()
	time.Sleep(500 * time.Millisecond) // B is now waiting on A's row lock
	close(release)
	must(t, <-aDone)
	errB := <-bDone

	if code(errB) != "SESSION_ALREADY_BILLED" {
		t.Fatalf("second collect: got %q, want SESSION_ALREADY_BILLED", code(errB))
	}
	if n, sum := f.liveDentalCharges(); n != 1 || sum != "2000.00" {
		t.Fatalf("live dental charges = %d (%s), want exactly 1 (2000.00)", n, sum)
	}
}

func TestD2_ParallelCollectsBillOnce(t *testing.T) {
	f := newFixture(t)
	p := f.course(4, "1000", "")
	var ids []uuid.UUID
	for _, s := range p.Sessions[:3] {
		f.record(f.dentist, s.ID)
		ids = append(ids, s.ID)
	}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if i%2 == 0 {
				_, _, _ = f.svc.CollectSessions(f.as(f.owner), f.patient, ids)
			} else {
				_, _ = f.svc.collectOne(f.as(f.dentist), f.patient, ids[i%3])
			}
		}(i)
	}
	wg.Wait()
	if n, sum := f.liveDentalCharges(); n != 3 || sum != "3000.00" {
		t.Fatalf("live dental charges = %d (%s), want 3 (3000.00)", n, sum)
	}
}

// --- D9: repricing one visit never re-prices a visit already given ---

func TestD9_RespreadLeavesGivenVisitsAlone(t *testing.T) {
	f := newFixture(t)
	p := f.course(3, "2000", "")
	v1, v2, v3 := p.Sessions[0].ID, p.Sessions[1].ID, p.Sessions[2].ID
	f.record(f.dentist, v3) // visit 3 given early, not billed
	must(t, f.svc.RepriceSession(f.as(f.dentist), f.patient, v1, "1000", "respread", ""))
	if _, a, _ := f.session(v3); a != "2000.00" {
		t.Fatalf("given visit 3 re-priced to %s", a)
	}
	if _, a, _ := f.session(v2); a != "3000.00" {
		t.Fatalf("planned visit 2 = %s, want 3000.00 (absorbed the 1000)", a)
	}
}

func TestD8_DatabaseRefusesNegativeFee(t *testing.T) {
	f := newFixture(t)
	v := f.course(2, "1000", "").Sessions[0].ID
	if _, err := f.db.Pool.Exec(context.Background(),
		`UPDATE treatment_sessions SET amount_due = -1 WHERE id = $1`, v); err == nil {
		t.Fatal("a negative amount_due was stored")
	}
}

func TestD1_RepriceCannotQuietlyDiscountAGivenVisit(t *testing.T) {
	f := newFixture(t)
	p := f.course(3, "2000", "")
	v := p.Sessions[0].ID
	f.record(f.dentist, v)
	if err := f.svc.RepriceSession(f.as(f.other), f.patient, v, "0", "total", "goodwill"); code(err) != "VISIT_OWED" {
		t.Fatalf("other dentist zeroing via reprice: got %q", code(err))
	}
	if err := f.svc.RepriceSession(f.as(f.dentist), f.patient, v, "1500", "total", ""); code(err) != validation {
		t.Fatalf("recorder lowering with no reason: got %q", code(err))
	}
	must(t, f.svc.RepriceSession(f.as(f.dentist), f.patient, v, "1500", "total", "agreed discount"))
	if _, a, _ := f.session(v); a != "1500.00" {
		t.Fatalf("amount = %s", a)
	}
	// Pricing a visit that has not happened yet is not forgiveness.
	must(t, f.svc.RepriceSession(f.as(f.other), f.patient, p.Sessions[2].ID, "500", "total", ""))
}
