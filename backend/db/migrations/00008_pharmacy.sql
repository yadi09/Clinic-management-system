-- +goose Up
-- +goose StatementBegin
-- Phase 4a: Pharmacy & Inventory (dispensing core).
--   * drugs            — the drug catalog (form, class, controlled, price, reorder level)
--   * drug_batches     — stock by batch with expiry (FEFO dispensing)
--   * stock_movements  — audit trail of every stock change
--   * pharmacy_sales / pharmacy_sale_items — the charge a dispense raises, and OTC sales
--   * prescriptions    — gain a dispense marker + a human Rx number
-- See docs/patient-workflow.md (pharmacy) and the pharmacist/manager mockups.

CREATE TABLE drugs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    name          TEXT NOT NULL,
    form          TEXT,                         -- tablet/capsule/inhaler/...
    drug_class    TEXT,                         -- Penicillin/Macrolide/... (enables class-aware allergy checks)
    is_controlled BOOLEAN NOT NULL DEFAULT false,
    unit_price    NUMERIC(12,2) NOT NULL DEFAULT 0,
    reorder_level INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID,
    deleted_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_drugs_name ON drugs(tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE drug_batches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    drug_id     UUID NOT NULL REFERENCES drugs(id),
    batch_no    TEXT NOT NULL,
    expiry_date DATE,
    qty_on_hand INTEGER NOT NULL DEFAULT 0,
    quarantined BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID,
    deleted_at  TIMESTAMPTZ
);
CREATE INDEX idx_drug_batches_fefo ON drug_batches(tenant_id, drug_id, expiry_date) WHERE deleted_at IS NULL;

CREATE TABLE stock_movements (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    drug_id    UUID NOT NULL REFERENCES drugs(id),
    batch_id   UUID REFERENCES drug_batches(id),
    delta      INTEGER NOT NULL,                -- negative = out (dispense/sale), positive = in (receive/adjust)
    reason     TEXT NOT NULL,                   -- dispense / otc_sale / adjust / receive / return
    ref_type   TEXT,
    ref_id     UUID,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID
);
CREATE INDEX idx_stock_movements_drug ON stock_movements(tenant_id, drug_id, created_at DESC);

CREATE TABLE pharmacy_sales (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id),
    sale_type        TEXT NOT NULL CHECK (sale_type IN ('dispense','otc')),
    patient_id       UUID REFERENCES patients(id),
    prescription_id  UUID REFERENCES prescriptions(id),
    status           TEXT NOT NULL DEFAULT 'charged' CHECK (status IN ('charged','paid','cancelled')),
    subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,
    total            NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency         TEXT NOT NULL DEFAULT 'ETB',
    counselling_notes TEXT,
    paid_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by       UUID,
    deleted_at       TIMESTAMPTZ
);
CREATE INDEX idx_pharmacy_sales_created ON pharmacy_sales(tenant_id, created_at DESC);

CREATE TABLE pharmacy_sale_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    sale_id     UUID NOT NULL REFERENCES pharmacy_sales(id) ON DELETE CASCADE,
    drug_id     UUID REFERENCES drugs(id),
    batch_id    UUID REFERENCES drug_batches(id),
    description TEXT NOT NULL,
    qty         INTEGER NOT NULL DEFAULT 1,
    unit_price  NUMERIC(12,2) NOT NULL DEFAULT 0,
    line_total  NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_pharmacy_sale_items_sale ON pharmacy_sale_items(sale_id);

-- Prescriptions: a dispense marker + a human-friendly Rx number.
CREATE SEQUENCE IF NOT EXISTS prescriptions_rx_no_seq;
ALTER TABLE prescriptions
    ADD COLUMN dispensed_at TIMESTAMPTZ,
    ADD COLUMN rx_no BIGINT NOT NULL DEFAULT nextval('prescriptions_rx_no_seq');
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['drugs','drug_batches','stock_movements','pharmacy_sales','pharmacy_sale_items']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON drugs, drug_batches, stock_movements, pharmacy_sales, pharmacy_sale_items TO clinic_app;
    GRANT USAGE, SELECT ON SEQUENCE prescriptions_rx_no_seq TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE prescriptions DROP COLUMN IF EXISTS rx_no, DROP COLUMN IF EXISTS dispensed_at;
DROP SEQUENCE IF EXISTS prescriptions_rx_no_seq;
DROP TABLE IF EXISTS pharmacy_sale_items;
DROP TABLE IF EXISTS pharmacy_sales;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS drug_batches;
DROP TABLE IF EXISTS drugs;
-- +goose StatementEnd
