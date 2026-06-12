-- name: CreateInvitation :one
INSERT INTO user_invitations (tenant_id, user_id, token_hash, expires_at, created_by)
VALUES (@tenant_id, @user_id, @token_hash, @expires_at, @created_by)
RETURNING id;

-- name: GetInvitationByToken :one
SELECT id, tenant_id, user_id, expires_at, accepted_at
FROM user_invitations
WHERE tenant_id = @tenant_id AND token_hash = @token_hash;

-- name: MarkInvitationAccepted :exec
UPDATE user_invitations SET accepted_at = now()
WHERE tenant_id = @tenant_id AND id = @id;
