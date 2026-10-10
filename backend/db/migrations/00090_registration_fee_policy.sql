-- +goose Up
-- +goose StatementBegin

-- How often a patient pays the clinic's registration fee (FEAT-REG-1).
--
-- Until now every service tagged "default" was charged on every day a patient
-- arrived. Clinics differ: one charges registration once in a patient's life,
-- another again after a week, a month or two. One row per clinic says which of its
-- arrival services is the registration fee and how often it is due. No row, or
-- rule 'every_visit', is the old behaviour, so nothing changes for a clinic until it
-- chooses.
CREATE TABLE registration_fee_policies (
    tenant_id                 UUID PRIMARY KEY REFERENCES tenants(id),
    service_item_id           UUID REFERENCES service_items(id),
    rule                      TEXT NOT NULL DEFAULT 'every_visit'
                              CHECK (rule IN ('every_visit', 'once', 'every')),
    -- rule 'every': due again this long after the last registration fee.
    every_count               INT CHECK (every_count IS NULL OR every_count BETWEEN 1 AND 3650),
    every_unit                TEXT CHECK (every_unit IS NULL OR every_unit IN ('day', 'week', 'month')),
    -- Patients brought over from the paper register already registered on paper.
    paper_patients_registered BOOLEAN NOT NULL DEFAULT true,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                UUID,
    CHECK (rule <> 'every' OR (every_count IS NOT NULL AND every_unit IS NOT NULL))
);

ALTER TABLE registration_fee_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_fee_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registration_fee_policies
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON registration_fee_policies TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS registration_fee_policies;
-- +goose StatementEnd
