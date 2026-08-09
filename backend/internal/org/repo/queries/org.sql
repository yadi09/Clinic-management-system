-- ---- Clinic --------------------------------------------------------------

-- name: GetClinic :one
SELECT id, name, timezone, locale, logo_storage_key
FROM clinics
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY created_at
LIMIT 1;

-- name: CreateClinic :one
INSERT INTO clinics (tenant_id, name, timezone, locale, created_by)
VALUES (@tenant_id, @name, @timezone, @locale, @created_by)
RETURNING id;

-- name: UpdateClinic :exec
UPDATE clinics SET name = @name, timezone = @timezone, locale = @locale, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: GetClinicSettings :one
SELECT id, card_fee_enabled, card_fee_amount, card_currency, free_window_days, triage_required, doctor_assignment
FROM clinics
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY created_at
LIMIT 1;

-- name: UpdateClinicSettings :exec
UPDATE clinics SET
  card_fee_enabled = @card_fee_enabled,
  card_fee_amount = @card_fee_amount,
  card_currency = @card_currency,
  free_window_days = @free_window_days,
  triage_required = @triage_required,
  doctor_assignment = @doctor_assignment,
  updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- ---- Branches ------------------------------------------------------------

-- name: ListBranches :many
SELECT id, clinic_id, name, code, address, phone, is_active, created_at
FROM branches
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY name;

-- name: GetBranch :one
SELECT id, clinic_id, name, code, address, phone, opening_hours, is_active
FROM branches
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CreateBranch :one
INSERT INTO branches (tenant_id, clinic_id, name, code, address, phone, opening_hours, created_by)
VALUES (@tenant_id, @clinic_id, @name, @code, @address, @phone, @opening_hours::jsonb, @created_by)
RETURNING id;

-- name: UpdateBranch :exec
UPDATE branches SET name = @name, code = @code, address = @address, phone = @phone,
  opening_hours = @opening_hours::jsonb, is_active = @is_active, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SoftDeleteBranch :exec
UPDATE branches SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: CountBranches :one
SELECT count(*) FROM branches WHERE tenant_id = @tenant_id AND deleted_at IS NULL;

-- name: GetBranchLimit :one
-- The tenant's plan branch cap (NULL = unlimited). No subscription row ⇒ no rows.
SELECT p.branch_limit
FROM subscriptions s JOIN plans p ON p.id = s.plan_id
WHERE s.tenant_id = @tenant_id
ORDER BY s.created_at DESC
LIMIT 1;

-- name: GetTenantModuleDefaults :many
SELECT flag, enabled FROM feature_flags WHERE tenant_id = @tenant_id AND branch_id IS NULL;

-- name: GetBranchModuleOverrides :many
SELECT flag, enabled FROM feature_flags WHERE tenant_id = @tenant_id AND branch_id = @branch_id;

-- name: UpsertBranchModule :exec
INSERT INTO feature_flags (tenant_id, flag, enabled, source, branch_id)
VALUES (@tenant_id, @flag, @enabled, 'override', @branch_id)
ON CONFLICT (tenant_id, flag, branch_id) WHERE branch_id IS NOT NULL
DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();

-- name: DeleteBranchModule :exec
DELETE FROM feature_flags WHERE tenant_id = @tenant_id AND branch_id = @branch_id AND flag = @flag;

-- ---- Departments ---------------------------------------------------------

-- name: ListDepartments :many
SELECT id, branch_id, name, specialty, created_at
FROM departments
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY name;

-- name: CreateDepartment :one
INSERT INTO departments (tenant_id, branch_id, name, specialty, created_by)
VALUES (@tenant_id, @branch_id, @name, @specialty, @created_by)
RETURNING id;

-- name: UpdateDepartment :exec
UPDATE departments SET name = @name, specialty = @specialty, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: SoftDeleteDepartment :exec
UPDATE departments SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- ---- Resources -----------------------------------------------------------

-- name: ListResources :many
SELECT id, branch_id, department_id, name, type, created_at
FROM resources
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
ORDER BY name;

-- name: CreateResource :one
INSERT INTO resources (tenant_id, branch_id, department_id, name, type, created_by)
VALUES (@tenant_id, @branch_id, @department_id, @name, @type, @created_by)
RETURNING id;

-- name: SoftDeleteResource :exec
UPDATE resources SET deleted_at = now(), updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;
