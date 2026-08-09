-- +goose Up
-- +goose StatementBegin
-- Pregnancy dating (Maternity module). We store the method + raw inputs (JSONB),
-- not just the derived EDD, so a dating is recomputable and auditable; an
-- append-only history row is written on every change for redating traceability.
-- Clinical dates are DATE (timezone-free). Tenant-scoped + RLS like every table.
CREATE TABLE pregnancy_dating (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(id),
    patient_id           UUID NOT NULL REFERENCES patients(id),
    method               TEXT NOT NULL
                          CHECK (method IN ('LMP','ULTRASOUND','KNOWN_EDD','IVF','CONCEPTION')),
    inputs               JSONB NOT NULL,
    calculated_lmp       DATE NOT NULL,
    edd                  DATE NOT NULL,
    estimated_conception DATE NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_pregnancy_dating_patient ON pregnancy_dating(tenant_id, patient_id);

CREATE TABLE pregnancy_dating_history (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(id),
    patient_id           UUID NOT NULL REFERENCES patients(id),
    method               TEXT NOT NULL,
    inputs               JSONB NOT NULL,
    calculated_lmp       DATE NOT NULL,
    edd                  DATE NOT NULL,
    estimated_conception DATE NOT NULL,
    recorded_by          UUID REFERENCES users(id),
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    note                 TEXT
);
CREATE INDEX idx_pregnancy_dating_history_patient ON pregnancy_dating_history(tenant_id, patient_id, recorded_at DESC);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pregnancy_dating','pregnancy_dating_history']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON pregnancy_dating, pregnancy_dating_history TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS pregnancy_dating_history;
DROP TABLE IF EXISTS pregnancy_dating;
-- +goose StatementEnd
