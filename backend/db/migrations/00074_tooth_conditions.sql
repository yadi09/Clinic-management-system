-- +goose Up
-- +goose StatementBegin

-- The conditions a clinic marks on a tooth, in that clinic's own terms.
--
-- Five were compiled into the frontend: healthy, decayed, filled, extracted, crown.
-- A practice that charts "root treated", "implant" or "mobile" had nowhere to put
-- them, and one that never places crowns carried a legend entry it never used.
--
-- The CODE is what a chart stores, so it never changes once written: renaming
-- "Filled" to "Restored" changes every legend and tooltip and leaves every chart
-- exactly as the dentist marked it. Colour is one strong value per condition; the
-- pale fill behind a tooth is derived from it, so a clinic picks one colour rather
-- than a matched pair.
CREATE TABLE dental_tooth_statuses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    code       TEXT NOT NULL,
    label      TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    sort_order INT  NOT NULL DEFAULT 0,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX ux_tooth_statuses_code
    ON dental_tooth_statuses(tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX idx_tooth_statuses_list
    ON dental_tooth_statuses(tenant_id, sort_order) WHERE deleted_at IS NULL;

-- Every clinic already charting keeps the five it has been using, with the colours
-- already on its screens, so no chart changes appearance overnight.
INSERT INTO dental_tooth_statuses (tenant_id, code, label, color, sort_order)
SELECT f.tenant_id, s.code, s.label, s.color, s.ord
  FROM feature_flags f
  CROSS JOIN (VALUES
      ('healthy',   'Healthy',   '#0a7c59', 1),
      ('decayed',   'Decayed',   '#c0392b', 2),
      ('filled',    'Filled',    '#1a4fd8', 3),
      ('extracted', 'Extracted', '#b8b8b8', 4),
      ('crown',     'Crown',     '#f0c040', 5)
  ) AS s(code, label, color, ord)
 WHERE f.flag = 'dental' AND f.enabled AND f.branch_id IS NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  ALTER TABLE dental_tooth_statuses ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dental_tooth_statuses FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON dental_tooth_statuses
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON dental_tooth_statuses TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS dental_tooth_statuses;
-- +goose StatementEnd
