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

-- name: ListDefaultServices :many
-- Active services tagged as the default intake fee (registration / consultation),
-- raised automatically when a patient enters via walk-in or appointment check-in.
SELECT id, code, name, price FROM service_items
WHERE tenant_id = @tenant_id AND deleted_at IS NULL AND is_active AND is_default
ORDER BY name;

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

-- ---- service providers (which staff perform a service) ----

-- name: ClearServiceProviders :exec
DELETE FROM service_providers WHERE tenant_id = @tenant_id AND service_item_id = @service_item_id;

-- name: AddServiceProvider :exec
INSERT INTO service_providers (tenant_id, service_item_id, user_id)
VALUES (@tenant_id, @service_item_id, @user_id)
ON CONFLICT (service_item_id, user_id) DO NOTHING;

-- name: ListServiceProviderIDs :many
SELECT user_id FROM service_providers
WHERE tenant_id = @tenant_id AND service_item_id = @service_item_id;

-- name: ListProvidersForServices :many
-- Distinct active staff who provide ANY of the given services (reception's filtered dropdown).
SELECT DISTINCT u.id, u.full_name
FROM service_providers sp
JOIN users u ON u.id = sp.user_id AND u.tenant_id = sp.tenant_id
WHERE sp.tenant_id = @tenant_id AND sp.service_item_id = ANY(@service_ids::uuid[]) AND u.status = 'active'
ORDER BY u.full_name;

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
SELECT id, source, description, amount, currency, status, payment_method, waive_reason, settled_at, created_at, receipt_no
FROM charges
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL
ORDER BY created_at DESC LIMIT 50;

-- name: SettleCharge :one
-- Atomic claim: only a pending charge can be settled (prevents double-collect).
UPDATE charges SET status = 'paid', payment_method = @payment_method, settled_by = @settled_by, settled_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'pending' AND deleted_at IS NULL
RETURNING id, source, patient_id, branch_id, department_id, to_triage, provider_id, enqueued;

-- name: NextReceiptNo :one
-- Per-tenant monotonic receipt number (atomic increment).
INSERT INTO billing_counters (tenant_id, name, value) VALUES (@tenant_id, 'receipt', 1)
ON CONFLICT (tenant_id, name) DO UPDATE SET value = billing_counters.value + 1
RETURNING value;

-- name: SetChargeReceipt :exec
UPDATE charges SET receipt_no = @receipt_no, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id;

-- name: WaiveCharge :one
UPDATE charges SET status = 'waived', waive_reason = @waive_reason, settled_by = @settled_by, settled_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'pending' AND deleted_at IS NULL
RETURNING id, source, patient_id, branch_id, department_id, to_triage, provider_id, enqueued;

-- name: MarkChargeEnqueued :exec
UPDATE charges SET enqueued = true, updated_at = now() WHERE tenant_id = @tenant_id AND id = @id;

-- name: GetCharge :one
SELECT id, patient_id, encounter_id, source, description, amount, currency, status, settled_at
FROM charges
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: ChargeStatus :one
-- Used by lab/pharmacy pre-pay gates: has this charge been settled (paid/waived)?
SELECT status FROM charges
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: VoidCharge :one
-- Atomic claim: only a still-pending charge can be voided (keying error / patient left).
UPDATE charges SET status = 'void', void_reason = @void_reason, voided_by = @voided_by, voided_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'pending' AND deleted_at IS NULL
RETURNING id, source, patient_id, amount;

-- name: CountReversals :one
-- Prevents double-refunding the same charge.
SELECT count(*)::int FROM charges
WHERE tenant_id = @tenant_id AND reverses_charge_id = @id AND deleted_at IS NULL;

-- name: CreateReversalCharge :one
-- A refund posts a linked negative entry dated now (so historical day/Z reports stay
-- correct); the original settled charge is left intact for the audit trail.
INSERT INTO charges (tenant_id, patient_id, encounter_id, source, description, amount, currency, status,
  payment_method, settled_by, settled_at, reverses_charge_id, created_by)
VALUES (@tenant_id, @patient_id, @encounter_id, 'refund', @description, @amount, @currency, 'paid',
  @payment_method, @settled_by, now(), @reverses_charge_id, @created_by)
RETURNING id, amount, created_at;

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
-- Gross collected by service line (refund reversing entries are reported separately).
SELECT source, COALESCE(sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges WHERE tenant_id = @tenant_id AND status = 'paid' AND source <> 'refund' AND settled_at >= @since
GROUP BY source ORDER BY total DESC;

-- name: CashRefundedSince :one
-- Refunds are stored as negative entries; report them as a positive total.
SELECT COALESCE(-sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges WHERE tenant_id = @tenant_id AND source = 'refund' AND status = 'paid' AND settled_at >= @since;

-- name: CashByMethodSince :many
-- Collected grouped by payment method (cash / card / mobile / transfer / refund).
SELECT COALESCE(payment_method, 'unknown') AS method, COALESCE(sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges WHERE tenant_id = @tenant_id AND status = 'paid' AND settled_at >= @since
GROUP BY payment_method ORDER BY total DESC;

-- name: CashByBranchSince :many
-- Collected grouped by branch (charges with no branch — e.g. lab/pharmacy today —
-- bucket as 'Unassigned').
SELECT COALESCE(b.name, 'Unassigned') AS branch, COALESCE(sum(c.amount), 0)::numeric AS total, count(*)::int AS n
FROM charges c
LEFT JOIN branches b ON b.id = c.branch_id AND b.tenant_id = c.tenant_id
WHERE c.tenant_id = @tenant_id AND c.status = 'paid' AND c.source <> 'refund' AND c.settled_at >= @since
GROUP BY b.name ORDER BY total DESC;

-- name: CashByCashierSince :many
-- Collected grouped by the cashier who settled it (excludes refund reversing entries).
SELECT c.settled_by, COALESCE(u.full_name, 'Unknown') AS cashier, COALESCE(sum(c.amount), 0)::numeric AS total, count(*)::int AS n
FROM charges c
LEFT JOIN users u ON u.id = c.settled_by AND u.tenant_id = c.tenant_id
WHERE c.tenant_id = @tenant_id AND c.status = 'paid' AND c.source <> 'refund' AND c.settled_at >= @since
GROUP BY c.settled_by, u.full_name ORDER BY total DESC;

-- ---- end-of-day cash reconciliation (Z-report) ----

-- name: ExpectedForCashierDay :many
-- What a cashier collected on a business day, grouped by method (the "expected" drawer).
SELECT COALESCE(payment_method, 'unknown') AS method, COALESCE(sum(amount), 0)::numeric AS total, count(*)::int AS n
FROM charges
WHERE tenant_id = @tenant_id AND settled_by = @cashier_id AND status = 'paid' AND source <> 'refund'
  AND settled_at >= @day_start AND settled_at < @day_end
GROUP BY payment_method ORDER BY method;

-- name: GetReconciliation :one
SELECT id, cashier_id, business_date, expected_total, counted_total, variance, by_method, note, closed_at
FROM cash_reconciliations
WHERE tenant_id = @tenant_id AND cashier_id = @cashier_id AND business_date = @business_date;

-- name: InsertReconciliation :one
INSERT INTO cash_reconciliations (tenant_id, cashier_id, business_date, expected_total, counted_total, variance, by_method, note, closed_by)
VALUES (@tenant_id, @cashier_id, @business_date, @expected_total, @counted_total, @variance, @by_method, @note, @closed_by)
ON CONFLICT (tenant_id, cashier_id, business_date)
DO UPDATE SET expected_total = EXCLUDED.expected_total, counted_total = EXCLUDED.counted_total,
  variance = EXCLUDED.variance, by_method = EXCLUDED.by_method, note = EXCLUDED.note,
  closed_by = EXCLUDED.closed_by, closed_at = now()
RETURNING id, closed_at;

-- name: ListReconciliations :many
SELECT r.id, r.cashier_id, COALESCE(u.full_name, 'Unknown') AS cashier, r.business_date,
  r.expected_total, r.counted_total, r.variance, r.note, r.closed_at
FROM cash_reconciliations r
LEFT JOIN users u ON u.id = r.cashier_id AND u.tenant_id = r.tenant_id
WHERE r.tenant_id = @tenant_id AND (sqlc.narg(cashier_id)::uuid IS NULL OR r.cashier_id = sqlc.narg(cashier_id))
ORDER BY r.business_date DESC, r.closed_at DESC LIMIT 100;
