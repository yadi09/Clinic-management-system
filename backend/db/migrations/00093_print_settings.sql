-- +goose Up
-- +goose StatementBegin

-- How this clinic's printed papers look (receipts, prescriptions, certificates...).
--
-- One row per clinic. `settings` is the whole look and wording as JSON — identity
-- (names, address, phones, tax number), the template chosen for each kind of
-- document, which optional parts show, and any label the clinic rewrote. It is a
-- document rather than columns because a clinic can change its mind about what
-- belongs on a receipt every week, and the shape is owned by the front end that
-- draws it. The server keeps it small and valid JSON, nothing more.
--
-- The logo is stored inline as a small data URL: a printed page has to be able to
-- draw it with no network and no signed link that may have expired by the time the
-- printer is ready.
CREATE TABLE print_settings (
    tenant_id  UUID PRIMARY KEY REFERENCES tenants(id),
    settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
    logo       TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID
);

-- Which papers have already left the building, and how often. A reprint of a
-- receipt must be told apart from the original, and that fact cannot live in the
-- browser: it has to be the same on every computer in the clinic.
CREATE TABLE print_log (
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    kind       TEXT NOT NULL,
    ref        TEXT NOT NULL,
    count      INT  NOT NULL DEFAULT 1,
    first_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_by   UUID,
    last_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_by    UUID,
    PRIMARY KEY (tenant_id, kind, ref)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['print_settings','print_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO clinic_app', t);
    END IF;
  END LOOP;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS print_log;
DROP TABLE IF EXISTS print_settings;
-- +goose StatementEnd
