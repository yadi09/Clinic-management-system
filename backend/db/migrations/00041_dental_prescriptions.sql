-- +goose Up
-- +goose StatementBegin
-- Printable prescriptions attached to a treatment session. A session can carry
-- several (e.g. antibiotics + analgesia, or scripts issued on different visits);
-- each is a document of one or more medication lines. Reuses the shared drug
-- catalog (GET /drugs) for autocomplete but stores drug_name so a script stands
-- alone even if the library entry later changes.
CREATE TABLE dental_prescriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    session_id  UUID NOT NULL REFERENCES treatment_sessions(id) ON DELETE CASCADE,
    patient_id  UUID NOT NULL REFERENCES patients(id),
    note        TEXT,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dental_prescriptions_session ON dental_prescriptions(tenant_id, session_id);

CREATE TABLE dental_prescription_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    prescription_id UUID NOT NULL REFERENCES dental_prescriptions(id) ON DELETE CASCADE,
    seq             INT  NOT NULL DEFAULT 1,
    drug_name       TEXT NOT NULL,
    dose            TEXT,
    frequency       TEXT,
    duration        TEXT,
    instructions    TEXT
);
CREATE INDEX idx_dental_prescription_items_rx ON dental_prescription_items(tenant_id, prescription_id, seq);

-- Categorise a session's images: before / after / xray (NULL = uncategorised).
ALTER TABLE attachments ADD COLUMN image_category TEXT;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dental_prescriptions','dental_prescription_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    $f$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON dental_prescriptions, dental_prescription_items TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE attachments DROP COLUMN IF EXISTS image_category;
DROP TABLE IF EXISTS dental_prescription_items;
DROP TABLE IF EXISTS dental_prescriptions;
-- +goose StatementEnd
