-- +goose Up
-- +goose StatementBegin
-- Phase 5a: Laboratory.
--   * lab_tests / lab_analytes      — admin-configurable test catalog (drives flagging)
--   * lab_orders / lab_order_items  — a doctor's order; one item (sample) per test
--   * lab_results                   — per-analyte results with an auto-flag
--   * encounters gain an 'awaiting_results' status (parked while labs run)

CREATE TABLE lab_tests (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    code       TEXT NOT NULL,
    name       TEXT NOT NULL,
    specimen   TEXT,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_lab_tests_code ON lab_tests(tenant_id, lower(code)) WHERE deleted_at IS NULL;

CREATE TABLE lab_analytes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    test_id       UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    unit          TEXT,
    ref_low       NUMERIC(12,2),
    ref_high      NUMERIC(12,2),
    critical_low  NUMERIC(12,2),
    critical_high NUMERIC(12,2),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lab_analytes_test ON lab_analytes(test_id);

CREATE SEQUENCE IF NOT EXISTS lab_sample_no_seq START 8800;

CREATE TABLE lab_orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    order_no      BIGINT NOT NULL DEFAULT nextval('lab_sample_no_seq'),
    encounter_id  UUID REFERENCES encounters(id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    provider_id   UUID REFERENCES users(id),
    priority      TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','stat')),
    clinical_note TEXT,
    status        TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','accessioned','in_process','resulted','validated','cancelled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID,
    deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_lab_orders_patient ON lab_orders(tenant_id, patient_id, created_at DESC);
CREATE INDEX idx_lab_orders_encounter ON lab_orders(encounter_id) WHERE deleted_at IS NULL;

CREATE TABLE lab_order_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    order_id      UUID NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
    test_id       UUID NOT NULL REFERENCES lab_tests(id),
    sample_no     BIGINT NOT NULL DEFAULT nextval('lab_sample_no_seq'),
    specimen      TEXT,
    status        TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','collected','in_process','resulted','validated','cancelled')),
    collected_by  TEXT,
    collected_at  TIMESTAMPTZ,
    resulted_at   TIMESTAMPTZ,
    validated_at  TIMESTAMPTZ,
    validated_by  UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lab_order_items_order ON lab_order_items(order_id);
CREATE INDEX idx_lab_order_items_status ON lab_order_items(tenant_id, status);

CREATE TABLE lab_results (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    order_item_id UUID NOT NULL REFERENCES lab_order_items(id) ON DELETE CASCADE,
    analyte_id    UUID NOT NULL REFERENCES lab_analytes(id),
    value         TEXT,
    flag          TEXT NOT NULL DEFAULT 'normal' CHECK (flag IN ('normal','high','low','critical')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_lab_results_item_analyte ON lab_results(order_item_id, analyte_id);

-- Encounters: parked-while-awaiting-results status.
ALTER TABLE encounters DROP CONSTRAINT IF EXISTS encounters_status_check;
ALTER TABLE encounters ADD CONSTRAINT encounters_status_check CHECK (status IN ('open','awaiting_results','closed'));
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['lab_tests','lab_analytes','lab_orders','lab_order_items','lab_results']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON lab_tests, lab_analytes, lab_orders, lab_order_items, lab_results TO clinic_app;
    GRANT USAGE, SELECT ON SEQUENCE lab_sample_no_seq TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE encounters DROP CONSTRAINT IF EXISTS encounters_status_check;
ALTER TABLE encounters ADD CONSTRAINT encounters_status_check CHECK (status IN ('open','closed'));
DROP TABLE IF EXISTS lab_results;
DROP TABLE IF EXISTS lab_order_items;
DROP TABLE IF EXISTS lab_orders;
DROP SEQUENCE IF EXISTS lab_sample_no_seq;
DROP TABLE IF EXISTS lab_analytes;
DROP TABLE IF EXISTS lab_tests;
-- +goose StatementEnd
