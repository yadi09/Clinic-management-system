-- +goose Up
-- +goose StatementBegin

-- A staff record held an email and nothing else you could reach a person on.
--
-- Patients have had a phone since the first migration; the people who run the
-- clinic did not. That gap is why a forgotten password can only be answered with a
-- link handed over in person (00075): with no number on file there is nothing to
-- send a code to, and no way to tell whether the person asking is the account
-- holder. Storing the number when the account is created is the prerequisite for
-- that, and useful long before it — a clinic with six staff across two branches
-- needs a way to ring the one who is on shift.
--
-- Stored in the same local 09xxxxxxxx form as patients.phone (kernel/phone
-- Normalise), so one definition covers both and a number can be handed to the SMS
-- gateway unchanged. Nullable: the three accounts already live predate this, and an
-- admin filling them in is a task, not a migration's guess.
ALTER TABLE users ADD COLUMN phone TEXT;

-- For the reset-by-SMS path this makes possible: find the account a number belongs
-- to. Not unique — a small clinic really does share one handset between the front
-- desk and the owner, and refusing the second account would be inventing a rule the
-- clinic does not have. Any lookup by phone must therefore expect more than one row
-- and resolve it by email, never assume the first.
CREATE INDEX idx_users_phone ON users(tenant_id, phone)
    WHERE phone IS NOT NULL AND deleted_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_users_phone;
ALTER TABLE users DROP COLUMN IF EXISTS phone;
-- +goose StatementEnd
