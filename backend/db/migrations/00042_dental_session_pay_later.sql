-- +goose Up
-- +goose StatementBegin
-- The doctor may render a session's treatment on the patient's promise to pay
-- later (bypassing up-front collection). pay_later flags that decision; the note
-- records the promise/reason. Such a session counts as an unpaid debt for service
-- already given (surfaced as a warning) until it is actually paid.
ALTER TABLE treatment_sessions ADD COLUMN pay_later BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE treatment_sessions ADD COLUMN pay_later_note TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE treatment_sessions DROP COLUMN IF EXISTS pay_later_note;
ALTER TABLE treatment_sessions DROP COLUMN IF EXISTS pay_later;
-- +goose StatementEnd
