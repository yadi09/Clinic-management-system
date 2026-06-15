-- +goose Up
-- +goose StatementBegin
-- Phase 4b-2: pharmacy supply chain + stock control.
--   * suppliers
--   * purchase_orders / po_items (receiving creates batches + stock movements)
--   * stock_counts / stock_count_items (count → variance → adjust → approve)

CREATE TABLE suppliers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    name           TEXT NOT NULL,
    contact        TEXT,
    lead_time_days INTEGER NOT NULL DEFAULT 0,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     UUID,
    deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_suppliers_name ON suppliers(tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE SEQUENCE IF NOT EXISTS purchase_orders_po_no_seq;
CREATE TABLE purchase_orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    po_no         BIGINT NOT NULL DEFAULT nextval('purchase_orders_po_no_seq'),
    supplier_id   UUID NOT NULL REFERENCES suppliers(id),
    status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','received','cancelled')),
    expected_date DATE,
    total         NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes         TEXT,
    received_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID,
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(tenant_id, status) WHERE deleted_at IS NULL;

CREATE TABLE po_items (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    po_id      UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    drug_id    UUID NOT NULL REFERENCES drugs(id),
    qty        INTEGER NOT NULL DEFAULT 0,
    unit_cost  NUMERIC(12,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    received   BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_po_items_po ON po_items(po_id);

CREATE TABLE stock_counts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved')),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by  UUID,
    approved_at TIMESTAMPTZ,
    approved_by UUID
);
CREATE INDEX idx_stock_counts_tenant ON stock_counts(tenant_id, created_at DESC);

CREATE TABLE stock_count_items (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    count_id  UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
    drug_id   UUID NOT NULL REFERENCES drugs(id),
    on_hand   INTEGER NOT NULL DEFAULT 0,
    counted   INTEGER NOT NULL DEFAULT 0,
    adjusted  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_stock_count_items_count ON stock_count_items(count_id);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','purchase_orders','po_items','stock_counts','stock_count_items']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers, purchase_orders, po_items, stock_counts, stock_count_items TO clinic_app;
    GRANT USAGE, SELECT ON SEQUENCE purchase_orders_po_no_seq TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS stock_count_items;
DROP TABLE IF EXISTS stock_counts;
DROP TABLE IF EXISTS po_items;
DROP TABLE IF EXISTS purchase_orders;
DROP SEQUENCE IF EXISTS purchase_orders_po_no_seq;
DROP TABLE IF EXISTS suppliers;
-- +goose StatementEnd
