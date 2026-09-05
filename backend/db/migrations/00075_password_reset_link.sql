-- +goose Up
-- +goose StatementBegin

-- Forgetting a password had no way out.
--
-- Staff are created by an admin, receive a one-time link, and set their own
-- password. There is no email sender anywhere in this system and no phone number on
-- a staff record, so a member of staff who forgot their password could not be helped
-- by anybody: the invitation had already been used, and nothing could issue another.
--
-- The mechanism to fix it already existed. An invitation is a hashed, single-use,
-- expiring token that sets a password — which is exactly what a reset is. What was
-- missing is the distinction between the two, because they must end differently: an
-- invitation signs the new user in, while a reset must NOT, or a member of staff with
-- MFA enabled would have just been handed a way around their second factor.
ALTER TABLE user_invitations
    ADD COLUMN purpose TEXT NOT NULL DEFAULT 'invite'
        CHECK (purpose IN ('invite', 'reset'));

-- Only one live link per person: issuing a new one must retire the last, or an old
-- link left in a chat thread stays usable for as long as its expiry allows.
CREATE INDEX idx_user_invitations_open
    ON user_invitations(tenant_id, user_id)
    WHERE accepted_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_user_invitations_open;
ALTER TABLE user_invitations DROP COLUMN IF EXISTS purpose;
-- +goose StatementEnd
