-- +goose Up
-- +goose StatementBegin

-- event_outbox holds every clinic's domain events (who was billed, which patient moved),
-- and until now any application session could read all of them: it was left without
-- row-level security because the outbox relay must read across clinics. No endpoint ever
-- read it, but the branch leak audit (REG_BRWS_020) found the wall missing underneath.
--
-- The relay runs with NO clinic set; every request runs with one. So: a session that names
-- a clinic sees only that clinic's events (and the few that belong to no clinic); a session
-- that names none — the relay — sees them all. CASE, not OR: SQL does not promise to skip
-- the uuid cast of an empty setting, and CASE does.
ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY own_clinic_or_relay ON event_outbox
  USING (CASE WHEN coalesce(current_setting('app.tenant_id', true), '') = '' THEN true
              ELSE tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid END)
  WITH CHECK (CASE WHEN coalesce(current_setting('app.tenant_id', true), '') = '' THEN true
              ELSE tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid END);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP POLICY IF EXISTS own_clinic_or_relay ON event_outbox;
ALTER TABLE event_outbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE event_outbox DISABLE ROW LEVEL SECURITY;
-- +goose StatementEnd
