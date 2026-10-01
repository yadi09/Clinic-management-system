-- +goose Up
-- +goose StatementBegin

-- Who did it. Every audit entry in production had an empty actor (audit D5:
-- 1,778 entries in 90 days, 0 with an actor) because the outbox had nowhere to
-- carry one: events are written in the request's transaction, where the
-- signed-in user is known, and turned into audit_logs later by the worker, where
-- they are not. The publisher now records the user and their active branch here,
-- and the worker copies both onto the audit entry.
--
-- Nullable, no backfill: system events have no actor, and past ones cannot be
-- reconstructed honestly.
ALTER TABLE event_outbox ADD COLUMN actor_id  UUID;
ALTER TABLE event_outbox ADD COLUMN branch_id UUID;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Drops who-did-it for events not yet dispatched; dispatched ones keep it in audit_logs.
ALTER TABLE event_outbox DROP COLUMN IF EXISTS branch_id;
ALTER TABLE event_outbox DROP COLUMN IF EXISTS actor_id;
-- +goose StatementEnd
