-- +goose Up
-- +goose StatementBegin

-- What a clinic actually does, in that clinic's words.
--
-- The procedure picker offered a list compiled into the frontend: seventeen names,
-- the same seventeen for every clinic on the platform. A practice that does implants
-- could not add "Implant placement"; one that does not do dentures had to scroll
-- past two kinds. The list is clinical vocabulary, and vocabulary belongs to the
-- clinic, not to the build.
--
-- Deleting a procedure is safe by construction: a session stores the procedure as
-- text, so retiring "Bridge" from the picker cannot rewrite a visit that recorded
-- one. is_active retires a name from the picker while leaving it readable in the
-- record — which is what a clinic means by "we stopped offering that".
CREATE TABLE dental_procedures (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    name       TEXT NOT NULL,
    is_active  BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

-- Two procedures with the same name is a data-entry slip, not a choice.
CREATE UNIQUE INDEX ux_dental_procedures_name
    ON dental_procedures(tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_dental_procedures_list
    ON dental_procedures(tenant_id, sort_order) WHERE deleted_at IS NULL;

-- Every clinic already using the dental module starts with exactly the list it has
-- been using, so nobody opens the picker tomorrow to find it empty. From then on it
-- is theirs to change.
INSERT INTO dental_procedures (tenant_id, name, sort_order)
SELECT f.tenant_id, p.name, p.ord
  FROM feature_flags f
  CROSS JOIN (VALUES
      ('Consultation', 1), ('X-Ray', 2), ('Teeth Cleaning', 3), ('Scaling & Polishing', 4),
      ('Tooth Extraction', 5), ('Filling (Composite)', 6), ('Filling (Amalgam)', 7),
      ('Root Canal Treatment', 8), ('Crown Placement', 9), ('Bridge', 10),
      ('Partial Denture', 11), ('Full Denture', 12), ('Teeth Whitening', 13),
      ('Orthodontic Consultation', 14), ('Braces Fitting', 15), ('Emergency Treatment', 16)
  ) AS p(name, ord)
 WHERE f.flag = 'dental' AND f.enabled AND f.branch_id IS NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  ALTER TABLE dental_procedures ENABLE ROW LEVEL SECURITY;
  ALTER TABLE dental_procedures FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON dental_procedures
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON dental_procedures TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS dental_procedures;
-- +goose StatementEnd
