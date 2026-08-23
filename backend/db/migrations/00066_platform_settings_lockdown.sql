-- +goose Up
-- +goose StatementBegin

-- The tenant role must not be able to touch the platform's own secrets.
--
-- This database carries a DEFAULT PRIVILEGES rule granting clinic_app
-- SELECT/INSERT/UPDATE/DELETE on every new table — right for the tenant tables that
-- make up almost all of the schema, and wrong for exactly one kind: the vendor's own.
-- platform_settings inherited it silently at creation, so the role every clinic
-- request runs as could read the encrypted Verify.ET key and, worse, overwrite or
-- delete it. platform_admins, created before that rule, has no such grant — this
-- brings the new table in line with it.
--
-- The value is AES-GCM ciphertext and the decryption key lives in the application's
-- environment, never in the database, so this was defence in depth rather than an
-- open door. It is still a door.
REVOKE ALL ON platform_settings FROM clinic_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Deliberately not re-granted: nothing should ever want this back.
SELECT 1;
-- +goose StatementEnd
