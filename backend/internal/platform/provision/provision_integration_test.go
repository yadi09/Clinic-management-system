package provision

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

// TestNewDentalClinicStartsComplete provisions a dental clinic exactly as the
// platform console does and checks everything it must start with — the payment
// methods above all, which provisioning never created until 2026-10-01.
func TestNewDentalClinicStartsComplete(t *testing.T) {
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

	slug := "dc-" + uuid.NewString()[:8]
	var res Result
	if err := db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var e error
		res, e = BootstrapTenant(ctx, tx, Params{Name: "Test Dental", Slug: slug, OwnerEmail: slug + "@t.test",
			OwnerName: "Owner", OwnerPasswordHash: "x", ClinicType: "dental", PlanCode: "dental-chair"})
		return e
	}); err != nil {
		t.Fatalf("provision: %v", err)
	}
	one := func(q string, out any) {
		t.Helper()
		if err := db.Pool.QueryRow(ctx, q, res.TenantID).Scan(out); err != nil {
			t.Fatalf("%v\n%s", err, q)
		}
	}
	var rails int
	one(`SELECT count(*) FROM payment_rails WHERE tenant_id = $1 AND active`, &rails)
	if rails != 4 {
		t.Fatalf("payment methods = %d, want 4 (cash, card, mobile, transfer)", rails)
	}
	var cash int
	one(`SELECT count(*) FROM payment_rails WHERE tenant_id = $1 AND kind = 'cash'`, &cash)
	if cash != 1 {
		t.Fatalf("cash methods = %d, want 1", cash)
	}
	var dental, lab bool
	one(`SELECT coalesce(bool_or(enabled), false) FROM feature_flags WHERE tenant_id = $1 AND flag = 'dental' AND branch_id IS NULL`, &dental)
	one(`SELECT coalesce(bool_or(enabled), false) FROM feature_flags WHERE tenant_id = $1 AND flag = 'laboratory' AND branch_id IS NULL`, &lab)
	if !dental || lab {
		t.Fatalf("flags: dental=%v laboratory=%v, want dental on and lab off", dental, lab)
	}
	var defaultFee bool
	one(`SELECT coalesce(bool_or(is_default), false) FROM service_items WHERE tenant_id = $1`, &defaultFee)
	if defaultFee {
		t.Fatal("a dental clinic must not start with a fee charged on every visit")
	}
	var doctorPays bool
	one(`SELECT EXISTS (SELECT 1 FROM roles r JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
	                    WHERE r.tenant_id = $1 AND r.code = 'doctor' AND p.code LIKE 'payment.%')`, &doctorPays)
	if doctorPays {
		t.Fatal("the dentist role must not carry payment permissions")
	}
}
