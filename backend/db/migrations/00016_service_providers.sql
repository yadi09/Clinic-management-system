-- +goose Up
-- +goose StatementBegin
-- CASH-5: which staff provide each service. Reception's "assign" dropdown is
-- filtered to the providers of the selected service(s) (not all users).
CREATE TABLE service_providers (
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    service_item_id UUID NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (service_item_id, user_id)
);
CREATE INDEX idx_service_providers_user ON service_providers(tenant_id, user_id);
-- +goose StatementEnd

-- +goose StatementBegin
DO $$
BEGIN
  ALTER TABLE service_providers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE service_providers FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON service_providers
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON service_providers TO clinic_app;
  END IF;
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS service_providers;
-- +goose StatementEnd
