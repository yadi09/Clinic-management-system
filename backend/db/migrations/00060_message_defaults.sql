-- +goose Up
-- +goose StatementBegin
-- Wording every clinic can start from, in both languages.
--
-- 00055 created the tables and left them empty, on the theory that a clinic would
-- write its own. That is the wrong default: an empty template list means the first
-- thing anyone meets is a blank box and a question about tone, in a second language,
-- with a per-character cost. Almost nobody writes that from nothing.
--
-- So every clinic gets working wording on day one and edits from there. The rules
-- stay OFF — the words are a suggestion, but spending the clinic's money and
-- messaging its patients is a decision it makes deliberately.
--
-- Two constraints shaped the wording itself:
--
-- Length. Amharic fits 70 characters per paid message against Latin's 160, so each
-- Amharic default is written to land inside one segment rather than translated
-- literally from a comfortable English sentence. Politeness that costs triple is
-- not politeness a clinic can afford daily.
--
-- Discretion. A phone is shared in a great many Ethiopian households, so a message
-- naming the procedure discloses it to whoever picks the handset up. The defaults
-- therefore say "you have an appointment", never what for. A clinic can add detail;
-- it should not arrive by accident.
INSERT INTO message_templates (tenant_id, kind, lang, body)
SELECT t.id, v.kind, v.lang, v.body
FROM tenants t
CROSS JOIN (VALUES
  ('welcome', 'en',
   'Welcome to {{clinic}}. Your card number is {{card}} — please keep it for your next visit.'),
  ('welcome', 'am',
   'እንኳን ደህና መጡ። የካርድ ቁጥርዎ {{card}} ነው። ለሚቀጥለው ጉብኝት ይያዙት።'),
  ('appointment_reminder', 'en',
   'Reminder: you have an appointment at {{clinic}} on {{date}} at {{time}}.'),
  ('appointment_reminder', 'am',
   'ማስታወሻ፦ በ{{date}} በ{{time}} ቀጠሮ አለዎት።'),
  ('bill_reminder', 'en',
   'You have an unpaid balance of {{amount}} ETB at {{clinic}}. Please settle it on your next visit.'),
  ('bill_reminder', 'am',
   'በ{{clinic}} {{amount}} ብር ያልተከፈለ ቀሪ አለዎት። እባክዎ ይክፈሉ።')
) AS v(kind, lang, body)
ON CONFLICT (tenant_id, kind, lang) DO NOTHING;

-- One rule row per kind, all switched off, with sensible timing already chosen so
-- turning one on is a single click rather than a form.
INSERT INTO message_rules (tenant_id, kind, enabled, offset_hours, send_at, repeat_days, max_repeats)
SELECT t.id, v.kind, false, v.offset_hours, v.send_at::time, v.repeat_days, v.max_repeats
FROM tenants t
CROSS JOIN (VALUES
  -- Immediate: the card number is useful while the patient is still at the desk.
  ('welcome', 0, NULL, 0, 0),
  -- The evening before is the reminder that actually changes attendance; 18:00 is
  -- after work and well clear of quiet hours.
  ('appointment_reminder', -24, '18:00', 0, 0),
  -- A week after the debt appears, then once more a week later. Twice is a
  -- reminder; more than that is harassment the clinic pays for.
  ('bill_reminder', 168, '10:00', 7, 1)
) AS v(kind, offset_hours, send_at, repeat_days, max_repeats)
ON CONFLICT (tenant_id, kind) DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM message_rules;
DELETE FROM message_templates;
-- +goose StatementEnd
