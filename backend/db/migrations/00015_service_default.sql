-- +goose Up
-- +goose StatementBegin
-- CASH-3: tag services reception starts with (e.g. a registration fee). Prices and
-- the "what gets charged" default now live entirely in the service catalog.
ALTER TABLE service_items ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT false;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE service_items DROP COLUMN IF EXISTS is_default;
-- +goose StatementEnd
