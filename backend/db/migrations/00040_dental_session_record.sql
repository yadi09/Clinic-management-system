-- +goose Up
-- +goose StatementBegin
-- Each session records what happened that visit: the procedure performed and the
-- specific tooth/teeth worked on (Palmer). Notes, Rx and images already live on the
-- session; this completes the per-session clinical record.
ALTER TABLE treatment_sessions ADD COLUMN procedure TEXT;
ALTER TABLE treatment_sessions ADD COLUMN tooth TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE treatment_sessions DROP COLUMN IF EXISTS tooth;
ALTER TABLE treatment_sessions DROP COLUMN IF EXISTS procedure;
-- +goose StatementEnd
