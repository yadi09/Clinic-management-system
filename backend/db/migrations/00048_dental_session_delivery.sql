-- +goose Up
-- +goose StatementBegin
-- When treatment was actually delivered, by whom, and where.
--
-- treatment_sessions records what was PLANNED (scheduled_date) and what the record
-- says (procedure, tooth, notes), but nothing about the delivery itself:
--
--   * updated_at is bumped by collecting, by flagging pay-later and by every edit
--     to a note, so it cannot serve as a treatment date.
--   * created_by is whoever created the PLAN — often months earlier, and frequently
--     not the clinician who did the work.
--   * there is no branch at all, so a two-branch clinic cannot tell where a visit
--     happened or filter a report by it.
--
-- Without these the "treatment given, never billed" report cannot state when the
-- treatment was given, who gave it, or which branch owes the money — which is most
-- of what makes such a report actionable rather than merely alarming.
--
-- All three are nullable and backfilled to NULL on purpose: existing rows genuinely
-- do not know, and inventing a delivery date from updated_at would put a confident
-- wrong number in a financial report. Consumers fall back to scheduled_date and say
-- so.
ALTER TABLE treatment_sessions
  ADD COLUMN completed_at TIMESTAMPTZ,
  ADD COLUMN completed_by UUID,
  ADD COLUMN branch_id    UUID REFERENCES branches(id);

-- The report's hot path: delivered sessions, oldest first, per tenant.
CREATE INDEX idx_treatment_sessions_delivery
  ON treatment_sessions(tenant_id, completed_at)
  WHERE status = 'done';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_treatment_sessions_delivery;
ALTER TABLE treatment_sessions
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS completed_by,
  DROP COLUMN IF EXISTS branch_id;
-- +goose StatementEnd
