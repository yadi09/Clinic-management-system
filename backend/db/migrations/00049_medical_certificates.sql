-- +goose Up
-- +goose StatementBegin
-- Medical certificates — the note a patient takes to an employer or a school.
--
-- This is a LEGAL DOCUMENT, not a print view. An employer who doubts one will ring
-- the clinic, and the clinic has to be able to say "yes, we issued MC-2026-0041 to
-- that patient on that date, signed by that clinician". A form that only opens a
-- printable page can answer none of that, and cannot tell a real certificate from
-- one somebody retyped.
--
-- So every certificate is a row, numbered, attributed to the clinician who actually
-- issued it, and re-printable byte-for-byte afterwards.
CREATE TABLE medical_certificates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    branch_id   UUID REFERENCES branches(id),
    -- Per tenant, per calendar year, so the reference on the paper reads MC-2026-0041
    -- and stays short and quotable over the phone.
    year        INT  NOT NULL,
    serial      INT  NOT NULL,

    -- What the clinic is actually attesting. A single "sick note" shape cannot say
    -- "fit to return", which is the other half of the same conversation with an
    -- employer, or "attended today", which is all a school usually needs.
    kind        TEXT NOT NULL CHECK (kind IN ('sick_leave','fitness','attendance')),

    diagnosis   TEXT,
    -- A diagnosis on a document handed to an employer is a disclosure. Ethiopian
    -- clinics routinely issue certificates that state the rest period and nothing
    -- more, and the patient should not have to ask for that to be the default.
    show_diagnosis BOOLEAN NOT NULL DEFAULT false,

    -- Sick leave only. Stored as BOTH ends: computing "to" at print time would let a
    -- reprint disagree with the paper already in an employer's file.
    rest_days   INT,
    rest_from   DATE,
    rest_to     DATE,

    notes       TEXT,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    issued_by   UUID,

    -- Issued in error. The row is kept and marked, never deleted: the number was on
    -- paper the moment it printed, and a missing number is worse than a void one.
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
    void_reason TEXT,
    voided_by   UUID,
    voided_at   TIMESTAMPTZ,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Sick leave must carry a period; the other kinds must not pretend to.
    CONSTRAINT mc_rest_period CHECK (
        (kind = 'sick_leave' AND rest_from IS NOT NULL AND rest_to IS NOT NULL AND rest_days >= 1)
        OR (kind <> 'sick_leave')
    ),
    CONSTRAINT mc_rest_order CHECK (rest_to IS NULL OR rest_from IS NULL OR rest_to >= rest_from)
);

-- The number is the document's identity, so the database enforces it rather than
-- trusting the counter to have been read under a lock.
CREATE UNIQUE INDEX idx_medical_certificates_ref ON medical_certificates(tenant_id, year, serial);
CREATE INDEX idx_medical_certificates_patient ON medical_certificates(tenant_id, patient_id, issued_at DESC);

-- Per-tenant counters for clinical documents, same shape as billing_counters. A
-- max()+1 read would hand two clinicians the same number under concurrency.
CREATE TABLE clinical_counters (
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name      TEXT NOT NULL,
    value     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, name)
);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['medical_certificates','clinical_counters']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON medical_certificates, clinical_counters TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS medical_certificates;
DROP TABLE IF EXISTS clinical_counters;
-- +goose StatementEnd
