-- +goose Up
-- +goose StatementBegin

-- The link between a dental visit and its bill was invisible to the database
-- (audit W22/D2): no index, no uniqueness. Go was the only thing stopping two
-- visits sharing one charge, and the only thing stopping a typed minus sign from
-- becoming a negative fee that quietly offsets other debt (D8).
--
-- Both hold on the live data today (0 shared charges, 0 negative fees, checked
-- 2026-09-30), so these apply without a backfill. If one ever fails, the data
-- has drifted and must be looked at before forcing anything.

-- One bill belongs to at most one visit. Also the index the money projection's
-- session->charge join has been doing without.
CREATE UNIQUE INDEX ux_treatment_sessions_charge
    ON treatment_sessions (charge_id) WHERE charge_id IS NOT NULL;

ALTER TABLE treatment_sessions
    ADD CONSTRAINT treatment_sessions_amount_nonneg CHECK (amount_due >= 0);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Removing a guard loses no data.
ALTER TABLE treatment_sessions DROP CONSTRAINT IF EXISTS treatment_sessions_amount_nonneg;
DROP INDEX IF EXISTS ux_treatment_sessions_charge;
-- +goose StatementEnd
