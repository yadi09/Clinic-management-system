-- name: NextMRNValue :one
-- Atomically allocate the next per-tenant MRN sequence number.
INSERT INTO mrn_counters (tenant_id, last_value)
VALUES (@tenant_id, 1)
ON CONFLICT (tenant_id) DO UPDATE SET last_value = mrn_counters.last_value + 1
RETURNING last_value;

-- name: CreatePatient :one
INSERT INTO patients (
  tenant_id, mrn, first_name, middle_name, last_name, gender, dob,
  national_id, passport_no, phone, email, address, emergency_contact, blood_group, created_by
) VALUES (
  @tenant_id, @mrn, @first_name, @middle_name, @last_name, @gender, @dob,
  @national_id, @passport_no, @phone, @email, @address::jsonb, @emergency_contact::jsonb, @blood_group, @created_by
)
RETURNING id, mrn, created_at;

-- name: GetPatientByID :one
SELECT id, tenant_id, mrn, first_name, middle_name, last_name, gender, dob,
       national_id, passport_no, phone, email, address, emergency_contact, blood_group,
       created_at, updated_at
FROM patients
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: UpdatePatient :exec
UPDATE patients SET
  first_name = @first_name, middle_name = @middle_name, last_name = @last_name,
  gender = @gender, dob = @dob, national_id = @national_id, passport_no = @passport_no,
  phone = @phone, email = @email, address = @address::jsonb,
  emergency_contact = @emergency_contact::jsonb, blood_group = @blood_group, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SoftDeletePatient :exec
UPDATE patients SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SearchPatients :many
SELECT id, mrn, first_name, middle_name, last_name, gender, dob, phone, email
FROM patients
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
  AND (
    @q::text = ''
    OR concat_ws(' ', first_name, middle_name, last_name) ILIKE '%' || @q || '%'
    OR search_tsv @@ websearch_to_tsquery('simple', @q)
    OR lower(first_name || ' ' || last_name) % lower(@q)
    OR mrn ILIKE '%' || @q || '%'
    OR phone ILIKE '%' || @q || '%'
  )
ORDER BY last_name, first_name
LIMIT @lim OFFSET @off;

-- name: CountPatients :one
SELECT count(*)
FROM patients
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
  AND (
    @q::text = ''
    OR concat_ws(' ', first_name, middle_name, last_name) ILIKE '%' || @q || '%'
    OR search_tsv @@ websearch_to_tsquery('simple', @q)
    OR lower(first_name || ' ' || last_name) % lower(@q)
    OR mrn ILIKE '%' || @q || '%'
    OR phone ILIKE '%' || @q || '%'
  );

-- name: FindDuplicateCandidates :many
-- Likely-duplicate detection on create (FR-PAT-03): name+DOB, phone, or national id.
SELECT id, mrn, first_name, last_name, dob, phone, national_id
FROM patients
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
  AND (
    (lower(first_name) = lower(@first_name) AND lower(last_name) = lower(@last_name) AND dob = @dob)
    OR (@phone::text <> '' AND phone = @phone)
    OR (@national_id::text <> '' AND national_id = @national_id)
  )
LIMIT 10;
