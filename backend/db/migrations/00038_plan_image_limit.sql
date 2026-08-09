-- +goose Up
-- +goose StatementBegin
-- Per-plan cap on images per patient (dental X-rays / before-after photos).
-- NULL = unlimited. Backfill existing plans to 8 to preserve today's behavior
-- (was a hardcoded frontend cap); the super-admin can change it per plan.
ALTER TABLE plans ADD COLUMN images_per_patient INTEGER; -- NULL = unlimited
UPDATE plans SET images_per_patient = 8 WHERE images_per_patient IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE plans DROP COLUMN IF EXISTS images_per_patient;
-- +goose StatementEnd
