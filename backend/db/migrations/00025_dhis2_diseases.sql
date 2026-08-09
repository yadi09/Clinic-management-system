-- +goose Up
-- +goose StatementBegin
-- DHIS2 Disease Registration showcase: the month's top-10 diseases with patient
-- counts by age band × sex, stored per clinic so the "Push to DHIS2" action can
-- expand them into the national dataset's data values. The DHIS2 dataElement id
-- lives on the row (editable); counts are stored as JSON keyed by {M|F}_{ageband}.
CREATE TABLE dhis2_diseases (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    rank         INTEGER NOT NULL,          -- 1..10, display + column order
    name         TEXT NOT NULL,             -- disease label
    data_element TEXT NOT NULL,             -- DHIS2 dataElement id (verified)
    counts       JSONB NOT NULL DEFAULT '{}'::jsonb, -- {"M_5_14":1,"F_15_29":8,...}
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_dhis2_diseases_rank ON dhis2_diseases(tenant_id, rank);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  EXECUTE 'ALTER TABLE dhis2_diseases ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE dhis2_diseases FORCE ROW LEVEL SECURITY';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON dhis2_diseases
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  $f$;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON dhis2_diseases TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS dhis2_diseases;
-- +goose StatementEnd
