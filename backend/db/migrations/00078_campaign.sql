-- +goose Up
-- +goose StatementBegin

-- Enkutatash: a campaign that teaches, then draws.
--
-- Dental clinics are reached on Telegram, sent a demo video and a page about the
-- system, and then come here. They register with three fields, answer questions
-- about what the software actually does — a wrong answer is explained and asked
-- again, because the point is that they learn the feature, not that they score —
-- and then they spin once for one of three free implementations.
--
-- The whole reason this is a table and not a static page: the draw has to be
-- provably fair to people who have no reason to trust us yet.
--
--   The outcomes are sealed before anyone plays. On opening, every one of the N
--   chances is either a gift or a real New Year offer, and which is which is
--   decided by a secret seed whose SHA-256 is published on the page from the
--   first day. At close the seed itself is published, and anyone can recompute
--   the entire wheel:
--
--       rank(i) = SHA256(seed || ':' || i)      for i in 0 .. N-1
--       the `gifts` positions with the lowest rank are the gifts
--
--   Clinics claim positions in the order they finish the quiz, so every clinic's
--   chance is exactly gifts/chances no matter when it arrives. Nobody can be
--   moved, and we cannot pick a winner after seeing who entered.
CREATE TABLE campaigns (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The unguessable part of the URL. Private by link, like the pricing page.
    code             TEXT NOT NULL UNIQUE,
    title            TEXT NOT NULL,
    subtitle         TEXT,
    status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'open', 'closed')),
    opens_at         TIMESTAMPTZ,
    closes_at        TIMESTAMPTZ,
    -- How many clinics can play, and how many of them get the gift.
    chances          INTEGER NOT NULL DEFAULT 20 CHECK (chances > 0),
    gifts            INTEGER NOT NULL DEFAULT 3  CHECK (gifts >= 0),
    gift_label       TEXT NOT NULL DEFAULT 'Complete dental clinic system — implemented free',
    gift_detail      TEXT,
    -- Published from day one; the seed itself only at close.
    seed             TEXT,
    seed_hash        TEXT,
    sealed_at        TIMESTAMPTZ,
    contact_telegram TEXT,
    contact_phone    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The segments that are not the gift. Every one is a real offer, so no clinic
-- ever spins a losing wheel — which is both kinder and the thing that turns a
-- raffle into a reason to talk next week.
CREATE TABLE campaign_prizes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    detail      TEXT,
    weight      INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
    sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_campaign_prizes ON campaign_prizes(campaign_id, sort);

-- One row per chance, generated when the campaign opens and never rewritten
-- once claimed. Claiming in index order over a shuffled list is the same draw as
-- picking at random from an unshuffled one, and it is far easier to prove.
CREATE TABLE campaign_slots (
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    is_gift     BOOLEAN NOT NULL DEFAULT false,
    prize_id    UUID REFERENCES campaign_prizes(id) ON DELETE SET NULL,
    entry_id    UUID,
    claimed_at  TIMESTAMPTZ,
    PRIMARY KEY (campaign_id, idx)
);
CREATE INDEX idx_campaign_slots_open ON campaign_slots(campaign_id, idx) WHERE entry_id IS NULL;

-- A question exists to teach one feature. `teaches` is what we say once they get
-- it right; each wrong choice carries its own explanation, because "no, try
-- again" teaches nothing and this campaign has no other purpose.
CREATE TABLE campaign_questions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    prompt      TEXT NOT NULL,
    teaches     TEXT,
    -- [{"label": "...", "correct": true|false, "explain": "..."}]
    choices     JSONB NOT NULL DEFAULT '[]'::jsonb,
    sort        INTEGER NOT NULL DEFAULT 0,
    active      BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_campaign_questions ON campaign_questions(campaign_id, sort);

-- One clinic. The phone is the identity: one entry, one spin, and the number is
-- how we call them afterwards — which, whoever wins, is what this is really for.
CREATE TABLE campaign_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id  UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    full_name    TEXT NOT NULL,
    phone        TEXT NOT NULL,
    clinic_name  TEXT NOT NULL,
    -- Hashed, like every other token in this system. Held in the browser so a
    -- refresh mid-quiz does not lose their place.
    token_hash   TEXT NOT NULL,
    -- Every attempt, right or wrong: [{"q":"...","choice":N,"correct":bool,"at":"..."}]
    -- The wrong ones are the useful ones — they say which feature nobody knew about.
    answers      JSONB NOT NULL DEFAULT '[]'::jsonb,
    quiz_done_at TIMESTAMPTZ,
    slot_idx     INTEGER,
    spun_at      TIMESTAMPTZ,
    won          BOOLEAN NOT NULL DEFAULT false,
    prize_label  TEXT,
    -- Set when a gift left unclaimed at close is drawn among everyone who played.
    drawn_at     TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, phone)
);
CREATE INDEX idx_campaign_entries ON campaign_entries(campaign_id, created_at DESC);

-- Read and written by the public campaign endpoints on the ordinary app pool.
-- No tenant_id anywhere here: a clinic filling this in does not have a workspace
-- yet, which is the entire point of the campaign.
GRANT SELECT, INSERT, UPDATE ON campaigns, campaign_prizes, campaign_slots,
      campaign_questions, campaign_entries TO clinic_app;

-- --------------------------------------------------------------------------
-- The Enkutatash 2019 campaign itself, ready to edit in the console.
-- --------------------------------------------------------------------------
INSERT INTO campaigns (code, title, subtitle, chances, gifts, gift_label, gift_detail,
                       opens_at, closes_at)
VALUES (
  'enkutatash-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  'መልካም አዲስ ዓመት',
  'Three dental clinics start 2019 with the whole system installed, free.',
  20, 3,
  'Complete dental clinic system — implemented free',
  'Installed at your clinic, your records brought across, your team trained. Yours to keep.',
  now(),
  -- Meskel, 27 September 2026: the end of the Meskerem holidays and the day the
  -- draw closes. Enough time to actually reach every clinic on the list.
  '2026-09-27 20:00:00+03'
);

INSERT INTO campaign_prizes (campaign_id, label, detail, weight, sort)
SELECT c.id, v.label, v.detail, v.weight, v.sort FROM campaigns c, (VALUES
  ('25% off the implementation', 'A quarter off the one-time setup, for the whole of Meskerem.', 3, 10),
  ('20% off the implementation', 'A fifth off the one-time setup, for the whole of Meskerem.', 3, 20),
  ('Free data migration',        'We bring your old patient register across ourselves — cards, names, phone numbers, history.', 3, 30),
  ('Free training day at your clinic', 'A full day with your dentists, your front desk and your cashier, in your own rooms.', 3, 40),
  ('Free first-year support',    'Every question answered for twelve months, at no cost.', 3, 50),
  ('Free tooth-chart setup',     'Your own procedures and your own tooth conditions configured for you before you start.', 2, 60)
) AS v(label, detail, weight, sort)
WHERE c.code LIKE 'enkutatash-%';

-- The questions. Each one is a feature we want a dentist to remember on Meskerem 2,
-- so every wrong answer says what the software actually does instead.
INSERT INTO campaign_questions (campaign_id, prompt, teaches, choices, sort)
SELECT c.id, v.prompt, v.teaches, v.choices::jsonb, v.sort FROM campaigns c, (VALUES
(
 'A patient comes back after two years with pain in the upper right first molar. Where does that tooth''s history live?',
 'Every tooth carries its own record — what was found, what was done, and when. Two years later the answer takes one look, not a search through old notes.',
 '[{"label":"On a tooth chart, where each tooth holds its own status and history","correct":true,"explain":""},
   {"label":"Written into the visit note as a sentence","correct":false,"explain":"That is what paper does, and it is exactly why nobody can answer this question two years later. ClinicOS keeps a tooth chart: all 32 teeth, each with its own condition and its own history, and the conditions themselves are yours to name."},
   {"label":"On a scan of the paper chart","correct":false,"explain":"A scan cannot be searched or counted. In ClinicOS the chart is live: tap the tooth, see everything ever recorded on it, and the X-rays taken of it."}]',
 10),
(
 'You are starting a brace case. How many of the 32 teeth do you tick one at a time?',
 'Whole mouth in one tap — and you can also select every decayed tooth, or the whole upper arch, at once.',
 '[{"label":"None — there is Select all, upper, lower, and select-by-condition","correct":true,"explain":""},
   {"label":"All 32, one by one","correct":false,"explain":"Not here. There is Select all for a brace case, upper or lower arch, and — the one people like most — select every tooth that already has a condition, so ''all the decayed ones'' is a single tap."},
   {"label":"You record braces without choosing teeth","correct":false,"explain":"You can select the whole mouth in one tap, and the treatment is still recorded tooth by tooth, so the chart stays true."}]',
 20),
(
 'A 14,000 birr course of treatment. The patient will pay across several visits. What does the system do?',
 'A plan with a deposit and a payment per visit, agreed up front. Reception and the cashier both see the balance without asking you.',
 '[{"label":"A treatment plan with a deposit and instalments, and a running balance","correct":true,"explain":""},
   {"label":"You raise the full 14,000 and hope","correct":false,"explain":"ClinicOS records the plan: a deposit and an agreed payment per visit. What is owed, what has been paid and what is still to come is on the patient''s card, so the front desk can answer without walking to your room."},
   {"label":"You track it in a notebook","correct":false,"explain":"That is where the money goes missing. The plan lives with the patient''s record, and the balance follows them to the cashier automatically."}]',
 30),
(
 'You finished a filling, the patient walked out, and nobody sent it to the cashier. What happens next?',
 'The unbilled work finds you. Bill one treatment you would have forgotten and the system has paid for itself.',
 '[{"label":"It appears on an Unbilled treatment report, and in red on the patient''s card","correct":true,"explain":""},
   {"label":"Nothing — it is lost","correct":false,"explain":"Not here. Work that was recorded but never charged is listed on its own report, and shows in red on the chairside card with the amount, so somebody can act on it that same day."},
   {"label":"You would have to check every patient by hand","correct":false,"explain":"The system already checks. Every treatment recorded and not billed is on one screen, with the patient and the amount — this is the single feature that most often pays for the software."}]',
 40),
(
 'A patient genuinely cannot pay today, but needs the treatment now. What does the front desk do?',
 'Treat now, pay later — recorded as a promise with a reason, and the debt stays visible until it is settled.',
 '[{"label":"Record it as pay-later with the reason, and the debt stays visible","correct":true,"explain":""},
   {"label":"Mark it paid and sort it out later","correct":false,"explain":"That is how a clinic loses money it never knows it lost. ClinicOS records the promise with a reason and a name, keeps the amount owed on the patient''s card, and lists everyone who owes you, aged by how long."},
   {"label":"Turn the patient away","correct":false,"explain":"You do not have to. Give the treatment against a recorded promise: who agreed it, why, and how much — and it stays on the books until it is paid."}]',
 50),
(
 'How many X-rays and photographs can you keep on one patient?',
 'As many as the treatment needs. There is no per-patient limit — only the storage the clinic has.',
 '[{"label":"As many as the treatment needs","correct":true,"explain":""},
   {"label":"About ten, then you delete old ones","correct":false,"explain":"No limit per patient. Take the full series, before-and-after photographs, whatever the case needs — the only ceiling is total storage, and that can be added to at any time."},
   {"label":"Only the most recent one is kept","correct":false,"explain":"Every image is kept and stays attached to the patient and the tooth, so you can put the before and the after side by side years later."}]',
 60),
(
 'Your receptionist writes ጳጉሜን on the card and your report needs September. Which date does the system show?',
 'Both, side by side, everywhere a date appears. Nobody converts anything in their head.',
 '[{"label":"Both, side by side","correct":true,"explain":""},
   {"label":"Only Gregorian, and you convert in your head","correct":false,"explain":"ClinicOS shows the Ethiopian and the Gregorian date together — on the patient card, on appointments, on reports. Your desk reads one, the Ministry reads the other, and nobody has to convert anything."},
   {"label":"Only Ethiopian","correct":false,"explain":"Both are shown together, so the same screen works for your front desk and for anything you have to file."}]',
 70)
) AS v(prompt, teaches, choices, sort)
WHERE c.code LIKE 'enkutatash-%';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS campaign_entries;
DROP TABLE IF EXISTS campaign_slots;
DROP TABLE IF EXISTS campaign_questions;
DROP TABLE IF EXISTS campaign_prizes;
DROP TABLE IF EXISTS campaigns;
-- +goose StatementEnd
