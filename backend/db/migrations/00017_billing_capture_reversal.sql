-- +goose Up
-- +goose StatementBegin
-- Phase Billing-A: capture lab & pharmacy revenue into the unified charges spine
-- (so the two biggest service lines are billed and show up in cashier + Finance),
-- and make charges reversible — void a still-pending charge (keying error / patient
-- left), refund a settled one via a linked negative reversing entry.

-- Lab tests carry a catalog-managed price; placing an order raises one lab charge,
-- and that charge gates sample accession (pre-pay).
ALTER TABLE lab_tests  ADD COLUMN price NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE lab_orders ADD COLUMN charge_id UUID;

-- Pharmacy two-phase dispense: 'awaiting_payment' holds the priced sale (no stock
-- moved yet) until the cashier collects; charge_id links it to the billing charge.
ALTER TABLE pharmacy_sales ADD COLUMN charge_id UUID;
ALTER TABLE pharmacy_sales DROP CONSTRAINT IF EXISTS pharmacy_sales_status_check;
ALTER TABLE pharmacy_sales ADD CONSTRAINT pharmacy_sales_status_check
    CHECK (status IN ('awaiting_payment','charged','paid','cancelled','dispensed'));

-- Charges: reversibility.
--   * void   — a pending charge is retired (mistake / patient left); reason + actor.
--   * refund — a settled charge gets a linked negative 'refund' entry dated now, so
--              historical day/Z reports stay correct and the refund is visible.
ALTER TABLE charges ADD COLUMN void_reason        TEXT;
ALTER TABLE charges ADD COLUMN voided_by          UUID;
ALTER TABLE charges ADD COLUMN voided_at          TIMESTAMPTZ;
ALTER TABLE charges ADD COLUMN reverses_charge_id UUID REFERENCES charges(id);

ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_source_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_check
    CHECK (source IN ('consultation','service','lab','pharmacy','refund','other'));

-- A charge may be voided as well as pending → keep the status CHECK as-is
-- ('pending','paid','waived','void'); 'void' already exists.

-- Find a refund quickly and prevent double-refund.
CREATE INDEX idx_charges_reverses ON charges(reverses_charge_id) WHERE reverses_charge_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_charges_reverses;
ALTER TABLE charges DROP CONSTRAINT IF EXISTS charges_source_check;
ALTER TABLE charges ADD CONSTRAINT charges_source_check
    CHECK (source IN ('consultation','service','lab','pharmacy','other'));
ALTER TABLE charges DROP COLUMN IF EXISTS reverses_charge_id;
ALTER TABLE charges DROP COLUMN IF EXISTS voided_at;
ALTER TABLE charges DROP COLUMN IF EXISTS voided_by;
ALTER TABLE charges DROP COLUMN IF EXISTS void_reason;

ALTER TABLE pharmacy_sales DROP CONSTRAINT IF EXISTS pharmacy_sales_status_check;
ALTER TABLE pharmacy_sales ADD CONSTRAINT pharmacy_sales_status_check
    CHECK (status IN ('charged','paid','cancelled'));
ALTER TABLE pharmacy_sales DROP COLUMN IF EXISTS charge_id;

ALTER TABLE lab_orders DROP COLUMN IF EXISTS charge_id;
ALTER TABLE lab_tests  DROP COLUMN IF EXISTS price;
-- +goose StatementEnd
