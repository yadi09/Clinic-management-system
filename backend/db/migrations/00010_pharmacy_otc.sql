-- +goose Up
-- +goose StatementBegin
-- Phase 4b-1: OTC sale fields on the pharmacy sale (counter sales carry a
-- discount, tax, and a recorded payment method).
ALTER TABLE pharmacy_sales
    ADD COLUMN discount       NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN tax            NUMERIC(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN payment_method TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pharmacy_sales
    DROP COLUMN IF EXISTS payment_method,
    DROP COLUMN IF EXISTS tax,
    DROP COLUMN IF EXISTS discount;
-- +goose StatementEnd
