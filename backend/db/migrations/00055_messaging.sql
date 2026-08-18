-- +goose Up
-- +goose StatementBegin
-- Telling patients things, by SMS.
--
-- A clinic's whole relationship with a patient between visits happens on a phone,
-- and until now the system had no way to use one. Reminders were a receptionist
-- with a notebook; a patient who owed money heard about it when they next walked
-- in; a new patient left without their card number written anywhere they would
-- still have it in six months.
--
-- Three tables, and the split between them is the point:
--
--   message_templates  what the clinic WANTS to say (editable, per language)
--   message_rules      WHEN it should be said (a day before, a week after)
--   messages           what was ACTUALLY said, to whom, and what it cost
--
-- A message row freezes the rendered text and the phone number at the moment it
-- was queued. It deliberately does not point at a template: when the clinic
-- rewrites its reminder next month, last month's log must still show the words
-- the patient really received. A log that changes retroactively is not a log.
--
-- On the gateway (SMSEthiopia, direct Ethio Telecom): there are no delivery
-- receipts. Its send endpoint returns no usable message id and it exposes no
-- status callback, so the furthest any row can honestly get is 'sent' — meaning
-- the network accepted it. There is no 'delivered' state here because we would
-- have no way to know, and a status we cannot verify is worse than none.

CREATE TABLE message_templates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    -- kind is the occasion. 'custom' has no template — it is written per send.
    kind       TEXT NOT NULL CHECK (kind IN ('welcome', 'appointment_reminder', 'bill_reminder')),
    lang       TEXT NOT NULL CHECK (lang IN ('en', 'am')),
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID,
    UNIQUE (tenant_id, kind, lang)
);

-- When each kind goes out, and whether it goes out at all.
--
-- Separate from the template because they are edited by different thoughts: the
-- wording is a matter of tone, the timing is a matter of policy, and a clinic
-- that is still deciding what to say should be able to leave the automation off
-- without losing its draft.
CREATE TABLE message_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    kind        TEXT NOT NULL CHECK (kind IN ('welcome', 'appointment_reminder', 'bill_reminder')),
    -- Off by default, always. Turning on a feature that spends the clinic's money
    -- and messages its patients is a decision they make, not one they discover.
    enabled     BOOLEAN NOT NULL DEFAULT false,
    -- Hours relative to the thing being talked about: negative is before (an
    -- appointment reminder at -24), positive is after (a bill chased at +168).
    -- Ignored by 'welcome', which is immediate by nature.
    offset_hours INT NOT NULL DEFAULT -24,
    -- Local clock time to send at, so a reminder planned at 02:00 still arrives at
    -- a civilised hour. NULL means "as soon as the offset is reached".
    send_at     TIME,
    -- Chasing an unpaid bill: how many more times, how far apart. 0 = once only.
    repeat_days INT NOT NULL DEFAULT 0 CHECK (repeat_days >= 0),
    max_repeats INT NOT NULL DEFAULT 0 CHECK (max_repeats >= 0 AND max_repeats <= 5),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, kind)
);

CREATE TABLE messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    branch_id   UUID REFERENCES branches(id),
    patient_id  UUID REFERENCES patients(id),
    kind        TEXT NOT NULL CHECK (kind IN ('welcome', 'appointment_reminder', 'bill_reminder', 'custom')),
    lang        TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'am')),
    -- Frozen at queue time. The patient may change their number tomorrow; this is
    -- the one the message went to, which is what an audit needs to know.
    msisdn      TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    -- What it cost, worked out when queued: an SMS is 160 GSM-7 characters or 70
    -- UCS-2 (any Amharic at all forces UCS-2), and a clinic that cannot see that
    -- before sending discovers it on the bill.
    segments    INT NOT NULL DEFAULT 1,
    cost        NUMERIC(10,4) NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
    -- Why nothing was sent: no_phone | bad_phone | quota | duplicate | no_consent.
    -- Recorded rather than discarded, because "why didn't she get it?" is the
    -- question the front desk will actually be asked.
    skip_reason TEXT,
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ,
    attempts    INT NOT NULL DEFAULT 0,
    last_error  TEXT,
    campaign_id UUID,
    -- Idempotency, structurally. A duplicate SMS costs money AND annoys a patient,
    -- so a second planner pass must be unable to create one rather than merely
    -- unlikely to. e.g. 'appt:<uuid>:24h', 'welcome:<uuid>', 'bill:<uuid>:2026-W34:1'.
    dedupe_key  TEXT,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_messages_dedupe ON messages(tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
-- The dispatcher's own query: due, not yet dealt with, oldest first.
CREATE INDEX idx_messages_due ON messages(scheduled_for)
  WHERE status = 'scheduled';
CREATE INDEX idx_messages_patient ON messages(tenant_id, patient_id, created_at DESC);
CREATE INDEX idx_messages_log ON messages(tenant_id, created_at DESC);
-- Counting a month's spend against the plan cap, cheaply.
CREATE INDEX idx_messages_billed ON messages(tenant_id, sent_at)
  WHERE status = 'sent';

CREATE TABLE message_campaigns (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    lang        TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'am')),
    status      TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'scheduled', 'sending', 'done', 'cancelled')),
    scheduled_for TIMESTAMPTZ,
    total       INT NOT NULL DEFAULT 0,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_campaigns_tenant ON message_campaigns(tenant_id, created_at DESC);

ALTER TABLE messages
  ADD CONSTRAINT messages_campaign_fk FOREIGN KEY (campaign_id)
  REFERENCES message_campaigns(id) ON DELETE SET NULL;

-- Sending settings live on the clinic profile: one sender identity, one set of
-- quiet hours, one default language. Not per branch — a patient does not care
-- which branch they were seen at when their phone buzzes at 6am.
ALTER TABLE clinics
  ADD COLUMN sms_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN sms_lang        TEXT NOT NULL DEFAULT 'en' CHECK (sms_lang IN ('en', 'am')),
  -- Quiet hours in the clinic's own timezone. A message due inside them is held
  -- until the window opens, never dropped: the reminder is still wanted, just not
  -- at 04:00. Equal values mean no quiet period at all.
  ADD COLUMN sms_quiet_from  TIME NOT NULL DEFAULT '21:00',
  ADD COLUMN sms_quiet_to    TIME NOT NULL DEFAULT '07:00',
  -- The gateway sends from one shared platform identity and its API has no sender
  -- field, so the clinic's name has to travel inside the text or the patient has
  -- no idea who is messaging them. Defaults to the clinic name at first save.
  ADD COLUMN sms_sender_name TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN clinics.sms_sender_name IS
  'Prefixed to every outgoing message. The gateway has no sender-ID field, so this is the only thing telling the patient who is writing.';

-- Per-plan monthly allowance, overridable per clinic — the same shape as every
-- other limit (storage, patients, users, branches), so it is enforced by the same
-- kernel and shown by the same usage bars.
ALTER TABLE plans   ADD COLUMN IF NOT EXISTS sms_monthly INTEGER;         -- NULL = unlimited
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sms_monthly_override INTEGER; -- NULL = inherit

UPDATE plans SET sms_monthly = 500  WHERE code = 'starter'  AND sms_monthly IS NULL;
UPDATE plans SET sms_monthly = 2000 WHERE code = 'clinic'   AND sms_monthly IS NULL;
UPDATE plans SET sms_monthly = 10000 WHERE code = 'pro'     AND sms_monthly IS NULL;

-- Patients can be marked unreachable-by-choice. Honoured by every kind, including
-- a hand-picked campaign: if someone has asked not to be messaged, a staff member
-- ticking their name in a list is not a reason to overrule them.
ALTER TABLE patients ADD COLUMN sms_opt_out BOOLEAN NOT NULL DEFAULT false;

-- The module flag, and the two permissions.
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
    CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr',
                    'finance_advanced','maternity','inpatient','dental','messaging'));

-- message.manage = configure templates, timing and sending settings (the owner).
-- message.send   = write and send one to patients (reception, too).
INSERT INTO permissions (code, description) VALUES
  ('message.manage', 'Configure patient messaging: templates, timing and sending settings'),
  ('message.send',   'Send messages to patients')
ON CONFLICT (code) DO NOTHING;


DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['message_templates','message_rules','messages','message_campaigns']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    $f$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON message_templates, message_rules, messages, message_campaigns TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS message_campaigns;
DROP TABLE IF EXISTS message_rules;
DROP TABLE IF EXISTS message_templates;
ALTER TABLE patients DROP COLUMN IF EXISTS sms_opt_out;
ALTER TABLE tenants  DROP COLUMN IF EXISTS sms_monthly_override;
ALTER TABLE plans    DROP COLUMN IF EXISTS sms_monthly;
ALTER TABLE clinics
  DROP COLUMN IF EXISTS sms_enabled,
  DROP COLUMN IF EXISTS sms_lang,
  DROP COLUMN IF EXISTS sms_quiet_from,
  DROP COLUMN IF EXISTS sms_quiet_to,
  DROP COLUMN IF EXISTS sms_sender_name;
DELETE FROM permissions WHERE code IN ('message.manage', 'message.send');
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
    CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr',
                    'finance_advanced','maternity','inpatient','dental'));
-- +goose StatementEnd
