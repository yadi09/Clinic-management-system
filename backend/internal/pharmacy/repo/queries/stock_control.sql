-- Phase 4b-2: stock counts (count → variance → adjust → approve).

-- name: CreateStockCount :one
INSERT INTO stock_counts (tenant_id, note, created_by)
VALUES (@tenant_id, @note, @created_by)
RETURNING id;

-- name: SnapshotStockCountItems :exec
-- Snapshot every active drug's current on-hand into the count (counted starts equal).
INSERT INTO stock_count_items (tenant_id, count_id, drug_id, on_hand, counted)
SELECT @tenant_id, @count_id, d.id,
  COALESCE((SELECT SUM(b.qty_on_hand) FROM drug_batches b WHERE b.drug_id = d.id AND b.deleted_at IS NULL), 0),
  COALESCE((SELECT SUM(b.qty_on_hand) FROM drug_batches b WHERE b.drug_id = d.id AND b.deleted_at IS NULL), 0)
FROM drugs d
WHERE d.tenant_id = @tenant_id AND d.deleted_at IS NULL AND d.is_active;

-- name: ListStockCounts :many
SELECT id, status, created_at, approved_at FROM stock_counts
WHERE tenant_id = @tenant_id ORDER BY created_at DESC LIMIT 50;

-- name: GetStockCount :one
SELECT id, status, created_at, approved_at FROM stock_counts
WHERE tenant_id = @tenant_id AND id = @id;

-- name: ListStockCountItems :many
SELECT ci.id, ci.drug_id, ci.on_hand, ci.counted, ci.adjusted, d.name AS drug_name
FROM stock_count_items ci
JOIN drugs d ON d.id = ci.drug_id AND d.tenant_id = ci.tenant_id
WHERE ci.tenant_id = @tenant_id AND ci.count_id = @count_id
ORDER BY d.name;

-- name: GetStockCountItem :one
SELECT id, count_id, drug_id, on_hand, counted, adjusted
FROM stock_count_items WHERE tenant_id = @tenant_id AND id = @id;

-- name: SetStockCountItemCounted :exec
UPDATE stock_count_items SET counted = @counted WHERE tenant_id = @tenant_id AND id = @id;

-- name: MarkStockCountItemAdjusted :exec
UPDATE stock_count_items SET adjusted = true, on_hand = @on_hand WHERE tenant_id = @tenant_id AND id = @id;

-- name: ApproveStockCount :exec
UPDATE stock_counts SET status = 'approved', approved_at = now(), approved_by = @approved_by
WHERE tenant_id = @tenant_id AND id = @id AND status = 'open';
