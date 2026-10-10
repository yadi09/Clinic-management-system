package provision

import (
	"context"
	"database/sql"
	"os"
	"strings"
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

// TestBootstrapStopsCleanlyWhenTheStandardAllergensCannotBeSeeded: a clinic must not
// be left half-made. When seeding the standard allergy names fails, provisioning
// returns an error that says what failed, and (the caller rolling back) no tenant
// with that slug exists afterwards. The failure is forced with a trigger created and
// undone inside the same transaction, so no other test ever sees it.
func TestBootstrapStopsCleanlyWhenTheStandardAllergensCannotBeSeeded(t *testing.T) {
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

	slug := "al-" + uuid.NewString()[:8]
	err = db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `CREATE FUNCTION refuse_allergen_seed() RETURNS trigger LANGUAGE plpgsql
			AS $$ BEGIN RAISE EXCEPTION 'seeding refused'; END $$`); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `CREATE TRIGGER refuse_allergen_seed BEFORE INSERT ON allergen_catalog
			FOR EACH ROW EXECUTE FUNCTION refuse_allergen_seed()`); e != nil {
			return e
		}
		_, e := BootstrapTenant(ctx, tx, Params{Name: "Half Made", Slug: slug, OwnerEmail: slug + "@t.test",
			OwnerName: "Owner", OwnerPasswordHash: "x", ClinicType: "general", PlanCode: "clinic"})
		return e
	})
	if err == nil || !strings.Contains(err.Error(), "standard allergens") {
		t.Fatalf("provisioning error = %v, want one naming the standard allergens", err)
	}
	var n int
	if e := db.Pool.QueryRow(ctx, `SELECT count(*) FROM tenants WHERE slug = $1`, slug).Scan(&n); e != nil {
		t.Fatal(e)
	}
	if n != 0 {
		t.Fatalf("a failed provisioning left %d tenant row(s)", n)
	}
}
