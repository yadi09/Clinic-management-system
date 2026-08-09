-- +goose Up
-- +goose StatementBegin
-- Vendor-side referral/partner lead capture from the public partner pages. This is
-- a global (non-tenant) table, read/written only through the privileged platform
-- connection, so it is not RLS-scoped — same category as plans / platform_admins.
CREATE TABLE partner_leads (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             TEXT NOT NULL,
    phone            TEXT,
    email            TEXT,
    region           TEXT,
    audience         TEXT,   -- influencer | clinic_owner | professional | sales | other
    clinics_estimate TEXT,   -- 1-3 | 4-10 | 11-20 | 20+
    goal             TEXT,
    source           TEXT,   -- partner link slug and/or ?ref= that referred them
    ip               TEXT,
    user_agent       TEXT,
    status           TEXT NOT NULL DEFAULT 'new',  -- new | contacted | signed | archived
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_partner_leads_created ON partner_leads(created_at DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS partner_leads;
-- +goose StatementEnd
