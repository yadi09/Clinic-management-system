-- +goose Up
-- +goose StatementBegin
-- Structured dental treatment plans: one treatment (e.g. root canal) that runs
-- over months as a schedule of dated SESSIONS. Each session carries its own
-- amount (a slice of the plan total), status, notes/Rx, payment (a dental charge),
-- and images. Replaces the old flat treatment_items + dental_visits (left intact).
CREATE TABLE treatment_plans (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    patient_id     UUID NOT NULL REFERENCES patients(id),
    title          TEXT NOT NULL,
    tooth          TEXT,
    total_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
    start_date     DATE NOT NULL,
    interval_unit  TEXT NOT NULL DEFAULT 'month' CHECK (interval_unit IN ('day','week','month')),
    interval_count INT  NOT NULL DEFAULT 1,
    session_count  INT  NOT NULL DEFAULT 1,
    deadline       DATE,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
    note           TEXT,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_treatment_plans_patient ON treatment_plans(tenant_id, patient_id);

CREATE TABLE treatment_sessions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    plan_id        UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
    patient_id     UUID NOT NULL REFERENCES patients(id),
    seq            INT  NOT NULL,
    scheduled_date DATE NOT NULL,
    amount_due     NUMERIC(12,2) NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','cancelled')),
    charge_id      UUID,  -- the dental charge raised for this session (payment state derived from it)
    notes          TEXT,
    rx             TEXT,
    created_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_treatment_sessions_plan ON treatment_sessions(tenant_id, plan_id, seq);
CREATE INDEX idx_treatment_sessions_patient ON treatment_sessions(tenant_id, patient_id);

-- Images can be filed under a specific session (that visit's X-rays); NULL = general.
ALTER TABLE attachments ADD COLUMN treatment_session_id UUID;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['treatment_plans','treatment_sessions']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON treatment_plans, treatment_sessions TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE attachments DROP COLUMN IF EXISTS treatment_session_id;
DROP TABLE IF EXISTS treatment_sessions;
DROP TABLE IF EXISTS treatment_plans;
-- +goose StatementEnd
