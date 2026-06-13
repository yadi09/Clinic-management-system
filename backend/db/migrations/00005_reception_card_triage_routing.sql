-- +goose Up
-- +goose StatementBegin
-- Phase 3a: Reception flow & routing.
--   * Clinic-level flow settings (card fee, free-window, triage, assignment mode)
--   * Card / consultation fee receipts (the appointment-gated "free follow-up" rule)
--   * Appointment coverage flags (a doctor-booked follow-up is free within a window)
--   * The visit spine (encounters) + triage vitals
--   * Queue routing: a stage (triage / with-doctor) and the assigned doctor
-- See docs/patient-workflow.md.

-- ---- Clinic flow settings (per-tenant; on the clinic profile) --------------
ALTER TABLE clinics
    ADD COLUMN card_fee_enabled  BOOLEAN       NOT NULL DEFAULT true,
    ADD COLUMN card_fee_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN card_currency     TEXT          NOT NULL DEFAULT 'ETB',
    ADD COLUMN free_window_days  INTEGER       NOT NULL DEFAULT 30,
    ADD COLUMN triage_required   BOOLEAN       NOT NULL DEFAULT false,
    ADD COLUMN doctor_assignment TEXT          NOT NULL DEFAULT 'manual'
        CHECK (doctor_assignment IN ('manual','auto'));

-- ---- Appointments: doctor-booked follow-up coverage ------------------------
-- A follow-up booked by a doctor is "covered" (no card fee) when attended on or
-- before free_until. Self-initiated walk-ins always pay, even within the window.
ALTER TABLE appointments
    ADD COLUMN is_followup BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN free_until  TIMESTAMPTZ;

-- ---- Queue routing: stage + assigned doctor --------------------------------
ALTER TABLE queue_entries
    ADD COLUMN stage                TEXT NOT NULL DEFAULT 'with_doctor'
        CHECK (stage IN ('triage','with_doctor')),
    ADD COLUMN assigned_provider_id UUID REFERENCES users(id);
CREATE INDEX idx_queue_provider ON queue_entries(tenant_id, assigned_provider_id, state)
    WHERE deleted_at IS NULL;
CREATE INDEX idx_queue_stage ON queue_entries(tenant_id, department_id, stage, state)
    WHERE deleted_at IS NULL;

-- ---- Card / consultation payments (receipts) -------------------------------
CREATE TABLE card_payments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    branch_id      UUID NOT NULL REFERENCES branches(id),
    patient_id     UUID NOT NULL REFERENCES patients(id),
    appointment_id UUID REFERENCES appointments(id),
    amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency       TEXT NOT NULL DEFAULT 'ETB',
    waived         BOOLEAN NOT NULL DEFAULT false,
    waive_reason   TEXT,
    paid_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_by    UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ
);
CREATE INDEX idx_card_payments_patient ON card_payments(tenant_id, patient_id, paid_at DESC);

-- ---- Encounters (the visit spine; one per queue entry) ---------------------
CREATE TABLE encounters (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    branch_id      UUID NOT NULL REFERENCES branches(id),
    department_id  UUID REFERENCES departments(id),
    patient_id     UUID NOT NULL REFERENCES patients(id),
    queue_entry_id UUID REFERENCES queue_entries(id),
    provider_id    UUID REFERENCES users(id),
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     UUID,
    deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_encounters_queue_entry ON encounters(queue_entry_id)
    WHERE queue_entry_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_encounters_patient ON encounters(tenant_id, patient_id, started_at DESC);

-- ---- Vitals (recorded at triage / during the encounter) --------------------
CREATE TABLE vitals (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    patient_id   UUID NOT NULL REFERENCES patients(id),
    systolic     INTEGER,
    diastolic    INTEGER,
    pulse        INTEGER,
    temp_c       NUMERIC(4,1),
    resp_rate    INTEGER,
    spo2         INTEGER,
    weight_kg    NUMERIC(5,2),
    height_cm    NUMERIC(5,1),
    notes        TEXT,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_by  UUID,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vitals_encounter ON vitals(encounter_id);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['card_payments','encounters','vitals']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON card_payments, encounters, vitals TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS vitals;
DROP TABLE IF EXISTS encounters;
DROP TABLE IF EXISTS card_payments;
DROP INDEX IF EXISTS idx_queue_stage;
DROP INDEX IF EXISTS idx_queue_provider;
ALTER TABLE queue_entries DROP COLUMN IF EXISTS assigned_provider_id, DROP COLUMN IF EXISTS stage;
ALTER TABLE appointments DROP COLUMN IF EXISTS free_until, DROP COLUMN IF EXISTS is_followup;
ALTER TABLE clinics
    DROP COLUMN IF EXISTS doctor_assignment,
    DROP COLUMN IF EXISTS triage_required,
    DROP COLUMN IF EXISTS free_window_days,
    DROP COLUMN IF EXISTS card_currency,
    DROP COLUMN IF EXISTS card_fee_amount,
    DROP COLUMN IF EXISTS card_fee_enabled;
-- +goose StatementEnd
