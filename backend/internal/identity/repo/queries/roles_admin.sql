-- name: ListRoles :many
SELECT id, code, name, is_system
FROM roles
WHERE tenant_id = @tenant_id
ORDER BY name;

-- name: GetRoleByCode :one
SELECT id FROM roles WHERE tenant_id = @tenant_id AND code = @code;

-- name: ClearUserRoles :exec
DELETE FROM user_role_scopes WHERE tenant_id = @tenant_id AND user_id = @user_id;

-- name: AssignUserRole :exec
INSERT INTO user_role_scopes (tenant_id, user_id, role_id)
VALUES (@tenant_id, @user_id, @role_id)
ON CONFLICT (user_id, role_id, branch_id, department_id) DO NOTHING;
