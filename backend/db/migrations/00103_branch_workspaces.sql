-- +goose Up
-- +goose StatementBegin

-- Branches as separate workspaces.
--
-- A clinic with several branches used to keep them all inside one workspace and
-- rely on every screen to filter by branch. Anything a screen forgot crossed over:
-- the cashier at one branch could see and settle another branch's bills, and every
-- patient note was readable everywhere. The wall that has never leaked is the one
-- between two clinics, enforced by row-level security in the database itself.
--
-- So each branch is now its own workspace (a tenant), with that same wall. What
-- ties them together is an organization: the group a clinic's branches belong to.
-- It carries no clinical or money data at all — only which workspaces belong
-- together, and which people may move between them.
CREATE TABLE organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN organization_id UUID REFERENCES organizations(id);
CREATE INDEX idx_tenants_organization ON tenants(organization_id) WHERE organization_id IS NOT NULL;

-- The people who may move between an organization's branches: the owner, and any
-- branch admins the owner adds. A person has one account in each branch (users
-- are per workspace, under that workspace's row-level security); person_id is
-- what says "these accounts are the same human". Ids only — no names, no emails —
-- so even read in full it says nothing about anyone.
CREATE TABLE org_links (
    person_id       UUID NOT NULL,
    organization_id UUID NOT NULL REFERENCES organizations(id),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, tenant_id),
    UNIQUE (tenant_id, user_id)
);
CREATE INDEX idx_org_links_org ON org_links(organization_id);

-- Like the tenants registry, these are read across workspaces (to show a switcher
-- and to check a switch), so they carry no row-level security. They are written
-- only by the vendor's privileged connection, never by the clinic application.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    REVOKE ALL ON organizations, org_links FROM clinic_app;
    GRANT SELECT ON organizations, org_links TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS org_links;
DROP INDEX IF EXISTS idx_tenants_organization;
ALTER TABLE tenants DROP COLUMN IF EXISTS organization_id;
DROP TABLE IF EXISTS organizations;
-- +goose StatementEnd
