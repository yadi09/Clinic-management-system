package events_test

import (
	"context"
	"database/sql"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The relay drains the WHOLE outbox (it is a cross-tenant system table), so
// running it against the shared regression database would dispatch — and mark
// dispatched — other suites' events, and theirs would dispatch ours. The relay
// tests therefore run in a dedicated sibling database (<name>_kevents), migrated
// here, and serialise on an advisory lock so concurrent `go test` runs of this
// package cannot drain each other's rows.

const outboxLockKey = 7262101

var (
	sibOnce sync.Once
	sibDSN  string
	sibErr  error
)

func siblingDSN(t *testing.T) string {
	t.Helper()
	base := testkit.RequireDB(t)
	sibOnce.Do(func() { sibDSN, sibErr = prepareSibling(base) })
	if sibErr != nil {
		t.Fatalf("prepare dedicated outbox database: %v", sibErr)
	}
	return sibDSN
}

func prepareSibling(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(u.Path, "/") + "_kevents"
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, base)
	if err != nil {
		return "", err
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(7262102)`); err != nil {
		return "", err
	}
	defer conn.Exec(ctx, `SELECT pg_advisory_unlock(7262102)`) //nolint:errcheck
	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		if _, err := conn.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize()); err != nil {
			return "", err
		}
	}
	u.Path = "/" + name
	dsn := u.String()
	sdb, err := sql.Open("pgx", dsn)
	if err != nil {
		return "", err
	}
	defer sdb.Close()
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return "", err
	}
	goose.SetLogger(goose.NopLogger())
	if err := goose.UpContext(ctx, sdb, "."); err != nil {
		return "", err
	}
	return dsn, nil
}

// outboxDB returns a pool on the dedicated database with an empty outbox, held
// exclusively for the duration of the test.
func outboxDB(t *testing.T) *kerneldb.DB {
	t.Helper()
	dsn := siblingDSN(t)
	ctx := context.Background()
	lock, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("lock conn: %v", err)
	}
	if _, err := lock.Exec(ctx, `SELECT pg_advisory_lock($1)`, outboxLockKey); err != nil {
		t.Fatalf("advisory lock: %v", err)
	}
	t.Cleanup(func() { lock.Close(context.Background()) }) // closing releases the lock
	d := testkit.SuperDB(t, dsn)
	if _, err := d.Pool.Exec(ctx, `DELETE FROM event_outbox`); err != nil {
		t.Fatalf("clear outbox: %v", err)
	}
	return d
}
