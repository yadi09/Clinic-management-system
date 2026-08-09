-- +goose Up
-- +goose StatementBegin
-- Front-desk visibility into dental care. Reception and the cashier need to see a
-- patient's treatment plan, session dates and balance to answer "what do I owe?"
-- and "when do I come back?" — and to take payment for sessions — WITHOUT being
-- able to change the clinical record. dental.manage stays the write permission;
-- dental.read is view-only. New tenants get it from provision.go.
INSERT INTO permissions (code, description) VALUES
  ('dental.read', 'View the tooth chart, treatment plans, session dates and dental balance (front desk)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'dental.read'
WHERE r.code IN ('tenant_owner', 'clinic_admin', 'branch_manager', 'doctor', 'receptionist', 'cashier')
ON CONFLICT (role_id, permission_id) DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'dental.read');
DELETE FROM permissions WHERE code = 'dental.read';
-- +goose StatementEnd
