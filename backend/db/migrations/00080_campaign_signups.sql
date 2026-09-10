-- +goose Up
-- +goose StatementBegin

-- Registering interest is not the same thing as playing.
--
-- The campaign has two lists and they had been collapsed into one. A clinic that
-- fills in this form has put its hand up; it has not seen the video, answered
-- anything or spun. We reach out to these clinics, and the ones that agree are
-- sent the quiz link — which is where campaign_entries begins.
--
-- Keeping them apart matters for the draw as much as the sales: entries claim a
-- position on the wheel, and a clinic that merely signed up must not hold one.
CREATE TABLE campaign_signups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    owner_name  TEXT NOT NULL,
    phone       TEXT NOT NULL,
    clinic_name TEXT NOT NULL,
    -- Free text on purpose. Ethiopian clinics are found by landmark and sub-city,
    -- not by an address a dropdown could hold.
    location    TEXT NOT NULL,
    -- What the clinic is made of, in their own words: "reception, two dentists,
    -- one chair, we send X-rays out". The thing that tells us whether this is a
    -- one-chair practice or a group before we ever call.
    structure   TEXT,
    -- The same answer in a countable form, from the chips on the form, so the
    -- console can say how many have a lab without anyone reading 40 paragraphs.
    facilities  TEXT[] NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'contacted', 'invited', 'joined', 'declined')),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One clinic, one entry on the list. A second attempt updates rather than
    -- duplicating, because a clinic re-sending the form is correcting itself.
    UNIQUE (campaign_id, phone)
);
CREATE INDEX idx_campaign_signups ON campaign_signups(campaign_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON campaign_signups TO clinic_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS campaign_signups;
-- +goose StatementEnd
