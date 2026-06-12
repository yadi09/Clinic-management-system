-- +goose Up
-- +goose StatementBegin
-- The application MUST connect as a non-superuser, NOBYPASSRLS role so that
-- Row-Level Security is actually enforced (a superuser bypasses RLS even with
-- FORCE). Migrations run as the owner/superuser; api+worker connect as
-- clinic_app. In Docker the LOGIN variant (with a password) is created by the
-- postgres init script; here we ensure the role exists and hold its grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    CREATE ROLE clinic_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO clinic_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO clinic_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clinic_app;

-- Future tables/sequences created by the migration owner are auto-granted.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO clinic_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO clinic_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM clinic_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM clinic_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM clinic_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM clinic_app;
REVOKE USAGE ON SCHEMA public FROM clinic_app;
-- The role itself is left in place (it may be shared across databases).
-- +goose StatementEnd
