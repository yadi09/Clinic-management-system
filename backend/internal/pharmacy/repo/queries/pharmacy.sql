-- Phase 4a: Pharmacy dispensing core.

-- ---- Drug catalog ----------------------------------------------------------

-- name: ListDrugs :many
SELECT d.id, d.name, d.form, d.drug_class, d.is_controlled, d.unit_price, d.reorder_level, d.is_active,
       COALESCE((SELECT SUM(b.qty_on_hand) FROM drug_batches b WHERE b.drug_id = d.id AND b.deleted_at IS NULL), 0)::int AS on_hand
FROM drugs d
WHERE d.tenant_id = @tenant_id AND d.deleted_at IS NULL
  AND (sqlc.narg(class)::text IS NULL OR d.drug_class = sqlc.narg(class))
  AND (sqlc.narg(controlled)::bool IS NULL OR d.is_controlled = sqlc.narg(controlled))
ORDER BY d.name;

-- name: SearchDrugs :many
SELECT id, name, drug_class, is_controlled, unit_price
FROM drugs
WHERE tenant_id = @tenant_id AND deleted_at IS NULL AND is_active
  AND name ILIKE '%' || @q || '%'
ORDER BY name LIMIT 50;

-- name: FindDrugByName :one
SELECT id, name, drug_class, is_controlled, unit_price
FROM drugs
WHERE tenant_id = @tenant_id AND deleted_at IS NULL AND lower(name) = lower(@name)
LIMIT 1;

-- name: GetDrug :one
SELECT id, name, drug_class, is_controlled, unit_price
FROM drugs
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- ---- Batches / stock -------------------------------------------------------

-- name: ListBatches :many
SELECT b.id, b.drug_id, b.batch_no, b.expiry_date, b.qty_on_hand, b.quarantined, d.name AS drug_name
FROM drug_batches b
JOIN drugs d ON d.id = b.drug_id AND d.tenant_id = b.tenant_id
WHERE b.tenant_id = @tenant_id AND b.deleted_at IS NULL
ORDER BY (b.expiry_date IS NULL), b.expiry_date, d.name;

-- name: ListBatchesByDrug :many
-- All non-deleted batches for a drug in FEFO order (earliest expiry first, nulls
-- last). Availability (stock / quarantine / expiry) is enforced on dispense.
SELECT id, batch_no, expiry_date, qty_on_hand, quarantined
FROM drug_batches
WHERE tenant_id = @tenant_id AND drug_id = @drug_id AND deleted_at IS NULL
ORDER BY (expiry_date IS NULL), expiry_date, batch_no;

-- name: GetBatch :one
SELECT id, drug_id, qty_on_hand, expiry_date, quarantined
FROM drug_batches
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: DecrementBatch :one
-- Decrements only if enough stock; returns no row when insufficient (caller treats as error).
UPDATE drug_batches SET qty_on_hand = qty_on_hand - @qty, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL AND qty_on_hand >= @qty
RETURNING id, qty_on_hand;

-- name: AdjustBatchQty :one
-- Returns no row if the adjustment would drive stock negative (caller treats as a conflict).
UPDATE drug_batches SET qty_on_hand = qty_on_hand + @delta, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL AND qty_on_hand + @delta >= 0
RETURNING id, qty_on_hand;

-- name: SetBatchQuarantine :exec
UPDATE drug_batches SET quarantined = @quarantined, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CreateBatch :one
INSERT INTO drug_batches (tenant_id, drug_id, batch_no, expiry_date, qty_on_hand, created_by)
VALUES (@tenant_id, @drug_id, @batch_no, @expiry_date, @qty_on_hand, @created_by)
RETURNING id, batch_no, expiry_date, qty_on_hand, quarantined;

-- name: InsertStockMovement :exec
INSERT INTO stock_movements (tenant_id, drug_id, batch_id, delta, reason, ref_type, ref_id, note, created_by)
VALUES (@tenant_id, @drug_id, @batch_id, @delta, @reason, @ref_type, @ref_id, @note, @created_by);

-- ---- Dispense queue / detail ----------------------------------------------

-- name: ListDispenseQueue :many
SELECT p.id, p.rx_no, p.dispensed_at, p.patient_id,
       pt.first_name, pt.last_name, pt.mrn,
       u.full_name AS prescriber,
       (SELECT count(*) FROM prescription_items pi WHERE pi.prescription_id = p.id)::int AS item_count,
       EXISTS (SELECT 1 FROM allergies a WHERE a.patient_id = p.patient_id AND a.tenant_id = p.tenant_id AND a.deleted_at IS NULL) AS has_allergy,
       EXISTS (SELECT 1 FROM pharmacy_sales s WHERE s.prescription_id = p.id AND s.tenant_id = p.tenant_id AND s.status = 'awaiting_payment' AND s.deleted_at IS NULL) AS awaiting_payment
FROM prescriptions p
JOIN encounters e ON e.id = p.encounter_id AND e.tenant_id = p.tenant_id
JOIN patients pt ON pt.id = p.patient_id AND pt.tenant_id = p.tenant_id
LEFT JOIN users u ON u.id = e.provider_id AND u.tenant_id = e.tenant_id
WHERE p.tenant_id = @tenant_id AND p.deleted_at IS NULL AND p.status <> 'cancelled' AND e.status = 'closed'
  AND (sqlc.narg(include_dispensed)::bool IS TRUE OR p.dispensed_at IS NULL)
ORDER BY (p.dispensed_at IS NOT NULL), p.rx_no DESC
LIMIT 100;

-- name: GetPrescriptionHeader :one
SELECT p.id, p.rx_no, p.patient_id, p.dispensed_at,
       pt.first_name, pt.last_name, pt.mrn,
       u.full_name AS prescriber
FROM prescriptions p
JOIN patients pt ON pt.id = p.patient_id AND pt.tenant_id = p.tenant_id
JOIN encounters e ON e.id = p.encounter_id AND e.tenant_id = p.tenant_id
LEFT JOIN users u ON u.id = e.provider_id AND u.tenant_id = e.tenant_id
WHERE p.tenant_id = @tenant_id AND p.id = @id AND p.deleted_at IS NULL;

-- name: ListPrescriptionItemsForDispense :many
SELECT id, drug_name, dose, frequency, duration, instructions
FROM prescription_items
WHERE tenant_id = @tenant_id AND prescription_id = @prescription_id
ORDER BY created_at, id;

-- name: ListPatientAllergiesForDispense :many
SELECT substance FROM allergies
WHERE tenant_id = @tenant_id AND patient_id = @patient_id AND deleted_at IS NULL;

-- name: MarkPrescriptionDispensed :one
-- Atomic "claim": returns the row only if it was not already dispensed, so it
-- acts as the concurrency gate against a double dispense.
UPDATE prescriptions SET dispensed_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL AND dispensed_at IS NULL
RETURNING id;

-- ---- Sales / charges -------------------------------------------------------

-- name: CreateSale :one
INSERT INTO pharmacy_sales (tenant_id, sale_type, patient_id, prescription_id, status, subtotal, total, currency, counselling_notes, charge_id, paid_at, created_by)
VALUES (@tenant_id, @sale_type, @patient_id, @prescription_id, @status, @subtotal, @total, @currency, @counselling_notes, @charge_id, @paid_at, @created_by)
RETURNING id, total, status, created_at;

-- name: CreateSaleItem :exec
INSERT INTO pharmacy_sale_items (tenant_id, sale_id, drug_id, batch_id, description, qty, unit_price, line_total)
VALUES (@tenant_id, @sale_id, @drug_id, @batch_id, @description, @qty, @unit_price, @line_total);

-- name: GetAwaitingSaleByPrescription :one
-- The prepared-but-unpaid sale for a prescription (drives the pre-pay gate + queue badge).
SELECT id, charge_id, total, currency, status
FROM pharmacy_sales
WHERE tenant_id = @tenant_id AND prescription_id = @prescription_id
  AND status = 'awaiting_payment' AND deleted_at IS NULL
ORDER BY created_at DESC LIMIT 1;

-- name: ListSaleItems :many
SELECT id, drug_id, batch_id, description, qty, unit_price, line_total
FROM pharmacy_sale_items
WHERE tenant_id = @tenant_id AND sale_id = @sale_id
ORDER BY id;

-- name: MarkSaleDispensed :exec
UPDATE pharmacy_sales SET status = 'dispensed', paid_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'awaiting_payment';

-- name: CancelAwaitingSale :exec
-- Drops a prepared-but-unpaid sale (e.g. patient declined at the cashier).
UPDATE pharmacy_sales SET status = 'cancelled', updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND status = 'awaiting_payment';

-- ---- Catalog admin (Phase 4b-1) -------------------------------------------

-- name: CreateDrug :one
INSERT INTO drugs (tenant_id, name, form, drug_class, is_controlled, unit_price, reorder_level, created_by)
VALUES (@tenant_id, @name, @form, @drug_class, @is_controlled, @unit_price, @reorder_level, @created_by)
RETURNING id;

-- name: UpdateDrug :exec
UPDATE drugs SET name = @name, form = @form, drug_class = @drug_class, is_controlled = @is_controlled,
  unit_price = @unit_price, reorder_level = @reorder_level, is_active = @is_active, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- ---- OTC sale (Phase 4b-1) -------------------------------------------------

-- name: CreateOtcSale :one
INSERT INTO pharmacy_sales (tenant_id, sale_type, patient_id, status, subtotal, discount, tax, total, currency, payment_method, paid_at, created_by)
VALUES (@tenant_id, 'otc', @patient_id, 'paid', @subtotal, @discount, @tax, @total, @currency, @payment_method, now(), @created_by)
RETURNING id, total, status;

-- ---- Dashboard (Phase 4b-1) ------------------------------------------------

-- name: ValueOnHand :one
SELECT COALESCE(SUM(b.qty_on_hand * d.unit_price), 0)::numeric AS value_on_hand
FROM drug_batches b JOIN drugs d ON d.id = b.drug_id AND d.tenant_id = b.tenant_id
WHERE b.tenant_id = @tenant_id AND b.deleted_at IS NULL;

-- name: CountExpiredBatches :one
SELECT count(*)::int FROM drug_batches
WHERE tenant_id = @tenant_id AND deleted_at IS NULL AND qty_on_hand > 0
  AND expiry_date IS NOT NULL AND expiry_date < @today;

-- name: DispensingVolume :many
SELECT created_at::date AS day, count(*)::int AS count
FROM pharmacy_sales
WHERE tenant_id = @tenant_id AND sale_type = 'dispense' AND created_at >= @since
GROUP BY created_at::date
ORDER BY day;

-- ---- KPIs ------------------------------------------------------------------

-- name: DispenseQueueKpis :one
SELECT
  (SELECT count(*)::int FROM prescriptions p
     JOIN encounters e ON e.id = p.encounter_id AND e.tenant_id = p.tenant_id
     WHERE p.tenant_id = @tenant_id AND p.deleted_at IS NULL AND p.status <> 'cancelled'
       AND e.status = 'closed' AND p.dispensed_at IS NULL) AS to_dispense,
  (SELECT count(*)::int FROM prescriptions px
     WHERE px.tenant_id = @tenant_id AND px.dispensed_at >= @today) AS dispensed_today,
  (SELECT count(*)::int FROM drugs d
     WHERE d.tenant_id = @tenant_id AND d.deleted_at IS NULL
       AND COALESCE((SELECT SUM(b.qty_on_hand) FROM drug_batches b WHERE b.drug_id = d.id AND b.deleted_at IS NULL), 0) <= d.reorder_level) AS low_stock,
  (SELECT count(*)::int FROM drug_batches b
     WHERE b.tenant_id = @tenant_id AND b.deleted_at IS NULL AND b.qty_on_hand > 0
       AND b.expiry_date IS NOT NULL AND b.expiry_date <= @near_expiry_before) AS near_expiry;
