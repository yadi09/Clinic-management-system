-- +goose Up
-- +goose StatementBegin
-- Phase RX-LIB: per-clinic drug & allergen libraries for prescribing. The doctor
-- searches a drug and its default dose/frequency/duration/instructions auto-fill;
-- each drug carries allergen tags so a prescription can be checked against the
-- patient's recorded allergies (warn + override, reason recorded).
CREATE TABLE allergen_catalog (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    name       TEXT NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_allergen_name ON allergen_catalog(tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE drug_catalog (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(id),
    name                 TEXT NOT NULL,
    default_dose         TEXT,
    default_frequency    TEXT,
    default_duration     TEXT,
    default_instructions TEXT,
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by           UUID,
    deleted_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_drug_name ON drug_catalog(tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_drug_active ON drug_catalog(tenant_id, is_active, name);

CREATE TABLE drug_allergens (
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    drug_id     UUID NOT NULL REFERENCES drug_catalog(id) ON DELETE CASCADE,
    allergen_id UUID NOT NULL REFERENCES allergen_catalog(id) ON DELETE CASCADE,
    PRIMARY KEY (drug_id, allergen_id)
);
CREATE INDEX idx_drug_allergens_drug ON drug_allergens(tenant_id, drug_id);

-- Link a prescribed item back to the catalog drug + record an allergy override reason.
ALTER TABLE prescription_items ADD COLUMN drug_id UUID REFERENCES drug_catalog(id);
ALTER TABLE prescription_items ADD COLUMN allergy_override TEXT;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['allergen_catalog','drug_catalog','drug_allergens']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON allergen_catalog, drug_catalog, drug_allergens TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE prescription_items DROP COLUMN IF EXISTS allergy_override;
ALTER TABLE prescription_items DROP COLUMN IF EXISTS drug_id;
DROP TABLE IF EXISTS drug_allergens;
DROP TABLE IF EXISTS drug_catalog;
DROP TABLE IF EXISTS allergen_catalog;
-- +goose StatementEnd
