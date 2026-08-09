-- +goose Up
-- +goose StatementBegin
-- Inpatient bed management: wards → beds, and admissions (patient ↔ bed). Billed
-- through the existing charges spine (source='bed'); occupancy is DERIVED from an
-- active admission (no stored bed status to drift). Tenant-scoped + RLS + branch.
CREATE TABLE wards (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    branch_id  UUID NOT NULL REFERENCES branches(id),
    name       TEXT NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wards_branch ON wards(tenant_id, branch_id) WHERE is_active;

CREATE TABLE beds (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    branch_id      UUID NOT NULL REFERENCES branches(id),
    ward_id        UUID NOT NULL REFERENCES wards(id),
    label          TEXT NOT NULL,
    bed_type       TEXT NOT NULL DEFAULT 'general',
    daily_rate     NUMERIC(12,2) NOT NULL DEFAULT 0,
    out_of_service BOOLEAN NOT NULL DEFAULT false,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_beds_label ON beds(tenant_id, ward_id, lower(label)) WHERE is_active;
CREATE INDEX idx_beds_branch ON beds(tenant_id, branch_id) WHERE is_active;

CREATE TABLE bed_admissions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(id),
    branch_id          UUID NOT NULL REFERENCES branches(id),
    patient_id         UUID NOT NULL REFERENCES patients(id),
    bed_id             UUID NOT NULL REFERENCES beds(id),
    admitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expected_discharge DATE,
    discharged_at      TIMESTAMPTZ,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discharged')),
    daily_rate         NUMERIC(12,2) NOT NULL DEFAULT 0,
    deposit_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
    charged_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_due_at     TIMESTAMPTZ,
    deposit_charge_id  UUID,
    admitted_by        UUID,
    discharged_by      UUID,
    note               TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active admission per bed, and one active bed per patient.
CREATE UNIQUE INDEX ux_bed_admissions_bed_active ON bed_admissions(tenant_id, bed_id) WHERE status = 'active';
CREATE UNIQUE INDEX ux_bed_admissions_patient_active ON bed_admissions(tenant_id, patient_id) WHERE status = 'active';
CREATE INDEX idx_bed_admissions_active ON bed_admissions(tenant_id, branch_id, status);

-- Bed revenue is its own charge source.
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_source_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_check
    CHECK (source IN ('consultation','service','lab','pharmacy','refund','other','bed'));

-- Allow the new "inpatient" module flag (feature_flags.flag whitelist).
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
    CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr','finance_advanced','maternity','inpatient'));
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['wards','beds','bed_admissions']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON wards, beds, bed_admissions TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
    CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr','finance_advanced','maternity'));
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_source_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_check
    CHECK (source IN ('consultation','service','lab','pharmacy','refund','other'));
DROP TABLE IF EXISTS bed_admissions;
DROP TABLE IF EXISTS beds;
DROP TABLE IF EXISTS wards;
-- +goose StatementEnd
