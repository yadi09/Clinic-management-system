-- +goose Up
-- +goose StatementBegin

-- A stay is a sequence of beds, not one bed.
--
-- bed_admissions carries a single bed_id and a single daily_rate, and Transfer
-- overwrote BOTH with the new bed's. Discharge then billed the whole stay at whatever
-- rate the patient happened to end on. Measured on the live system: ten nights in a
-- 300/day bed followed by one night in a 3,000/day ICU bed billed 33,000 instead of
-- 6,000 — a 5.5x overcharge, and the reverse transfer undercharges just as badly.
-- There was nowhere to record what the patient actually occupied, so the history was
-- destroyed by the update rather than merely mis-read.
--
-- One row per bed the patient occupies, with the rate at the time. The admission row
-- keeps bed_id/daily_rate as the CURRENT bed, which is what the board reads; money is
-- computed from the segments.
CREATE TABLE bed_admission_stays (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    admission_id UUID NOT NULL REFERENCES bed_admissions(id) ON DELETE CASCADE,
    bed_id       UUID NOT NULL REFERENCES beds(id),
    daily_rate   NUMERIC(12,2) NOT NULL DEFAULT 0,
    from_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL while the patient is still in this bed.
    to_at        TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bed_stays_admission ON bed_admission_stays(tenant_id, admission_id, from_at);
-- One open segment per admission: a patient cannot be in two beds at once.
CREATE UNIQUE INDEX ux_bed_stays_open ON bed_admission_stays(tenant_id, admission_id) WHERE to_at IS NULL;

-- Existing admissions become a single segment, which is exactly what they were before
-- a transfer could split them. Anything already transferred cannot be reconstructed —
-- the old rate is gone — so it keeps the rate now on the row, unchanged from what it
-- would have billed anyway.
INSERT INTO bed_admission_stays (tenant_id, admission_id, bed_id, daily_rate, from_at, to_at)
SELECT tenant_id, id, bed_id, daily_rate, admitted_at,
       CASE WHEN status = 'discharged' THEN coalesce(discharged_at, updated_at) END
FROM bed_admissions;

-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  ALTER TABLE bed_admission_stays ENABLE ROW LEVEL SECURITY;
  ALTER TABLE bed_admission_stays FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON bed_admission_stays
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON bed_admission_stays TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS bed_admission_stays;
-- +goose StatementEnd
