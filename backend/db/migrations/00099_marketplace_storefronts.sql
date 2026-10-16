-- +goose Up
-- +goose StatementBegin

-- Every seller gets a store link: /marketplace/s/<slug>. They send it to their own
-- clients, who see only that seller's products with the same search and filters.

ALTER TABLE mp_sellers ADD COLUMN slug TEXT;
-- The link name may be changed once: a free-for-all would break links already sent.
ALTER TABLE mp_sellers ADD COLUMN slug_changed BOOLEAN NOT NULL DEFAULT false;

-- Existing sellers: a readable name from the business name, made unique by a number.
-- A name with no latin letters or digits (Amharic) becomes "seller".
WITH base AS (
    SELECT id, created_at,
           CASE WHEN length(r) < 3 OR r IN ('admin','sell','s','listing','listings','platform','api','marketplace',
                'new','www','login','signup','me','my','store','stores','clinicos','seller','sellers')
                THEN 'seller' ELSE left(r, 34) END AS b
      FROM (SELECT id, created_at,
                   trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) AS r
              FROM mp_sellers) x
), numbered AS (
    SELECT id, b, row_number() OVER (PARTITION BY b ORDER BY created_at, id) AS n FROM base
)
UPDATE mp_sellers s
   SET slug = left(CASE WHEN n.n = 1 THEN n.b ELSE n.b || '-' || n.n END, 40)
  FROM numbered n WHERE n.id = s.id;

ALTER TABLE mp_sellers ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX ux_mp_sellers_slug ON mp_sellers(slug);

-- A visit to a store page, so a seller can see their reach as well as their contacts.
CREATE TABLE mp_visits (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id  UUID NOT NULL REFERENCES mp_sellers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mp_visits_seller ON mp_visits(seller_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON mp_visits TO clinic_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS mp_visits;
DROP INDEX IF EXISTS ux_mp_sellers_slug;
ALTER TABLE mp_sellers DROP COLUMN IF EXISTS slug_changed;
ALTER TABLE mp_sellers DROP COLUMN IF EXISTS slug;
-- +goose StatementEnd
