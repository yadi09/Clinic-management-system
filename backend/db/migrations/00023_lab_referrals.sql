-- +goose Up
-- +goose StatementBegin
-- Phase RX-LAB-REFERRAL: external lab referrals for clinics without an in-house
-- lab. The doctor requests tests (free-text) → prints a request the patient takes
-- to an outside lab → the result is recorded back on the encounter when the
-- patient returns. Flexible result: any of a summary note, structured values, or
-- attached scans. Independent of the in-house `laboratory` feature flag.
CREATE TABLE lab_referrals (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    encounter_id   UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    patient_id     UUID NOT NULL REFERENCES patients(id),
    tests          TEXT NOT NULL,                 -- requested tests, free-text (one per line)
    indication     TEXT,                          -- clinical indication / note to the lab
    status         TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','resulted','cancelled')),
    -- Result intake (any subset may be filled):
    result_summary TEXT,                          -- interpretation / key findings
    result_values  JSONB,                         -- optional structured rows [{name,value,unit,ref,flag}]
    result_files   JSONB,                         -- optional attached scans [{key,url,name,mime}]
    external_lab   TEXT,                          -- which outside lab produced it
    resulted_at    TIMESTAMPTZ,
    resulted_by    UUID,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ
);
CREATE INDEX idx_lab_referrals_encounter ON lab_referrals(tenant_id, encounter_id) WHERE deleted_at IS NULL;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  EXECUTE 'ALTER TABLE lab_referrals ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE lab_referrals FORCE ROW LEVEL SECURITY';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON lab_referrals
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  $f$;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON lab_referrals TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS lab_referrals;
-- +goose StatementEnd
