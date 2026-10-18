-- +goose Up
-- +goose StatementBegin

-- Pay from home. A patient pays what is already billed (or the next visit ahead of time)
-- by transferring money from their own phone, then types the transaction number. The
-- bank check decides; nothing is marked paid on the patient's word.
--
-- Off by default, and separate from "show payments": a clinic may let patients SEE their
-- money long before it lets them pay.
ALTER TABLE portal_settings ADD COLUMN allow_pay BOOLEAN NOT NULL DEFAULT false;

-- One row per attempt. The receipt is the clinic's usual one (charges + payment_references);
-- this table is the patient-facing story and the cashier's list of attempts nobody has
-- confirmed yet.
CREATE TABLE portal_payments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    patient_id     UUID NOT NULL REFERENCES patients(id),
    rail_id        UUID NOT NULL REFERENCES payment_rails(id),
    reference      TEXT NOT NULL,
    reference_norm TEXT NOT NULL,
    -- What the server worked out is owed for the chosen items. Never the browser's figure.
    amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    -- [{kind: charge|session, id, label, amount}] as they were when the patient chose.
    items          JSONB NOT NULL,
    -- checking: the bank is being asked. waiting: nobody has confirmed it yet — the
    -- cashier does. paid: settled, receipt_no is set. rejected: the bank (or the cashier) said no.
    state          TEXT NOT NULL CHECK (state IN ('checking','waiting','paid','rejected')),
    -- In the patient's words, shown on their page.
    reason         TEXT,
    -- What the bank check said, for the cashier: verified | rejected | review | pending | unchecked.
    verify_state   TEXT,
    verify_reason  TEXT,
    receipt_no     BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_by     UUID
);
-- A transaction number can be in flight or paid once. A rejected attempt does not hold it,
-- so a corrected typo can be sent again.
CREATE UNIQUE INDEX idx_portal_payments_ref ON portal_payments(tenant_id, rail_id, reference_norm)
    WHERE state IN ('checking','waiting','paid');
CREATE INDEX idx_portal_payments_open ON portal_payments(tenant_id, created_at DESC) WHERE state IN ('checking','waiting');
CREATE INDEX idx_portal_payments_patient ON portal_payments(tenant_id, patient_id, created_at DESC);

ALTER TABLE portal_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON portal_payments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON portal_payments TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS portal_payments;
ALTER TABLE portal_settings DROP COLUMN IF EXISTS allow_pay;
-- +goose StatementEnd
