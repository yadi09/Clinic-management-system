-- +goose Up
-- +goose StatementBegin

-- Priority, and the thing that makes priority mean something.
--
-- The pipeline filled faster than it was worked: five of the first seven clinics
-- collected were still marked "never contacted". Ranking them is half the answer —
-- a clinic that is ready to buy must not wait behind one that is not — but a rank
-- alone changes nothing, because nothing puts it in front of anybody on a given
-- morning.
--
-- So a prospect also carries the next step and the day it is due. Those two columns
-- turn a list into a worklist: what must happen, to whom, today. Everything else
-- here — the daily view, the overdue warning, the ordering of the board — is read
-- off them.
ALTER TABLE crm_prospects
    ADD COLUMN priority TEXT NOT NULL DEFAULT 'warm'
        CHECK (priority IN ('hot', 'warm', 'cold')),
    -- What the rep decided to do next, in their own words.
    ADD COLUMN next_action    TEXT,
    ADD COLUMN next_action_at DATE;

-- The board and the worklist both sort by "most urgent, longest ignored", so the
-- rank is worth having as a number rather than recomputing a CASE per row.
CREATE INDEX idx_crm_prospects_priority
    ON crm_prospects(priority, next_action_at)
    WHERE deleted_at IS NULL AND status = 'open';

CREATE INDEX idx_crm_prospects_due
    ON crm_prospects(next_action_at)
    WHERE deleted_at IS NULL AND status = 'open' AND next_action_at IS NOT NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_crm_prospects_due;
DROP INDEX IF EXISTS idx_crm_prospects_priority;
ALTER TABLE crm_prospects
    DROP COLUMN IF EXISTS next_action_at,
    DROP COLUMN IF EXISTS next_action,
    DROP COLUMN IF EXISTS priority;
-- +goose StatementEnd
