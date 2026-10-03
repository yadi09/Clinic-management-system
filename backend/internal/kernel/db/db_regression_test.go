package db_test

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// These tests run as the superuser: they assert the transaction manager's own
// behaviour (commit/rollback/GUC), not RLS — RLS is covered by
// rls_integration_test.go. plans is a global (non-RLS) table, so a uniquely coded
// plan row is a convenient, isolated marker of whether a transaction committed.

func connect(t *testing.T, params string) *kerneldb.DB {
	t.Helper()
	dsn := testkit.RequireDB(t)
	if params != "" {
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		q := u.Query()
		for _, kv := range strings.Split(params, "&") {
			p := strings.SplitN(kv, "=", 2)
			q.Set(p[0], p[1])
		}
		u.RawQuery = q.Encode()
		dsn = u.String()
	}
	d, err := kerneldb.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(d.Close)
	return d
}

func uniqueCode() string { return "rg-kdb-" + uuid.NewString()[:13] }

func insertPlan(ctx context.Context, tx pgx.Tx, code string) error {
	_, err := tx.Exec(ctx, `INSERT INTO plans (code, name) VALUES ($1, 'kernel db regress')`, code)
	return err
}

func planExists(t *testing.T, d *kerneldb.DB, code string) bool {
	t.Helper()
	var n int
	if err := d.Pool.QueryRow(context.Background(), `SELECT count(*) FROM plans WHERE code = $1`, code).Scan(&n); err != nil {
		t.Fatalf("count plan: %v", err)
	}
	return n > 0
}

func cleanupPlan(t *testing.T, d *kerneldb.DB, code string) {
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM plans WHERE code = $1`, code)
	})
}

// guc reads app.tenant_id as the transaction sees it ("" when unset or reset).
func guc(ctx context.Context, tx pgx.Tx) (string, error) {
	var s *string
	if err := tx.QueryRow(ctx, `SELECT current_setting('app.tenant_id', true)`).Scan(&s); err != nil {
		return "", err
	}
	if s == nil {
		return "", nil
	}
	return *s, nil
}

// Given a WithTx whose fn succeeds, When it returns, Then its writes are committed.
func TestREG_KERNEL_DB_001_WithTxCommitsOnSuccess(t *testing.T) {
	d := connect(t, "")
	ctx := context.Background()
	code := uniqueCode()
	cleanupPlan(t, d, code)
	if err := d.WithTx(ctx, func(tx pgx.Tx) error { return insertPlan(ctx, tx, code) }); err != nil {
		t.Fatalf("WithTx: %v", err)
	}
	if !planExists(t, d, code) {
		t.Fatal("row written inside a successful WithTx was not committed")
	}
}

// Given fn returns an error, When WithTx/WithTenantTx returns, Then that same error is returned and nothing is committed.
func TestREG_KERNEL_DB_002_RollsBackOnErrorAndReturnsIt(t *testing.T) {
	d := connect(t, "")
	ctx := context.Background()
	sentinel := errors.New("boom")
	for name, run := range map[string]func(func(pgx.Tx) error) error{
		"WithTx":       func(fn func(pgx.Tx) error) error { return d.WithTx(ctx, fn) },
		"WithTenantTx": func(fn func(pgx.Tx) error) error { return d.WithTenantTx(ctx, uuid.New(), fn) },
	} {
		code := uniqueCode()
		cleanupPlan(t, d, code)
		err := run(func(tx pgx.Tx) error {
			if err := insertPlan(ctx, tx, code); err != nil {
				return err
			}
			return sentinel
		})
		if !errors.Is(err, sentinel) {
			t.Fatalf("%s: err = %v, want the fn's error", name, err)
		}
		if planExists(t, d, code) {
			t.Fatalf("%s: write survived an fn error — not rolled back", name)
		}
	}
}

// Given fn panics, When WithTx unwinds, Then the transaction is rolled back and the same panic value is re-raised.
func TestREG_KERNEL_DB_003_RollsBackOnPanicAndRepanics(t *testing.T) {
	d := connect(t, "pool_max_conns=1")
	ctx := context.Background()
	code := uniqueCode()
	cleanupPlan(t, d, code)
	type marker struct{ s string }
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		_ = d.WithTx(ctx, func(tx pgx.Tx) error {
			if err := insertPlan(ctx, tx, code); err != nil {
				t.Fatalf("insert: %v", err)
			}
			panic(marker{"kaboom"})
		})
	}()
	if m, ok := recovered.(marker); !ok || m.s != "kaboom" {
		t.Fatalf("recovered %#v, want the original panic value re-raised", recovered)
	}
	if planExists(t, d, code) {
		t.Fatal("write survived a panic — not rolled back")
	}
	// The single pooled connection is usable again (the tx was released, not leaked).
	if err := d.WithTx(ctx, func(tx pgx.Tx) error { return insertPlan(ctx, tx, code) }); err != nil {
		t.Fatalf("pool unusable after panic: %v", err)
	}
	if !planExists(t, d, code) {
		t.Fatal("follow-up tx after panic did not commit")
	}
}

// Given a tenant in the context (WithTx) or explicit (WithTenantTx), When the tx runs, Then app.tenant_id equals that tenant; uuid.Nil / no tenant leaves it unset.
func TestREG_KERNEL_DB_004_TenantGUCSetPerTransaction(t *testing.T) {
	d := connect(t, "")
	ctx := context.Background()
	tenant := uuid.New()

	check := func(name string, run func(func(pgx.Tx) error) error, want string) {
		t.Helper()
		var got string
		if err := run(func(tx pgx.Tx) error {
			var e error
			got, e = guc(ctx, tx)
			return e
		}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got != want {
			t.Fatalf("%s: app.tenant_id = %q, want %q", name, got, want)
		}
	}
	check("WithTx(ctx with tenant)", func(fn func(pgx.Tx) error) error {
		return d.WithTx(tenancy.WithTenantID(ctx, tenant), fn)
	}, tenant.String())
	check("WithTenantTx(tenant)", func(fn func(pgx.Tx) error) error {
		return d.WithTenantTx(ctx, tenant, fn)
	}, tenant.String())
	check("WithTx(no tenant)", func(fn func(pgx.Tx) error) error { return d.WithTx(ctx, fn) }, "")
	check("WithTenantTx(uuid.Nil)", func(fn func(pgx.Tx) error) error {
		return d.WithTenantTx(ctx, uuid.Nil, fn)
	}, "")
}

// Given a one-connection pool that just ran tenant A's tx (committed, rolled back, or panicked), When the next tx runs with no tenant or tenant B, Then it never sees tenant A.
func TestREG_KERNEL_DB_005_TenantGUCNotLeakedAcrossPooledTx(t *testing.T) {
	d := connect(t, "pool_max_conns=1")
	ctx := context.Background()
	a, b := uuid.New(), uuid.New()
	var pidA int
	endings := map[string]func(tx pgx.Tx) error{
		"commit":   func(tx pgx.Tx) error { return nil },
		"rollback": func(tx pgx.Tx) error { return errors.New("fail") },
	}
	for name, end := range endings {
		_ = d.WithTenantTx(ctx, a, func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pidA); err != nil {
				return err
			}
			return end(tx)
		})
		var pid int
		var none, other string
		if err := d.WithTx(ctx, func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				return err
			}
			var e error
			none, e = guc(ctx, tx)
			return e
		}); err != nil {
			t.Fatalf("%s: no-tenant tx: %v", name, err)
		}
		if pid != pidA {
			t.Fatalf("%s: test precondition: expected the same pooled connection (pid %d vs %d)", name, pid, pidA)
		}
		if none != "" {
			t.Fatalf("%s: tenant A's GUC leaked into the next no-tenant tx on the same connection: %q", name, none)
		}
		if err := d.WithTenantTx(ctx, b, func(tx pgx.Tx) error {
			var e error
			other, e = guc(ctx, tx)
			return e
		}); err != nil {
			t.Fatalf("%s: tenant B tx: %v", name, err)
		}
		if other != b.String() {
			t.Fatalf("%s: tenant B tx saw %q, want %q", name, other, b)
		}
	}
	// Panic ending.
	func() {
		defer func() { _ = recover() }()
		_ = d.WithTenantTx(ctx, a, func(tx pgx.Tx) error { panic("x") })
	}()
	var after string
	if err := d.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		after, e = guc(ctx, tx)
		return e
	}); err != nil {
		t.Fatalf("after panic: %v", err)
	}
	if after != "" {
		t.Fatalf("tenant GUC leaked after a panicking tenant tx: %q", after)
	}
}

// Given fn swallows a failed statement and returns nil, When WithTx commits, Then the commit error is returned and nothing persists.
func TestREG_KERNEL_DB_006_CommitFailureIsReturned(t *testing.T) {
	d := connect(t, "")
	ctx := context.Background()
	code := uniqueCode()
	cleanupPlan(t, d, code)
	err := d.WithTx(ctx, func(tx pgx.Tx) error {
		if err := insertPlan(ctx, tx, code); err != nil {
			return err
		}
		_, _ = tx.Exec(ctx, `SELECT 1/0`) // aborts the transaction; error ignored
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "commit tx") {
		t.Fatalf("err = %v, want a 'commit tx' error", err)
	}
	if planExists(t, d, code) {
		t.Fatal("write persisted although the transaction was aborted")
	}
}

// Given a closed pool, When WithTx runs, Then it returns a 'begin tx' error without calling fn; Healthy also reports the failure.
func TestREG_KERNEL_DB_007_ClosedPoolFailsBeginAndHealth(t *testing.T) {
	d := connect(t, "")
	ctx := context.Background()
	if err := d.Healthy(ctx); err != nil {
		t.Fatalf("Healthy on an open pool: %v", err)
	}
	d.Close()
	called := false
	err := d.WithTx(ctx, func(pgx.Tx) error { called = true; return nil })
	if err == nil || !strings.Contains(err.Error(), "begin tx") {
		t.Fatalf("err = %v, want 'begin tx' error", err)
	}
	if called {
		t.Fatal("fn ran although the transaction never began")
	}
	if err := d.Healthy(ctx); err == nil {
		t.Fatal("Healthy reported a closed pool as healthy")
	}
	d.Close()                // idempotent
	(&kerneldb.DB{}).Close() // a zero DB closes without panicking
}

// Given a malformed or unreachable DSN, When Connect is called, Then it returns a descriptive error and no DB.
func TestREG_KERNEL_DB_008_ConnectRejectsBadDSN(t *testing.T) {
	ctx := context.Background()
	cases := map[string]struct{ dsn, want string }{
		"unparseable": {"postgres://user:pw@host:notaport/db", "parse database url"},
		"bad option":  {"postgres://u@127.0.0.1/db?pool_max_conns=zero", "parse database url"},
		"unreachable": {"postgres://u@127.0.0.1:1/regress?sslmode=disable&connect_timeout=2", "ping database"},
	}
	for name, c := range cases {
		d, err := kerneldb.Connect(ctx, c.dsn)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%s: err = %v, want containing %q", name, err, c.want)
		}
		if d != nil {
			t.Fatalf("%s: got a DB alongside the error", name)
		}
	}
}
