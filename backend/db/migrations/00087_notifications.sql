-- +goose Up
-- +goose StatementBegin

-- In-app notifications: the bell in the top bar and the pop-up shown at sign-in.
--
-- One row per recipient. Each staff member has their own read state, so one person
-- opening a notification never hides it from a colleague. A new kind of notification
-- adds a producer that writes rows here; the bell, the pop-up and the read tracking
-- stay the same.
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    -- What the notification is about, so the screen can open it. Both optional:
    -- a future notification may be about the clinic rather than a patient.
    patient_id  UUID REFERENCES patients(id),
    subject_id  UUID,
    -- The same event is notified to the same person once, however often the
    -- producer runs. The unique index below enforces it; producers never check first.
    dedupe_key  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX ux_notifications_dedupe ON notifications(tenant_id, user_id, dedupe_key);
CREATE INDEX idx_notifications_user ON notifications(tenant_id, user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(tenant_id, user_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The day each kind of notification was switched on. A producer only notifies
-- about events on or after it, so turning a kind on does not flood every inbox
-- with events from before it existed. Global (no tenant), read only by the worker.
CREATE TABLE notification_watermarks (
    kind        TEXT PRIMARY KEY,
    since       DATE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO notification_watermarks (kind, since)
VALUES ('missed_visit', (now() AT TIME ZONE 'Africa/Addis_Ababa')::date);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO clinic_app;
    -- Default privileges would otherwise give the clinic role full access to a
    -- table that cannot have row-level security (the 00066 lesson).
    REVOKE ALL ON notification_watermarks FROM clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS notification_watermarks;
DROP TABLE IF EXISTS notifications;
-- +goose StatementEnd
