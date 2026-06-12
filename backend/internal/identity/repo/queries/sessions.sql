-- name: CreateSession :one
INSERT INTO sessions (tenant_id, user_id, refresh_token_hash, user_agent, ip, expires_at, rotated_from)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id;

-- name: GetSessionByHash :one
SELECT id, tenant_id, user_id, expires_at, revoked_at
FROM sessions
WHERE tenant_id = $1 AND refresh_token_hash = $2;

-- name: RevokeSession :exec
UPDATE sessions SET revoked_at = now()
WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL;

-- name: RevokeAllUserSessions :exec
UPDATE sessions SET revoked_at = now()
WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL;
