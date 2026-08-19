-- +goose Up
-- +goose StatementBegin
-- Quiet hours are for messages the patient did not ask for.
--
-- 00055 applied them to everything, which held a welcome SMS — sent because the
-- patient was at that moment standing at the desk having just registered — until
-- seven the next morning. The clinic was open and registering patients at 21:38;
-- the one person guaranteed to be awake and expecting a message was the recipient.
-- The card number arriving twelve hours later is not a reminder of anything.
--
-- The distinction is not the hour, it is who started it:
--
--   Planned    an appointment reminder, a bill chase, a holiday greeting. Nobody
--              asked for these, and at 04:00 they are an intrusion. These wait.
--   Triggered  a welcome the patient just caused by registering; a test send a
--              staff member is watching their own phone for. Someone is waiting
--              on these right now, and delaying them looks like a fault.
--
-- Default false — respect quiet hours — so anything added later has to opt out of
-- them deliberately rather than inherit an exemption by forgetting to think.
ALTER TABLE messages
  ADD COLUMN bypass_quiet_hours BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN messages.bypass_quiet_hours IS
  'The recipient is waiting on this right now (welcome, test send), so quiet hours do not apply. Planned and bulk messages leave it false.';

-- Release anything already sitting in the overnight hold that should never have
-- been put there. A welcome queued this evening is still worth delivering now;
-- tomorrow morning it is just confusing.
UPDATE messages
   SET bypass_quiet_hours = true,
       scheduled_for = now()
 WHERE kind = 'welcome' AND status = 'scheduled' AND scheduled_for > now();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE messages DROP COLUMN IF EXISTS bypass_quiet_hours;
-- +goose StatementEnd
