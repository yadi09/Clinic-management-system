-- +goose Up
-- +goose StatementBegin

-- What has the patient in this bed actually paid?
--
-- The board could not answer that, and neither could the cashier. A stay raised at
-- most two charges — a deposit at admission and the balance at discharge — and the
-- only link back to the admission was bed_admissions.deposit_charge_id, a single
-- column that by construction can hold exactly one charge. Everything in between was
-- invisible: a patient staying thirty days who paid for ten had nothing on the
-- cashier, no record of how far the money reached, and a nurse looking at the board
-- saw "est. ETB 26,000" with no way to tell whether a birr of it had been collected.
--
-- Linking the charge to the admission is what makes the question answerable: a stay
-- can now carry as many charges as the family makes payments, and paid/outstanding is
-- a sum over them rather than a guess.
ALTER TABLE charges ADD COLUMN admission_id UUID REFERENCES bed_admissions(id);

CREATE INDEX idx_charges_admission ON charges(tenant_id, admission_id)
    WHERE admission_id IS NOT NULL AND deleted_at IS NULL;

-- Existing deposits keep their history rather than starting from nothing.
UPDATE charges c
   SET admission_id = a.id
  FROM bed_admissions a
 WHERE a.tenant_id = c.tenant_id
   AND a.deposit_charge_id = c.id
   AND c.admission_id IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_charges_admission;
ALTER TABLE charges DROP COLUMN IF EXISTS admission_id;
-- +goose StatementEnd
