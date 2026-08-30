-- +goose Up
-- +goose StatementBegin

-- The vendor's own sales pipeline: clinics being courted, and how far along each is.
--
-- This is not clinic data. It belongs to ClinicOS the business, lives above the
-- tenant boundary like platform_admins and partner_leads, and is reached only on the
-- privileged connection. The grants at the bottom make that explicit rather than
-- relying on it: a tenant's connection must never be able to read who the vendor is
-- selling to, and DEFAULT PRIVILEGES would otherwise hand clinic_app a grant on every
-- new table in this schema.

-- Marketing staff are platform accounts, but they are NOT super-admins: a rep who
-- can walk into a clinic must not be able to provision, suspend or impersonate one.
ALTER TABLE platform_admins
    ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
        CHECK (role IN ('admin', 'marketer'));

-- A campaign is an ordered set of phases. Both are the admin's to define: "phase 1,
-- phase 2, phase 3" is the whole model, and hard-coding a funnel would be wrong the
-- first time a different approach is tried.
CREATE TABLE crm_campaigns (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    goal        TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID REFERENCES platform_admins(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ
);

CREATE TABLE crm_phases (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID NOT NULL REFERENCES crm_campaigns(id) ON DELETE CASCADE,
    seq         INT  NOT NULL,
    name        TEXT NOT NULL,
    -- What the rep is meant to actually do at this step, in the admin's words.
    intent      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_crm_phases_seq ON crm_phases(campaign_id, seq);

-- A clinic the vendor wants as a customer. Everything a rep needs standing outside
-- the building: who to ask for, a number to tap, and an address to navigate to.
CREATE TABLE crm_prospects (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_name  TEXT NOT NULL,
    contact_name TEXT,
    contact_role TEXT,
    phone        TEXT,
    phone_alt    TEXT,
    email        TEXT,
    address      TEXT,
    -- Pasted from Google Maps, or built from the address. Either way the card shows
    -- one Directions button and the rep never retypes an address into their phone.
    map_url      TEXT,
    note         TEXT,
    -- Where it came from: walked in on, the website form, or someone's referral.
    source       TEXT NOT NULL DEFAULT 'field'
        CHECK (source IN ('field', 'inbound', 'referral', 'other')),
    -- The inbound enquiry this prospect was created from, if any. One prospect per
    -- lead, so re-running the import cannot duplicate the pipeline.
    partner_lead_id UUID UNIQUE REFERENCES partner_leads(id),
    owner_id     UUID REFERENCES platform_admins(id),
    status       TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'signed_up', 'not_yet', 'not_interested')),
    -- "Call me when we reopen in Meskerem" is a real answer and the commonest one.
    -- Without a date it is indistinguishable from a no.
    ready_on     DATE,
    outcome_note TEXT,
    -- Set when they become a customer, so the pipeline and the workspace are joined.
    tenant_id    UUID REFERENCES tenants(id),
    created_by   UUID REFERENCES platform_admins(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_crm_prospects_owner  ON crm_prospects(owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_crm_prospects_status ON crm_prospects(status)   WHERE deleted_at IS NULL;
-- Two reps collecting the same clinic is the failure this prevents; the number is
-- what they both have. Not unique — a group can share a line — but searchable.
CREATE INDEX idx_crm_prospects_phone  ON crm_prospects(phone)    WHERE deleted_at IS NULL;

-- A prospect walking through one campaign. At most one at a time: being at phase 2
-- of one campaign and phase 4 of another is not a state anyone can act on.
CREATE TABLE crm_enrollments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id UUID NOT NULL REFERENCES crm_prospects(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES crm_campaigns(id),
    phase_id    UUID REFERENCES crm_phases(id),
    status      TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'finished', 'dropped')),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    created_by  UUID REFERENCES platform_admins(id)
);
CREATE UNIQUE INDEX ux_crm_enrollment_active ON crm_enrollments(prospect_id) WHERE status = 'active';
CREATE INDEX idx_crm_enrollments_phase ON crm_enrollments(phase_id) WHERE status = 'active';

-- Each step, as it was completed. The record of who moved a clinic forward and when
-- is the difference between a pipeline and a guess.
CREATE TABLE crm_phase_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id UUID NOT NULL REFERENCES crm_enrollments(id) ON DELETE CASCADE,
    phase_id      UUID NOT NULL REFERENCES crm_phases(id),
    note          TEXT,
    done_by       UUID REFERENCES platform_admins(id),
    done_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_phase_events_enrollment ON crm_phase_events(enrollment_id);

-- Every touch. This is what stops the second rep phoning a clinic the first rep
-- called yesterday, which is the thing a shared pipeline is FOR.
CREATE TABLE crm_touches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id UUID NOT NULL REFERENCES crm_prospects(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('call', 'visit', 'message', 'note')),
    note        TEXT,
    -- Backdatable: a rep logging yesterday's visit this morning is the normal case.
    happened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    by_id       UUID REFERENCES platform_admins(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crm_touches_prospect ON crm_touches(prospect_id, happened_at DESC);

-- Vendor data, vendor connection only.
REVOKE ALL ON crm_campaigns, crm_phases, crm_prospects, crm_enrollments,
              crm_phase_events, crm_touches FROM clinic_app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS crm_touches;
DROP TABLE IF EXISTS crm_phase_events;
DROP TABLE IF EXISTS crm_enrollments;
DROP TABLE IF EXISTS crm_prospects;
DROP TABLE IF EXISTS crm_phases;
DROP TABLE IF EXISTS crm_campaigns;
ALTER TABLE platform_admins DROP COLUMN IF EXISTS role;
-- +goose StatementEnd
