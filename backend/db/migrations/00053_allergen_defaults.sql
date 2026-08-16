-- +goose Up
-- +goose StatementBegin
-- What an allergen usually does, remembered once.
--
-- A patient allergy records three things: the substance, the reaction, and how bad
-- it is. The clinic's allergen library recorded only the first, so every time
-- "Penicillin" was added to another patient somebody retyped "rash, swelling" and
-- re-picked a severity from memory — and typed it slightly differently, which is
-- how one clinic ends up with three descriptions of the same reaction.
--
-- The library now carries the usual answer to both. It is a DEFAULT, not a rule:
-- the same substance can put one patient in a rash and another in anaphylaxis, so
-- what lands on the patient's record is still editable before it is saved. What
-- this removes is the retyping, not the clinician's judgement.
ALTER TABLE allergen_catalog
  ADD COLUMN default_reaction TEXT,
  -- Same three values the patient record uses. Kept nullable because a clinic may
  -- know a substance is an allergen long before anyone has seen it react.
  ADD COLUMN default_severity TEXT
    CHECK (default_severity IS NULL OR default_severity IN ('mild', 'moderate', 'severe'));

COMMENT ON COLUMN allergen_catalog.default_reaction IS
  'The reaction this substance usually causes. Pre-fills the patient allergy form; always editable there.';
COMMENT ON COLUMN allergen_catalog.default_severity IS
  'The severity usually recorded for this substance. Pre-fills the patient allergy form; always editable there.';

-- Seed the defaults from what the clinic has already recorded on real patients, so
-- the library starts out knowing what its own notes already say. The most common
-- answer per substance wins; ties break towards the more severe, because the cost
-- of under-stating an allergy is not symmetrical with over-stating it.
WITH ranked AS (
  SELECT a.tenant_id,
         lower(a.substance) AS key,
         a.reaction,
         a.severity,
         row_number() OVER (
           PARTITION BY a.tenant_id, lower(a.substance)
           ORDER BY count(*) DESC,
                    array_position(ARRAY['severe','moderate','mild'], a.severity)
         ) AS rn
  FROM allergies a
  WHERE a.deleted_at IS NULL
  GROUP BY a.tenant_id, lower(a.substance), a.reaction, a.severity
)
UPDATE allergen_catalog c
   SET default_reaction = nullif(trim(coalesce(r.reaction, '')), ''),
       default_severity = r.severity,
       updated_at = now()
  FROM ranked r
 WHERE r.rn = 1
   AND c.tenant_id = r.tenant_id
   AND lower(c.name) = r.key
   AND c.deleted_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE allergen_catalog
  DROP COLUMN IF EXISTS default_reaction,
  DROP COLUMN IF EXISTS default_severity;
-- +goose StatementEnd
