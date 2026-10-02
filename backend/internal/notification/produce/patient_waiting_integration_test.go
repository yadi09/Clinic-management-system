package produce

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

// place makes the branch and department a queue entry needs.
func (f *fixture) place(tid uuid.UUID) (branch, dept uuid.UUID) {
	clinic := f.id(`SELECT id FROM clinics WHERE tenant_id = $1 LIMIT 1`, tid)
	branch = f.id(`INSERT INTO branches (tenant_id, clinic_id, name, code) VALUES ($1,$2,'Main','M') RETURNING id`, tid, clinic)
	dept = f.id(`INSERT INTO departments (tenant_id, branch_id, name) VALUES ($1,$2,'Dental') RETURNING id`, tid, branch)
	return
}

func (f *fixture) queue(tid, branch, dept, pid uuid.UUID, provider *uuid.UUID, stage, state, ago string) uuid.UUID {
	return f.id(`INSERT INTO queue_entries (tenant_id, branch_id, department_id, patient_id, stage, state,
	                                         assigned_provider_id, enqueued_at)
	             VALUES ($1,$2,$3,$4,$5,$6,$7, now() - $8::interval) RETURNING id`,
		tid, branch, dept, pid, stage, state, provider, ago)
}

func (f *fixture) unreadFor(uid, subject uuid.UUID) int {
	f.t.Helper()
	var n int
	if err := f.db.Pool.QueryRow(f.ctx,
		`SELECT count(*) FROM notifications WHERE user_id = $1 AND subject_id = $2 AND read_at IS NULL`,
		uid, subject).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func TestIntegrationPatientWaitingNotifications(t *testing.T) {
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

	// Switched on two days ago, so the 12-hour window is what is being tested.
	var since string
	if err := db.Pool.QueryRow(ctx, `SELECT since::text FROM notification_watermarks WHERE kind = 'patient_waiting'`).Scan(&since); err != nil {
		t.Fatalf("watermark row missing: %v", err)
	}
	f.exec(`UPDATE notification_watermarks SET since = ` + day("- 2") + ` WHERE kind = 'patient_waiting'`)
	t.Cleanup(func() {
		_, _ = db.Pool.Exec(context.Background(),
			`UPDATE notification_watermarks SET since = $1::date WHERE kind = 'patient_waiting'`, since)
	})

	tA := f.tenant("active")
	brA, depA := f.place(tA)
	drA := f.user(tA, "doctor", "active")
	drB := f.user(tA, "doctor", "active")
	desk := f.user(tA, "receptionist", "active")
	owner := f.user(tA, "tenant_owner", "active")
	pt := f.patient(tA, "Almaz", "Bekele", "Q-1")

	waiting := f.queue(tA, brA, depA, pt, &drA, "with_doctor", "waiting", "5 minutes")
	triage := f.queue(tA, brA, depA, f.patient(tA, "In", "Triage", "Q-2"), nil, "triage", "waiting", "5 minutes")
	stale := f.queue(tA, brA, depA, f.patient(tA, "Left", "Behind", "Q-3"), &drA, "with_doctor", "waiting", "13 hours")
	seen := f.queue(tA, brA, depA, f.patient(tA, "Already", "Seen", "Q-4"), &drA, "with_doctor", "in_consult", "5 minutes")

	// Another clinic, its own patient for its own doctor.
	tB := f.tenant("active")
	brB, depB := f.place(tB)
	drOther := f.user(tB, "doctor", "active")
	f.queue(tB, brB, depB, f.patient(tB, "Sara", "T", "B-1"), &drOther, "with_doctor", "waiting", "1 minute")

	pw := NewPatientWaiting(db, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if _, err := pw.Produce(ctx); err != nil {
		t.Fatalf("produce: %v", err)
	}

	for name, c := range map[string]struct {
		uid, subject uuid.UUID
		want         int
	}{
		"assigned doctor":         {drA, waiting, 1},
		"other doctor":            {drB, waiting, 0},
		"reception":               {desk, waiting, 0},
		"owner":                   {owner, waiting, 0},
		"triage (no doctor yet)":  {drA, triage, 0},
		"stale entry (13h)":       {drA, stale, 0},
		"already with the doctor": {drA, seen, 0},
	} {
		if got := f.countFor(c.uid, c.subject); got != c.want {
			t.Errorf("%s: %d notifications, want %d", name, got, c.want)
		}
	}
	if got := f.count(drOther); got != 1 {
		t.Errorf("clinic B's doctor has %d notifications, want 1", got)
	}
	if got := f.count(drA); got != 1 {
		t.Errorf("assigned doctor has %d notifications in total, want 1", got)
	}

	var body, data string
	if err := db.Pool.QueryRow(ctx,
		`SELECT body, data::text FROM notifications WHERE user_id = $1 AND subject_id = $2`, drA, waiting).Scan(&body, &data); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "Almaz Bekele (card Q-1) is waiting for you") {
		t.Errorf("body = %q", body)
	}
	if !strings.Contains(data, `"screen": "chairside"`) || !strings.Contains(data, `"patient": "Almaz Bekele"`) {
		t.Errorf("data = %s (a dental clinic should open Chairside)", data)
	}

	// Running again changes nothing.
	if _, err := pw.Produce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.countFor(drA, waiting); got != 1 {
		t.Fatalf("second pass duplicated: %d", got)
	}
	// Clearing leaves a patient who is still waiting alone.
	if _, err := pw.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.unreadFor(drA, waiting); got != 1 {
		t.Fatalf("resolve cleared a patient still waiting")
	}

	// Reassigned: the new doctor is told, the old doctor's notice clears.
	f.exec(`UPDATE queue_entries SET assigned_provider_id = $1 WHERE id = $2`, drB, waiting)
	if _, err := pw.Produce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := pw.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.unreadFor(drB, waiting); got != 1 {
		t.Fatalf("new doctor after reassignment: %d unread, want 1", got)
	}
	if got := f.unreadFor(drA, waiting); got != 0 {
		t.Fatalf("old doctor's notice did not clear after reassignment")
	}

	// Called in: the notice clears, and is kept as history.
	f.exec(`UPDATE queue_entries SET state = 'called' WHERE id = $1`, waiting)
	if _, err := pw.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.unreadFor(drB, waiting); got != 0 {
		t.Fatalf("notice still unread after the patient was called")
	}
	if got := f.countFor(drB, waiting); got != 1 {
		t.Fatalf("a cleared notice was deleted")
	}

	// A general clinic opens My day instead of Chairside.
	tG := f.tenant("active")
	f.exec(`UPDATE tenants SET clinic_type = 'general' WHERE id = $1`, tG)
	brG, depG := f.place(tG)
	drG := f.user(tG, "doctor", "active")
	qg := f.queue(tG, brG, depG, f.patient(tG, "Gen", "Eral", "G-1"), &drG, "with_doctor", "waiting", "1 minute")
	if _, err := pw.Produce(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx,
		`SELECT data::text FROM notifications WHERE user_id = $1 AND subject_id = $2`, drG, qg).Scan(&data); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(data, `"screen": "worklist"`) {
		t.Errorf("general clinic data = %s, want screen worklist", data)
	}
}
