package db

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
)

const appRolePassword = "apptest-rls-pw"

// TestIntegrationRLSIsolation proves the core tenant-isolation guarantee
// (NFR-13): connected as the least-privilege clinic_app role, a predicate-less
// query against a tenant-owned table cannot read another tenant's rows, and no
// rows are visible without a tenant set (fail-closed). Migrations run as the
// superuser in TEST_DATABASE_URL; assertions run as clinic_app (superusers
// bypass RLS, so testing as the superuser would be meaningless).
//
// Requires a throwaway Postgres via TEST_DATABASE_URL; skipped in -short/unset.
func TestIntegrationRLSIsolation(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in -short mode")
	}
	superDSN := os.Getenv("TEST_DATABASE_URL")
	if superDSN == "" {
		t.Skip("set TEST_DATABASE_URL (superuser) to run RLS integration test")
	}
	ctx := context.Background()

	// 1. Migrate as superuser and give clinic_app a login + password.
	superSQL, err := sql.Open("pgx", superDSN)
	if err != nil {
		t.Fatalf("open super: %v", err)
	}
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatalf("dialect: %v", err)
	}
	if err := goose.UpContext(ctx, superSQL, "."); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := superSQL.ExecContext(ctx,
		`ALTER ROLE clinic_app WITH LOGIN PASSWORD '`+appRolePassword+`'`); err != nil {
		t.Fatalf("grant clinic_app login: %v", err)
	}
	_ = superSQL.Close()

	// 2. Connect as the least-privilege app role (RLS-enforced).
	appDSN, err := withRole(superDSN, "clinic_app", appRolePassword)
	if err != nil {
		t.Fatalf("derive app dsn: %v", err)
	}
	d, err := Connect(ctx, appDSN)
	if err != nil {
		t.Fatalf("connect app: %v", err)
	}
	defer d.Close()

	// 3. Seed a plan and two tenants (registry tables; no RLS).
	var planID, tenantA, tenantB uuid.UUID
	if err := d.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO plans (code,name,audit_retention_days) VALUES ('rls_test','RLS Test',90)
			 ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`).Scan(&planID); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO tenants (name,slug,status,plan_id) VALUES ('A','rls-a','active',$1)
			 ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, planID).Scan(&tenantA); err != nil {
			return err
		}
		return tx.QueryRow(ctx,
			`INSERT INTO tenants (name,slug,status,plan_id) VALUES ('B','rls-b','active',$1)
			 ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, planID).Scan(&tenantB)
	}); err != nil {
		t.Fatalf("seed tenants: %v", err)
	}

	insertUser := func(tenantID uuid.UUID, email string) {
		t.Helper()
		if err := d.WithTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx,
				`INSERT INTO users (tenant_id,email,full_name,status) VALUES ($1,$2,'U','active')
				 ON CONFLICT (tenant_id,email) DO NOTHING`, tenantID, email)
			return err
		}); err != nil {
			t.Fatalf("insert user: %v", err)
		}
	}
	insertUser(tenantA, "a@rls.test")
	insertUser(tenantB, "b@rls.test")

	// 4. Under tenant A: predicate-less reads see ONLY tenant A's rows.
	if err := d.WithTenantTx(ctx, tenantA, func(tx pgx.Tx) error {
		var total, bVisible int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&total); err != nil {
			return err
		}
		if total != 1 {
			t.Fatalf("RLS leak: predicate-less count under tenant A = %d, want 1", total)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE email='b@rls.test'`).Scan(&bVisible); err != nil {
			return err
		}
		if bVisible != 0 {
			t.Fatalf("RLS leak: tenant A sees tenant B's user (%d)", bVisible)
		}
		return nil
	}); err != nil {
		t.Fatalf("tenant A query: %v", err)
	}

	// 5. With no tenant set, tenant-owned rows are invisible (fail-closed).
	if err := d.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			t.Fatalf("RLS not fail-closed: %d users visible with no tenant set", n)
		}
		return nil
	}); err != nil {
		t.Fatalf("no-tenant query: %v", err)
	}
}

// withRole returns dsn with its user/password replaced.
func withRole(dsn, user, password string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", err
	}
	u.User = url.UserPassword(user, password)
	return u.String(), nil
}
