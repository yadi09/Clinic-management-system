-- +goose Up
-- +goose StatementBegin

-- Registration requires only a first name (clinic feedback, 2026-10-01). A patient
-- whose age nobody knows has no date of birth, and inventing one would put a wrong
-- age on every screen; so dob may now be empty. Every reader already copes:
-- age(NULL) is NULL and the SQL coalesces it, and the API returns "" for it.
ALTER TABLE patients ALTER COLUMN dob DROP NOT NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- An unknown date of birth cannot be restored honestly; mark it as an estimate.
UPDATE patients SET dob = DATE '1900-01-01', dob_estimated = true WHERE dob IS NULL;
ALTER TABLE patients ALTER COLUMN dob SET NOT NULL;
-- +goose StatementEnd
