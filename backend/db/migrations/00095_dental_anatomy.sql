-- +goose Up
-- +goose StatementBegin

-- The anatomical tooth chart, alongside the simple one.
--
-- A clinic chooses which chart its staff draw on (dental_settings.chart_style), but
-- both charts read and write the SAME row of dental_charts, so switching never hides
-- or loses anything:
--
--   teeth    (unchanged) Palmer code -> the clinic's own condition ("UR1": "decayed")
--   anatomy  (new)       FDI number  -> surfaces, whole-tooth findings and position
--            {"11": {"surfaces": {"O": "caries"}, "crown": false, "root_canal": false,
--                    "missing": false, "rotation": 0, "tipping": 0,
--                    "buccal_lingual": 0, "vertical": 0, "gap_mesial": 2}}
--
-- Nothing already charted is converted: a mark made on the simple chart stays a mark
-- on the simple chart, and the anatomical chart shows it beside its own findings.
ALTER TABLE dental_charts ADD COLUMN anatomy JSONB NOT NULL DEFAULT '{}'::jsonb;

-- One row per clinic. A clinic with no row gets the default for new clinics
-- (anatomical); every clinic that exists now is pinned to the chart it already uses.
CREATE TABLE dental_settings (
    tenant_id   UUID PRIMARY KEY REFERENCES tenants(id),
    chart_style TEXT NOT NULL DEFAULT 'simple' CHECK (chart_style IN ('simple', 'anatomical')),
    updated_by  UUID,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO dental_settings (tenant_id, chart_style)
SELECT id, 'simple' FROM tenants
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  ALTER TABLE dental_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dental_settings FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON dental_settings
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE ON dental_settings TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS dental_settings;
ALTER TABLE dental_charts DROP COLUMN IF EXISTS anatomy;
-- +goose StatementEnd
