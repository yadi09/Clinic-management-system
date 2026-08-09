-- +goose Up
-- +goose StatementBegin
-- Bed-management permissions. Add to the global catalogue, then backfill grants for
-- EXISTING tenants (new tenants get them via provision.go). owner/admin/branch_manager
-- get both; receptionist + nurse get bed.assign.
INSERT INTO permissions (code, description) VALUES
  ('bed.manage', 'Configure wards/beds and view bed reports'),
  ('bed.assign', 'Admit, discharge and transfer patients between beds')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('bed.manage', 'bed.assign')
WHERE r.code IN ('tenant_owner', 'clinic_admin', 'branch_manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'bed.assign'
WHERE r.code IN ('receptionist', 'nurse', 'doctor')
ON CONFLICT (role_id, permission_id) DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('bed.manage', 'bed.assign'));
DELETE FROM permissions WHERE code IN ('bed.manage', 'bed.assign');
-- +goose StatementEnd
