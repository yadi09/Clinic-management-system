-- Phase 4b-2: suppliers + purchase orders (receiving creates batches + movements).

-- name: ListSuppliers :many
SELECT id, name, contact, lead_time_days, is_active
FROM suppliers
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY name;

-- name: CreateSupplier :one
INSERT INTO suppliers (tenant_id, name, contact, lead_time_days, created_by)
VALUES (@tenant_id, @name, @contact, @lead_time_days, @created_by)
RETURNING id, name, contact, lead_time_days, is_active;

-- name: CreatePO :one
INSERT INTO purchase_orders (tenant_id, supplier_id, expected_date, total, notes, created_by)
VALUES (@tenant_id, @supplier_id, @expected_date, @total, @notes, @created_by)
RETURNING id, po_no, status;

-- name: CreatePOItem :exec
INSERT INTO po_items (tenant_id, po_id, drug_id, qty, unit_cost, line_total)
VALUES (@tenant_id, @po_id, @drug_id, @qty, @unit_cost, @line_total);

-- name: ListPOs :many
SELECT po.id, po.po_no, po.status, po.expected_date, po.total, po.received_at,
       s.name AS supplier,
       (SELECT count(*) FROM po_items pi WHERE pi.po_id = po.id)::int AS item_count
FROM purchase_orders po
JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
WHERE po.tenant_id = @tenant_id AND po.deleted_at IS NULL
ORDER BY po.po_no DESC LIMIT 100;

-- name: GetPO :one
SELECT po.id, po.po_no, po.status, po.expected_date, po.total, po.supplier_id, s.name AS supplier
FROM purchase_orders po
JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
WHERE po.tenant_id = @tenant_id AND po.id = @id AND po.deleted_at IS NULL;

-- name: ListPOItems :many
SELECT pi.id, pi.drug_id, pi.qty, pi.unit_cost, pi.line_total, pi.received, d.name AS drug_name
FROM po_items pi
JOIN drugs d ON d.id = pi.drug_id AND d.tenant_id = pi.tenant_id
WHERE pi.tenant_id = @tenant_id AND pi.po_id = @po_id
ORDER BY d.name;

-- name: SetPOStatus :one
UPDATE purchase_orders SET status = @status, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL
RETURNING id, status;

-- name: SetPOReceived :one
-- Atomic claim: returns a row only if the PO wasn't already received, so it
-- gates against a concurrent double-receive (double stock).
UPDATE purchase_orders SET status = 'received', received_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL AND status NOT IN ('received','cancelled')
RETURNING id;

-- name: CountOpenPOs :one
SELECT count(*)::int FROM purchase_orders
WHERE tenant_id = @tenant_id AND deleted_at IS NULL AND status IN ('draft','ordered');
