-- +goose Up
-- +goose StatementBegin
-- Subscription plans gain a patient cap, and tenants gain per-clinic override
-- columns so the super-admin can customize any single clinic's limits beyond its
-- plan. Override semantics (all nullable): NULL = inherit the plan; a negative
-- value = unlimited (override the plan); >= 0 = an explicit cap for this clinic.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS patient_limit INTEGER; -- NULL = unlimited

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS storage_gb_override    INTEGER,
  ADD COLUMN IF NOT EXISTS patient_limit_override INTEGER,
  ADD COLUMN IF NOT EXISTS user_limit_override    INTEGER,
  ADD COLUMN IF NOT EXISTS branch_limit_override  INTEGER;

-- Sample plans the super-admin can edit later. NULL = unlimited for that limit.
-- (The existing 'business' plan is left as-is.)
INSERT INTO plans (code, name, branch_limit, user_limit, storage_gb, patient_limit, audit_retention_days, price_monthly) VALUES
  ('starter', 'Starter',  1,   3,   5,    100,  365,  500),
  ('clinic',  'Clinic',   3,   15,  50,   1000, 730,  1500),
  ('pro',     'Pro',      10,  100, 500,  NULL, 1095, 5000)
ON CONFLICT (code) DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM plans WHERE code IN ('starter', 'clinic', 'pro');
ALTER TABLE tenants
  DROP COLUMN IF EXISTS storage_gb_override,
  DROP COLUMN IF EXISTS patient_limit_override,
  DROP COLUMN IF EXISTS user_limit_override,
  DROP COLUMN IF EXISTS branch_limit_override;
ALTER TABLE plans DROP COLUMN IF EXISTS patient_limit;
-- +goose StatementEnd
