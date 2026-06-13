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
