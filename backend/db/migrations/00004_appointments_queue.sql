-- +goose Up
-- +goose StatementBegin
-- Phase 2: Appointments & Queue. Free-booking model (start + duration) with
-- DB-enforced no-double-booking via exclusion constraints, plus a live
-- department queue.

CREATE EXTENSION IF NOT EXISTS btree_gist; -- gist support for = on scalar cols

CREATE TABLE appointments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    branch_id     UUID NOT NULL REFERENCES branches(id),
    department_id UUID REFERENCES departments(id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    provider_id   UUID NOT NULL REFERENCES users(id),
    resource_id   UUID REFERENCES resources(id),
    starts_at     TIMESTAMPTZ NOT NULL,
    ends_at       TIMESTAMPTZ NOT NULL,
    status        TEXT NOT NULL DEFAULT 'booked'
                    CHECK (status IN ('booked','confirmed','checked_in','completed','cancelled','no_show')),
    reason        TEXT,
    cancel_reason TEXT,
    source        TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','portal')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID,
    deleted_at    TIMESTAMPTZ,
    CONSTRAINT appointments_time_valid CHECK (ends_at > starts_at)
);
CREATE INDEX idx_appointments_branch_time ON appointments(tenant_id, branch_id, starts_at);
CREATE INDEX idx_appointments_provider_time ON appointments(provider_id, starts_at);
CREATE INDEX idx_appointments_patient ON appointments(patient_id);
CREATE INDEX idx_appointments_status ON appointments(status);

-- No two active appointments for the same provider may overlap in time.
ALTER TABLE appointments ADD CONSTRAINT appointments_no_provider_overlap
    EXCLUDE USING gist (
        tenant_id WITH =,
        provider_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (status NOT IN ('cancelled','no_show') AND deleted_at IS NULL);

-- Same for a booked room/resource (only when one is assigned).
ALTER TABLE appointments ADD CONSTRAINT appointments_no_resource_overlap
    EXCLUDE USING gist (
        tenant_id WITH =,
        resource_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
    ) WHERE (resource_id IS NOT NULL AND status NOT IN ('cancelled','no_show') AND deleted_at IS NULL);

CREATE TABLE queue_entries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants(id),
    branch_id      UUID NOT NULL REFERENCES branches(id),
    department_id  UUID NOT NULL REFERENCES departments(id),
    patient_id     UUID NOT NULL REFERENCES patients(id),
    appointment_id UUID REFERENCES appointments(id),
    state          TEXT NOT NULL DEFAULT 'waiting'
                     CHECK (state IN ('waiting','called','in_consult','done','no_show')),
    priority       INTEGER NOT NULL DEFAULT 0,
    enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    called_at      TIMESTAMPTZ,
    started_at     TIMESTAMPTZ,
    ended_at       TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     UUID,
    deleted_at     TIMESTAMPTZ
);
CREATE INDEX idx_queue_active ON queue_entries(tenant_id, department_id, state, priority DESC, enqueued_at);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointments','queue_entries']
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON appointments, queue_entries TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS queue_entries;
DROP TABLE IF EXISTS appointments;
-- +goose StatementEnd
