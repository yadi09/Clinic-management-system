-- +goose Up
-- +goose StatementBegin
-- Phase 3b hardening: enforce the documented invariants so they hold under
-- concurrency and for non-browser clients.
--   * at most one (active) prescription per encounter
--   * at most one primary diagnosis per encounter (deterministic history)
CREATE UNIQUE INDEX IF NOT EXISTS idx_prescriptions_one_per_encounter
    ON prescriptions(encounter_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_diagnoses_one_primary
    ON diagnoses(encounter_id) WHERE is_primary AND deleted_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_diagnoses_one_primary;
DROP INDEX IF EXISTS idx_prescriptions_one_per_encounter;
-- +goose StatementEnd
