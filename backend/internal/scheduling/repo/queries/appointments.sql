-- name: CreateAppointment :one
INSERT INTO appointments (tenant_id, branch_id, department_id, patient_id, provider_id, resource_id,
                          starts_at, ends_at, reason, is_followup, free_until, ordered_by, origin_encounter_id, created_by)
VALUES (@tenant_id, @branch_id, @department_id, @patient_id, @provider_id, @resource_id,
        @starts_at, @ends_at, @reason, @is_followup, @free_until, @ordered_by, @origin_encounter_id, @created_by)
RETURNING id, starts_at, ends_at, status, created_at;

-- name: GetAppointment :one
SELECT id, tenant_id, branch_id, department_id, patient_id, provider_id, resource_id, starts_at, ends_at,
       status, reason, is_followup, free_until, ordered_by, origin_encounter_id
FROM appointments
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: ListAppointments :many
SELECT a.id, a.patient_id, a.provider_id, a.department_id, a.resource_id,
       a.starts_at, a.ends_at, a.status, a.reason, a.is_followup, a.free_until,
       a.ordered_by, a.origin_encounter_id,
       p.first_name, p.last_name, p.mrn,
       u.full_name AS provider_name,
       (u.status = 'active') AS provider_active,
       ob.full_name AS ordered_by_name,
       d.name AS department_name
FROM appointments a
JOIN patients p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
JOIN users u ON u.id = a.provider_id AND u.tenant_id = a.tenant_id
LEFT JOIN users ob ON ob.id = a.ordered_by AND ob.tenant_id = a.tenant_id
LEFT JOIN departments d ON d.id = a.department_id AND d.tenant_id = a.tenant_id
WHERE a.tenant_id = @tenant_id AND a.branch_id = @branch_id AND a.deleted_at IS NULL
  AND a.starts_at >= @from_ts AND a.starts_at < @to_ts
  AND (sqlc.narg(provider_id)::uuid IS NULL OR a.provider_id = sqlc.narg(provider_id))
  AND (NOT sqlc.arg(only_followup)::bool OR a.is_followup)
ORDER BY a.starts_at;

-- name: ListFollowups :many
-- Follow-ups in a window for the lens (due / upcoming / overdue / needs-handoff).
-- provider_active drives the handoff flag; overdue/coverage are derived from free_until.
SELECT a.id, a.patient_id, a.provider_id, a.department_id, a.resource_id,
       a.starts_at, a.ends_at, a.status, a.reason, a.is_followup, a.free_until,
       a.ordered_by, a.origin_encounter_id,
       p.first_name, p.last_name, p.mrn,
       u.full_name AS provider_name,
       (u.status = 'active') AS provider_active,
       ob.full_name AS ordered_by_name,
       d.name AS department_name
FROM appointments a
JOIN patients p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
JOIN users u ON u.id = a.provider_id AND u.tenant_id = a.tenant_id
LEFT JOIN users ob ON ob.id = a.ordered_by AND ob.tenant_id = a.tenant_id
LEFT JOIN departments d ON d.id = a.department_id AND d.tenant_id = a.tenant_id
WHERE a.tenant_id = @tenant_id AND a.branch_id = @branch_id AND a.deleted_at IS NULL
  AND a.is_followup
  AND a.starts_at >= @from_ts AND a.starts_at < @to_ts
ORDER BY a.starts_at;

-- name: RescheduleAppointment :one
UPDATE appointments
SET starts_at = @starts_at, ends_at = @ends_at, provider_id = @provider_id,
    resource_id = @resource_id, department_id = @department_id, reason = @reason, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id;

-- name: ReassignAppointmentProvider :one
-- Hand the follow-up to a covering doctor: change who attends (provider_id) while
-- leaving ordered_by intact. The GiST exclusion still rejects a time conflict.
UPDATE appointments
SET provider_id = @provider_id, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id, patient_id, ordered_by;

-- name: SetAppointmentStatus :one
UPDATE appointments
SET status = @status, cancel_reason = @cancel_reason, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id;

-- name: SetAppointmentFollowup :one
-- Mark an appointment as a covered (doctor-booked) follow-up that is free of the
-- card fee when attended on or before free_until. Used by reception to mark an
-- existing appointment manually; the doctor flow sets these inline at booking.
UPDATE appointments
SET is_followup = @is_followup, free_until = @free_until, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id, patient_id;
