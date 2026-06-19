-- +goose Up
-- +goose StatementBegin
-- Phase BILL-B: cash control — sequential receipt numbers, and an end-of-day
-- cash reconciliation (Z-report) so a cashier's drawer can be balanced.

-- Per-tenant monotonic counters (receipt numbers, etc.). Incremented atomically.
CREATE TABLE billing_counters (
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name      TEXT NOT NULL,
    value     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, name)
);

-- A human-friendly, per-tenant receipt number stamped when money changes hands.
ALTER TABLE charges ADD COLUMN receipt_no BIGINT;
CREATE INDEX idx_charges_receipt ON charges(tenant_id, receipt_no) WHERE receipt_no IS NOT NULL;

-- One end-of-day cash closeout per cashier per business day.
CREATE TABLE cash_reconciliations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    cashier_id     UUID NOT NULL REFERENCES users(id),
    business_date  DATE NOT NULL,
    expected_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    counted_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
    variance       NUMERIC(12,2) NOT NULL DEFAULT 0,
    by_method      JSONB NOT NULL DEFAULT '{}',
    note           TEXT,
    closed_by      UUID,
    closed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_cash_recon_unique ON cash_reconciliations(tenant_id, cashier_id, business_date);
CREATE INDEX idx_cash_recon_list ON cash_reconciliations(tenant_id, business_date DESC);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_counters','cash_reconciliations']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON billing_counters, cash_reconciliations TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS cash_reconciliations;
DROP INDEX IF EXISTS idx_charges_receipt;
ALTER TABLE charges DROP COLUMN IF EXISTS receipt_no;
DROP TABLE IF EXISTS billing_counters;
-- +goose StatementEnd
