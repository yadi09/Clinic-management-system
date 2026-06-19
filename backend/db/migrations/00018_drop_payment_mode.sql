-- +goose Up
-- +goose StatementBegin
-- Payment collection is now driven by roles/permissions (payment.charge raises a
-- charge; payment.collect settles it) rather than a per-clinic flag. Whether
-- reception collects inline or hands off to a cashier follows who holds
-- payment.collect — so the clinic-level toggle is retired.
ALTER TABLE clinics DROP COLUMN IF EXISTS payment_mode;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE clinics ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'reception'
    CHECK (payment_mode IN ('reception','cashier'));
-- +goose StatementEnd
