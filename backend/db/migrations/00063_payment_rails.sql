-- +goose Up
-- +goose StatementBegin

-- How a clinic actually takes money.
--
-- Until now this was four hard-coded words — cash, card, mobile, transfer — written
-- into charges.payment_method as free text, and duplicated in three places in the
-- frontend (reception, cashier, the pharmacy OTC counter). Two of those four are not
-- payment methods at all: "mobile" could be Telebirr, M-Pesa, CBE Birr or Kaafi
-- eBirr, and "transfer" could be any bank. That vagueness has two costs.
--
-- The clinic cannot reconcile its own day: "Mobile 4,200 ETB" cannot be held against
-- any statement, because no statement is called "mobile". And nothing records WHICH
-- transfer paid a bill — a 1,000 ETB Telebirr payment is stored as the word "mobile"
-- and nothing else, so a disputed payment a month later has no evidence at all.
--
-- A rail is one real way this clinic is paid: cash, a card machine, or a named
-- account at a named provider. The clinic configures its own, so a picker shows two
-- or three real options instead of four abstractions. bank_key holds the provider's
-- identifier (cbe, telebirr, …) and account_number the clinic's own receiving
-- account — the two facts a receipt-verification service needs later, captured here
-- as a side effect of describing how you get paid.
CREATE TABLE payment_rails (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    -- Stable machine value, written to charges.payment_method so every existing
    -- report, Z-report grouping and receipt keeps working unchanged.
    key             TEXT NOT NULL,
    label           TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('cash','card','wallet','bank')),
    -- The provider, when there is one. NULL for cash and card: there is no receipt
    -- to look up and never will be.
    bank_key        TEXT,
    account_name    TEXT,
    account_number  TEXT,
    -- Whether the desk must record the transaction reference. Seeded false so the
    -- day this ships behaves exactly as the day before; a clinic turns it on per
    -- rail once its staff are used to entering one.
    needs_reference BOOLEAN NOT NULL DEFAULT false,
    active          BOOLEAN NOT NULL DEFAULT true,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);
CREATE INDEX idx_payment_rails_tenant ON payment_rails(tenant_id, active, sort_order);

COMMENT ON COLUMN payment_rails.key IS
  'Stable value written to charges.payment_method / pharmacy_sales.payment_method. Never rename in place — reports group on it.';
COMMENT ON COLUMN payment_rails.bank_key IS
  'Provider identifier for receipt verification (cbe, boa, telebirr, mpesa, cbebirr, dashen, awash, siinqee, kaafiebirr). NULL for cash and card.';

ALTER TABLE payment_rails ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_rails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_rails
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_rails TO clinic_app;
  END IF;
END $$;

-- Every existing tenant keeps exactly the four options it has today, with the same
-- stored values, so nothing changes until someone edits them. "Mobile money" and
-- "Bank transfer" are deliberately relabelled to read as the categories they are —
-- the clinic replaces them with named accounts when it is ready.
INSERT INTO payment_rails (tenant_id, key, label, kind, needs_reference, sort_order)
SELECT t.id, v.key, v.label, v.kind, false, v.ord
  FROM tenants t
  CROSS JOIN (VALUES
    ('cash',     'Cash',          'cash',   0),
    ('card',     'Card',          'card',   1),
    ('mobile',   'Mobile money',  'wallet', 2),
    ('transfer', 'Bank transfer', 'bank',   3)
  ) AS v(key, label, kind, ord)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- What was paid, and the proof of it. Nullable: cash has no reference, and rows
-- settled before this migration have neither.
ALTER TABLE charges
  ADD COLUMN payment_rail_id   UUID REFERENCES payment_rails(id),
  ADD COLUMN payment_reference TEXT;

ALTER TABLE pharmacy_sales
  ADD COLUMN payment_rail_id   UUID REFERENCES payment_rails(id),
  ADD COLUMN payment_reference TEXT;

-- One transfer pays for one thing.
--
-- The uniqueness cannot live on charges: a visit checkout settles every pending
-- charge a patient has under ONE payment, so the same reference legitimately appears
-- on several rows. What must be unique is the payment EVENT. This table is one row
-- per reference the clinic has accepted, and the primary key is the guard: a second
-- attempt to settle anything with the same reference fails in the database, not in a
-- reconciliation three weeks later.
--
-- It is also where receipt verification will hang when it arrives — verified_at, the
-- provider's request id, what their settlement check said — which is why it is a
-- table and not an index.
CREATE TABLE payment_references (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    payment_rail_id UUID NOT NULL REFERENCES payment_rails(id),
    reference       TEXT NOT NULL,
    -- What uniqueness is actually tested on: case and spacing are how the same
    -- receipt gets typed twice and looks like two.
    reference_norm  TEXT NOT NULL,
    receipt_no      BIGINT,
    patient_id      UUID REFERENCES patients(id),
    amount          NUMERIC(12,2),
    settled_by      UUID,
    settled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, payment_rail_id, reference_norm)
);
CREATE INDEX idx_payment_references_receipt ON payment_references(tenant_id, receipt_no);

ALTER TABLE payment_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_references FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_references
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_references TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS payment_references;
ALTER TABLE pharmacy_sales DROP COLUMN IF EXISTS payment_reference, DROP COLUMN IF EXISTS payment_rail_id;
ALTER TABLE charges DROP COLUMN IF EXISTS payment_reference, DROP COLUMN IF EXISTS payment_rail_id;
DROP TABLE IF EXISTS payment_rails;
-- +goose StatementEnd
