-- +goose Up
-- +goose StatementBegin

-- Was this transfer real, for this amount, into THIS clinic's account?
--
-- payment_references already held one row per payment event, which is what stops the
-- same transfer paying twice. Verification hangs here for the same reason: the thing
-- being verified is the payment event, and keeping the answer beside the guard means
-- a receipt, a dispute and a report all read one row.
--
-- A row can now exist BEFORE a payment is settled: the desk checks the reference, and
-- claims it a moment later when the money is taken. receipt_no IS NULL means checked
-- but not yet collected.
ALTER TABLE payment_references
  -- verified | rejected | review | pending | unchecked (service off, down, or out of credit)
  ADD COLUMN verify_state      TEXT,
  -- Why, in the words shown to staff — the evidence a year from now.
  ADD COLUMN verify_reason     TEXT,
  -- The machine reason, usually the vendor's own settlement reason code.
  ADD COLUMN verify_detail     TEXT,
  ADD COLUMN verify_request_id TEXT,
  -- Their x-request-id response header: what vendor support asks for.
  ADD COLUMN verify_trace_id   TEXT,
  ADD COLUMN verified_amount   NUMERIC(12,2),
  ADD COLUMN sender_name       TEXT,
  ADD COLUMN receiver_account  TEXT,
  -- The two objects that decided it, kept verbatim. A summarised copy is not evidence.
  ADD COLUMN settlement_match  JSONB,
  ADD COLUMN confirmation      JSONB,
  ADD COLUMN checked_at        TIMESTAMPTZ,
  -- Set when someone took a payment the bank contradicted. Requires payment.waive and
  -- is recorded with who and why, because that is a decision, not an oversight.
  ADD COLUMN override_by       UUID,
  ADD COLUMN override_reason   TEXT;

COMMENT ON COLUMN payment_references.verify_state IS
  'verified | rejected | review | pending | unchecked. NULL = verification was never attempted (no key, or a rail with no provider).';

CREATE INDEX idx_payment_references_state
  ON payment_references(tenant_id, verify_state) WHERE verify_state IS NOT NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_payment_references_state;
ALTER TABLE payment_references
  DROP COLUMN IF EXISTS override_reason, DROP COLUMN IF EXISTS override_by,
  DROP COLUMN IF EXISTS checked_at, DROP COLUMN IF EXISTS confirmation,
  DROP COLUMN IF EXISTS settlement_match, DROP COLUMN IF EXISTS receiver_account,
  DROP COLUMN IF EXISTS sender_name, DROP COLUMN IF EXISTS verified_amount,
  DROP COLUMN IF EXISTS verify_trace_id, DROP COLUMN IF EXISTS verify_request_id,
  DROP COLUMN IF EXISTS verify_detail, DROP COLUMN IF EXISTS verify_reason,
  DROP COLUMN IF EXISTS verify_state;
-- +goose StatementEnd
