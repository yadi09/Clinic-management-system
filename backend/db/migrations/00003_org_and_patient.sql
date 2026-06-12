-- +goose Up
-- +goose StatementBegin

-- ===========================================================================
-- Phase 1: Organisation (clinics/branches/departments/resources),
-- Patient (patients/allergies/conditions/attachments/guardian_links),
-- user invitations, and per-tenant MRN counters.
-- ===========================================================================

-- ---- Organisation --------------------------------------------------------

CREATE TABLE clinics (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id),
    name             TEXT NOT NULL,
    timezone         TEXT NOT NULL DEFAULT 'Africa/Addis_Ababa',
    locale           TEXT NOT NULL DEFAULT 'en',
    logo_storage_key TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       UUID,
    deleted_at       TIMESTAMPTZ
);
CREATE INDEX idx_clinics_tenant ON clinics(tenant_id);

CREATE TABLE branches (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    clinic_id     UUID NOT NULL REFERENCES clinics(id),
    name          TEXT NOT NULL,
    code          TEXT NOT NULL,
    address       TEXT,
    phone         TEXT,
    opening_hours JSONB,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID,
    deleted_at    TIMESTAMPTZ,
    UNIQUE (tenant_id, code)
);
CREATE INDEX idx_branches_clinic ON branches(clinic_id);

CREATE TABLE departments (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants(id),
    branch_id                UUID NOT NULL REFERENCES branches(id),
    name                     TEXT NOT NULL,
    specialty                TEXT,
    default_form_template_id UUID,  -- FK added in Phase 3 (forms)
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by               UUID,
    deleted_at               TIMESTAMPTZ
);
CREATE INDEX idx_departments_branch ON departments(branch_id);

CREATE TABLE resources (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    branch_id     UUID NOT NULL REFERENCES branches(id),
    department_id UUID REFERENCES departments(id),
    name          TEXT NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('room','chair','equipment')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID,
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_resources_branch ON resources(branch_id);
CREATE INDEX idx_resources_department ON resources(department_id);

-- ---- Per-tenant MRN sequence (atomic via upsert) -------------------------

CREATE TABLE mrn_counters (
    tenant_id  UUID PRIMARY KEY REFERENCES tenants(id),
    last_value BIGINT NOT NULL DEFAULT 0
);

-- ---- Patient -------------------------------------------------------------

CREATE TABLE patients (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants(id),
    mrn               TEXT NOT NULL,
    first_name        TEXT NOT NULL,
    middle_name       TEXT,
    last_name         TEXT NOT NULL,
    gender            TEXT NOT NULL CHECK (gender IN ('male','female','other','unknown')),
    dob               DATE NOT NULL,
    national_id       TEXT,
    passport_no       TEXT,
    phone             TEXT,
    email             TEXT,
    address           JSONB,
    emergency_contact JSONB,
    blood_group       TEXT,
    -- Full-text vector for fast search (FR-PAT-04 / NFR-03). 'simple' config:
    -- names/MRN need exact-ish matching, not stemming.
    search_tsv        TSVECTOR GENERATED ALWAYS AS (
                        to_tsvector('simple',
                          coalesce(first_name,'') || ' ' ||
                          coalesce(middle_name,'') || ' ' ||
                          coalesce(last_name,'') || ' ' ||
                          coalesce(mrn,'') || ' ' ||
                          coalesce(phone,'') || ' ' ||
                          coalesce(national_id,''))
                      ) STORED,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by        UUID,
    deleted_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_patients_mrn ON patients(tenant_id, mrn);
CREATE UNIQUE INDEX idx_patients_national_id ON patients(tenant_id, national_id)
    WHERE national_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_patients_phone ON patients(tenant_id, phone);
CREATE INDEX idx_patients_search ON patients USING gin(search_tsv);
-- Fuzzy/typo-tolerant name matching for duplicate detection + search.
CREATE INDEX idx_patients_name_trgm ON patients
    USING gin ((lower(first_name || ' ' || last_name)) gin_trgm_ops);

CREATE TABLE allergies (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    substance  TEXT NOT NULL,
    reaction   TEXT,
    severity   TEXT NOT NULL CHECK (severity IN ('mild','moderate','severe')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_allergies_patient ON allergies(patient_id);

CREATE TABLE conditions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    icd_code    TEXT,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','inactive')),
    onset_date  DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID,
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX idx_conditions_patient ON conditions(patient_id);

CREATE TABLE attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    patient_id   UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    encounter_id UUID,  -- FK added in Phase 3 (clinical)
    type         TEXT NOT NULL CHECK (type IN ('pdf','image','report','scan')),
    storage_key  TEXT NOT NULL,
    filename     TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID,
    deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_attachments_patient ON attachments(patient_id);

CREATE TABLE guardian_links (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    patient_id          UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    guardian_patient_id UUID REFERENCES patients(id),
    guardian_user_id    UUID REFERENCES users(id),
    relationship        TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID,
    deleted_at          TIMESTAMPTZ
);
CREATE INDEX idx_guardian_links_patient ON guardian_links(patient_id);

-- ---- User invitations ----------------------------------------------------

CREATE TABLE user_invitations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID
);
CREATE UNIQUE INDEX idx_user_invitations_token ON user_invitations(token_hash);
CREATE INDEX idx_user_invitations_user ON user_invitations(user_id);

-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinics','branches','departments','resources','mrn_counters',
    'patients','allergies','conditions','attachments','guardian_links',
    'user_invitations'
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

-- Ensure the app role can use the new tables/sequences (default privileges from
-- 00002 cover tables created by this migration's owner; this is belt-and-suspenders).
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      clinics, branches, departments, resources, mrn_counters,
      patients, allergies, conditions, attachments, guardian_links, user_invitations
      TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS user_invitations;
DROP TABLE IF EXISTS guardian_links;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS conditions;
DROP TABLE IF EXISTS allergies;
DROP TABLE IF EXISTS patients;
DROP TABLE IF EXISTS mrn_counters;
DROP TABLE IF EXISTS resources;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS clinics;
-- +goose StatementEnd
