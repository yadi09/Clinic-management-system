-- Phase 3a billing: the card / consultation fee. Reads clinic settings and
-- appointment coverage (cross-module READs; writes stay in this module) to
-- decide whether a visit must pay, and records receipts in card_payments.

-- name: GetCardSettings :one
SELECT card_fee_enabled, card_fee_amount, card_currency, free_window_days
FROM clinics
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY created_at
LIMIT 1;

-- name: GetAppointmentCoverage :one
SELECT id, patient_id, is_followup, free_until, status
FROM appointments
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: GetCardPaymentSince :one
-- Most recent non-deleted card payment for a patient at/after a cutoff (used to
-- detect "already paid today" so reception doesn't double-charge).
SELECT id, amount, currency, waived, paid_at
FROM card_payments
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
  AND paid_at >= @since
ORDER BY paid_at DESC
LIMIT 1;

-- name: CreateCardPayment :one
INSERT INTO card_payments (tenant_id, branch_id, patient_id, appointment_id, amount, currency, waived, waive_reason, received_by)
VALUES (@tenant_id, @branch_id, @patient_id, @appointment_id, @amount, @currency, @waived, @waive_reason, @received_by)
RETURNING id, amount, currency, waived, paid_at;

-- name: ListCardPaymentsByPatient :many
SELECT id, amount, currency, waived, waive_reason, paid_at
FROM card_payments
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY paid_at DESC
LIMIT 20;

-- ============================================================================
-- Billing-1: service catalog + charges spine + cashier + cash summary
-- ============================================================================

-- ---- service catalog (what's billable, how much) ----

-- name: ListServiceItems :many
SELECT id, code, name, category, price, currency, is_active, is_default FROM service_items
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
  AND (sqlc.narg(active_only)::bool IS NOT TRUE OR is_active)
ORDER BY is_default DESC, category, name;

-- name: GetServiceItem :one
SELECT id, code, name, category, price, currency, is_active, is_default FROM service_items
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CreateServiceItem :one
INSERT INTO service_items (tenant_id, code, name, category, price, created_by)
VALUES (@tenant_id, @code, @name, @category, @price, @created_by)
RETURNING id, code, name, category, price, currency, is_active, is_default;

-- name: UpdateServiceItem :exec
UPDATE service_items SET code = @code, name = @name, category = @category, price = @price, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SetServiceItemActive :exec
UPDATE service_items SET is_active = @is_active, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SetServiceItemDefault :exec
UPDATE service_items SET is_default = @is_default, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SoftDeleteServiceItem :exec
UPDATE service_items SET deleted_at = now(), is_active = false, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- ---- charges ----

-- name: CreateCharge :one
INSERT INTO charges (tenant_id, patient_id, encounter_id, service_item_id, source, description, amount, currency,
  branch_id, department_id, to_triage, provider_id, created_by)
VALUES (@tenant_id, @patient_id, @encounter_id, @service_item_id, @source, @description, @amount, @currency,
  @branch_id, @department_id, @to_triage, @provider_id, @created_by)
RETURNING id, status, amount, currency, created_at;

-- name: ListPendingCharges :many
SELECT c.id, c.source, c.description, c.amount, c.currency, c.created_at,
  c.patient_id, p.first_name, p.last_name, p.mrn
FROM charges c
JOIN patients p ON p.id = c.patient_id AND p.tenant_id = c.tenant_id
WHERE c.tenant_id = @tenant_id AND c.status = 'pending' AND c.deleted_at IS NULL
ORDER BY c.created_at
LIMIT 200;

-- name: ListChargesByPatient :many
SELECT id, source, description, amount, currency, status, payment_method, waive_reason, settled_at, created_at
FROM charges
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY created_at DESC LIMIT 50;

-- name: SettleCharge :one
-- Atomic claim: only a pending charge can be settled (prevents double-collect).
UPDATE charges SET status = 'paid', payment_method = @payment_method, settled_by = @settled_by, settled_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'pending' AND deleted_at IS NULL
RETURNING id, source, patient_id, branch_id, department_id, to_triage, provider_id, enqueued;

-- name: WaiveCharge :one
UPDATE charges SET status = 'waived', waive_reason = @waive_reason, settled_by = @settled_by, settled_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'pending' AND deleted_at IS NULL
RETURNING id, source, patient_id, branch_id, department_id, to_triage, provider_id, enqueued;

-- name: MarkChargeEnqueued :exec
UPDATE charges SET enqueued = true, updated_at = now() WHERE tenant_id = @tenant_id AND id = @id;

-- name: CountPendingChargesByPatient :one
-- Used to gate the visit: only advance the patient once nothing is still owed.
SELECT count(*)::int FROM charges
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND status = 'pending' AND deleted_at IS NULL;

-- name: CountActiveQueueByPatient :one
-- Prevents enqueuing a patient who is already in the queue (idempotent advance).
SELECT count(*)::int FROM queue_entries
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
  AND state NOT IN ('done','no_show');

-- name: EnqueueFromCharge :exec
-- Auto-advance after payment: enqueue the patient to the routing captured on the
-- charge (state defaults to 'waiting', enqueued_at to now()).
INSERT INTO queue_entries (tenant_id, branch_id, department_id, patient_id, stage, assigned_provider_id, priority, created_by)
VALUES (@tenant_id, @branch_id, @department_id, @patient_id, @stage, @assigned_provider_id, 0, @created_by);

-- ---- cash summary (owner finance view) ----

-- name: CashCollectedSince :one
SELECT COALESCE(sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges WHERE tenant_id = @tenant_id AND status = 'paid' AND settled_at >= @since;

-- name: CashWaivedSince :one
SELECT COALESCE(sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges WHERE tenant_id = @tenant_id AND status = 'waived' AND settled_at >= @since;

-- name: CashOutstanding :one
SELECT COALESCE(sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges WHERE tenant_id = @tenant_id AND status = 'pending' AND deleted_at IS NULL;

-- name: CashBySourceSince :many
SELECT source, COALESCE(sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges WHERE tenant_id = @tenant_id AND status = 'paid' AND settled_at >= @since
GROUP BY source ORDER BY total DESC;
