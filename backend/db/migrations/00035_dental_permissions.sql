-- +goose Up
-- +goose StatementBegin
-- Dental permission. Add to the global catalogue, then backfill grants for
-- EXISTING tenants (new tenants get it via provision.go). owner/admin/branch_manager
-- and the doctor get dental.manage (odontogram + treatment plan + visits + raise a
-- dental bill). Money collection still uses payment.charge / payment.collect.
INSERT INTO permissions (code, description) VALUES
  ('dental.manage', 'Manage the tooth chart, treatment plan, dental visits and dental bills')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'dental.manage'
WHERE r.code IN ('tenant_owner', 'clinic_admin', 'branch_manager', 'doctor')
ON CONFLICT (role_id, permission_id) DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'dental.manage');
DELETE FROM permissions WHERE code = 'dental.manage';
-- +goose StatementEnd
