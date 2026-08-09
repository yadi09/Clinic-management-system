-- +goose Up
-- +goose StatementBegin
-- Clinic specialization: a clinic is created as a "type" (general medical vs
-- dental). The type drives a feature-flag preset at provisioning; a dental clinic
-- gets the "dental" module (odontogram + treatment plan + installment balance)
-- and a dedicated workspace in place of the encounter-centric general flow.
ALTER TABLE tenants ADD COLUMN clinic_type TEXT NOT NULL DEFAULT 'general'
    CHECK (clinic_type IN ('general','dental'));

-- Allow the new "dental" module flag (feature_flags.flag whitelist).
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
    CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr','finance_advanced','maternity','inpatient','dental'));

-- Dental fees are their own charge source (so Finance/Z-report bucket them apart).
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_source_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_check
    CHECK (source IN ('consultation','service','lab','pharmacy','refund','other','bed','dental'));

-- Odontogram: one row per patient, a JSONB map of tooth-code -> status
-- ({ "UR1":"decayed", "LL6":"filled", ... }, Palmer notation). Whole-map upsert.
CREATE TABLE dental_charts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    patient_id UUID NOT NULL REFERENCES patients(id),
    teeth      JSONB NOT NULL DEFAULT '{}',
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_dental_charts_patient ON dental_charts(tenant_id, patient_id);

-- Treatment plan: priced procedures the doctor plans/performs. "paid" is a
-- per-item flag the clinic ticks as installments come in; the running balance
-- (Σ fees − Σ settled dental charges) is what actually gates the unpaid flag.
CREATE TABLE treatment_items (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    patient_id UUID NOT NULL REFERENCES patients(id),
    procedure  TEXT NOT NULL,
    tooth      TEXT,
    fee        NUMERIC(12,2) NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','inprogress','done','cancelled')),
    paid       BOOLEAN NOT NULL DEFAULT false,
    note       TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_treatment_items_patient ON treatment_items(tenant_id, patient_id);

-- Visit history: what was actually done on a given date (procedure + tooth +
-- notes + prescription). Distinct from the plan (intent) above.
CREATE TABLE dental_visits (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    patient_id UUID NOT NULL REFERENCES patients(id),
    visit_date DATE NOT NULL,
    procedure  TEXT NOT NULL,
    tooth      TEXT,
    notes      TEXT,
    rx         TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dental_visits_patient ON dental_visits(tenant_id, patient_id, visit_date DESC);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dental_charts','treatment_items','dental_visits']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON dental_charts, treatment_items, dental_visits TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS dental_visits;
DROP TABLE IF EXISTS treatment_items;
DROP TABLE IF EXISTS dental_charts;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_source_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_check
    CHECK (source IN ('consultation','service','lab','pharmacy','refund','other','bed'));
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
    CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr','finance_advanced','maternity','inpatient'));
ALTER TABLE tenants DROP COLUMN IF EXISTS clinic_type;
-- +goose StatementEnd
