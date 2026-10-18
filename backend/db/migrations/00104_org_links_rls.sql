-- +goose Up
-- +goose StatementBegin

-- org_links carries a tenant_id, so like every such table it sits behind row-level
-- security. Its job is to be read ACROSS a clinic's branches (to list them and to
-- check a switch), so the wall here is the clinic's organization, not the single
-- workspace: a session sees only the links of the organization its own workspace
-- belongs to. tenants carries no RLS, so the lookup cannot recurse.
ALTER TABLE org_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_links FORCE ROW LEVEL SECURITY;
CREATE POLICY same_organization ON org_links
  USING (organization_id = (SELECT t.organization_id FROM tenants t
                             WHERE t.id = current_setting('app.tenant_id', true)::uuid));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP POLICY IF EXISTS same_organization ON org_links;
ALTER TABLE org_links NO FORCE ROW LEVEL SECURITY;
ALTER TABLE org_links DISABLE ROW LEVEL SECURITY;
-- +goose StatementEnd
