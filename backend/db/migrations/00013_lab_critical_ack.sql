-- +goose Up
-- +goose StatementBegin
-- Phase 5b-1: critical-value escalation + acknowledgement ("Mark notified").
--   * critical_flag  — set at validation if any result on the sample is critical
--   * notified_at/by — who acknowledged the critical to the ordering clinician, when
ALTER TABLE lab_order_items ADD COLUMN critical_flag BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lab_order_items ADD COLUMN notified_at   TIMESTAMPTZ;
ALTER TABLE lab_order_items ADD COLUMN notified_by   UUID REFERENCES users(id);

-- Inbox: validated samples for a provider, unacknowledged criticals first.
CREATE INDEX idx_lab_order_items_critical
  ON lab_order_items(tenant_id, critical_flag)
  WHERE critical_flag AND notified_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_lab_order_items_critical;
ALTER TABLE lab_order_items DROP COLUMN IF EXISTS notified_by;
ALTER TABLE lab_order_items DROP COLUMN IF EXISTS notified_at;
ALTER TABLE lab_order_items DROP COLUMN IF EXISTS critical_flag;
-- +goose StatementEnd
