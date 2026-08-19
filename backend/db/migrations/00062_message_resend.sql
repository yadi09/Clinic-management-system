-- +goose Up
-- +goose StatementBegin
-- Sending one again, without losing the fact that the first one failed.
--
-- A resend is a NEW row that points at the one it retried, never an edit of the
-- original. The history a clinic needs is "we tried at 21:38 and the gateway
-- refused it, then tried again at 09:10 and it arrived" — overwriting the first
-- attempt would leave a delivered message and no trace of the hour spent
-- wondering why the patient never heard from us.
--
-- It also keeps the money honest: two attempts is two segments charged, and a
-- single row flipping from failed to delivered would report one.
ALTER TABLE messages
  ADD COLUMN resent_from UUID REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX idx_messages_resent_from ON messages(resent_from)
  WHERE resent_from IS NOT NULL;

COMMENT ON COLUMN messages.resent_from IS
  'The earlier message this one retries. A resend is a new row so both attempts and both charges stay visible.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_messages_resent_from;
ALTER TABLE messages DROP COLUMN IF EXISTS resent_from;
-- +goose StatementEnd
