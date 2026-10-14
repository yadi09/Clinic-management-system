-- +goose Up
-- +goose StatementBegin

-- The anatomical chart, version 2: one row per thing recorded on a tooth.
--
-- Version 1 kept a tooth's findings as one JSON object (dental_charts.anatomy). The
-- chart now records WHAT is on a tooth and WHAT STATE it is in — already in the mouth,
-- to be done, done today — and those items must later be linked to the treatment plan
-- that schedules them and the charge that bills them, without ever being billed twice.
-- That needs each item to have its own identity, author and history: a row.
--
--   kind        caries | filling | crown | root_canal | extraction | missing | implant | bridge
--   surface     O M D B L for caries and filling; NULL for the whole tooth
--   material    filling: composite | amalgam; crown, implant, bridge: zirconia | pfm | gold | steel
--   status      existing (already in mouth) | planned (to be done) | done (done in a visit)
--   bridge_end  a bridge is stored on one end tooth (tooth) and names the other (bridge_end)
--   done_on     the clinic day (Addis) an item became done: "done today" is done_on = today
--
-- A removed item is not deleted: deleted_at/by keep the record of who removed what.
-- The business rules (implant only on a missing tooth, bridge shape, nothing on a
-- missing tooth…) are enforced by the service on every save.
CREATE TABLE dental_chart_items (
    id          UUID PRIMARY KEY,
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    patient_id  UUID NOT NULL REFERENCES patients(id),
    tooth       SMALLINT NOT NULL CHECK ((tooth BETWEEN 11 AND 48 AND tooth % 10 BETWEEN 1 AND 8) OR (tooth BETWEEN 51 AND 85 AND tooth % 10 BETWEEN 1 AND 5)),
    kind        TEXT NOT NULL CHECK (kind IN ('caries','filling','crown','root_canal','extraction','missing','implant','bridge')),
    surface     TEXT CHECK (surface IN ('O','M','D','B','L')),
    material    TEXT CHECK (material IN ('composite','amalgam','zirconia','pfm','gold','steel')),
    status      TEXT NOT NULL CHECK (status IN ('existing','planned','done')),
    bridge_end  SMALLINT,
    note        TEXT,
    done_on     DATE,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  UUID,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_by  UUID,
    deleted_at  TIMESTAMPTZ,
    CHECK ((kind IN ('caries','filling')) = (surface IS NOT NULL)),
    CHECK ((kind = 'bridge') = (bridge_end IS NOT NULL))
);
-- One live item per tooth, kind and surface.
CREATE UNIQUE INDEX ux_dental_chart_items_live
    ON dental_chart_items (tenant_id, patient_id, tooth, kind, coalesce(surface, ''))
    WHERE deleted_at IS NULL;
CREATE INDEX idx_dental_chart_items_patient ON dental_chart_items (tenant_id, patient_id) WHERE deleted_at IS NULL;

-- Tooth position, by FDI number (rotation, tipping, buccal_lingual, vertical,
-- gap_mesial). Kept apart from version 1's anatomy column, which this migration
-- leaves exactly as it was: it is the rollback copy.
ALTER TABLE dental_charts ADD COLUMN positions JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Carry version 1 over. Its records never said which material a filling or crown
-- was, so those items say so in their note until a dentist confirms them.
UPDATE dental_charts c SET positions = coalesce((
    SELECT jsonb_object_agg(k, jsonb_build_object(
             'rotation', coalesce((v->>'rotation')::numeric, 0),
             'tipping', coalesce((v->>'tipping')::numeric, 0),
             'buccal_lingual', coalesce((v->>'buccal_lingual')::numeric, 0),
             'vertical', coalesce((v->>'vertical')::numeric, 0),
             'gap_mesial', coalesce((v->>'gap_mesial')::numeric, 0)))
      FROM jsonb_each(c.anatomy) AS t(k, v)
     WHERE coalesce((v->>'rotation')::numeric, 0) <> 0 OR coalesce((v->>'tipping')::numeric, 0) <> 0
        OR coalesce((v->>'buccal_lingual')::numeric, 0) <> 0 OR coalesce((v->>'vertical')::numeric, 0) <> 0
        OR coalesce((v->>'gap_mesial')::numeric, 0) <> 0), '{}'::jsonb)
 WHERE c.anatomy <> '{}'::jsonb;

-- Surfaces: caries stays caries; a filling becomes a composite filling already in the
-- mouth. A surface holding both keeps only the filling (an existing filling replaces
-- the caries under it, as the chart's own rule says) — the caries is noted on it.
INSERT INTO dental_chart_items (id, tenant_id, patient_id, tooth, kind, surface, material, status, note, created_at, updated_at)
SELECT gen_random_uuid(), c.tenant_id, c.patient_id, t.k::smallint,
       CASE WHEN s.v = 'filling' THEN 'filling' ELSE 'caries' END,
       s.k,
       CASE WHEN s.v = 'filling' THEN 'composite' END,
       'existing',
       CASE WHEN s.v = 'filling' THEN 'Migrated from the first anatomical chart: material not recorded.' ELSE 'Migrated from the first anatomical chart.' END,
       c.updated_at, c.updated_at
  FROM dental_charts c
  CROSS JOIN LATERAL jsonb_each(c.anatomy) AS t(k, v)
  CROSS JOIN LATERAL jsonb_each_text(coalesce(t.v->'surfaces', '{}'::jsonb)) AS s(k, v)
 WHERE s.v IN ('caries', 'filling') AND NOT coalesce((t.v->>'missing')::boolean, false);

-- Whole tooth: missing, crown, root canal. A missing tooth keeps only "missing" (the
-- chart cannot draw a crown on a tooth that is not there); anything else it held is
-- written into the missing item's note so it is not lost.
INSERT INTO dental_chart_items (id, tenant_id, patient_id, tooth, kind, material, status, note, created_at, updated_at)
SELECT gen_random_uuid(), c.tenant_id, c.patient_id, t.k::smallint, x.kind, x.material, 'existing', x.note, c.updated_at, c.updated_at
  FROM dental_charts c
  CROSS JOIN LATERAL jsonb_each(c.anatomy) AS t(k, v)
  CROSS JOIN LATERAL (VALUES
      ('missing', NULL,
       'Migrated from the first anatomical chart.' ||
       CASE WHEN coalesce((t.v->>'crown')::boolean, false) OR coalesce((t.v->>'root_canal')::boolean, false)
              OR coalesce(t.v->'surfaces', '{}'::jsonb) <> '{}'::jsonb
            THEN ' It was also recorded with: ' || concat_ws(', ',
                   CASE WHEN coalesce((t.v->>'crown')::boolean, false) THEN 'a crown' END,
                   CASE WHEN coalesce((t.v->>'root_canal')::boolean, false) THEN 'a root canal' END,
                   CASE WHEN coalesce(t.v->'surfaces', '{}'::jsonb) <> '{}'::jsonb THEN 'surfaces ' || (t.v->'surfaces')::text END) || '.'
            ELSE '' END,
       coalesce((t.v->>'missing')::boolean, false)),
      ('crown', 'zirconia', 'Migrated from the first anatomical chart: material not recorded.',
       coalesce((t.v->>'crown')::boolean, false) AND NOT coalesce((t.v->>'missing')::boolean, false)),
      ('root_canal', NULL, 'Migrated from the first anatomical chart.',
       coalesce((t.v->>'root_canal')::boolean, false) AND NOT coalesce((t.v->>'missing')::boolean, false))
  ) AS x(kind, material, note, applies)
 WHERE x.applies;

DO $$
BEGIN
  ALTER TABLE dental_chart_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dental_chart_items FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON dental_chart_items
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE ON dental_chart_items TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Version 1's anatomy column was never changed, so the previous release reads it as it was.
DROP TABLE IF EXISTS dental_chart_items;
ALTER TABLE dental_charts DROP COLUMN IF EXISTS positions;
-- +goose StatementEnd
