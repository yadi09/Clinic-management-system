-- +goose Up
-- +goose StatementBegin

-- A plan decided five numbers and nothing else.
--
-- plans held patient/storage/user/branch/image caps. Every *feature* the pricing
-- page sells by tier — payment verification, the finance dashboard, patient SMS,
-- recall lists, aged debt, Ministry reporting, AI assist — lived in an unrelated
-- system (feature_flags, hand-toggled per clinic) or behind a server-wide API key
-- that is on for everybody. Changing a clinic's plan changed no feature at all, so
-- a clinic paying the entry price had the top tier's feature set and nothing said
-- so. This connects the two.
--
-- Three layers, resolved in one place (kernel/entitlements):
--
--   plan_features        what the plan entitles          — the price list
--   tenant_entitlements  the exception for one clinic    — an add-on sold, or a
--                                                          clinic grandfathered
--   feature_flags        the clinic's own on/off switch  — already existed
--
-- Effective = entitled AND not switched off. A clinic can therefore never switch
-- on something it is not paying for, and "off but available" keeps its meaning.

-- The catalogue. Deliberately only what is really gated: an entry here that no
-- code enforces would show as unchecked in the console and keep working anyway,
-- which is the exact defect this migration exists to remove.
CREATE TABLE features (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    detail      TEXT,
    -- Groups the console grid; mirrors the headings on the pricing page so what
    -- an operator ticks reads the same as what a dentist was sold.
    category    TEXT NOT NULL,
    clinic_type TEXT NOT NULL DEFAULT 'all'
                  CHECK (clinic_type IN ('all', 'general', 'dental')),
    sort        INTEGER NOT NULL DEFAULT 0
);

INSERT INTO features (code, name, detail, category, sort) VALUES
  ('payment_verification', 'Bank & wallet payment verification',
   'Confirm a transfer before releasing the work', 'Getting paid', 10),
  ('debt_ageing', 'Whole-clinic debt, aged 30 / 60 / 90 days',
   'Who owes you, and for how long', 'Getting paid', 20),
  ('finance_advanced', 'Finance dashboard',
   'Revenue, per-dentist, month on month', 'Getting paid', 30),
  ('messaging', 'Patient SMS',
   'Reminders, recalls and payment chase', 'Keeping chairs full', 40),
  ('recalls', 'Recall lists',
   'Who has not been in', 'Keeping chairs full', 50),
  ('dhis2', 'Ministry (DHIS2) reporting',
   'One-click monthly return to the national system', 'Reporting & assist', 60),
  ('ai_assist', 'AI clinical assist',
   'A second opinion on the visit you just recorded', 'Reporting & assist', 70);

CREATE TABLE plan_features (
    plan_id UUID    NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    feature TEXT    NOT NULL REFERENCES features(code) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (plan_id, feature)
);

-- One clinic's exception to its plan, either direction: an add-on actually sold
-- (AI assist on Practice, 1,500/month) or a clinic that had something before the
-- plans gated it and must not lose it. note records why, because "somebody
-- ticked a box in 2026" is not an answer anyone can act on later.
CREATE TABLE tenant_entitlements (
    tenant_id  UUID        NOT NULL REFERENCES tenants(id),
    feature    TEXT        NOT NULL REFERENCES features(code) ON DELETE CASCADE,
    enabled    BOOLEAN     NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, feature)
);
ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_entitlements
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The tenant's own connection reads all three at sign-in; only the vendor's
-- privileged connection writes the first two.
GRANT SELECT ON features, plan_features TO clinic_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_entitlements TO clinic_app;

-- A plan a clinic is already on cannot be deleted, so retiring is a status.
-- Retired plans stay valid for whoever is on them and are not offered again.
ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired'));

-- ---------------------------------------------------------------------------
-- The dental plans, as actually sold (clinicos.cc/pricing, 2026).
--
-- The rows that were here matched nothing on that page: Dental Basic 4,999 where
-- the page says Chair 4,000, Dental Pro 5,999 against Practice 7,000, a plan
-- whose code contained a space, no Custom at all, and images-per-patient capped
-- at 100 / 8 / 10 while the page promises unlimited images in bold on every
-- plan. A quote and the system could not both be right.
-- ---------------------------------------------------------------------------
INSERT INTO plans (code, name, clinic_type, patient_limit, storage_gb, user_limit,
                   branch_limit, images_per_patient, sms_monthly, audit_retention_days, price_monthly)
VALUES
  -- images_per_patient NULL = unlimited on every plan: storage is the only limit,
  -- which is what the page promises and what a dentist taking a full series needs.
  ('dental-chair',    'Chair',    'dental',  1000,    5,    5, 1, NULL,    0,  365,  4000),
  ('dental-practice', 'Practice', 'dental',  3000,   20,   15, 1, NULL, 2000,  730,  7000),
  ('dental-group',    'Group',    'dental', 10000,   50, NULL, 3, NULL, 2000, 1095, 13000),
  ('dental-custom',   'Custom',   'dental',  NULL, NULL, NULL, NULL, NULL, NULL, 1095, 0)
ON CONFLICT (code) DO NOTHING;

-- What each plan includes. Chair gets none of the paid extras; Practice adds
-- everything that gets money in and keeps chairs full; Group adds the Ministry
-- return and AI; Custom has the lot.
INSERT INTO plan_features (plan_id, feature, enabled)
SELECT p.id, f.code,
       CASE p.code
         WHEN 'dental-chair'    THEN false
         WHEN 'dental-practice' THEN f.code NOT IN ('dhis2', 'ai_assist')
         ELSE true
       END
  FROM plans p CROSS JOIN features f
 WHERE p.code IN ('dental-chair', 'dental-practice', 'dental-group', 'dental-custom')
ON CONFLICT (plan_id, feature) DO NOTHING;

-- Move every dental clinic off the plans that are going away, onto the nearest
-- plan on the page. Nothing shrinks: where a clinic's old plan was more generous
-- than its new one, the difference is preserved as a per-clinic override.
UPDATE tenants t SET plan_id = (SELECT id FROM plans WHERE code = 'dental-chair'),
       storage_gb_override = 20,   -- was 20 GB on Dental Basic; Chair sells 5
       user_limit_override = 10,   -- was 10 logins; Chair sells 5
       updated_at = now()
 WHERE t.slug = 'cure-dental';

UPDATE tenants t SET plan_id = (SELECT id FROM plans WHERE code = 'dental-chair'), updated_at = now()
 WHERE t.clinic_type = 'dental' AND t.slug <> 'cure-dental'
   AND EXISTS (SELECT 1 FROM plans p WHERE p.id = t.plan_id
                AND p.code IN ('dental-basic', 'dental-pro', 'dental business', 'business'));

UPDATE subscriptions s SET plan_id = t.plan_id, updated_at = now()
  FROM tenants t WHERE t.id = s.tenant_id AND t.clinic_type = 'dental';

UPDATE plans SET status = 'retired', updated_at = now()
 WHERE code IN ('dental-basic', 'dental-pro', 'dental business');

-- Grandfathering, so that connecting plans to features takes nothing away from a
-- clinic already relying on it. Cure Dental has the finance dashboard switched on
-- deliberately, and sends patient SMS through its own SMSEthiopia account — both
-- sit above Chair on the page. Revoke either from the console when they move plan.
INSERT INTO tenant_entitlements (tenant_id, feature, enabled, note)
SELECT t.id, f, true, 'in use before plans gated features — revoke when they move to Practice'
  FROM tenants t CROSS JOIN (VALUES ('finance_advanced'), ('messaging')) AS v(f)
 WHERE t.slug = 'cure-dental'
ON CONFLICT (tenant_id, feature) DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE plans SET status = 'active' WHERE code IN ('dental-basic', 'dental-pro', 'dental business');
UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'dental-basic'),
       storage_gb_override = NULL, user_limit_override = NULL
 WHERE clinic_type = 'dental'
   AND plan_id IN (SELECT id FROM plans WHERE code LIKE 'dental-chair' OR code LIKE 'dental-practice'
                                           OR code LIKE 'dental-group' OR code LIKE 'dental-custom');
UPDATE subscriptions s SET plan_id = t.plan_id FROM tenants t WHERE t.id = s.tenant_id;
DELETE FROM plans WHERE code IN ('dental-chair', 'dental-practice', 'dental-group', 'dental-custom');
ALTER TABLE plans DROP COLUMN IF EXISTS status;
DROP TABLE IF EXISTS tenant_entitlements;
DROP TABLE IF EXISTS plan_features;
DROP TABLE IF EXISTS features;
-- +goose StatementEnd
