-- +goose Up
-- +goose StatementBegin
-- Backfill: historically the encounter's provider_id was only set from the queue
-- entry's assigned provider, which is NULL in the normal walk-in → triage → doctor
-- flow. That left every encounter with provider_id = NULL, so the doctor's "My day"
-- board ("In progress" / "Done", both filtered by provider_id) was always empty.
-- The doctor who opened the consult is recorded in created_by, so adopt that as the
-- provider wherever it is missing. New encounters set provider_id on open (code fix).
UPDATE encounters
SET provider_id = created_by, updated_at = now()
WHERE provider_id IS NULL AND created_by IS NOT NULL AND deleted_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Irreversible data backfill; nothing to undo (the original NULLs are not retained).
SELECT 1;
-- +goose StatementEnd
