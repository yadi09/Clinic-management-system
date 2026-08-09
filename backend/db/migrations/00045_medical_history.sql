-- +goose Up
-- +goose StatementBegin
-- Medical history questionnaire — the pre-treatment health check.
--
-- General clinics capture history through SOAP encounters; a dental clinic has no
-- encounters at all (chart → plans → sessions), so its patients had no medical
-- history anywhere. That is a safety gap, not a missing nicety: before injecting
-- anaesthetic, extracting a tooth or taking an X-ray the clinician must know about
-- anticoagulants, cardiac valves, bisphosphonates, pregnancy and infectious disease.
--
-- One row per patient — this is a living document that gets re-confirmed, not an
-- append-only log. Answers are stored as JSONB with the question catalogue owned by
-- the frontend (same contract as dental_charts.teeth), so a clinic's questionnaire
-- can grow without a migration. reviewed_at drives the "due for review" prompt:
-- a history taken three years ago is not a history.
CREATE TABLE medical_histories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    answers     JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes       TEXT,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_medical_history_patient ON medical_histories(tenant_id, patient_id);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  EXECUTE 'ALTER TABLE medical_histories ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE medical_histories FORCE ROW LEVEL SECURITY';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON medical_histories
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  $f$;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON medical_histories TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS medical_histories;
-- +goose StatementEnd
