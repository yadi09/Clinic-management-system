-- +goose Up
-- +goose StatementBegin
-- Hand the messaging permissions to the roles that already exist.
--
-- 00055 created the two permission rows, which is enough for a clinic provisioned
-- after it ran: new tenants get their grants from provision.RoleGrants. Every
-- clinic already running would have seen the menu item and then a bare 403, because
-- roles are per tenant here and nothing had attached the permission to theirs.
--
-- Split from 00055 rather than folded into it because 00055 had already been
-- applied. Editing an applied migration means an environment that replays from a
-- later backup silently skips the fix, which is a worse bug than the one it fixes.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'message.manage'
WHERE r.code IN ('tenant_owner', 'clinic_admin', 'branch_manager')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Reception can write to patients and read the log — it is the desk that gets asked
-- "did you tell me?" — but not change what the clinic spends or how it speaks,
-- which stays with whoever runs the place.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'message.send'
WHERE r.code IN ('tenant_owner', 'clinic_admin', 'branch_manager', 'receptionist')
ON CONFLICT (role_id, permission_id) DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions WHERE permission_id IN
  (SELECT id FROM permissions WHERE code IN ('message.manage', 'message.send'));
-- +goose StatementEnd
