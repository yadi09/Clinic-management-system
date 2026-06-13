-- +goose Up
-- +goose StatementBegin
-- Phase 3b-1: Consultation / EMR.
--   * clinical_notes  — the SOAP note (draft → signed/locked)
--   * diagnoses       — encounter diagnoses, chosen from the admin catalog
--   * prescriptions / prescription_items — medications (allergy-guarded)
--   * diagnosis_categories / diagnosis_catalog — admin-configurable disease
--                       categories and the diagnoses doctors pick from
-- See docs/patient-workflow.md (the doctor's room) and Fig 10.8.

-- ---- Admin-configurable diagnosis catalog ---------------------------------
CREATE TABLE diagnosis_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID,
    deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_diag_categories_name ON diagnosis_categories(tenant_id, lower(name))
    WHERE deleted_at IS NULL;

CREATE TABLE diagnosis_catalog (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    category_id UUID NOT NULL REFERENCES diagnosis_categories(id),
    code        TEXT,                       -- ICD-10 (optional)
    name        TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID,
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX idx_diag_catalog_category ON diagnosis_catalog(tenant_id, category_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_diag_catalog_code ON diagnosis_catalog(tenant_id, code)
    WHERE code IS NOT NULL AND deleted_at IS NULL;

-- ---- SOAP note (one per encounter; locked once signed) --------------------
CREATE TABLE clinical_notes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    subjective   TEXT,
    objective    TEXT,
    assessment   TEXT,
    plan         TEXT,
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
    signed_by    UUID,
    signed_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID,
    deleted_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_clinical_notes_encounter ON clinical_notes(encounter_id) WHERE deleted_at IS NULL;

-- ---- Encounter diagnoses (snapshot of the chosen catalog entry) -----------
CREATE TABLE diagnoses (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    patient_id   UUID NOT NULL REFERENCES patients(id),
    catalog_id   UUID REFERENCES diagnosis_catalog(id),
    category_id  UUID REFERENCES diagnosis_categories(id),
    code         TEXT,
    description  TEXT NOT NULL,
    is_primary   BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID,
    deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_diagnoses_encounter ON diagnoses(encounter_id) WHERE deleted_at IS NULL;

-- ---- Prescriptions --------------------------------------------------------
CREATE TABLE prescriptions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    patient_id   UUID NOT NULL REFERENCES patients(id),
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID,
    deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_prescriptions_encounter ON prescriptions(encounter_id) WHERE deleted_at IS NULL;

CREATE TABLE prescription_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
    drug_name       TEXT NOT NULL,
    dose            TEXT,
    frequency       TEXT,
    duration        TEXT,
    instructions    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prescription_items_rx ON prescription_items(prescription_id);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['diagnosis_categories','diagnosis_catalog','clinical_notes','diagnoses','prescriptions','prescription_items']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      diagnosis_categories, diagnosis_catalog, clinical_notes, diagnoses, prescriptions, prescription_items
      TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS prescription_items;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS diagnoses;
DROP TABLE IF EXISTS clinical_notes;
DROP TABLE IF EXISTS diagnosis_catalog;
DROP TABLE IF EXISTS diagnosis_categories;
-- +goose StatementEnd
