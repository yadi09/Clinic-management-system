-- +goose Up
-- +goose StatementBegin
-- Give every plan an SMS allowance, not just the three sample ones.
--
-- 00055 set sms_monthly on starter/clinic/pro, which are the seeded examples. Every
-- clinic actually running is on one of the others — business, dental-basic,
-- dental-pro — and those were left NULL, which the limits kernel reads as
-- unlimited.
--
-- That is the wrong default here specifically. Storage and patient caps protect the
-- platform's disk; this one protects its bank account, because one shared gateway
-- account pays for every message every clinic sends. An uncapped plan means a
-- mistaken campaign to six hundred patients in Amharic is three segments each and
-- nobody finds out until the invoice.
--
-- 2,000 segments covers a real clinic's month — daily appointment reminders, new
-- registrations, bill chasing, and one greeting to the whole list — with room to
-- spare. It is a starting point, not a policy: the super-admin can raise any plan
-- or override a single clinic from the Plans tab.
UPDATE plans SET sms_monthly = 2000 WHERE sms_monthly IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Deliberately not reversed: restoring "unlimited" would silently remove a spend
-- cap, which is not a safe thing for a rollback to do on its own.
SELECT 1;
-- +goose StatementEnd
