-- +goose Up
-- +goose StatementBegin
-- Phase VITALS-A: per-clinic customisation of the triage vitals form. Each tenant
-- can enable/relabel the standard vital fields and set, per field, plausibility
-- bounds (min/max — block impossible values at entry) and a reference range
-- (low/high — flag Low/Normal/High). Rows are overrides on a built-in default
-- catalog: absent rows mean "use the seeded default" so existing clinics keep
-- working with no backfill.
CREATE TABLE vital_field_defs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    field_key   TEXT NOT NULL,                 -- standard key: systolic, diastolic, pulse, resp_rate, spo2, temp_c, weight_kg, height_cm
    label       TEXT NOT NULL,
    unit        TEXT NOT NULL DEFAULT '',
    decimals    INTEGER NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 2),
    enabled     BOOLEAN NOT NULL DEFAULT true,
    required    BOOLEAN NOT NULL DEFAULT false,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    min_val     NUMERIC(8,2),                  -- plausibility floor (block below)
    low_val     NUMERIC(8,2),                  -- below = "Low" flag
    high_val    NUMERIC(8,2),                  -- above = "High" flag
    max_val     NUMERIC(8,2),                  -- plausibility ceiling (block above)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, field_key)
);
CREATE INDEX idx_vital_field_defs_tenant ON vital_field_defs(tenant_id, sort_order);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  EXECUTE 'ALTER TABLE vital_field_defs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE vital_field_defs FORCE ROW LEVEL SECURITY';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON vital_field_defs
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  $f$;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON vital_field_defs TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS vital_field_defs;
-- +goose StatementEnd
