-- +goose Up
-- +goose StatementBegin
-- Per-clinic DHIS2 connection so each clinic pushes to its OWN national account,
-- replacing the single shared env token. The API token is stored encrypted
-- (AES-256-GCM with the app's MFA_ENC_KEY, same as TOTP secrets) — never plaintext.
CREATE TABLE dhis2_config (
    tenant_id       UUID PRIMARY KEY REFERENCES tenants(id),
    base_url        TEXT NOT NULL DEFAULT 'https://dhis.moh.gov.et',
    token_enc       TEXT,                       -- AES-GCM(base64); NULL = not connected
    org_unit        TEXT,                       -- the clinic's DHIS2 facility id
    org_unit_name   TEXT,
    data_set        TEXT NOT NULL DEFAULT 'JXiOYKPIaQ1', -- national Disease Registration dataset
    period_calendar TEXT NOT NULL DEFAULT 'ethiopian'
                      CHECK (period_calendar IN ('ethiopian','gregorian')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A clinic's diagnosis → DHIS2 dataElement mapping (only mapped diseases push).
CREATE TABLE dhis2_disease_map (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    disease_key       TEXT NOT NULL,            -- lower(btrim(diagnosis description))
    disease_name      TEXT NOT NULL,
    data_element      TEXT NOT NULL,            -- DHIS2 dataElement id
    data_element_name TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_dhis2_map_key ON dhis2_disease_map(tenant_id, disease_key);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dhis2_config','dhis2_disease_map']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    $f$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON dhis2_config, dhis2_disease_map TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS dhis2_disease_map;
DROP TABLE IF EXISTS dhis2_config;
-- +goose StatementEnd
