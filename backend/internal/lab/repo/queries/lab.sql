-- Phase 5a: Laboratory.

-- ---- catalog ----

-- name: ListLabTests :many
SELECT t.id, t.code, t.name, t.specimen, t.is_active,
  (SELECT count(*) FROM lab_analytes a WHERE a.test_id = t.id)::int AS analyte_count
FROM lab_tests t
WHERE t.tenant_id = @tenant_id AND t.deleted_at IS NULL AND (sqlc.narg(active_only)::bool IS NOT TRUE OR t.is_active)
ORDER BY t.name;

-- name: GetLabTest :one
SELECT id, code, name, specimen, is_active FROM lab_tests
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CreateLabTest :one
INSERT INTO lab_tests (tenant_id, code, name, specimen, created_by)
VALUES (@tenant_id, @code, @name, @specimen, @created_by)
RETURNING id, code, name, specimen, is_active;

-- name: ListAnalytesByTest :many
SELECT id, name, unit, ref_low, ref_high, critical_low, critical_high
FROM lab_analytes
WHERE tenant_id = @tenant_id AND test_id = @test_id
ORDER BY sort_order, name;

-- name: CreateAnalyte :exec
INSERT INTO lab_analytes (tenant_id, test_id, name, unit, ref_low, ref_high, critical_low, critical_high, sort_order)
VALUES (@tenant_id, @test_id, @name, @unit, @ref_low, @ref_high, @critical_low, @critical_high, @sort_order);

-- ---- orders ----

-- name: CreateLabOrder :one
INSERT INTO lab_orders (tenant_id, encounter_id, patient_id, provider_id, priority, clinical_note, created_by)
VALUES (@tenant_id, @encounter_id, @patient_id, @provider_id, @priority, @clinical_note, @created_by)
RETURNING id, order_no;

-- name: CreateLabOrderItem :one
INSERT INTO lab_order_items (tenant_id, order_id, test_id, specimen)
VALUES (@tenant_id, @order_id, @test_id, @specimen)
RETURNING id, sample_no;

-- name: ListOrdersByEncounter :many
SELECT id, order_no, priority, clinical_note, created_at
FROM lab_orders
WHERE tenant_id = @tenant_id AND encounter_id = @encounter_id AND deleted_at IS NULL
ORDER BY created_at;

-- name: ListOrdersByPatient :many
SELECT o.id, o.order_no, o.priority, o.created_at,
  (SELECT count(*) FROM lab_order_items i WHERE i.order_id = o.id)::int AS item_count,
  (SELECT count(*) FROM lab_order_items i WHERE i.order_id = o.id AND i.status = 'validated')::int AS validated_count
FROM lab_orders o
WHERE o.tenant_id = @tenant_id AND o.patient_id = @patient_id AND o.deleted_at IS NULL
ORDER BY o.created_at DESC LIMIT 50;

-- name: ListOrderItems :many
SELECT i.id, i.sample_no, i.status, i.specimen, t.id AS test_id, t.name AS test_name
FROM lab_order_items i
JOIN lab_tests t ON t.id = i.test_id AND t.tenant_id = i.tenant_id
WHERE i.tenant_id = @tenant_id AND i.order_id = @order_id
ORDER BY i.sample_no;

-- name: CountPendingLabsByEncounter :one
SELECT count(*)::int FROM lab_order_items i
JOIN lab_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
WHERE i.tenant_id = @tenant_id AND o.encounter_id = @encounter_id
  AND o.deleted_at IS NULL AND i.status NOT IN ('validated','cancelled');

-- name: ListPendingTestNamesByEncounter :many
SELECT DISTINCT t.name
FROM lab_order_items i
JOIN lab_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
JOIN lab_tests t ON t.id = i.test_id AND t.tenant_id = i.tenant_id
WHERE i.tenant_id = @tenant_id AND o.encounter_id = @encounter_id
  AND o.deleted_at IS NULL AND i.status NOT IN ('validated','cancelled');

-- ---- lab worklist + processing ----

-- name: ListLabWorklist :many
SELECT i.id, i.sample_no, i.status, i.created_at AS ordered_at,
  o.priority, p.first_name, p.last_name, p.mrn, t.name AS test_name
FROM lab_order_items i
JOIN lab_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
JOIN patients p ON p.id = o.patient_id AND p.tenant_id = i.tenant_id
JOIN lab_tests t ON t.id = i.test_id AND t.tenant_id = i.tenant_id
WHERE i.tenant_id = @tenant_id AND o.deleted_at IS NULL
  AND (sqlc.narg(status)::text IS NULL OR i.status = sqlc.narg(status))
ORDER BY (o.priority = 'stat') DESC, (o.priority = 'urgent') DESC, i.created_at
LIMIT 200;

-- name: GetOrderItem :one
SELECT i.id, i.sample_no, i.status, i.specimen, i.test_id, i.order_id,
  i.critical_flag, i.notified_at,
  o.priority, o.clinical_note, o.patient_id, o.encounter_id,
  p.first_name, p.last_name, p.mrn,
  t.name AS test_name, t.specimen AS test_specimen,
  u.full_name AS ordered_by, un.full_name AS notified_by_name
FROM lab_order_items i
JOIN lab_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
JOIN patients p ON p.id = o.patient_id AND p.tenant_id = i.tenant_id
JOIN lab_tests t ON t.id = i.test_id AND t.tenant_id = i.tenant_id
LEFT JOIN users u ON u.id = o.provider_id AND u.tenant_id = i.tenant_id
LEFT JOIN users un ON un.id = i.notified_by AND un.tenant_id = i.tenant_id
WHERE i.tenant_id = @tenant_id AND i.id = @id;

-- name: AccessionItem :one
UPDATE lab_order_items SET status = 'collected', collected_by = @collected_by, collected_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'ordered'
RETURNING id;

-- name: UpsertResult :exec
INSERT INTO lab_results (tenant_id, order_item_id, analyte_id, value, flag)
VALUES (@tenant_id, @order_item_id, @analyte_id, @value, @flag)
ON CONFLICT (order_item_id, analyte_id) DO UPDATE SET value = EXCLUDED.value, flag = EXCLUDED.flag, updated_at = now();

-- name: ListResultsByItem :many
SELECT r.analyte_id, r.value, r.flag, a.name, a.unit, a.ref_low, a.ref_high
FROM lab_results r
JOIN lab_analytes a ON a.id = r.analyte_id AND a.tenant_id = r.tenant_id
WHERE r.tenant_id = @tenant_id AND r.order_item_id = @order_item_id
ORDER BY a.sort_order, a.name;

-- name: SubmitResults :one
UPDATE lab_order_items SET status = 'resulted', resulted_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status IN ('collected','in_process')
RETURNING id;

-- name: ValidateItem :one
UPDATE lab_order_items SET status = 'validated', validated_at = now(), validated_by = @validated_by
WHERE tenant_id = @tenant_id AND id = @id AND status = 'resulted'
RETURNING id;

-- ---- Phase 5b-1: critical escalation + acknowledgement + doctor inbox ----

-- name: MarkItemCritical :exec
UPDATE lab_order_items SET critical_flag = true
WHERE tenant_id = @tenant_id AND id = @id;

-- name: MarkItemNotified :one
-- Acknowledge that a validated result was communicated to the ordering clinician.
UPDATE lab_order_items SET notified_at = now(), notified_by = @notified_by
WHERE tenant_id = @tenant_id AND id = @id AND status = 'validated' AND notified_at IS NULL
RETURNING id;

-- name: ListResultsInbox :many
-- The ordering doctor's returned results: unacknowledged criticals first, then
-- most-recently validated. Includes a per-sample abnormal/critical count.
SELECT i.id, i.sample_no, i.status, i.validated_at, i.critical_flag, i.notified_at,
  o.encounter_id, o.priority,
  p.first_name, p.last_name, p.mrn,
  t.name AS test_name,
  (SELECT count(*) FROM lab_results r WHERE r.order_item_id = i.id AND r.flag = 'critical')::int AS critical_count,
  (SELECT count(*) FROM lab_results r WHERE r.order_item_id = i.id AND r.flag <> 'normal')::int AS abnormal_count
FROM lab_order_items i
JOIN lab_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
JOIN patients p ON p.id = o.patient_id AND p.tenant_id = i.tenant_id
JOIN lab_tests t ON t.id = i.test_id AND t.tenant_id = i.tenant_id
WHERE i.tenant_id = @tenant_id AND o.provider_id = @provider_id AND o.deleted_at IS NULL
  AND i.status = 'validated'
  AND (i.validated_at > now() - interval '14 days' OR (i.critical_flag AND i.notified_at IS NULL))
ORDER BY (i.critical_flag AND i.notified_at IS NULL) DESC, i.validated_at DESC
LIMIT 100;

-- name: CountInboxCriticals :one
SELECT count(*)::int
FROM lab_order_items i
JOIN lab_orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
WHERE i.tenant_id = @tenant_id AND o.provider_id = @provider_id AND o.deleted_at IS NULL
  AND i.status = 'validated' AND i.critical_flag AND i.notified_at IS NULL;
