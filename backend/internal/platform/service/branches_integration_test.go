package service

// The settings copy behind "add a branch", at the edges the HTTP tests cannot reach: a
// listed settings table that no longer exists, a settings table that would need a
// reference a new branch cannot have, and a database that fails mid-way.

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/platform"
	"github.com/reicb/clinicsaas/internal/platform/provision"
)

var errRollback = errors.New("rollback")

func branchDB(t *testing.T) *kerneldb.DB {
	t.Helper()
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
	t.Cleanup(db.Pool.Close)
	return db
}

func twoTenants(t *testing.T, ctx context.Context, tx pgx.Tx) (src, dst provision.Result) {
	t.Helper()
	mk := func() provision.Result {
		slug := "cp-" + uuid.NewString()[:8]
		r, err := provision.BootstrapTenant(ctx, tx, provision.Params{
			Name: slug, Slug: slug, OwnerEmail: "o@" + slug + ".test", OwnerName: "Owner", OwnerPasswordHash: "x", OwnerStatus: "active",
		})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	return mk(), mk()
}

func withTables(t *testing.T, list []struct{ name, where string }) {
	t.Helper()
	saved := settingsTables
	settingsTables = list
	t.Cleanup(func() { settingsTables = saved })
}

// A listed table that is not in the database is skipped; the rest are still copied.
func TestCopySettingsSkipsATableThatNoLongerExists(t *testing.T) {
	db := branchDB(t)
	ctx := context.Background()
	withTables(t, []struct{ name, where string }{{"no_such_settings_table", ""}, {"payment_rails", ""}})
	_ = db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		src, dst := twoTenants(t, ctx, tx)
		copied, err := copySettings(ctx, tx, src.TenantID, dst.TenantID, dst.BranchID, dst.ClinicID, dst.DeptID)
		if err != nil {
			t.Fatalf("copy: %v", err)
		}
		if len(copied) != 1 || copied[0] != "payment_rails" {
			t.Fatalf("copied = %v", copied)
		}
		return errRollback
	})
}

// A settings table that must point at something a new branch cannot have (a user, a
// patient) is refused outright — never half-copied with the reference blanked.
func TestCopySettingsRefusesAReferenceItCannotCarry(t *testing.T) {
	db := branchDB(t)
	ctx := context.Background()
	withTables(t, []struct{ name, where string }{{"zz_copy_probe", ""}})
	_ = db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		src, dst := twoTenants(t, ctx, tx)
		if _, err := tx.Exec(ctx, `CREATE TABLE public.zz_copy_probe (
			id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
			owner uuid NOT NULL REFERENCES users(id))`); err != nil {
			t.Fatal(err)
		}
		_, err := copySettings(ctx, tx, src.TenantID, dst.TenantID, dst.BranchID, dst.ClinicID, dst.DeptID)
		if err == nil || !strings.Contains(err.Error(), "must point at a users row") {
			t.Fatalf("err = %v, want a refusal naming the users reference", err)
		}
		return errRollback
	})
}

// A database that fails mid-way surfaces as an error from every step, never as a
// half-made branch.
func TestCopySettingsSurfacesADatabaseFailure(t *testing.T) {
	db := branchDB(t)
	ctx := context.Background()
	_ = db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		_, _ = tx.Exec(ctx, `SELECT 1/0`) // the transaction is now aborted
		if _, err := copySettings(ctx, tx, uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()); err == nil {
			t.Fatal("copySettings on a failed transaction reported success")
		}
		if _, err := columnsOf(ctx, tx, "payment_rails"); err == nil {
			t.Fatal("columnsOf on a failed transaction reported success")
		}
		if _, err := foreignKeysOf(ctx, tx, "payment_rails"); err == nil {
			t.Fatal("foreignKeysOf on a failed transaction reported success")
		}
		return errRollback
	})
}

// With the database gone, listing and adding branches fail as errors, not as empty answers.
func TestBranchesSurfaceADatabaseFailure(t *testing.T) {
	db := branchDB(t)
	ctx := context.Background()
	closed, err := kerneldb.Connect(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	closed.Pool.Close()
	s := &Service{db: closed}
	if _, err := s.ListBranches(ctx, uuid.New()); err == nil {
		t.Fatal("ListBranches with no database reported success")
	}
	if _, err := s.CreateBranch(ctx, uuid.New(), platform.BranchInput{Name: "x", Slug: "y"}); err == nil {
		t.Fatal("CreateBranch with no database reported success")
	}
	_ = db
	if deref(nil) != "" || deref(ptrTo("a")) != "a" {
		t.Fatal("deref")
	}
}

func ptrTo(s string) *string { return &s }

// If the database refuses any step of adding a branch — making the clinic's group,
// linking its owners, copying a setting — nothing is left behind: no half-made
// workspace, no group, no links.
func TestAddingABranchIsAllOrNothing(t *testing.T) {
	db := branchDB(t)
	ctx := context.Background()
	s := &Service{db: db}
	var main provision.Result
	if err := db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		slug := "aon-" + uuid.NewString()[:8]
		var e error
		main, e = provision.BootstrapTenant(ctx, tx, provision.Params{
			Name: slug, Slug: slug, OwnerEmail: "o@" + slug + ".test", OwnerName: "Owner", OwnerPasswordHash: "x", OwnerStatus: "active",
		})
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `UPDATE tenants SET branch_limit_override = 9 WHERE id = $1`, main.TenantID)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	refuse := func(table, when string) func() {
		t.Helper()
		fn := "zz_refuse_" + table
		if _, err := db.Pool.Exec(ctx, `CREATE OR REPLACE FUNCTION `+fn+`() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(ctx, `CREATE TRIGGER `+fn+` BEFORE INSERT ON `+table+` FOR EACH ROW `+when+` EXECUTE FUNCTION `+fn+`()`); err != nil {
			t.Fatal(err)
		}
		undo := func() {
			_, _ = db.Pool.Exec(ctx, `DROP TRIGGER IF EXISTS `+fn+` ON `+table)
			_, _ = db.Pool.Exec(ctx, `DROP FUNCTION IF EXISTS `+fn+`()`)
		}
		t.Cleanup(undo)
		return undo
	}
	nothingLeft := func(slug string) {
		t.Helper()
		var n int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM tenants WHERE slug = $1`, slug).Scan(&n); err != nil || n != 0 {
			t.Fatalf("a failed branch left a workspace behind (%d, %v)", n, err)
		}
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM org_links l JOIN tenants t ON t.organization_id = l.organization_id WHERE t.id = $1`, main.TenantID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("a failed branch left %d owner links behind (%v)", n, err)
		}
	}
	for _, step := range []struct{ table, when string }{
		{"organizations", ""},
		{"org_links", ""},
		{"payment_rails", "WHEN (NEW.label = 'zz-never')"}, // armed below for the copy only
	} {
		t.Run(step.table, func(t *testing.T) {
			when := step.when
			if step.table == "payment_rails" {
				// Fail the copy, not the new workspace's own seeding: only rows copied from the main branch.
				when = `WHEN (NEW.tenant_id <> '` + main.TenantID.String() + `' AND NEW.created_at < now() - interval '1 second')`
				if _, err := db.Pool.Exec(ctx, `UPDATE payment_rails SET created_at = now() - interval '1 day' WHERE tenant_id = $1`, main.TenantID); err != nil {
					t.Fatal(err)
				}
			}
			undo := refuse(step.table, when)
			defer undo()
			slug := "aon-br-" + uuid.NewString()[:8]
			if _, err := s.CreateBranch(ctx, main.TenantID, platform.BranchInput{Name: "x", Slug: slug}); err == nil {
				t.Fatalf("adding a branch succeeded although %s refused", step.table)
			}
			nothingLeft(slug)
		})
	}
}
