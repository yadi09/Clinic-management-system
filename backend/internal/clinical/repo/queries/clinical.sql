-- Phase 3a clinical: the visit spine (encounters, one per queue entry) and
-- triage vitals. Phase 3b extends encounters with notes/diagnoses/prescriptions.

-- name: GetEncounterByQueueEntry :one
SELECT id, branch_id, department_id, patient_id, queue_entry_id, provider_id, status, started_at, closed_at
FROM encounters
WHERE tenant_id = @tenant_id AND queue_entry_id = @queue_entry_id AND deleted_at IS NULL
LIMIT 1;

-- name: GetEncounter :one
SELECT id, branch_id, department_id, patient_id, queue_entry_id, provider_id, status, started_at, closed_at
FROM encounters
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CreateEncounter :one
INSERT INTO encounters (tenant_id, branch_id, department_id, patient_id, queue_entry_id, provider_id, created_by)
VALUES (@tenant_id, @branch_id, @department_id, @patient_id, @queue_entry_id, @provider_id, @created_by)
RETURNING id, branch_id, department_id, patient_id, queue_entry_id, provider_id, status, started_at, closed_at;

-- name: CreateVitals :one
INSERT INTO vitals (tenant_id, encounter_id, patient_id, systolic, diastolic, pulse, temp_c, resp_rate, spo2, weight_kg, height_cm, notes, recorded_by)
VALUES (@tenant_id, @encounter_id, @patient_id, @systolic, @diastolic, @pulse, @temp_c, @resp_rate, @spo2, @weight_kg, @height_cm, @notes, @recorded_by)
RETURNING id, recorded_at;

-- name: ListVitalsByEncounter :many
SELECT id, systolic, diastolic, pulse, temp_c, resp_rate, spo2, weight_kg, height_cm, notes, recorded_at, recorded_by
FROM vitals
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id
ORDER BY recorded_at DESC;

-- ============================================================================
-- Phase 3b: Consultation / EMR
-- ============================================================================

-- name: GetQueueEntryForEncounter :one
-- Bootstrap data to open/create an encounter from a worklist (queue) entry.
SELECT branch_id, department_id, patient_id, assigned_provider_id
FROM queue_entries
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CloseEncounter :one
UPDATE encounters SET status = 'closed', closed_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id, queue_entry_id;

-- name: GetPatientBanner :one
SELECT first_name, last_name, mrn, dob, gender, blood_group
FROM patients
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: ListPatientAllergies :many
SELECT substance, severity, reaction
FROM allergies
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY substance;

-- ---- SOAP note -------------------------------------------------------------

-- name: GetNoteByEncounter :one
SELECT id, subjective, objective, assessment, plan, status, signed_by, signed_at
FROM clinical_notes
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id AND deleted_at IS NULL
LIMIT 1;

-- name: CreateNote :one
INSERT INTO clinical_notes (tenant_id, encounter_id, subjective, objective, assessment, plan, created_by)
VALUES (@tenant_id, @encounter_id, @subjective, @objective, @assessment, @plan, @created_by)
RETURNING id, subjective, objective, assessment, plan, status, signed_by, signed_at;

-- name: UpdateNote :one
UPDATE clinical_notes
SET subjective = @subjective, objective = @objective, assessment = @assessment, plan = @plan, updated_at = now()
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id AND status = 'draft' AND deleted_at IS NULL
RETURNING id, subjective, objective, assessment, plan, status, signed_by, signed_at;

-- name: SignNote :one
UPDATE clinical_notes
SET status = 'signed', signed_by = @signed_by, signed_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id AND status = 'draft' AND deleted_at IS NULL
RETURNING id;

-- ---- Encounter diagnoses ---------------------------------------------------

-- name: CreateDiagnosis :one
INSERT INTO diagnoses (tenant_id, encounter_id, patient_id, catalog_id, category_id, code, description, is_primary, created_by)
VALUES (@tenant_id, @encounter_id, @patient_id, @catalog_id, @category_id, @code, @description, @is_primary, @created_by)
RETURNING id, code, description, is_primary, category_id;

-- name: ListDiagnosesByEncounter :many
SELECT d.id, d.code, d.description, d.is_primary, d.category_id, c.name AS category_name
FROM diagnoses d
LEFT JOIN diagnosis_categories c ON c.id = d.category_id AND c.tenant_id = d.tenant_id
WHERE d.tenant_id = @tenant_id AND d.encounter_id = @encounter_id AND d.deleted_at IS NULL
ORDER BY d.is_primary DESC, d.created_at;

-- name: DeleteDiagnosis :exec
UPDATE diagnoses SET deleted_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND encounter_id = @encounter_id AND deleted_at IS NULL;

-- name: ClearPrimaryDiagnoses :exec
UPDATE diagnoses SET is_primary = false
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id AND is_primary AND deleted_at IS NULL;

-- ---- Prescriptions ---------------------------------------------------------

-- name: GetPrescriptionByEncounter :one
SELECT id FROM prescriptions
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id AND deleted_at IS NULL
LIMIT 1;

-- name: CreatePrescription :one
INSERT INTO prescriptions (tenant_id, encounter_id, patient_id, created_by)
VALUES (@tenant_id, @encounter_id, @patient_id, @created_by)
RETURNING id;

-- name: CreatePrescriptionItem :one
INSERT INTO prescription_items (tenant_id, prescription_id, drug_name, dose, frequency, duration, instructions)
VALUES (@tenant_id, @prescription_id, @drug_name, @dose, @frequency, @duration, @instructions)
RETURNING id, drug_name, dose, frequency, duration, instructions;

-- name: ListPrescriptionsByEncounter :many
SELECT pi.id, pi.drug_name, pi.dose, pi.frequency, pi.duration, pi.instructions
FROM prescriptions p
JOIN prescription_items pi ON pi.prescription_id = p.id AND pi.tenant_id = p.tenant_id
WHERE p.tenant_id = @tenant_id AND p.encounter_id = @encounter_id AND p.deleted_at IS NULL
ORDER BY pi.created_at, pi.id;

-- name: DeletePrescriptionItem :exec
-- Encounter-scoped via the parent prescription so a path's encounter id actually
-- constrains which item can be removed (prevents cross-encounter deletes).
DELETE FROM prescription_items pi
USING prescriptions p
WHERE pi.prescription_id = p.id
  AND pi.tenant_id = @tenant_id AND pi.id = @id
  AND p.encounter_id = @encounter_id AND p.deleted_at IS NULL;

-- ---- Diagnosis catalog (admin) + search (doctor) ---------------------------

-- name: ListDiagnosisCategories :many
SELECT id, name, sort_order, is_active
FROM diagnosis_categories
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY sort_order, name;

-- name: CreateDiagnosisCategory :one
INSERT INTO diagnosis_categories (tenant_id, name, sort_order, created_by)
VALUES (@tenant_id, @name, @sort_order, @created_by)
RETURNING id, name, sort_order, is_active;

-- name: UpdateDiagnosisCategory :exec
UPDATE diagnosis_categories SET name = @name, sort_order = @sort_order, is_active = @is_active, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: DeleteDiagnosisCategory :exec
UPDATE diagnosis_categories SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: ListDiagnosisCatalog :many
SELECT dc.id, dc.category_id, dc.code, dc.name, dc.is_active, cat.name AS category_name
FROM diagnosis_catalog dc
JOIN diagnosis_categories cat ON cat.id = dc.category_id AND cat.tenant_id = dc.tenant_id
WHERE dc.tenant_id = @tenant_id AND dc.deleted_at IS NULL
  AND (sqlc.narg(search)::text IS NULL OR dc.name ILIKE '%' || sqlc.narg(search) || '%' OR dc.code ILIKE '%' || sqlc.narg(search) || '%')
  AND (sqlc.narg(category_id)::uuid IS NULL OR dc.category_id = sqlc.narg(category_id))
  AND (sqlc.narg(include_inactive)::bool IS TRUE OR dc.is_active = true)
ORDER BY cat.sort_order, cat.name, dc.name
LIMIT 200;

-- name: GetCatalogEntry :one
SELECT id, category_id, code, name
FROM diagnosis_catalog
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CreateDiagnosisCatalogEntry :one
INSERT INTO diagnosis_catalog (tenant_id, category_id, code, name, created_by)
VALUES (@tenant_id, @category_id, @code, @name, @created_by)
RETURNING id, category_id, code, name, is_active;

-- name: UpdateDiagnosisCatalogEntry :exec
UPDATE diagnosis_catalog SET category_id = @category_id, code = @code, name = @name, is_active = @is_active, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: DeleteDiagnosisCatalogEntry :exec
UPDATE diagnosis_catalog SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: ListPatientEncounters :many
-- Patient history timeline (Phase 3b-2): past encounters with their primary diagnosis.
SELECT e.id, e.started_at, e.status,
       u.full_name AS provider_name,
       COALESCE((SELECT d.description FROM diagnoses d
        WHERE d.encounter_id = e.id AND d.deleted_at IS NULL
        ORDER BY d.is_primary DESC, d.created_at LIMIT 1), '')::text AS primary_dx
FROM encounters e
LEFT JOIN users u ON u.id = e.provider_id AND u.tenant_id = e.tenant_id
WHERE e.tenant_id = @tenant_id AND e.patient_id = @patient_id AND e.deleted_at IS NULL
ORDER BY e.started_at DESC
LIMIT 20;
