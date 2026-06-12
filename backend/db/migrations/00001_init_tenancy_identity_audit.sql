-- +goose Up
-- +goose StatementBegin

-- Phase 0 foundation: tenancy, subscription, identity/access, audit, and the
-- transactional outbox. Multi-tenant isolation = mandatory tenant_id on every
-- tenant-owned row + repository predicates + Postgres RLS (defence in depth).
-- See docs/adr/ADR-002-multitenancy.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() fallback
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search (used from Phase 1)

-- ---------------------------------------------------------------------------
-- Tenancy & subscription (registry tables — NOT tenant-isolated by RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE plans (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                  TEXT NOT NULL UNIQUE,        -- starter|professional|business|enterprise
    name                  TEXT NOT NULL,
    branch_limit          INTEGER,                     -- NULL = unlimited
    user_limit            INTEGER,                     -- NULL = unlimited
    storage_gb            INTEGER,                     -- NULL = custom
    audit_retention_days  INTEGER NOT NULL DEFAULT 90,
    price_monthly         NUMERIC(12,2),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,                -- URL-safe; workspace identifier
    status        TEXT NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created','onboarding','active','suspended','cancelled')),
    plan_id       UUID NOT NULL REFERENCES plans(id),
    region        TEXT,                                -- data-residency (future routing)
    timezone      TEXT NOT NULL DEFAULT 'Africa/Addis_Ababa',
    locale        TEXT NOT NULL DEFAULT 'en',
    currency      TEXT NOT NULL DEFAULT 'ETB',
    onboarded_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_plan ON tenants(plan_id);

CREATE TABLE subscriptions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants(id),
    plan_id               UUID NOT NULL REFERENCES plans(id),
    status                TEXT NOT NULL DEFAULT 'trialing'
                            CHECK (status IN ('trialing','active','past_due','cancelled')),
    current_period_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
    current_period_end    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
    cancel_at             TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

CREATE TABLE feature_flags (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    flag        TEXT NOT NULL
                  CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr','finance_advanced')),
    enabled     BOOLEAN NOT NULL DEFAULT false,
    source      TEXT NOT NULL DEFAULT 'plan' CHECK (source IN ('plan','addon','override')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, flag)
);

CREATE TABLE billing_accounts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL UNIQUE REFERENCES tenants(id),
    external_customer_id TEXT,
    currency             TEXT NOT NULL DEFAULT 'ETB',
    billing_email        TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id),
    email            TEXT NOT NULL,
    password_hash    TEXT,                              -- Argon2id; NULL until invite accepted
    full_name        TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'invited'
                       CHECK (status IN ('invited','active','suspended','deactivated')),
    mfa_enabled      BOOLEAN NOT NULL DEFAULT false,
    mfa_secret       TEXT,                              -- encrypted TOTP secret
    last_login_at    TIMESTAMPTZ,
    failed_attempts  INTEGER NOT NULL DEFAULT 0,
    locked_until     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       UUID,
    deleted_at       TIMESTAMPTZ,
    UNIQUE (tenant_id, email)
);
CREATE INDEX idx_users_status ON users(tenant_id, status);

CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    code        TEXT NOT NULL,                          -- doctor|receptionist|...
    name        TEXT NOT NULL,
    is_system   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);

-- Atomic permission catalog — GLOBAL (not tenant-owned, no RLS)
CREATE TABLE permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL UNIQUE,                   -- patient.create|lab.result.approve|...
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    role_id        UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id  UUID NOT NULL REFERENCES permissions(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (role_id, permission_id)
);
CREATE INDEX idx_role_permissions_role ON role_permissions(role_id);

CREATE TABLE user_role_scopes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id        UUID NOT NULL REFERENCES roles(id),
    branch_id      UUID,                                -- NULL = tenant-wide (branches arrive Phase 1)
    department_id  UUID,                                -- NULL = all departments in scope
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, role_id, branch_id, department_id)
);
CREATE INDEX idx_user_role_scopes_user ON user_role_scopes(user_id);

CREATE TABLE sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  TEXT NOT NULL,                  -- SHA-256 of the opaque refresh token
    user_agent          TEXT,
    ip                  TEXT,
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    rotated_from        UUID,                           -- prior session id on rotation
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE UNIQUE INDEX idx_sessions_refresh_hash ON sessions(refresh_token_hash);

-- Append-only audit (no UPDATE/DELETE). Partitioned by created_at from Phase B.
CREATE TABLE audit_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    actor_id     UUID,                                  -- NULL for system
    branch_id    UUID,
    action       TEXT NOT NULL,                         -- e.g. auth.login, patient.update
    target_type  TEXT NOT NULL,
    target_id    UUID,
    payload      JSONB,                                 -- diff/context (no secrets)
    ip           TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_tenant_time ON audit_logs(tenant_id, created_at);
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id);

-- ---------------------------------------------------------------------------
-- Transactional outbox (system table — NOT RLS; relay reads across tenants)
-- ---------------------------------------------------------------------------

CREATE TABLE event_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID,                               -- NULL for system events
    aggregate_type  TEXT NOT NULL,                      -- e.g. encounter
    aggregate_id    UUID NOT NULL,
    event_type      TEXT NOT NULL,                      -- routing key <module>.<aggregate>.<event>
    payload         JSONB NOT NULL,
    sequence        BIGSERIAL,                          -- per-aggregate ordering
    attempts        INTEGER NOT NULL DEFAULT 0,
    dead_lettered   BOOLEAN NOT NULL DEFAULT false,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at   TIMESTAMPTZ                         -- NULL = pending
);
CREATE INDEX idx_event_outbox_pending ON event_outbox(dispatched_at) WHERE dispatched_at IS NULL AND dead_lettered = false;
CREATE INDEX idx_event_outbox_aggregate ON event_outbox(aggregate_type, aggregate_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security on every tenant-owned table.
-- Policy: a row is visible/writable only when its tenant_id matches the
-- per-transaction GUC app.tenant_id (set by kernel/db.WithTx via SET LOCAL).
-- FORCE so even the table owner (the app's connection) is constrained.
-- ---------------------------------------------------------------------------

-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subscriptions','feature_flags','billing_accounts',
    'users','roles','role_permissions','user_role_scopes',
    'sessions','audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    $f$, t);
  END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS event_outbox;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_role_scopes;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS billing_accounts;
DROP TABLE IF EXISTS feature_flags;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS plans;
-- +goose StatementEnd
