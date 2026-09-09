-- +goose Up
-- +goose StatementBegin

-- Nobody knows how many clinics will come.
--
-- The wheel needs a denominator before anyone plays — that is what makes each
-- clinic's chance provable — but guessing it wrong had a cost at both ends: set
-- it too low and the twenty-first clinic is told to wait, set it too high and
-- most of the gifts fall through to the closing draw instead of being won on
-- screen.
--
-- So the pool grows. When a clinic finishes the questions and finds every
-- position taken, another block is appended and the positions nobody has claimed
-- are re-sealed — carrying forward exactly the gifts still outstanding, never
-- more. Three is three whether five clinics come or five hundred; what changes is
-- how thinly those three are spread, and the page says so live.
ALTER TABLE campaigns
    ADD COLUMN auto_extend  BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN extend_block INTEGER NOT NULL DEFAULT 10 CHECK (extend_block > 0);

COMMENT ON COLUMN campaigns.auto_extend IS
  'Grow the wheel when it fills rather than turning a clinic away.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE campaigns DROP COLUMN IF EXISTS auto_extend, DROP COLUMN IF EXISTS extend_block;
-- +goose StatementEnd
