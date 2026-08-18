-- +goose Up
-- +goose StatementBegin
-- Delivery, now that it can actually be known.
--
-- 00055 stopped at 'sent' on the basis that the gateway's v1 API returns no usable
-- message id (`id` is literally always the number 0) and publishes no status
-- endpoint — so a message, once sent, was unobservable forever and claiming
-- "delivered" would have been a guess.
--
-- Its v2 API returns a ULID and answers GET /api/v2/sms/{id} with ACCEPTED → SENT →
-- DELIVERED, confirmed by the handset. So delivery becomes a fact we can hold, and
-- the honest ceiling moves up by one.
--
-- Polling, not the webhook: their delivery callback is a paid add-on that support
-- has to enable per campaign, carries no signature of any kind, and currently fires
-- only on success — a message that fails produces no callback at all. Their own
-- documentation points at the status endpoint for reconciliation, so that is the
-- mechanism, and the webhook stays unbuilt.
ALTER TABLE messages
  -- The ULID. The only handle to a sent message; without it delivery can never be
  -- looked up, which is why it is written the moment the gateway returns it.
  ADD COLUMN gateway_id TEXT,
  -- The gateway's own last word: ACCEPTED | SENT | DELIVERED.
  ADD COLUMN gateway_status TEXT,
  ADD COLUMN delivered_at TIMESTAMPTZ,
  ADD COLUMN status_checked_at TIMESTAMPTZ,
  -- Bounded polling. Messages sent before the gateway's status upgrade rolled out
  -- stay ACCEPTED forever, so an unbounded reconciler would chase them until the
  -- end of time; this is the ceiling that stops it.
  ADD COLUMN status_checks INT NOT NULL DEFAULT 0;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('scheduled', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled'));

COMMENT ON COLUMN messages.gateway_id IS
  'SMSEthiopia v2 ULID. The only handle for looking a message up after sending.';
COMMENT ON COLUMN messages.status IS
  'sent = the network accepted it. delivered = the handset confirmed it. The two are different facts and the UI must not blur them.';

-- The reconciler''s worklist: sent, has a handle, not yet confirmed, not given up on.
CREATE INDEX idx_messages_awaiting_delivery
  ON messages(status_checked_at NULLS FIRST)
  WHERE status = 'sent' AND gateway_id IS NOT NULL AND status_checks < 12;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE messages SET status = 'sent' WHERE status = 'delivered';
DROP INDEX IF EXISTS idx_messages_awaiting_delivery;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'skipped', 'cancelled'));
ALTER TABLE messages
  DROP COLUMN IF EXISTS gateway_id,
  DROP COLUMN IF EXISTS gateway_status,
  DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS status_checked_at,
  DROP COLUMN IF EXISTS status_checks;
-- +goose StatementEnd
