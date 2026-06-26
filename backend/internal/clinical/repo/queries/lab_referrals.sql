-- External lab referrals (RX-LAB-REFERRAL).

-- name: CreateLabReferral :one
INSERT INTO lab_referrals (tenant_id, encounter_id, patient_id, tests, indication, created_by)
VALUES (@tenant_id, @encounter_id, @patient_id, @tests, @indication, @created_by)
RETURNING id, tests, indication, status, created_at;

-- name: ListLabReferralsByEncounter :many
SELECT id, tests, indication, status, result_summary, result_values, result_files,
       external_lab, resulted_at, created_at
FROM lab_referrals
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id AND deleted_at IS NULL
ORDER BY created_at;

-- name: RecordLabReferralResult :exec
UPDATE lab_referrals
SET status = 'resulted', result_summary = @result_summary, result_values = @result_values,
    result_files = @result_files, external_lab = @external_lab, resulted_at = now(),
    resulted_by = @resulted_by, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CancelLabReferral :exec
UPDATE lab_referrals SET status = 'cancelled', updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: GetLabReferralEncounter :one
-- Resolve the parent encounter for a referral (to scope result writes).
SELECT encounter_id, patient_id FROM lab_referrals
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;
