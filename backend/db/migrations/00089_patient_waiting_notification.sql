-- +goose Up
-- +goose StatementBegin

-- "A patient is waiting for you": the second kind of notification. It starts
-- from the day it is switched on, like every kind.
INSERT INTO notification_watermarks (kind, since)
VALUES ('patient_waiting', (now() AT TIME ZONE 'Africa/Addis_Ababa')::date)
ON CONFLICT (kind) DO NOTHING;

-- The worker looks for waiting patients every few seconds, across every clinic.
-- Without this the look would scan every queue entry ever made, a table that
-- grows by every visit; with it, only the handful of entries waiting right now.
CREATE INDEX IF NOT EXISTS idx_queue_waiting ON queue_entries (enqueued_at)
    WHERE state = 'waiting' AND deleted_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_queue_waiting;
DELETE FROM notification_watermarks WHERE kind = 'patient_waiting';
-- +goose StatementEnd
