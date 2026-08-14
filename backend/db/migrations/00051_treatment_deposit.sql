-- +goose Up
-- +goose StatementBegin
-- Down payment on a treatment plan.
--
-- A course of dental work is quoted as one price and paid over months. In practice
-- the patient pays something up front to start the work, and the balance is spread
-- across the sessions. Before this, the plan could only divide the total equally,
-- so a dentist wanting 20,000 down on a 72,000 course had to fake it by inflating
-- the first session — which then read as a visit fee, mispriced the visit on every
-- report, and looked wrong when that session was rescheduled or cancelled.
--
-- The deposit is stored as a treatment_sessions row with kind='deposit' rather than
-- a column on the plan. That is deliberate: sessionMoneyCTE is the single place
-- dental decides what a charge means, and every money surface in the product —
-- balance, cashier, unbilled treatment, refunds, write-offs, revenue reports — is
-- built on it. A deposit that is a row flows through all of them correctly on day
-- one. A deposit that is a column would have needed each of those taught about it
-- separately, and any one of them missed is money that silently disappears.
--
-- The cost of that choice is that a deposit is not a visit, and the visit surfaces
-- must not treat it as one. The API splits it out of `sessions` into its own field,
-- so no caller sees a deposit where it expects an appointment.
ALTER TABLE treatment_sessions
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'visit' CHECK (kind IN ('visit', 'deposit'));

COMMENT ON COLUMN treatment_sessions.kind IS
  'visit = a dated appointment in the course. deposit = the up-front payment, seq 0, carries money but is never delivered clinically.';

-- One down payment per plan. Two would be a bug in the caller, and the money
-- surfaces would faithfully bill both.
CREATE UNIQUE INDEX idx_treatment_sessions_one_deposit
  ON treatment_sessions(plan_id) WHERE kind = 'deposit';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_treatment_sessions_one_deposit;
DELETE FROM treatment_sessions WHERE kind = 'deposit';
ALTER TABLE treatment_sessions DROP COLUMN IF EXISTS kind;
-- +goose StatementEnd
