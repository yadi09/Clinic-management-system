-- name: ListAllergies :many
SELECT id, substance, reaction, severity, created_at
FROM allergies
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY created_at;

-- name: AddAllergy :one
INSERT INTO allergies (tenant_id, patient_id, substance, reaction, severity, created_by)
VALUES (@tenant_id, @patient_id, @substance, @reaction, @severity, @created_by)
RETURNING id;

-- name: RemoveAllergy :exec
UPDATE allergies SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND id = @id AND deleted_at IS NULL;

-- name: ListConditions :many
SELECT id, icd_code, description, status, onset_date, created_at
FROM conditions
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY created_at;

-- name: AddCondition :one
INSERT INTO conditions (tenant_id, patient_id, icd_code, description, status, onset_date, created_by)
VALUES (@tenant_id, @patient_id, @icd_code, @description, @status, @onset_date, @created_by)
RETURNING id;

-- name: RemoveCondition :exec
UPDATE conditions SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND id = @id AND deleted_at IS NULL;

-- name: ListAttachments :many
SELECT id, type, storage_key, filename, mime_type, size_bytes, created_at
FROM attachments
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY created_at DESC;

-- name: CreateAttachment :one
INSERT INTO attachments (tenant_id, patient_id, type, storage_key, filename, mime_type, size_bytes, created_by)
VALUES (@tenant_id, @patient_id, @type, @storage_key, @filename, @mime_type, @size_bytes, @created_by)
RETURNING id, created_at;

-- name: GetAttachment :one
SELECT id, storage_key
FROM attachments
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND id = @id AND deleted_at IS NULL;

-- name: RemoveAttachment :exec
UPDATE attachments SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND id = @id AND deleted_at IS NULL;

-- name: ListGuardians :many
SELECT id, guardian_patient_id, guardian_user_id, relationship, created_at
FROM guardian_links
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY created_at;

-- name: AddGuardian :one
INSERT INTO guardian_links (tenant_id, patient_id, guardian_patient_id, guardian_user_id, relationship, created_by)
VALUES (@tenant_id, @patient_id, @guardian_patient_id, @guardian_user_id, @relationship, @created_by)
RETURNING id;
