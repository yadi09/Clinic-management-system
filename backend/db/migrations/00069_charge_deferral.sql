-- +goose Up
-- +goose StatementBegin

-- Treat now, pay later — for the clinics that are not dental.
--
-- A dental course can be given against a recorded promise to pay: pay_later carries
-- the reason, and the money projection keeps a promise separate from a delivered debt.
-- A general clinic had nothing of the kind. Its fee GATES the queue, so a patient who
-- cannot pay today cannot be seen at all, and the only ways out were to waive the
-- charge — writing the money off, which is not what the clinic means when it treats a
-- staff member's child or an emergency — or to leave the charge pending and let the
-- patient through some other way, which no path allows.
--
-- The consequence is visible on the reception row: "Owes 18,000 ETB from earlier
-- visits" cannot distinguish money the clinic agreed to be owed from a charge somebody
-- forgot to collect. Those are different facts and they lead to different actions.
--
-- Deferring is deliberately NOT a third status. The charge stays `pending`, because it
-- is still owed and must still appear at the cashier, in receivables and in the ageing.
-- What is recorded is that someone decided, when, and why.
ALTER TABLE charges
    ADD COLUMN deferred_at   TIMESTAMPTZ,
    ADD COLUMN deferred_by   UUID,
    ADD COLUMN defer_reason  TEXT;

-- The ageing report and the reception row both ask "is this agreed credit?", which is
-- a partial index's job.
CREATE INDEX idx_charges_deferred ON charges(tenant_id, patient_id)
    WHERE deferred_at IS NOT NULL AND status = 'pending' AND deleted_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_charges_deferred;
ALTER TABLE charges DROP COLUMN IF EXISTS defer_reason;
ALTER TABLE charges DROP COLUMN IF EXISTS deferred_by;
ALTER TABLE charges DROP COLUMN IF EXISTS deferred_at;
-- +goose StatementEnd
