-- +goose Up
-- +goose StatementBegin

-- Provisioning never created payment methods (migration 00063 seeded only the
-- clinics that existed then), so a clinic created since had an empty method picker
-- and every payment was recorded as cash. Give any clinic with no methods at all
-- the same four defaults every other clinic started with. A clinic that has set up
-- even one method is left exactly as it is.
INSERT INTO payment_rails (tenant_id, key, label, kind, needs_reference, sort_order)
SELECT t.id, v.key, v.label, v.kind, false, v.ord
  FROM tenants t
  CROSS JOIN (VALUES
    ('cash',     'Cash',          'cash',   0),
    ('card',     'Card',          'card',   1),
    ('mobile',   'Mobile money',  'wallet', 2),
    ('transfer', 'Bank transfer', 'bank',   3)
  ) AS v(key, label, kind, ord)
 WHERE NOT EXISTS (SELECT 1 FROM payment_rails r WHERE r.tenant_id = t.id)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- Methods may already be in use on charges; nothing is removed.
SELECT 1;
