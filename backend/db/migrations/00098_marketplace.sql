-- +goose Up
-- +goose StatementBegin

-- The ClinicOS marketplace: dental suppliers, wholesalers and clinics post products,
-- and anyone can search for them and contact the seller.
--
-- None of this is clinic data. A seller is not a tenant and a listing is public, so
-- these tables live above the tenant boundary (no RLS) like campaigns and
-- partner_leads. A tenant's data is never reachable from here: a clinic that sells
-- is just a seller of kind 'clinic'. (No tenant_id column: the isolation guard treats
-- any table carrying one as clinic data that must be row-level secured.)

CREATE TABLE mp_sellers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT NOT NULL CHECK (kind IN ('supplier','clinic','individual')),
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL,
    telegram      TEXT,
    city          TEXT NOT NULL,
    subcity       TEXT,
    about         TEXT,
    password_hash TEXT NOT NULL,
    -- New sellers are pending until the vendor has phoned them. Nothing they post is
    -- public before then.
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','suspended')),
    status_note   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at   TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_mp_sellers_phone ON mp_sellers(phone);
CREATE INDEX idx_mp_sellers_status ON mp_sellers(status, created_at DESC);

-- Opaque session tokens, hashed like every other token here.
CREATE TABLE mp_sessions (
    token_hash TEXT PRIMARY KEY,
    seller_id  UUID NOT NULL REFERENCES mp_sellers(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mp_listings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id    UUID NOT NULL REFERENCES mp_sellers(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    brand        TEXT,
    category     TEXT NOT NULL,
    description  TEXT,
    -- Required, never defaulted: a buyer must never mistake a used chair for a new one.
    condition    TEXT NOT NULL
                 CHECK (condition IN ('new','like_new','used_good','used_fair','for_parts')),
    -- NULL price means "ask for price".
    price_etb    NUMERIC(14,2) CHECK (price_etb IS NULL OR price_etb >= 0),
    negotiable   BOOLEAN NOT NULL DEFAULT false,
    quantity     INT CHECK (quantity IS NULL OR quantity >= 0),
    expiry       TEXT,          -- MM/YYYY, consumables only
    warranty     TEXT,
    -- Storage keys; delivery URLs are built from them on the way out.
    photos       TEXT[] NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','hidden')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    search       TSVECTOR GENERATED ALWAYS AS (
                   to_tsvector('simple',
                     coalesce(title,'') || ' ' || coalesce(brand,'') || ' ' ||
                     coalesce(category,'') || ' ' || coalesce(description,''))) STORED
);
CREATE INDEX idx_mp_listings_seller ON mp_listings(seller_id, created_at DESC);
CREATE INDEX idx_mp_listings_browse ON mp_listings(category, created_at DESC) WHERE status = 'active';
CREATE INDEX idx_mp_listings_search ON mp_listings USING GIN(search);
CREATE INDEX idx_mp_listings_title ON mp_listings (lower(title));

-- Every tap on Call / Telegram / WhatsApp, so a seller can see what ClinicOS sent them.
CREATE TABLE mp_contacts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES mp_listings(id) ON DELETE CASCADE,
    seller_id  UUID NOT NULL REFERENCES mp_sellers(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL CHECK (channel IN ('call','telegram','whatsapp')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mp_contacts_seller ON mp_contacts(seller_id, created_at DESC);

-- Searches that found nothing: tells the vendor which suppliers to recruit.
CREATE TABLE mp_searches (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    term       TEXT NOT NULL,
    results    INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mp_searches_empty ON mp_searches(created_at DESC) WHERE results = 0;

GRANT SELECT, INSERT, UPDATE, DELETE ON mp_sellers, mp_sessions, mp_listings, mp_contacts, mp_searches TO clinic_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS mp_searches;
DROP TABLE IF EXISTS mp_contacts;
DROP TABLE IF EXISTS mp_listings;
DROP TABLE IF EXISTS mp_sessions;
DROP TABLE IF EXISTS mp_sellers;
-- +goose StatementEnd
