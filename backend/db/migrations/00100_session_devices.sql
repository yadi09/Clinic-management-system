-- +goose Up
-- +goose StatementBegin

-- What the Active sessions list shows about a device.
--
-- A session row is replaced every time the sign-in is renewed (refresh-token
-- rotation), so created_at is the LAST renewal. started_at is when this device first
-- signed in and is carried across renewals; the renewal time is the device's
-- "last active". label is a name the user gives the device ("Reception PC") and is
-- carried too. country is the two-letter country the visitor's request came from.
ALTER TABLE sessions ADD COLUMN started_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN label      TEXT;
ALTER TABLE sessions ADD COLUMN country    TEXT;

-- Backfill: walk each session's rotation chain back to the first sign-in.
WITH RECURSIVE chain AS (
    SELECT id, id AS root_id, rotated_from, created_at AS started FROM sessions
    UNION ALL
    SELECT c.id, p.id, p.rotated_from, p.created_at
      FROM chain c JOIN sessions p ON p.id = c.rotated_from
)
UPDATE sessions s SET started_at = sub.started
  FROM (SELECT DISTINCT ON (id) id, started FROM chain ORDER BY id, started ASC) sub
 WHERE s.id = sub.id;
UPDATE sessions SET started_at = created_at WHERE started_at IS NULL;
ALTER TABLE sessions ALTER COLUMN started_at SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN started_at SET DEFAULT now();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN IF EXISTS country;
ALTER TABLE sessions DROP COLUMN IF EXISTS label;
ALTER TABLE sessions DROP COLUMN IF EXISTS started_at;
-- +goose StatementEnd
