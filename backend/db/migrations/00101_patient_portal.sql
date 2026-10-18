-- +goose Up
-- +goose StatementBegin

-- The patient portal: a clinic-branded page where a patient signs in with their card
-- number and sees their own treatment, money and teeth. Read-only in this version.
--
-- Off by default. A clinic turns it on, and chooses what its patients see: some will
-- not want to show money or unbilled work. The settings are one row per clinic.
CREATE TABLE portal_settings (
    tenant_id     UUID PRIMARY KEY REFERENCES tenants(id),
    enabled       BOOLEAN NOT NULL DEFAULT false,
    show_money    BOOLEAN NOT NULL DEFAULT true,
    show_unbilled BOOLEAN NOT NULL DEFAULT true,
    show_teeth    BOOLEAN NOT NULL DEFAULT true,
    show_3d       BOOLEAN NOT NULL DEFAULT true,
    welcome_note  TEXT NOT NULL DEFAULT '',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    UUID
);

-- Every sign-in, so the clinic can see who looked and when. A card number is a weak
-- secret (it is printed on the card); this is what makes its use visible.
CREATE TABLE portal_logins (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    patient_id UUID NOT NULL REFERENCES patients(id),
    ip         TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_logins_patient ON portal_logins(tenant_id, patient_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_settings','portal_logins'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)$p$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO clinic_app', t);
    END IF;
  END LOOP;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS portal_logins;
DROP TABLE IF EXISTS portal_settings;
-- +goose StatementEnd
