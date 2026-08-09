-- name: GetUserRoleCodes :many
SELECT DISTINCT r.code
FROM user_role_scopes urs
JOIN roles r ON r.id = urs.role_id AND r.tenant_id = urs.tenant_id
WHERE urs.tenant_id = $1 AND urs.user_id = $2
ORDER BY r.code;

-- name: GetUserPermissionCodes :many
SELECT DISTINCT p.code
FROM user_role_scopes urs
JOIN role_permissions rp ON rp.role_id = urs.role_id AND rp.tenant_id = urs.tenant_id
JOIN permissions p ON p.id = rp.permission_id
WHERE urs.tenant_id = $1 AND urs.user_id = $2
ORDER BY p.code;

-- name: GetTenantFlags :many
-- Tenant-wide default flags (branch overrides are layered on top of these).
SELECT flag, enabled
FROM feature_flags
WHERE tenant_id = $1 AND branch_id IS NULL;

-- name: GetBranchFlagOverrides :many
-- Per-branch flag overrides for one branch; applied over the tenant defaults.
SELECT flag, enabled
FROM feature_flags
WHERE tenant_id = $1 AND branch_id = $2;

-- name: GetUserScopes :many
-- Every (role, branch, department) scope for a user. A NULL branch_id means the
-- assignment is tenant-wide (access to all branches).
SELECT r.code AS role_code, urs.branch_id, urs.department_id
FROM user_role_scopes urs
JOIN roles r ON r.id = urs.role_id AND r.tenant_id = urs.tenant_id
WHERE urs.tenant_id = $1 AND urs.user_id = $2
ORDER BY r.code;

-- name: ListActiveBranches :many
-- Active branches for the tenant, oldest first (the first is the default branch).
SELECT id, name, code
FROM branches
WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
ORDER BY created_at;
