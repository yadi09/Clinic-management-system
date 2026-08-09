-- name: CreateSession :one
INSERT INTO sessions (tenant_id, user_id, refresh_token_hash, user_agent, ip, expires_at, rotated_from, active_branch_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id;

-- name: GetSessionByHash :one
SELECT id, tenant_id, user_id, expires_at, revoked_at, active_branch_id
FROM sessions
WHERE tenant_id = $1 AND refresh_token_hash = $2;

-- name: SetSessionActiveBranch :exec
UPDATE sessions SET active_branch_id = $3
WHERE tenant_id = $1 AND id = $2;

-- name: SessionRotated :one
-- True if this session has a successor (it was revoked by refresh rotation). This
-- distinguishes genuine token reuse (a rotated token replayed) from an intentional
-- revocation (logout / sign-out-others / password change), so the latter doesn't
-- nuke the user's other live sessions.
SELECT EXISTS(SELECT 1 FROM sessions WHERE tenant_id = @tenant_id AND rotated_from = @id) AS rotated;

-- name: RevokeSession :exec
UPDATE sessions SET revoked_at = now()
WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL;

-- name: RevokeAllUserSessions :exec
UPDATE sessions SET revoked_at = now()
WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL;

-- name: RevokeOtherUserSessions :execrows
-- Revoke every session for the user except the one holding keep_hash (the current
-- device). A NULL keep_hash revokes all. Used on password change + "sign out other devices".
UPDATE sessions SET revoked_at = now()
WHERE tenant_id = @tenant_id AND user_id = @user_id AND revoked_at IS NULL
  AND (sqlc.narg(keep_hash)::text IS NULL OR refresh_token_hash <> sqlc.narg(keep_hash));
