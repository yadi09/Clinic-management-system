-- name: CreateQueueEntry :one
INSERT INTO queue_entries (tenant_id, branch_id, department_id, patient_id, appointment_id, stage, assigned_provider_id, priority, created_by)
VALUES (@tenant_id, @branch_id, @department_id, @patient_id, @appointment_id, @stage, @assigned_provider_id, @priority, @created_by)
RETURNING id, branch_id, department_id;

-- name: ClinicRequiresTriage :one
-- Clinic policy (Settings → Patient flow): when true, every visit is triaged first.
SELECT COALESCE(triage_required, false) FROM clinics
WHERE tenant_id = @tenant_id AND deleted_at IS NULL ORDER BY created_at LIMIT 1;

-- name: ListQueue :many
SELECT q.id, q.patient_id, q.appointment_id, q.state, q.priority, q.stage, q.assigned_provider_id,
       q.enqueued_at, q.called_at, q.started_at, q.ended_at,
       p.first_name, p.last_name, p.mrn,
       u.full_name AS provider_name,
       EXISTS (SELECT 1 FROM vitals vt JOIN encounters e ON e.id = vt.encounter_id
               WHERE e.queue_entry_id = q.id AND e.tenant_id = q.tenant_id AND e.deleted_at IS NULL) AS has_vitals,
       -- Derived: the patient's consult has at least one lab sample still in flight.
       -- The live status lives on lab_order_items (the order header stays 'ordered'),
       -- so they show in the "In lab" lane and fall back to "In consult" the moment
       -- results are submitted/validated (or the test is cancelled).
       EXISTS (SELECT 1 FROM lab_order_items loi
                 JOIN lab_orders lo ON lo.id = loi.order_id
                 JOIN encounters le ON le.id = lo.encounter_id
               WHERE le.queue_entry_id = q.id AND loi.tenant_id = q.tenant_id
                 AND lo.deleted_at IS NULL
                 AND loi.status IN ('ordered','collected','in_process')) AS in_lab
FROM queue_entries q
JOIN patients p ON p.id = q.patient_id AND p.tenant_id = q.tenant_id
LEFT JOIN users u ON u.id = q.assigned_provider_id AND u.tenant_id = q.tenant_id
WHERE q.tenant_id = @tenant_id AND q.department_id = @department_id AND q.deleted_at IS NULL
  AND (sqlc.narg(branch_id)::uuid IS NULL OR q.branch_id = sqlc.narg(branch_id))
  AND q.enqueued_at >= @since
  AND (sqlc.narg(until)::timestamptz IS NULL OR q.enqueued_at < sqlc.narg(until))
  AND (sqlc.narg(stage)::text IS NULL OR q.stage = sqlc.narg(stage))
ORDER BY q.priority DESC, q.enqueued_at;

-- name: GetTriageReadiness :one
-- A queue entry's stage + whether vitals have been recorded (gates triage → doctor).
SELECT q.stage,
       EXISTS (SELECT 1 FROM vitals vt JOIN encounters e ON e.id = vt.encounter_id
               WHERE e.queue_entry_id = q.id AND e.tenant_id = q.tenant_id AND e.deleted_at IS NULL) AS has_vitals
FROM queue_entries q
WHERE q.tenant_id = @tenant_id AND q.id = @id AND q.deleted_at IS NULL;

-- name: ListWorklist :many
SELECT q.id, q.patient_id, q.appointment_id, q.state, q.priority, q.stage, q.assigned_provider_id,
       q.department_id, q.enqueued_at, q.called_at, q.started_at, q.ended_at,
       p.first_name, p.last_name, p.mrn,
       d.name AS department_name
FROM queue_entries q
JOIN patients p ON p.id = q.patient_id AND p.tenant_id = q.tenant_id
LEFT JOIN departments d ON d.id = q.department_id AND d.tenant_id = q.tenant_id
WHERE q.tenant_id = @tenant_id AND q.assigned_provider_id = @assigned_provider_id
  AND q.deleted_at IS NULL AND q.state IN ('waiting','called','in_consult')
  AND (sqlc.narg(branch_id)::uuid IS NULL OR q.branch_id = sqlc.narg(branch_id))
  AND q.enqueued_at >= @since
  AND (sqlc.narg(until)::timestamptz IS NULL OR q.enqueued_at < sqlc.narg(until))
ORDER BY q.priority DESC, q.enqueued_at;

-- name: AssignQueueProvider :one
UPDATE queue_entries
SET assigned_provider_id = @assigned_provider_id, stage = 'with_doctor', updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id, branch_id, department_id;

-- name: TransitionQueueEntry :one
UPDATE queue_entries
SET state = @state,
    called_at = CASE WHEN @state = 'called' THEN now() ELSE called_at END,
    started_at = CASE WHEN @state = 'in_consult' THEN now() ELSE started_at END,
    ended_at = CASE WHEN @state IN ('done','no_show') THEN now() ELSE ended_at END,
    updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id, branch_id, department_id;

-- name: SetQueuePriority :exec
UPDATE queue_entries SET priority = @priority, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: NotifyQueue :exec
SELECT pg_notify('queue_events', @payload::text);

-- name: ListUnassignedReady :many
-- Patients who've cleared triage (stage=with_doctor) and are waiting but not yet
-- assigned to any doctor — the "pick up" pool surfaced on each doctor's My day.
SELECT q.id, q.patient_id, q.appointment_id, q.state, q.priority, q.stage, q.assigned_provider_id,
       q.department_id, q.enqueued_at, q.called_at, q.started_at, q.ended_at,
       p.first_name, p.last_name, p.mrn,
       d.name AS department_name
FROM queue_entries q
JOIN patients p ON p.id = q.patient_id AND p.tenant_id = q.tenant_id
LEFT JOIN departments d ON d.id = q.department_id AND d.tenant_id = q.tenant_id
WHERE q.tenant_id = @tenant_id AND q.deleted_at IS NULL
  AND q.stage = 'with_doctor' AND q.assigned_provider_id IS NULL
  AND q.state IN ('waiting','called')
  AND (sqlc.narg(branch_id)::uuid IS NULL OR q.branch_id = sqlc.narg(branch_id))
  AND q.enqueued_at >= @since
  AND (sqlc.narg(until)::timestamptz IS NULL OR q.enqueued_at < sqlc.narg(until))
ORDER BY q.priority DESC, q.enqueued_at;
