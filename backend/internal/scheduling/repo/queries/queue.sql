-- name: CreateQueueEntry :one
INSERT INTO queue_entries (tenant_id, branch_id, department_id, patient_id, appointment_id, priority, created_by)
VALUES (@tenant_id, @branch_id, @department_id, @patient_id, @appointment_id, @priority, @created_by)
RETURNING id, branch_id, department_id;

-- name: ListQueue :many
SELECT q.id, q.patient_id, q.appointment_id, q.state, q.priority,
       q.enqueued_at, q.called_at, q.started_at, q.ended_at,
       p.first_name, p.last_name, p.mrn
FROM queue_entries q
JOIN patients p ON p.id = q.patient_id AND p.tenant_id = q.tenant_id
WHERE q.tenant_id = @tenant_id AND q.department_id = @department_id AND q.deleted_at IS NULL
  AND q.enqueued_at >= @since
ORDER BY q.priority DESC, q.enqueued_at;

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
