-- +goose Up
-- +goose StatementBegin
-- Follow-up context & handoff. A follow-up is now owned by the doctor who ordered
-- it (ordered_by), distinct from the provider who will attend it (provider_id) so
-- it can be handed to a covering doctor. origin_encounter_id links the follow-up
-- back to the visit that spawned it, giving the attending doctor context.
ALTER TABLE appointments
    ADD COLUMN ordered_by          UUID REFERENCES users(id),
    ADD COLUMN origin_encounter_id UUID REFERENCES encounters(id);

-- Fast lookups for the follow-up lens (due / upcoming / overdue) and for finding
-- the follow-ups that a given encounter produced.
CREATE INDEX idx_appointments_followup ON appointments(tenant_id, branch_id, starts_at)
    WHERE is_followup AND deleted_at IS NULL;
CREATE INDEX idx_appointments_origin ON appointments(origin_encounter_id)
    WHERE origin_encounter_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_appointments_origin;
DROP INDEX IF EXISTS idx_appointments_followup;
ALTER TABLE appointments
    DROP COLUMN IF EXISTS origin_encounter_id,
    DROP COLUMN IF EXISTS ordered_by;
-- +goose StatementEnd
