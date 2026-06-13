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
