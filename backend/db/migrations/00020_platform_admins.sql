-- +goose Up
-- +goose StatementBegin
-- Phase PLAT-A: the platform (super-admin) layer. Platform admins are vendor-side
-- operators who provision and manage tenants (clinics); they are NOT tenant users
-- and are not tenant-scoped. The platform module connects with a privileged
-- (RLS-bypassing) DB role; the tenant app role (clinic_app) must never read these.
CREATE TABLE platform_admins (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    mfa_secret    TEXT,
    mfa_enabled   BOOLEAN NOT NULL DEFAULT false,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The least-privilege tenant app role must NOT be able to read platform credentials
-- or the tenant roster. Revoke the blanket grant it holds from migration 0002.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    REVOKE ALL ON platform_admins FROM clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS platform_admins;
-- +goose StatementEnd
