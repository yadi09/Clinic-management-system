-- name: GetTenantBySlug :one
-- Resolve a tenant by its workspace slug. The tenants table is a registry
-- (no RLS), so this runs before a tenant context is established (login).
SELECT id, name, slug, status, plan_id, timezone, locale, currency
FROM tenants
WHERE slug = $1 AND deleted_at IS NULL;
