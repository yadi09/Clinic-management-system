-- +goose Up
-- +goose StatementBegin
-- Scope plans to a clinic type. 'all' = universal (offered to every clinic type);
-- a specific value scopes the plan to that type. A clinic of type X is offered
-- plans where clinic_type IN ('all', X). Existing plans default to 'all'. The CHECK
-- widens when a new clinic type is added (same pattern as tenants.clinic_type).
ALTER TABLE plans ADD COLUMN clinic_type TEXT NOT NULL DEFAULT 'all'
    CHECK (clinic_type IN ('all', 'general', 'dental'));

-- Dental sample plans (image-heavy → more storage, often fewer patients). Editable.
INSERT INTO plans (code, name, clinic_type, branch_limit, user_limit, storage_gb, patient_limit, audit_retention_days, price_monthly) VALUES
  ('dental-basic', 'Dental Basic', 'dental', 1,  5,  25,  300,  365,  800),
  ('dental-pro',   'Dental Pro',   'dental', 3,  20, 200, NULL, 1095, 2500)
ON CONFLICT (code) DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM plans WHERE code IN ('dental-basic', 'dental-pro');
ALTER TABLE plans DROP COLUMN IF EXISTS clinic_type;
-- +goose StatementEnd
