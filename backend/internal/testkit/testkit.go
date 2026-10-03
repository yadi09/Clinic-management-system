// Package testkit is the shared foundation of the regression suite: a guarded test
// database, real clinics provisioned exactly as the platform console does it, staff
// in every role, the real API started as a process, and a way to keep known bugs
// visible without letting them hide a new regression.
//
// Every test that touches a database goes through RequireDB, which refuses anything
// that is not plainly a throwaway database. The suite must never be able to reach a
// clinic's real data, however the environment is misconfigured.
package testkit

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

// AppRolePassword is the password the suite gives the clinic_app role in the test
// database, so the API can connect as the RLS-enforced role, exactly as in production.
const AppRolePassword = "regress-app-pw"

var (
	migrateOnce sync.Once
	migrateErr  error
)

// RequireDB returns the superuser DSN of the test database, migrated to the latest
// version, or skips the test when none is configured. It FAILS (not skips) when the
// DSN looks like anything other than a local throwaway database.
func RequireDB(t testing.TB) string {
	t.Helper()
	if testing.Short() {
		t.Skip("integration test (run without -short)")
	}
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres (see TESTING.md)")
	}
	if err := guard(dsn); err != nil {
		t.Fatalf("refusing to run: %v", err)
	}
	migrateOnce.Do(func() { migrateErr = migrate(dsn) })
	if migrateErr != nil {
		t.Fatalf("migrate test database: %v", migrateErr)
	}
	return dsn
}

// guard refuses DSNs that could be production: a remote host, or a database whose
// name does not say it is for tests. TESTKIT_ALLOW_REMOTE=1 lifts only the host rule
// (CI service containers), never the name rule.
func guard(dsn string) error {
	u, err := url.Parse(dsn)
	if err != nil {
		return fmt.Errorf("TEST_DATABASE_URL is not a URL: %w", err)
	}
	host := u.Hostname()
	local := host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "postgres"
	if !local && os.Getenv("TESTKIT_ALLOW_REMOTE") != "1" {
		return fmt.Errorf("TEST_DATABASE_URL host %q is not local", host)
	}
	name := strings.ToLower(strings.TrimPrefix(u.Path, "/"))
	if !strings.Contains(name, "test") && !strings.Contains(name, "regress") {
		return fmt.Errorf("database %q must have 'test' or 'regress' in its name", name)
	}
	return nil
}

func migrate(dsn string) error {
	sdb, err := sql.Open("pgx", dsn)
	if err != nil {
		return err
	}
	defer sdb.Close()
	// Several test processes (parallel packages, two developers, CI shards) may set
	// up the same database at once; concurrent migrations or ALTER ROLE fail with
	// "tuple concurrently updated". One advisory lock serialises the setup.
	ctx := context.Background()
	conn, err := sdb.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock(7262001)`); err != nil {
		return err
	}
	defer conn.ExecContext(ctx, `SELECT pg_advisory_unlock(7262001)`) //nolint:errcheck
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	goose.SetLogger(goose.NopLogger())
	if err := goose.UpContext(context.Background(), sdb, "."); err != nil {
		return err
	}
	// The API connects as clinic_app; give it a login in the test database only.
	if _, err = conn.ExecContext(ctx, `ALTER ROLE clinic_app WITH LOGIN PASSWORD '`+AppRolePassword+`'`); err != nil {
		return err
	}
	// Production's Postgres (the stock Docker image) runs in UTC. A developer's local
	// server inherits the machine's zone instead, which moves every SQL "today" and
	// made results depend on where the suite ran. Pin the test database to production's.
	_, err = conn.ExecContext(ctx, `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'); END $$`)
	return err
}

// Prepare is RequireDB for TestMain, which has no *testing.T: it returns the
// migrated superuser DSN, or a non-empty skip reason, or an error that must stop the
// run (including a guard refusal).
func Prepare() (dsn, skip string, err error) {
	dsn = os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		return "", "TEST_DATABASE_URL not set — integration and API regression tests skipped (see TESTING.md)", nil
	}
	if err := guard(dsn); err != nil {
		return "", "", fmt.Errorf("refusing to run: %w", err)
	}
	migrateOnce.Do(func() { migrateErr = migrate(dsn) })
	return dsn, "", migrateErr
}

// AppDSNFrom is AppDSN without a test handle.
func AppDSNFrom(superDSN string) string {
	u, err := url.Parse(superDSN)
	if err != nil {
		return superDSN
	}
	u.User = url.UserPassword("clinic_app", AppRolePassword)
	return u.String()
}

// AppDSN is the test database as the clinic_app role (RLS enforced).
func AppDSN(t testing.TB, superDSN string) string {
	t.Helper()
	u, err := url.Parse(superDSN)
	if err != nil {
		t.Fatal(err)
	}
	u.User = url.UserPassword("clinic_app", AppRolePassword)
	return u.String()
}

// SuperDB opens a pool as the superuser, for arranging and inspecting test data.
// Never use it to exercise behaviour: it bypasses RLS.
func SuperDB(t testing.TB, dsn string) *kerneldb.DB {
	t.Helper()
	db, err := kerneldb.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(db.Pool.Close)
	return db
}
