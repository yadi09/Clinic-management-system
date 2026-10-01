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
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	"github.com/reicb/clinicsaas/internal/billing"
	billingsvc "github.com/reicb/clinicsaas/internal/billing/service"
	"github.com/reicb/clinicsaas/internal/dental"
	financesvc "github.com/reicb/clinicsaas/internal/finance/service"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/audit"
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

// --- D3: finishing a course never forgives an unpaid down payment ---

func TestD3_FinishCourseKeepsTheDepositOwed(t *testing.T) {
	f := newFixture(t)
	p := f.course(3, "2000", "500")
	if p.Deposit == nil {
		t.Fatal("course has no deposit row")
	}
	f.record(f.dentist, p.Sessions[0].ID)
	must(t, f.svc.SetPayLater(f.as(f.dentist), f.patient, p.Sessions[2].ID, true, "next month"))

	n, err := f.svc.FinishCourse(f.as(f.dentist), f.patient, p.ID)
	must(t, err)
	if n != 2 { // visits 2 and 3 (the promised one included)
		t.Fatalf("cancelled %d visits, want 2", n)
	}
	if st, amt, _ := f.session(p.Deposit.ID); st != "planned" || amt != "500.00" {
		t.Fatalf("deposit after finish: %s %s, want planned 500.00", st, amt)
	}
	// And it is still billable — owed, not silently gone.
	must(t, f.svc.CollectSession(f.as(f.owner), f.patient, p.Deposit.ID))
	if st, _, _ := f.session(p.Sessions[0].ID); st != "done" {
		t.Fatalf("given visit 1 became %s", st)
	}
}

// --- D4: the day close holds the counted drawer against cash only ---

func TestD4_DayCloseExpectsCashNetOfCashRefunds(t *testing.T) {
	f := newFixture(t)
	b := billingsvc.NewService(f.db, events.NewOutboxPublisher())
	p := f.course(3, "1000", "")
	var charges []uuid.UUID
	for _, s := range p.Sessions {
		f.record(f.dentist, s.ID)
		must(t, f.svc.CollectSession(f.as(f.owner), f.patient, s.ID))
		var cid uuid.UUID
		must(t, f.db.Pool.QueryRow(context.Background(),
			`SELECT charge_id FROM treatment_sessions WHERE id = $1`, s.ID).Scan(&cid))
		charges = append(charges, cid)
	}
	cashier := f.as(f.owner)
	must(t, b.SettleCharge(cashier, charges[0], billing.SettleInput{Method: "cash"}))
	must(t, b.SettleCharge(cashier, charges[1], billing.SettleInput{Method: "cash"}))
	must(t, b.SettleCharge(cashier, charges[2], billing.SettleInput{Method: "telebirr"}))
	must(t, b.RefundCharge(cashier, charges[1], "patient changed their mind"))

	day, err := b.ExpectedForDay(cashier, time.Now().UTC().Format("2006-01-02"))
	must(t, err)
	// 2,000 cash in − 1,000 cash refunded = 1,000 in the drawer; Telebirr never was.
	if day.ExpectedTotal != "1000.00" || day.NonCashTotal != "1000.00" {
		t.Fatalf("expected cash %s, non-cash %s; want 1000.00 and 1000.00 (lines %+v)",
			day.ExpectedTotal, day.NonCashTotal, day.ByMethod)
	}
	rec, err := b.CloseDay(cashier, billing.CloseDayInput{BusinessDate: day.BusinessDate, Counted: "1000"})
	must(t, err)
	if rec.Variance != "0.00" {
		t.Fatalf("an exact drawer closed with variance %s", rec.Variance)
	}
}

// --- D8: collect refuses what nobody should be billed for ---

func TestD8_CollectRefusesCancelledVisitsAndEmptyBulk(t *testing.T) {
	f := newFixture(t)
	p := f.course(3, "1000", "")
	v := p.Sessions[1].ID
	must(t, f.svc.UpdateSession(f.as(f.dentist), f.patient, v, dental.SessionUpdate{Status: "cancelled"}))
	if err := f.svc.CollectSession(f.as(f.owner), f.patient, v); code(err) != "SESSION_CANCELLED" {
		t.Fatalf("collect cancelled visit: got %q", code(err))
	}
	if _, _, err := f.svc.CollectSessions(f.as(f.owner), f.patient, nil); code(err) != validation {
		t.Fatalf("bulk with no ids: got %q, want validation", code(err))
	}
	if n, _ := f.liveDentalCharges(); n != 0 {
		t.Fatalf("%d charges raised", n)
	}
}

func TestD8_CreatePlanRefusesUnreadableMoney(t *testing.T) {
	f := newFixture(t)
	for _, in := range []dental.PlanInput{
		{TotalAmount: "12,000", SessionCount: 3},
		{TotalAmount: "12000", Deposit: "2000 ETB", SessionCount: 3},
		{TotalAmount: "-5", SessionCount: 3},
		{TotalAmount: "3000", Sessions: []dental.SessionSeed{{ScheduledDate: "2030-01-01", AmountDue: "-1000"}}},
	} {
		in.Title, in.StartDate, in.IntervalUnit, in.IntervalCount = "X", "2030-01-01", "week", 1
		if _, err := f.svc.CreatePlan(f.as(f.dentist), f.patient, in); code(err) != validation {
			t.Fatalf("plan %+v: got %q, want validation", in, code(err))
		}
	}
}

// --- D5: every audit entry says who did it ---

func TestD5_AuditEntryNamesTheActor(t *testing.T) {
	f := newFixture(t)
	v := f.course(2, "1000", "").Sessions[0].ID
	f.record(f.dentist, v) // publishes dental.session.updated as the dentist

	reg := events.NewRegistry()
	reg.OnAny(audit.NewWriter(f.db).EventHandler())
	relay := events.NewRelay(f.db, reg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for i := 0; i < 50; i++ { // drain everything pending, other tests' events included
		n, err := relay.RunOnce(context.Background())
		must(t, err)
		if n == 0 {
			break
		}
	}
	var actor *uuid.UUID
	must(t, f.db.Pool.QueryRow(context.Background(),
		`SELECT actor_id FROM audit_logs
		  WHERE tenant_id = $1 AND action = 'dental.session.updated' AND target_id = $2
		  ORDER BY created_at DESC LIMIT 1`, f.tenant, v).Scan(&actor))
	if actor == nil || *actor != f.dentist {
		t.Fatalf("audit actor = %v, want the dentist %v", actor, f.dentist)
	}
}

// --- D13c: pulling a bill back off the cashier's queue is a recorded decision ---

func TestD13_PullBackNeedsAReasonAndKeepsIt(t *testing.T) {
	f := newFixture(t)
	v := f.course(2, "1000", "").Sessions[0].ID
	f.record(f.dentist, v)
	must(t, f.svc.CollectSession(f.as(f.dentist), f.patient, v))
	if err := f.svc.UncollectSession(f.as(f.dentist), f.patient, v, "  "); code(err) != validation {
		t.Fatalf("no reason: got %q", code(err))
	}
	var cid uuid.UUID
	must(t, f.db.Pool.QueryRow(context.Background(), `SELECT charge_id FROM treatment_sessions WHERE id = $1`, v).Scan(&cid))
	must(t, f.svc.UncollectSession(f.as(f.dentist), f.patient, v, "sent the wrong visit"))
	var why string
	must(t, f.db.Pool.QueryRow(context.Background(), `SELECT void_reason FROM charges WHERE id = $1`, cid).Scan(&why))
	if why != "pulled back from the cashier: sent the wrong visit" {
		t.Fatalf("void_reason = %q", why)
	}
}

// --- D11: a course can be cancelled safely, and not by the back doors ---

func TestD11_CancelAMistakenCourse(t *testing.T) {
	f := newFixture(t)
	p := f.course(3, "2000", "500")
	if _, err := f.svc.CancelPlan(f.as(f.dentist), f.patient, p.ID, ""); code(err) != validation {
		t.Fatalf("no reason: got %q", code(err))
	}
	n, err := f.svc.CancelPlan(f.as(f.dentist), f.patient, p.ID, "created on the wrong patient")
	must(t, err)
	if n != 4 { // three visits and the unpaid down payment
		t.Fatalf("cancelled %d rows, want 4", n)
	}
	if st, _, _ := f.session(p.Deposit.ID); st != "cancelled" {
		t.Fatalf("deposit = %s, want cancelled with the course", st)
	}
	if ev := f.lastEvent("dental.plan.cancelled", p.ID); ev == nil || ev["reason"] != "created on the wrong patient" {
		t.Fatalf("event = %v", ev)
	}
}

func TestD11_CancelRefusesOwedOrBilledCourses(t *testing.T) {
	f := newFixture(t)
	p := f.course(3, "2000", "")
	f.record(f.dentist, p.Sessions[0].ID)
	if _, err := f.svc.CancelPlan(f.as(f.owner), f.patient, p.ID, "x"); code(err) != "PLAN_HAS_DEBT" {
		t.Fatalf("given visit owed: got %q", code(err))
	}
	must(t, f.svc.CollectSession(f.as(f.owner), f.patient, p.Sessions[0].ID))
	if _, err := f.svc.CancelPlan(f.as(f.owner), f.patient, p.ID, "x"); code(err) != "PLAN_HAS_BILLS" {
		t.Fatalf("bill at cashier: got %q", code(err))
	}
}

func TestD11_BackDoorsAreClosed(t *testing.T) {
	f := newFixture(t)
	p := f.course(2, "1000", "")
	cancelled := "cancelled"
	if err := f.svc.UpdatePlan(f.as(f.owner), f.patient, p.ID, dental.PlanUpdate{Status: &cancelled}); code(err) != validation {
		t.Fatalf("status via UpdatePlan: got %q", code(err))
	}
	f.record(f.dentist, p.Sessions[0].ID)
	if err := f.svc.DeletePlan(f.as(f.owner), f.patient, p.ID); code(err) != "PLAN_HAS_RECORDS" {
		t.Fatalf("delete with given treatment: got %q", code(err))
	}
	clean := f.course(2, "1000", "")
	must(t, f.svc.DeletePlan(f.as(f.dentist), f.patient, clean.ID))
}

// --- D14: the course total is always the sum of what the course contains ---

func (f *fixture) planTotal(planID uuid.UUID) string {
	f.t.Helper()
	var t string
	must(f.t, f.db.Pool.QueryRow(context.Background(),
		`SELECT total_amount::text FROM treatment_plans WHERE id = $1`, planID).Scan(&t))
	return t
}

func TestD14_TotalFollowsExtrasFeesAndCancellations(t *testing.T) {
	f := newFixture(t)
	p := f.course(2, "1000", "") // 2,000
	var xray uuid.UUID
	must(t, f.db.Pool.QueryRow(context.Background(),
		`INSERT INTO service_items (tenant_id, code, name, category, price) VALUES ($1,'XR','X-ray','dental',500) RETURNING id`,
		f.tenant).Scan(&xray))
	must(t, f.svc.AddExtra(f.as(f.dentist), f.patient, p.Sessions[0].ID, dental.ExtraInput{ServiceID: xray}))
	if got := f.planTotal(p.ID); got != "2500.00" {
		t.Fatalf("after adding a 500 extra: total %s, want 2500.00", got)
	}
	var extra uuid.UUID
	must(t, f.db.Pool.QueryRow(context.Background(),
		`SELECT id FROM treatment_sessions WHERE plan_id = $1 AND kind = 'extra'`, p.ID).Scan(&extra))
	must(t, f.svc.RemoveExtra(f.as(f.dentist), f.patient, extra))
	if got := f.planTotal(p.ID); got != "2000.00" {
		t.Fatalf("after removing it: total %s, want 2000.00", got)
	}
	must(t, f.svc.UpdateSession(f.as(f.dentist), f.patient, p.Sessions[1].ID, dental.SessionUpdate{AmountDue: "1500"}))
	if got := f.planTotal(p.ID); got != "2500.00" {
		t.Fatalf("after a fee edit: total %s, want 2500.00", got)
	}
	must(t, f.svc.UpdateSession(f.as(f.dentist), f.patient, p.Sessions[1].ID, dental.SessionUpdate{Status: "cancelled"}))
	if got := f.planTotal(p.ID); got != "1000.00" {
		t.Fatalf("after cancelling visit 2: total %s, want 1000.00", got)
	}
}

// --- D20/D21: one definition of "still owed", used by Finance and the SMS chase ---

func TestD21_FinanceCountsWhatTheReportCounts(t *testing.T) {
	f := newFixture(t)
	p := f.course(2, "1000", "500") // deposit 500 owed from the start
	f.record(f.dentist, p.Sessions[0].ID)
	var xray uuid.UUID
	must(t, f.db.Pool.QueryRow(context.Background(),
		`INSERT INTO service_items (tenant_id, code, name, category, price) VALUES ($1,'XR','X-ray','dental',300) RETURNING id`,
		f.tenant).Scan(&xray))
	must(t, f.svc.AddExtra(f.as(f.dentist), f.patient, p.Sessions[0].ID, dental.ExtraInput{ServiceID: xray}))
	// A second course, given and unbilled, then (as the owner) cancelled: not owed.
	q := f.course(1, "4000", "")
	f.record(f.dentist, q.Sessions[0].ID)
	_, err := f.db.Pool.Exec(context.Background(), `UPDATE treatment_plans SET status='cancelled' WHERE id=$1`, q.ID)
	must(t, err)

	got, n, err := financesvc.NewDentalAdapter(f.db).UnbilledTotal(f.as(f.owner))
	must(t, err)
	if got != "1800.00" || n != 3 { // visit 1,000 + deposit 500 + X-ray 300
		t.Fatalf("finance unbilled = %s over %d, want 1800.00 over 3", got, n)
	}
	var chased string
	must(t, f.db.Pool.QueryRow(context.Background(), dental.SessionMoneySQL+`
		SELECT coalesce(sum(owed_amount),0)::text FROM session_money sm
		 WHERE sm.alive AND sm.owed_now AND sm.pay_state IN ('unpaid','refunded')`, f.tenant).Scan(&chased))
	if chased != "1800.00" {
		t.Fatalf("SMS planner's set = %s, want 1800.00 (the cancelled course excluded)", chased)
	}
}

// --- D17: a prescription is withdrawn, not erased, and names who wrote it ---

func TestD17_PrescriptionIsVoidedAndKeepsItsAuthor(t *testing.T) {
	f := newFixture(t)
	v := f.course(2, "1000", "").Sessions[0].ID
	f.record(f.dentist, v)
	rx, err := f.svc.AddPrescription(f.as(f.dentist), f.patient, v, dental.PrescriptionInput{
		Items: []dental.RxItemInput{{DrugName: "Amoxicillin 500mg"}}, Note: "after meals"})
	must(t, err)
	plans, err := f.svc.ListPlans(f.as(f.other), f.patient)
	must(t, err)
	if got := plans[0].Sessions[0].Prescriptions; len(got) != 1 || got[0].PrescribedBy != "Staff" {
		t.Fatalf("prescriptions = %+v, want one written by the dentist", got)
	}
	if err := f.svc.DeletePrescription(f.as(f.other), f.patient, rx.ID, ""); code(err) != validation {
		t.Fatalf("withdraw without reason: got %q", code(err))
	}
	must(t, f.svc.DeletePrescription(f.as(f.other), f.patient, rx.ID, "wrong drug"))
	var kept int
	must(t, f.db.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM dental_prescriptions WHERE id = $1 AND voided_at IS NOT NULL AND void_reason = 'wrong drug'`, rx.ID).Scan(&kept))
	if kept != 1 {
		t.Fatal("the withdrawn prescription is not kept on the record")
	}
	plans, _ = f.svc.ListPlans(f.as(f.other), f.patient)
	if n := len(plans[0].Sessions[0].Prescriptions); n != 0 {
		t.Fatalf("withdrawn prescription still shown on the visit (%d)", n)
	}
	// Not on a cancelled visit.
	c := f.course(2, "1000", "").Sessions[1].ID
	must(t, f.svc.UpdateSession(f.as(f.dentist), f.patient, c, dental.SessionUpdate{Status: "cancelled"}))
	if _, err := f.svc.AddPrescription(f.as(f.dentist), f.patient, c, dental.PrescriptionInput{
		Items: []dental.RxItemInput{{DrugName: "Ibuprofen"}}}); code(err) != "SESSION_CANCELLED" {
		t.Fatalf("Rx on a cancelled visit: got %q", code(err))
	}
}
