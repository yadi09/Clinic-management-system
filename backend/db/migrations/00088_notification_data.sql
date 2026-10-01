-- +goose Up
-- +goose StatementBegin

-- The facts a notification is about, as fields rather than only as a sentence, so
-- the screen can lead with what staff scan for (the patient's name and card) and
-- show the date in both calendars. The body stays as the readable fallback.
--
-- A constant default is stored in the catalogue, not written into every row, so
-- this is instant however large the table grows.
ALTER TABLE notifications ADD COLUMN data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A notification about a patient who no longer exists means nothing, and must not
-- stand in the way of removing them: the app only soft-deletes, but the e2e
-- cleanup scripts hard-delete their test patients, and a plain foreign key made
-- that DELETE fail once a test patient had been notified about.
ALTER TABLE notifications DROP CONSTRAINT notifications_patient_id_fkey;
ALTER TABLE notifications ADD CONSTRAINT notifications_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE notifications DROP CONSTRAINT notifications_patient_id_fkey;
ALTER TABLE notifications ADD CONSTRAINT notifications_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES patients(id);
ALTER TABLE notifications DROP COLUMN IF EXISTS data;
-- +goose StatementEnd
