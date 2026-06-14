-- +goose Up
-- +goose StatementBegin
-- Phase 4a hardening (from the adversarial review):
--   * guarantee Rx numbers are unique
--   * index the dispense-queue / dispensed-today reads
-- (Per-tenant contiguous Rx numbering is a later refinement; uniqueness is the
--  correctness requirement here.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_prescriptions_rx_no ON prescriptions(rx_no);
CREATE INDEX IF NOT EXISTS idx_prescriptions_dispense ON prescriptions(tenant_id, dispensed_at) WHERE deleted_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_prescriptions_dispense;
DROP INDEX IF EXISTS idx_prescriptions_rx_no;
-- +goose StatementEnd
