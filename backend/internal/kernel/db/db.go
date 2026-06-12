// Package db owns the Postgres connection pool and the transaction manager.
// It is the single choke point for tenant isolation: WithTx sets the
// per-transaction GUC app.tenant_id (via set_config(...,is_local=true)) so that
// Row-Level Security policies reject cross-tenant rows even if an application
// query forgets its tenant predicate (ADR-002, defence in depth).
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// DB wraps a pgx connection pool.
type DB struct {
	Pool *pgxpool.Pool
}

// Connect opens and verifies a pooled connection to Postgres.
func Connect(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConnIdleTime = 5 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect database: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &DB{Pool: pool}, nil
}

// Close releases the pool.
func (d *DB) Close() {
	if d.Pool != nil {
		d.Pool.Close()
	}
}

// Healthy reports whether the database is reachable.
func (d *DB) Healthy(ctx context.Context) error {
	c, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return d.Pool.Ping(c)
}

// WithTx runs fn inside a transaction. If the context carries an active tenant,
// the tenant GUC is set transaction-locally so RLS is enforced for every
// statement in fn. The transaction is committed if fn returns nil, otherwise
// rolled back.
func (d *DB) WithTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tenantID, hasTenant := tenancy.TenantIDFromContext(ctx)
	return d.runTx(ctx, hasTenant, tenantID, fn)
}

// WithTenantTx runs fn inside a transaction scoped to an explicit tenant. Used
// by system processes (e.g. the outbox relay) that handle events on behalf of a
// tenant without an authenticated principal in context.
func (d *DB) WithTenantTx(ctx context.Context, tenantID uuid.UUID, fn func(pgx.Tx) error) error {
	return d.runTx(ctx, tenantID != uuid.Nil, tenantID, fn)
}

func (d *DB) runTx(ctx context.Context, setTenant bool, tenantID uuid.UUID, fn func(pgx.Tx) error) (err error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(ctx)
			panic(p)
		}
		if err != nil {
			_ = tx.Rollback(ctx)
		}
	}()

	if setTenant {
		// set_config(name, value, is_local=true) is transaction-scoped and,
		// unlike SET LOCAL, accepts a bind parameter.
		if _, err = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID.String()); err != nil {
			return fmt.Errorf("set tenant guc: %w", err)
		}
	}

	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
