-- +goose Up
-- +goose StatementBegin
-- Each clinic sends under its own name.
--
-- 00055 assumed one platform API key for everyone, because the gateway's send
-- endpoint has no sender field and it looked as though the sending identity was a
-- property of the account. It is not: a sender ID belongs to a **campaign**, an
-- account holds many campaigns, and an API key is permanently bound to one of
-- them. So a clinic with its own campaign gets its own Ethio-Telecom-approved
-- sender name — and needs its own key to send through it.
--
-- That is a much better outcome than the workaround it replaces. Until now the
-- clinic's name had to be pasted into the front of every message, costing
-- characters on every single send, because the patient would otherwise see 8726 —
-- a shared numeric sender that only reaches numbers verified in the dashboard, and
-- so was never viable for real patients anyway. With an approved sender name the
-- phone shows "CureDental" and the body is free to be just the message.
--
-- The key is encrypted at rest with the same AES-256-GCM key that protects TOTP
-- secrets and DHIS2 tokens. It is a credential that can spend money, and RLS keeps
-- it inside its tenant, but neither is a reason to store it in the clear.
ALTER TABLE clinics
  ADD COLUMN sms_api_key_enc TEXT,
  -- The approved sender name as Ethio Telecom cleared it. Display only: the
  -- gateway derives the real one from the campaign behind the key, so this cannot
  -- change what a patient sees — it records what we expect them to see.
  ADD COLUMN sms_sender_id TEXT,
  -- Approval is a human process at Ethio Telecom taking 1–2 business days, with
  -- rejection a real outcome. There is no API to ask, so the state is recorded
  -- here by whoever watched the console. It exists to answer one question well:
  -- when every message fails with 10006, is this clinic broken or just waiting?
  ADD COLUMN sms_sender_status TEXT NOT NULL DEFAULT 'none'
    CHECK (sms_sender_status IN ('none', 'pending', 'approved', 'rejected'));

COMMENT ON COLUMN clinics.sms_api_key_enc IS
  'AES-GCM(base64) of this clinic''s SMSEthiopia key. The key is bound to one campaign, which supplies the sender ID and the package that gets debited.';
COMMENT ON COLUMN clinics.sms_sender_name IS
  'Fallback only: prefixed into the message body when the clinic has no approved sender ID, so the patient still knows who is writing. Costs characters on every send.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE clinics
  DROP COLUMN IF EXISTS sms_api_key_enc,
  DROP COLUMN IF EXISTS sms_sender_id,
  DROP COLUMN IF EXISTS sms_sender_status;
-- +goose StatementEnd
