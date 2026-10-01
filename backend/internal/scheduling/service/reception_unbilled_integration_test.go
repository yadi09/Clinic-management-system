package service

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

// TestReceptionUnbilledMatchesTheDentalReport runs the reception rows' "unbilled"
// figure (audit D10) against a real schema: given treatment and an agreed down
// payment count; planned, cancelled and cancelled-course rows do not.
func TestReceptionUnbilledMatchesTheDentalReport(t *testing.T) {
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

	var tid, pid, live, dead uuid.UUID
	q := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v\n%s", err, sql)
		}
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	slug := "r-" + uuid.NewString()[:8]
	must(db.Pool.QueryRow(ctx, `INSERT INTO tenants (name, slug, status, plan_id) VALUES ($1,$1,'active',(SELECT id FROM plans LIMIT 1)) RETURNING id`, slug).Scan(&tid))
	must(db.Pool.QueryRow(ctx, `INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender, dob) VALUES ($1,'R1','A','B','male','1990-01-01') RETURNING id`, tid).Scan(&pid))
	plan := `INSERT INTO treatment_plans (tenant_id, patient_id, title, total_amount, start_date, interval_unit, interval_count, session_count, status)
	         VALUES ($1,$2,'Course',0,current_date,'week',1,3,$3) RETURNING id`
	must(db.Pool.QueryRow(ctx, plan, tid, pid, "active").Scan(&live))
	must(db.Pool.QueryRow(ctx, plan, tid, pid, "cancelled").Scan(&dead))
	sess := `INSERT INTO treatment_sessions (tenant_id, plan_id, patient_id, seq, scheduled_date, amount_due, status, kind)
	         VALUES ($1,$2,$3,$4,current_date,$5,$6,$7)`
	q(sess, tid, live, pid, 1, 1500, "done", "visit")     // given, unbilled: counts
	q(sess, tid, live, pid, 0, 500, "planned", "deposit") // agreed down payment: counts
	q(sess, tid, live, pid, 2, 700, "planned", "visit")   // not given yet: no
	q(sess, tid, live, pid, 3, 900, "cancelled", "visit") // cancelled: no
	q(sess, tid, dead, pid, 1, 4000, "done", "visit")     // course cancelled: no

	var amt string
	must(db.Pool.QueryRow(ctx, owedCTE+`
		SELECT coalesce((SELECT amt FROM unbilled WHERE patient_id = $3), 0)::text`, tid, addisTZ, pid).Scan(&amt))
	if amt != "2000.00" {
		t.Fatalf("unbilled = %s, want 2000.00 (1500 given + 500 deposit)", amt)
	}
}
