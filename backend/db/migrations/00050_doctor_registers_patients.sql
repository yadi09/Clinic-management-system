-- +goose Up
-- +goose StatementBegin
-- Who is allowed to register a patient, per clinic.
--
-- The canonical role set gives patient.create to the front desk only — reception,
-- branch manager, clinic admin, owner — because that matches a clinic with a front
-- desk: someone registers the patient and takes the card payment, then triage, then
-- the doctor. A doctor can find and read any patient but cannot create one.
--
-- That is right for a twenty-person clinic and wrong for a one-dentist practice,
-- where the dentist IS the front desk. Live proof: cure-special-dental has a single
-- doctor and no receptionist, so a walk-in cannot be registered at all unless the
-- owner happens to be logged in.
--
-- So it becomes a per-clinic decision rather than a product-wide one. This is a
-- COLUMN and not a bare role_permissions grant on purpose: provisioning reconciles
-- each role to exactly RoleGrants (DELETE ... NOT IN), so a grant alone would be
-- silently revoked the next time BootstrapTenant ran over the tenant. The column is
-- the durable answer; the grant is derived from it.
ALTER TABLE tenants
  ADD COLUMN doctor_registers_patients BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.doctor_registers_patients IS
  'Grants patient.create to the doctor role for this clinic. Read by provision.BootstrapTenant when reconciling role grants — do not grant the permission directly.';
-- +goose StatementEnd

-- +goose StatementBegin
-- Backfill: on where the clinic has nobody else who can do it.
--
-- A clinic with an active receptionist, branch manager or clinic admin keeps the
-- separation it already relies on. A clinic whose only other route is the owner's
-- own login gets it turned on, because there the rule is not separation of duties,
-- it is a locked door.
UPDATE tenants t SET doctor_registers_patients = true
WHERE t.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM user_role_scopes urs
    JOIN roles r  ON r.id = urs.role_id AND r.tenant_id = t.id
    JOIN users u  ON u.id = urs.user_id AND u.tenant_id = t.id
    WHERE u.deleted_at IS NULL
      AND u.status = 'active'
      AND r.code IN ('receptionist', 'branch_manager', 'clinic_admin')
  );
-- +goose StatementEnd

-- +goose StatementBegin
-- Apply the column to the actual grants, so the change takes effect without waiting
-- for a re-provision. Idempotent in both directions.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT t.id, r.id, p.id
FROM tenants t
JOIN roles r       ON r.tenant_id = t.id AND r.code = 'doctor'
JOIN permissions p ON p.code = 'patient.create'
WHERE t.deleted_at IS NULL AND t.doctor_registers_patients
ON CONFLICT (role_id, permission_id) DO NOTHING;

DELETE FROM role_permissions rp
USING tenants t, roles r, permissions p
WHERE rp.tenant_id = t.id AND rp.role_id = r.id AND rp.permission_id = p.id
  AND r.tenant_id = t.id AND r.code = 'doctor'
  AND p.code = 'patient.create'
  AND NOT t.doctor_registers_patients;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id AND rp.permission_id = p.id
  AND r.code = 'doctor' AND p.code = 'patient.create';

ALTER TABLE tenants DROP COLUMN IF EXISTS doctor_registers_patients;
-- +goose StatementEnd
