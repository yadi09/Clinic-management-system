-- +goose Up
-- +goose StatementBegin

-- A printed paper that can be checked by whoever holds it.
--
-- The QR code on a prescription is a link to a row here, not a copy of the data. The
-- row keeps a SNAPSHOT of what was printed, built by the server from its own records
-- at the moment of printing, so what a pharmacist sees on the screen is what the
-- clinic issued — whatever has been done to the paper since. The status (genuine,
-- cancelled, a newer version exists, past its validity) is read from the source
-- record every time, so cancelling a prescription changes the answer at once.
--
-- Only a hash of the token is stored. The token itself is derived from the
-- prescription and a server secret, so printing the same prescription again gives
-- the same QR (a copy, not a new paper) without the token ever being kept.
CREATE TABLE paper_verifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    kind          TEXT NOT NULL CHECK (kind IN ('dental_rx', 'encounter_rx')),
    subject_id    UUID NOT NULL,
    token_hash    BYTEA NOT NULL,
    code          TEXT NOT NULL,
    ref           TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    snapshot      JSONB NOT NULL,
    valid_days    INT,
    issued_by     UUID,
    issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    scans         INT NOT NULL DEFAULT 0,
    first_scan_at TIMESTAMPTZ,
    last_scan_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_paper_verifications_token ON paper_verifications (token_hash);
CREATE UNIQUE INDEX uq_paper_verifications_code ON paper_verifications (tenant_id, code);
CREATE INDEX idx_paper_verifications_subject ON paper_verifications (tenant_id, kind, subject_id);

DO $$
BEGIN
  ALTER TABLE paper_verifications ENABLE ROW LEVEL SECURITY;
  ALTER TABLE paper_verifications FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON paper_verifications
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE ON paper_verifications TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS paper_verifications;
-- +goose StatementEnd
