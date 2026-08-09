-- name: GetTenantForOrg :one
-- The tenant registry row backing the "workspace" (login handle). The tenants
-- table is the cross-tenant registry (no RLS); scoped here by id = the caller's
-- tenant. clinic_app holds the table grants.
SELECT id, name, slug FROM tenants
WHERE id = @id AND deleted_at IS NULL;

-- name: UpdateTenantSlug :exec
UPDATE tenants SET slug = @slug, updated_at = now()
WHERE id = @id AND deleted_at IS NULL;
