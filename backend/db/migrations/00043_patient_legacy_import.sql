-- +goose Up
-- +goose StatementBegin
-- Legacy spreadsheet import: a patient carried over from a paper/Excel register
-- was first seen long before the row was created in ClinicOS. created_at records
-- when WE got the record; first_visit_date records when the CLINIC first saw them.
ALTER TABLE patients ADD COLUMN first_visit_date DATE;

-- Legacy registers usually store an AGE, not a birthdate. We derive a birthdate
-- (1 Jan of the implied birth year) so dob's NOT NULL holds, and flag it so the
-- UI/clinicians know the date is approximate — it must not be trusted for
-- age-sensitive dosing without confirmation.
ALTER TABLE patients ADD COLUMN dob_estimated BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_patients_first_visit ON patients(tenant_id, first_visit_date);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_patients_first_visit;
ALTER TABLE patients DROP COLUMN IF EXISTS dob_estimated;
ALTER TABLE patients DROP COLUMN IF EXISTS first_visit_date;
-- +goose StatementEnd
