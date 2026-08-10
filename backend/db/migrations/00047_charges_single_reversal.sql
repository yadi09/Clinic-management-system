-- +goose Up
-- +goose StatementBegin
-- One refund per charge, enforced by the database.
--
-- A refund is a linked negative row, not a status change: CreateReversalCharge
-- inserts a second charge carrying reverses_charge_id. The only thing stopping a
-- charge being refunded twice is CountReversals — a plain SELECT with no lock,
-- read before the INSERT in the same transaction. Under READ COMMITTED two
-- concurrent refunds of the same charge both read zero and both insert, and the
-- clinic pays a patient back twice. A double-clicked button or a retried request
-- is enough; it does not need two managers.
--
-- idx_charges_reverses (00017) is non-unique, so it cannot help. Replacing it with
-- a UNIQUE partial index makes the second insert fail outright, whatever the
-- application layer does or forgets to do.
--
-- Soft-deleted reversals are excluded so a refund that was voided and re-issued
-- stays possible — the index only forbids two LIVE reversals of one charge.

-- Pre-flight: refuse to create the index rather than fail halfway if the data
-- already violates it, and name the offenders so they can be fixed by hand.
DO $$
DECLARE dupes int;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT reverses_charge_id
    FROM charges
    WHERE reverses_charge_id IS NOT NULL AND deleted_at IS NULL
    GROUP BY reverses_charge_id HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'cannot enforce single-reversal: % charge(s) already have more than one live reversal. Resolve them first: SELECT reverses_charge_id, count(*) FROM charges WHERE reverses_charge_id IS NOT NULL AND deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1;', dupes;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_charges_reverses;
CREATE UNIQUE INDEX idx_charges_reverses_unique
  ON charges(reverses_charge_id)
  WHERE reverses_charge_id IS NOT NULL AND deleted_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_charges_reverses_unique;
CREATE INDEX idx_charges_reverses ON charges(reverses_charge_id) WHERE reverses_charge_id IS NOT NULL;
-- +goose StatementEnd
