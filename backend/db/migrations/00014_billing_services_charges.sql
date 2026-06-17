-- +goose Up
-- +goose StatementBegin
-- Phase Billing-1: configurable service catalog + a unified charges spine + a
-- payment_mode switch. The existing card-fee flow (card_payments) is left intact;
-- the new charges/cashier system is additive and only drives the flow when a
-- clinic switches payment_mode to 'cashier'.

-- What's billable and how much (admin-configurable).
CREATE TABLE service_items (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    code       TEXT NOT NULL,
    name       TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT 'general',
    price      NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency   TEXT NOT NULL DEFAULT 'ETB',
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_service_items_code ON service_items(tenant_id, lower(code)) WHERE deleted_at IS NULL;

-- A charge raised against a patient for a service. The cashier settles or waives it.
CREATE TABLE charges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    patient_id      UUID NOT NULL REFERENCES patients(id),
    encounter_id    UUID REFERENCES encounters(id),
    service_item_id UUID REFERENCES service_items(id),
    source          TEXT NOT NULL DEFAULT 'service' CHECK (source IN ('consultation','service','lab','pharmacy','other')),
    description     TEXT NOT NULL,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'ETB',
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','waived','void')),
    payment_method  TEXT,
    waive_reason    TEXT,
    -- Routing for a cashier-mode consultation charge: on settlement the patient is
    -- enqueued to this department / provider (the "auto-advance after payment").
    branch_id       UUID REFERENCES branches(id),
    department_id   UUID REFERENCES departments(id),
    to_triage       BOOLEAN NOT NULL DEFAULT false,
    provider_id     UUID REFERENCES users(id),
    enqueued        BOOLEAN NOT NULL DEFAULT false,
    created_by      UUID,
    settled_by      UUID,
    settled_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX idx_charges_pending ON charges(tenant_id, created_at) WHERE status = 'pending' AND deleted_at IS NULL;
CREATE INDEX idx_charges_patient ON charges(tenant_id, patient_id, created_at DESC);
CREATE INDEX idx_charges_settled ON charges(tenant_id, settled_at DESC) WHERE status IN ('paid','waived');

-- Payment mode: 'reception' collects inline (today); 'cashier' routes to a cashier.
ALTER TABLE clinics ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'reception'
    CHECK (payment_mode IN ('reception','cashier'));
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_items','charges']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON service_items, charges TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE clinics DROP COLUMN IF EXISTS payment_mode;
DROP TABLE IF EXISTS charges;
DROP TABLE IF EXISTS service_items;
-- +goose StatementEnd
