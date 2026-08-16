-- +goose Up
-- +goose StatementBegin
-- The dental prescription joins the drug library the rest of the clinic already uses.
--
-- Migration 00022 built this for general medicine: a per-clinic drug_catalog whose
-- entries carry a default dose, frequency, duration and instructions, allergen tags
-- per drug, and — on prescription_items — a drug_id plus the reason a clinician gave
-- for prescribing over a recorded allergy. The dental prescription was written later
-- and got none of it: free text, no defaults, and no allergy check at all.
--
-- That gap is not cosmetic. A dentist writing amoxicillin for a patient whose
-- penicillin allergy is recorded two panels above got no warning whatsoever, while
-- the doctor down the corridor writing the same drug in an encounter was stopped and
-- made to give a reason. Same clinic, same patient, same allergy, different answer.
--
-- These two columns are what the dental item was missing to be checked the same way.
ALTER TABLE dental_prescription_items
  ADD COLUMN drug_id UUID REFERENCES drug_catalog(id),
  -- Non-empty means: the drug clashed with a recorded allergy and this clinician
  -- prescribed it anyway, for this stated reason. It is kept on the item because
  -- that is what a later reader needs to see beside the drug, not in a log.
  ADD COLUMN allergy_override TEXT;

CREATE INDEX idx_dental_rx_items_drug ON dental_prescription_items(tenant_id, drug_id)
  WHERE drug_id IS NOT NULL;

COMMENT ON COLUMN dental_prescription_items.allergy_override IS
  'Reason the prescriber gave for writing this drug against a recorded allergy. NULL/empty = no conflict was raised.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_dental_rx_items_drug;
ALTER TABLE dental_prescription_items
  DROP COLUMN IF EXISTS drug_id,
  DROP COLUMN IF EXISTS allergy_override;
-- +goose StatementEnd
