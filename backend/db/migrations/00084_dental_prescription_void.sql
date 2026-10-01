-- +goose Up
-- +goose StatementBegin

-- A prescription is a document that leaves the clinic: printed, handed over, its QR
-- carrying DRX:<id>. It was hard-deleted in one click with no event (audit D17), so
-- a script already in a pharmacy's hands could vanish from the record. It is now
-- voided instead — kept, with who, when and why — and hidden from the visit.
ALTER TABLE dental_prescriptions ADD COLUMN voided_at   TIMESTAMPTZ;
ALTER TABLE dental_prescriptions ADD COLUMN voided_by   UUID;
ALTER TABLE dental_prescriptions ADD COLUMN void_reason TEXT;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Voided prescriptions would reappear on their visits.
ALTER TABLE dental_prescriptions DROP COLUMN IF EXISTS void_reason;
ALTER TABLE dental_prescriptions DROP COLUMN IF EXISTS voided_by;
ALTER TABLE dental_prescriptions DROP COLUMN IF EXISTS voided_at;
-- +goose StatementEnd
