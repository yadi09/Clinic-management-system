-- Phase 4b-2: pharmacy reports (read-only aggregations; CSV export deferred).

-- name: ReportConsumption :many
SELECT d.name AS drug_name, COALESCE(SUM(-m.delta), 0)::int AS qty
FROM stock_movements m
JOIN drugs d ON d.id = m.drug_id AND d.tenant_id = m.tenant_id
WHERE m.tenant_id = @tenant_id AND m.reason IN ('dispense','otc_sale')
GROUP BY d.name
ORDER BY qty DESC LIMIT 20;

-- name: ReportStockValuation :many
SELECT d.name AS drug_name,
  COALESCE((SELECT SUM(b.qty_on_hand) FROM drug_batches b WHERE b.drug_id = d.id AND b.deleted_at IS NULL), 0)::int AS on_hand,
  d.unit_price,
  (COALESCE((SELECT SUM(b.qty_on_hand) FROM drug_batches b WHERE b.drug_id = d.id AND b.deleted_at IS NULL), 0) * d.unit_price)::numeric AS value
FROM drugs d
WHERE d.tenant_id = @tenant_id AND d.deleted_at IS NULL
ORDER BY value DESC;

-- name: ReportControlledRegister :many
SELECT m.created_at, d.name AS drug_name, m.delta, m.reason
FROM stock_movements m
JOIN drugs d ON d.id = m.drug_id AND d.tenant_id = m.tenant_id
WHERE m.tenant_id = @tenant_id AND d.is_controlled
ORDER BY m.created_at DESC LIMIT 100;

-- name: ReportWastage :many
SELECT d.name AS drug_name, b.batch_no, b.expiry_date, b.qty_on_hand,
  (b.qty_on_hand * d.unit_price)::numeric AS value
FROM drug_batches b
JOIN drugs d ON d.id = b.drug_id AND d.tenant_id = b.tenant_id
WHERE b.tenant_id = @tenant_id AND b.deleted_at IS NULL AND b.qty_on_hand > 0
  AND ((b.expiry_date IS NOT NULL AND b.expiry_date < @today) OR b.quarantined)
ORDER BY value DESC;

-- name: ReportMargins :many
SELECT d.name AS drug_name, d.unit_price AS sell,
  COALESCE((SELECT AVG(pi.unit_cost) FROM po_items pi WHERE pi.drug_id = d.id AND pi.tenant_id = d.tenant_id), 0)::numeric AS avg_cost
FROM drugs d
WHERE d.tenant_id = @tenant_id AND d.deleted_at IS NULL
ORDER BY d.name;

-- name: ReportSupplierPerformance :many
SELECT s.name AS supplier, s.lead_time_days,
  count(po.id)::int AS pos,
  count(po.id) FILTER (WHERE po.status = 'received')::int AS received
FROM suppliers s
LEFT JOIN purchase_orders po ON po.supplier_id = s.id AND po.tenant_id = s.tenant_id AND po.deleted_at IS NULL
WHERE s.tenant_id = @tenant_id AND s.deleted_at IS NULL
GROUP BY s.name, s.lead_time_days
ORDER BY s.name;
