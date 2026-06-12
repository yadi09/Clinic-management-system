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
SELECT flag, enabled
FROM feature_flags
WHERE tenant_id = $1;
