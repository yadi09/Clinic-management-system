-- name: GetUserByEmail :one
SELECT id, tenant_id, email, password_hash, full_name, status, mfa_enabled, mfa_secret, failed_attempts, locked_until
FROM users
WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL;

-- name: GetUserByID :one
SELECT id, tenant_id, email, full_name, status, mfa_enabled
FROM users
WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL;

-- name: IncrementFailedLogin :one
UPDATE users
SET failed_attempts = failed_attempts + 1, updated_at = now()
WHERE tenant_id = $1 AND id = $2
RETURNING failed_attempts;

-- name: LockUser :exec
UPDATE users
SET locked_until = $3, updated_at = now()
WHERE tenant_id = $1 AND id = $2;

-- name: ClearLoginFailures :exec
UPDATE users
SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
WHERE tenant_id = $1 AND id = $2;

-- name: SetUserMFA :exec
UPDATE users
SET mfa_enabled = $3, mfa_secret = $4, updated_at = now()
WHERE tenant_id = $1 AND id = $2;
