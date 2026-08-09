-- +goose Up
-- +goose StatementBegin
-- The dental examination record — the clinical assessment that produces a diagnosis.
--
-- The workspace already records what was DONE (a treatment plan's dated sessions,
-- each with its procedure, tooth, notes, Rx and images). What it has never had is
-- the assessment that comes BEFORE that: why the patient came, what the clinician
-- found on examining them, what investigations were run, and what they concluded.
-- Without it the chart shows six fillings with no recorded reason for any of them —
-- unusable for continuity of care, for a second opinion, or as a medico-legal record.
--
-- This is deliberately NOT a per-session form. You take a chief complaint and a full
-- extraoral/intraoral examination at a first visit, at a new complaint or at recall —
-- not every time you seat the patient to continue a root canal. So an examination is
-- its own dated record, optionally linked to the session at which it was performed.
--
-- Two things it deliberately does not duplicate:
--   * medical history  -> medical_histories (one living row per patient)
--   * the odontogram   -> dental_charts     (one living row per patient)
-- Both are shown alongside the form rather than copied into it, so there is exactly
-- one place each of them is true.
--
-- The multi-select findings (extraoral, intraoral, investigations, treatment given)
-- are JSONB arrays of option keys, with the catalogue owned by the frontend — the
-- same contract as dental_charts.teeth and medical_histories.answers, so a clinic's
-- form can grow without a migration.

-- Replaces the original flat visit log from 00034. That table was orphaned by the
-- plans/sessions redesign in 00039: no Go or TypeScript code has referenced it since,
-- and it holds no rows in production. Recreating it is clearer than layering a dozen
-- clinical columns onto a shape built for something else.
DROP TABLE IF EXISTS dental_visits;

CREATE TABLE dental_visits (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants(id),
    patient_id            UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    -- The session this examination was performed at, when there was one. Kept
    -- nullable and ON DELETE SET NULL: a first-visit examination happens before any
    -- treatment plan exists, and deleting a plan must never destroy the clinical
    -- assessment that justified it.
    session_id            UUID REFERENCES treatment_sessions(id) ON DELETE SET NULL,
    visit_date            DATE NOT NULL,

    chief_complaint       TEXT,
    hpi                   TEXT,
    past_dental_history   TEXT,

    extraoral             JSONB NOT NULL DEFAULT '[]'::jsonb,
    extraoral_notes       TEXT,
    intraoral             JSONB NOT NULL DEFAULT '[]'::jsonb,
    intraoral_notes       TEXT,

    investigations        JSONB NOT NULL DEFAULT '[]'::jsonb,
    investigation_results TEXT,

    diagnosis             TEXT,
    treatment_plan        TEXT,

    treatment_given       JSONB NOT NULL DEFAULT '[]'::jsonb,
    anaesthesia           TEXT,
    complications         TEXT,
    -- Per-tooth work done at this visit: [{tooth, procedure, notes}].
    procedures            JSONB NOT NULL DEFAULT '[]'::jsonb,
    postop                TEXT,

    created_by            UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dental_visits_patient ON dental_visits(tenant_id, patient_id, visit_date DESC);
CREATE INDEX idx_dental_visits_session ON dental_visits(tenant_id, session_id) WHERE session_id IS NOT NULL;
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  EXECUTE 'ALTER TABLE dental_visits ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE dental_visits FORCE ROW LEVEL SECURITY';
  EXECUTE $f$
    CREATE POLICY tenant_isolation ON dental_visits
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  $f$;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON dental_visits TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS dental_visits;
-- +goose StatementEnd
