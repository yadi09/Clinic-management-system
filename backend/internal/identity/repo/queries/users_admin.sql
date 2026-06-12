-- name: CreateInvitedUser :one
INSERT INTO users (tenant_id, email, full_name, status, created_by)
VALUES (@tenant_id, @email, @full_name, 'invited', @created_by)
RETURNING id;

-- name: ListUsers :many
SELECT u.id, u.email, u.full_name, u.status, u.last_login_at, u.created_at,
       coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}')::text[] AS roles
FROM users u
LEFT JOIN user_role_scopes urs ON urs.user_id = u.id AND urs.tenant_id = u.tenant_id
LEFT JOIN roles r ON r.id = urs.role_id AND r.tenant_id = u.tenant_id
WHERE u.tenant_id = @tenant_id AND u.deleted_at IS NULL
GROUP BY u.id
ORDER BY u.created_at DESC;

-- name: CountActiveUsers :one
SELECT count(*) FROM users
WHERE tenant_id = @tenant_id AND status = 'active' AND deleted_at IS NULL;

-- name: GetTenantUserLimit :one
SELECT p.user_limit
FROM tenants t JOIN plans p ON p.id = t.plan_id
WHERE t.id = @tenant_id;

-- name: UpdateUserStatus :exec
UPDATE users SET status = @status, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SetPasswordAndActivate :exec
UPDATE users SET password_hash = @password_hash, status = 'active', updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id;
