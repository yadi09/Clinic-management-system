-- +goose Up
-- +goose StatementBegin

-- Platform-wide settings the vendor (ReiCB) owns, not any clinic.
--
-- The first of them is the Verify.ET API key. It arrived as an environment variable,
-- which meant the only way to supply or rotate it was to SSH into the server and
-- restart the API — not a product, just a deployment step wearing one. Every other
-- third-party credential here (a clinic's DHIS2 token, its SMS key) is pasted into
-- the app and encrypted at rest, and this now works the same way.
--
-- Deliberately NOT tenant-scoped and deliberately NOT readable by clinic_app: this
-- is the platform's own secret, reached only through the privileged pool behind
-- platform.admin, exactly like tenant provisioning.
CREATE TABLE platform_settings (
    key        TEXT PRIMARY KEY,
    -- AES-256-GCM ciphertext (kernel/auth.EncryptSecret, MFA_ENC_KEY). The plaintext
    -- never touches this table, the logs, or any response body.
    value_enc  TEXT NOT NULL,
    -- A safe fragment for the console to show, so an admin can tell which key is
    -- loaded without the key being retrievable. Never enough to use.
    hint       TEXT,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_settings IS
  'Vendor-owned settings, e.g. the Verify.ET API key. Privileged pool only — no clinic_app grant, no RLS policy, because no tenant may read it.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS platform_settings;
-- +goose StatementEnd
