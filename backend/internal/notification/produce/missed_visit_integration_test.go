package produce

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/notification"
	"github.com/reicb/clinicsaas/internal/notification/service"
)

// The day relative to today in the clinic's timezone, as SQL. Every date in this
// test is written this way so it agrees with the producer whatever the machine's
// own timezone is.
func day(offset string) string {
	return "((now() AT TIME ZONE 'Africa/Addis_Ababa')::date " + offset + ")"
}

type fixture struct {
	t   *testing.T
	ctx context.Context
	db  *kerneldb.DB
}

func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Pool.Exec(f.ctx, q, args...); err != nil {
		f.t.Fatalf("%v\n%s", err, q)
	}
}

func (f *fixture) id(q string, args ...any) uuid.UUID {
	f.t.Helper()
	var u uuid.UUID
	if err := f.db.Pool.QueryRow(f.ctx, q, args...).Scan(&u); err != nil {
		f.t.Fatalf("%v\n%s", err, q)
	}
	return u
}

func (f *fixture) tenant(status string) uuid.UUID {
	slug := "ntf-" + uuid.NewString()[:8]
	tid := f.id(`INSERT INTO tenants (name, slug, status, plan_id, clinic_type)
	             VALUES ($1,$1,$2,(SELECT id FROM plans LIMIT 1),'dental') RETURNING id`, slug, status)
	f.exec(`INSERT INTO clinics (tenant_id, name, timezone) VALUES ($1,'Test Dental','Africa/Addis_Ababa')`, tid)
	return tid
}

func (f *fixture) user(tid uuid.UUID, role, status string) uuid.UUID {
	uid := f.id(`INSERT INTO users (tenant_id, email, full_name, status)
	             VALUES ($1, $2, $3, $4) RETURNING id`,
		tid, uuid.NewString()[:8]+"@t.test", role+" user", status)
	rid := f.id(`INSERT INTO roles (tenant_id, code, name) VALUES ($1,$2,$2)
	             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, tid, role)
	f.exec(`INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, tid, uid, rid)
	return uid
}

func (f *fixture) patient(tid uuid.UUID, first, last, mrn string) uuid.UUID {
	return f.id(`INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender)
	             VALUES ($1,$2,$3,$4,'female') RETURNING id`, tid, mrn, first, last)
}

func (f *fixture) plan(tid, pid uuid.UUID, status string, createdBy *uuid.UUID) uuid.UUID {
	return f.id(`INSERT INTO treatment_plans (tenant_id, patient_id, title, total_amount, start_date,
	                                          interval_unit, interval_count, session_count, status, created_by)
	             VALUES ($1,$2,'Root canal',0,current_date,'week',1,3,$3,$4) RETURNING id`,
		tid, pid, status, createdBy)
}

func (f *fixture) session(tid, plan, pid uuid.UUID, seq int, when, status, kind string) uuid.UUID {
	return f.id(`INSERT INTO treatment_sessions (tenant_id, plan_id, patient_id, seq, scheduled_date,
	                                             amount_due, status, kind)
	             VALUES ($1,$2,$3,$4,`+day(when)+`,0,$5,$6) RETURNING id`,
		tid, plan, pid, seq, status, kind)
}

func (f *fixture) count(uid uuid.UUID) int {
	f.t.Helper()
	var n int
	if err := f.db.Pool.QueryRow(f.ctx,
		`SELECT count(*) FROM notifications WHERE user_id = $1`, uid).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func (f *fixture) countFor(uid, subject uuid.UUID) int {
	f.t.Helper()
	var n int
	if err := f.db.Pool.QueryRow(f.ctx,
		`SELECT count(*) FROM notifications WHERE user_id = $1 AND subject_id = $2`, uid, subject).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestIntegrationMissedVisitNotifications(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if testing.Short() || dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres")
	}
	ctx := context.Background()
	sdb, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	goose.SetBaseFS(migrations.FS)
	_ = goose.SetDialect("postgres")
	if err := goose.UpContext(ctx, sdb, "."); err != nil {
		t.Fatal(err)
	}
	sdb.Close()
	db, err := kerneldb.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	f := &fixture{t: t, ctx: ctx, db: db}

	// Pretend the feature was switched on three days ago, and put it back after.
	var since string
	if err := db.Pool.QueryRow(ctx, `SELECT since::text FROM notification_watermarks WHERE kind = 'missed_visit'`).Scan(&since); err != nil {
		t.Fatalf("watermark row missing: %v", err)
	}
	f.exec(`UPDATE notification_watermarks SET since = ` + day("- 3") + ` WHERE kind = 'missed_visit'`)
	t.Cleanup(func() {
		_, _ = db.Pool.Exec(context.Background(),
			`UPDATE notification_watermarks SET since = $1::date WHERE kind = 'missed_visit'`, since)
	})

	// --- clinic A -------------------------------------------------------------
	tA := f.tenant("active")
	owner := f.user(tA, "tenant_owner", "active")
	desk := f.user(tA, "receptionist", "active")
	gone := f.user(tA, "receptionist", "suspended")
	cashier := f.user(tA, "cashier", "active")
	dentist := f.user(tA, "doctor", "active")
	otherDentist := f.user(tA, "doctor", "active")

	pt := f.patient(tA, "Almaz", "Bekele", "C-101")
	course := f.plan(tA, pt, "active", &dentist)
	missed := f.session(tA, course, pt, 1, "- 1", "planned", "visit") // yesterday, never done: missed
	f.session(tA, course, pt, 2, "+ 0", "planned", "visit")           // today: not missed yet
	f.session(tA, course, pt, 3, "- 2", "done", "visit")              // done: not missed
	f.session(tA, course, pt, 4, "- 1", "cancelled", "visit")         // cancelled: not missed
	f.session(tA, course, pt, 0, "- 1", "planned", "deposit")         // money, not a visit
	f.session(tA, course, pt, 5, "- 5", "planned", "visit")           // before switch-on: skipped
	dead := f.plan(tA, pt, "cancelled", &dentist)
	f.session(tA, dead, pt, 1, "- 1", "planned", "visit") // course cancelled: not missed

	// A course whose planner is no longer here: the clinic's doctors are told.
	ptO := f.patient(tA, "Kebede", "", "C-102")
	orphan := f.plan(tA, ptO, "active", nil)
	orphanMissed := f.session(tA, orphan, ptO, 1, "- 1", "planned", "visit")

	// --- clinic B: its own miss, its own staff ----------------------------------
	tB := f.tenant("active")
	deskB := f.user(tB, "receptionist", "active")
	ptB := f.patient(tB, "Sara", "Tesfaye", "B-1")
	f.session(tB, f.plan(tB, ptB, "active", nil), ptB, 1, "- 1", "planned", "visit")

	// --- a suspended clinic is left alone ---------------------------------------
	tS := f.tenant("suspended")
	deskS := f.user(tS, "receptionist", "active")
	ptS := f.patient(tS, "Hana", "G", "S-1")
	f.session(tS, f.plan(tS, ptS, "active", nil), ptS, 1, "- 1", "planned", "visit")

	// --- one clinic's bad data must not stop the others ---------------------------
	// An unknown timezone (no constraint stops one being stored) and a clinic with
	// no clinics row at all. Before the fallback, either made the whole statement
	// fail, so no clinic anywhere was notified.
	tZ := f.tenant("active")
	f.exec(`UPDATE clinics SET timezone = 'Not/A_Zone' WHERE tenant_id = $1`, tZ)
	deskZ := f.user(tZ, "receptionist", "active")
	ptZ := f.patient(tZ, "Abel", "T", "Z-1")
	f.session(tZ, f.plan(tZ, ptZ, "active", nil), ptZ, 1, "- 1", "planned", "visit")
	tN := f.tenant("active")
	f.exec(`DELETE FROM clinics WHERE tenant_id = $1`, tN)
	deskN := f.user(tN, "receptionist", "active")
	ptN := f.patient(tN, "Mimi", "K", "N-1")
	f.session(tN, f.plan(tN, ptN, "active", nil), ptN, 1, "- 1", "planned", "visit")

	mv := NewMissedVisits(db, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := mv.Produce(ctx); err != nil {
		t.Fatalf("produce: %v", err)
	}

	// Who heard about Almaz's missed visit.
	for name, c := range map[string]struct {
		uid  uuid.UUID
		want int
	}{
		"owner": {owner, 1}, "reception": {desk, 1}, "planning dentist": {dentist, 1},
		"other dentist": {otherDentist, 0}, "cashier": {cashier, 0}, "suspended user": {gone, 0},
	} {
		if got := f.countFor(c.uid, missed); got != c.want {
			t.Errorf("%s: %d notifications for the missed visit, want %d", name, got, c.want)
		}
	}
	// The orphan course reaches every doctor, plus owner and reception.
	for name, uid := range map[string]uuid.UUID{"dentist": dentist, "other dentist": otherDentist, "owner": owner, "reception": desk} {
		if got := f.countFor(uid, orphanMissed); got != 1 {
			t.Errorf("orphan course, %s: %d notifications, want 1", name, got)
		}
	}
	// Exactly two notices in clinic A per recipient who sees both, nothing else.
	if got := f.count(desk); got != 2 {
		t.Errorf("reception has %d notifications, want 2 (no today/done/cancelled/deposit/old visits)", got)
	}
	if got := f.count(cashier); got != 0 {
		t.Errorf("cashier has %d notifications, want 0", got)
	}
	if got := f.count(deskB); got != 1 {
		t.Errorf("clinic B reception has %d notifications, want 1", got)
	}
	if got := f.count(deskS); got != 0 {
		t.Errorf("a suspended clinic got %d notifications, want 0", got)
	}
	if got := f.count(deskZ); got != 1 {
		t.Errorf("clinic with an unknown timezone: %d notifications, want 1 (Addis fallback)", got)
	}
	if got := f.count(deskN); got != 1 {
		t.Errorf("clinic with no clinics row: %d notifications, want 1 (tenant timezone)", got)
	}

	// Never across clinics: clinic A's notices name only clinic A's staff.
	var leaked int
	if err := db.Pool.QueryRow(ctx,
		`SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id
		  WHERE n.tenant_id <> u.tenant_id`).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatalf("%d notifications addressed to a user of another clinic", leaked)
	}

	// The wording the staff will read.
	var body string
	if err := db.Pool.QueryRow(ctx,
		`SELECT body FROM notifications WHERE user_id = $1 AND subject_id = $2`, desk, missed).Scan(&body); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Almaz Bekele", "card C-101", "missed visit 1 of Root canal on "} {
		if !strings.Contains(body, want) {
			t.Errorf("body %q does not contain %q", body, want)
		}
	}

	// The same facts as fields, for the screen to lay out.
	var data map[string]any
	var raw []byte
	if err := db.Pool.QueryRow(ctx,
		`SELECT data FROM notifications WHERE user_id = $1 AND subject_id = $2`, desk, missed).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("data is not a JSON object: %s", raw)
	}
	if data["patient"] != "Almaz Bekele" || data["card"] != "C-101" || data["course"] != "Root canal" ||
		data["visit"] != float64(1) || data["date"] == "" {
		t.Fatalf("data fields wrong: %s", raw)
	}
	// A notice written before the fields existed is filled in once by the next pass.
	f.exec(`UPDATE notifications SET data = '{}'::jsonb WHERE user_id = $1 AND subject_id = $2`, desk, missed)
	if _, err := mv.Produce(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx,
		`SELECT data FROM notifications WHERE user_id = $1 AND subject_id = $2`, desk, missed).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "Almaz Bekele") {
		t.Fatalf("an older notice was not filled in: %s", raw)
	}

	// Running again changes nothing.
	again, err := mv.Produce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.count(desk); got != 2 {
		t.Fatalf("after a second pass reception has %d, want still 2", got)
	}
	_ = again

	// --- the inbox service, as the receptionist ---------------------------------
	svc := service.NewService(db)
	as := func(tid, uid uuid.UUID) context.Context {
		return tenancy.WithPrincipal(ctx, &tenancy.Principal{UserID: uid, TenantID: tid})
	}
	page, err := svc.List(as(tA, desk), notification.ListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Unread != 2 {
		t.Fatalf("receptionist inbox: %d items, %d unread; want 2 and 2", len(page.Items), page.Unread)
	}
	first := page.Items[0].ID

	// Someone else, in the same clinic, cannot open it — and is told it does not exist.
	if err := svc.MarkRead(as(tA, cashier), first); !isNotFound(err) {
		t.Fatalf("cashier marking reception's notice: err = %v, want not found", err)
	}
	// Nor from another clinic.
	if err := svc.MarkRead(as(tB, deskB), first); !isNotFound(err) {
		t.Fatalf("clinic B marking clinic A's notice: err = %v, want not found", err)
	}
	if n, _ := svc.UnreadCount(as(tA, desk)); n != 2 {
		t.Fatalf("someone else's attempt changed the receptionist's unread count to %d", n)
	}

	if err := svc.MarkRead(as(tA, desk), first); err != nil {
		t.Fatal(err)
	}
	if err := svc.MarkRead(as(tA, desk), first); err != nil {
		t.Fatalf("marking an already-read notice should succeed: %v", err)
	}
	if n, _ := svc.UnreadCount(as(tA, desk)); n != 1 {
		t.Fatalf("unread after reading one = %d, want 1", n)
	}
	unread, err := svc.List(as(tA, desk), notification.ListFilter{UnreadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(unread.Items) != 1 || unread.Items[0].ID == first {
		t.Fatalf("unread-only list wrong: %+v", unread.Items)
	}
	// The owner's copy of the same event is untouched.
	if n, _ := svc.UnreadCount(as(tA, owner)); n != 2 {
		t.Fatalf("owner unread = %d, want 2 (reading is personal)", n)
	}
	if n, err := svc.MarkAllRead(as(tA, desk)); err != nil || n != 1 {
		t.Fatalf("mark all read: n=%d err=%v, want 1", n, err)
	}
	if n, _ := svc.UnreadCount(as(tA, desk)); n != 0 {
		t.Fatalf("unread after mark-all = %d, want 0", n)
	}
	if _, err := svc.List(context.Background(), notification.ListFilter{}); err == nil {
		t.Fatal("listing without a signed-in user should fail")
	}

	// --- handled misses clear themselves ----------------------------------------
	// The owner has read nothing: both notices (Almaz, and the orphan course) unread.
	unreadOwner := func() int { n, _ := svc.UnreadCount(as(tA, owner)); return n }
	// Nothing changed yet: clearing must leave a standing miss alone.
	if _, err := mv.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if n := unreadOwner(); n != 2 {
		t.Fatalf("resolve cleared a miss that still stands: owner unread = %d, want 2", n)
	}
	// Rebooked into the future: no new notice, and the old one clears.
	f.exec(`UPDATE treatment_sessions SET scheduled_date = `+day("+ 7")+` WHERE id = $1`, missed)
	if _, err := mv.Produce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.countFor(desk, missed); got != 1 {
		t.Fatalf("a rebooked visit produced a new notice: reception has %d for it", got)
	}
	if n, err := mv.Resolve(ctx); err != nil || n == 0 {
		t.Fatalf("resolve after rebooking: cleared %d, err %v; want some", n, err)
	}
	if n := unreadOwner(); n != 1 {
		t.Fatalf("after rebooking, owner unread = %d, want 1 (only the orphan course)", n)
	}
	// Marked done: its notice clears too.
	f.exec(`UPDATE treatment_sessions SET status = 'done' WHERE id = $1`, orphanMissed)
	if _, err := mv.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if n := unreadOwner(); n != 0 {
		t.Fatalf("after the visit was done, owner unread = %d, want 0", n)
	}
	// The notice is kept as history, not deleted.
	if got := f.countFor(owner, missed); got != 1 {
		t.Fatalf("a cleared notice was deleted: owner has %d for it, want 1", got)
	}

	// A visit rebooked and then missed again on its new date is a new miss: it is
	// notified again, and the new notice is not cleared as the old one was.
	f.exec(`UPDATE treatment_sessions SET scheduled_date = `+day("- 2")+` WHERE id = $1`, missed)
	if _, err := mv.Produce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := mv.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.countFor(desk, missed); got != 2 {
		t.Fatalf("rebooked then missed again: reception has %d notices for it, want 2", got)
	}
	if n, _ := svc.UnreadCount(as(tA, desk)); n != 1 {
		t.Fatalf("the new miss should be the one unread notice, unread = %d", n)
	}
	if n := unreadOwner(); n != 1 {
		t.Fatalf("owner should have the new miss unread, unread = %d", n)
	}

	// Removing a patient outright (as the e2e cleanups do) takes their notices
	// with it instead of being refused by the foreign key.
	f.exec(`DELETE FROM treatment_sessions WHERE patient_id = $1`, ptB)
	f.exec(`DELETE FROM treatment_plans WHERE patient_id = $1`, ptB)
	f.exec(`DELETE FROM patients WHERE id = $1`, ptB)
	if got := f.count(deskB); got != 0 {
		t.Fatalf("a deleted patient's notices remain: %d", got)
	}
}

func isNotFound(err error) bool {
	var ae *apperr.Error
	return errors.As(err, &ae) && ae.HTTPStatus == 404
}
