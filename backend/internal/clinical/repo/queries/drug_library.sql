-- Drug & allergen libraries (RX-LIB).

-- ===== allergen catalog =====

-- name: ListAllergens :many
SELECT id, name, is_active FROM allergen_catalog
WHERE tenant_id = @tenant_id AND deleted_at IS NULL
  AND (sqlc.narg(include_inactive)::bool IS TRUE OR is_active)
  AND (sqlc.narg(search)::text IS NULL OR name ILIKE '%' || sqlc.narg(search)::text || '%')
ORDER BY name;

-- name: CreateAllergen :one
INSERT INTO allergen_catalog (tenant_id, name, created_by)
VALUES (@tenant_id, @name, @created_by)
RETURNING id, name, is_active;

-- name: UpdateAllergen :exec
UPDATE allergen_catalog SET name = @name, is_active = @is_active, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: DeleteAllergen :exec
UPDATE allergen_catalog SET deleted_at = now(), is_active = false
WHERE tenant_id = @tenant_id AND id = @id;

-- ===== drug catalog =====

-- name: SearchDrugs :many
SELECT d.id, d.name, d.default_dose, d.default_frequency, d.default_duration, d.default_instructions, d.is_active,
       COALESCE(array_agg(a.name ORDER BY a.name) FILTER (WHERE a.name IS NOT NULL), '{}')::text[] AS allergens
FROM drug_catalog d
LEFT JOIN drug_allergens da ON da.drug_id = d.id AND da.tenant_id = d.tenant_id
LEFT JOIN allergen_catalog a ON a.id = da.allergen_id AND a.tenant_id = d.tenant_id AND a.deleted_at IS NULL
WHERE d.tenant_id = @tenant_id AND d.deleted_at IS NULL
  AND (sqlc.narg(include_inactive)::bool IS TRUE OR d.is_active)
  AND (sqlc.narg(search)::text IS NULL OR d.name ILIKE '%' || sqlc.narg(search)::text || '%')
GROUP BY d.id
ORDER BY d.name
LIMIT 50;

-- name: GetDrugAllergenNames :many
SELECT a.name FROM drug_allergens da
JOIN allergen_catalog a ON a.id = da.allergen_id AND a.tenant_id = da.tenant_id AND a.deleted_at IS NULL
WHERE da.tenant_id = @tenant_id AND da.drug_id = @drug_id;

-- name: CreateDrug :one
INSERT INTO drug_catalog (tenant_id, name, default_dose, default_frequency, default_duration, default_instructions, created_by)
VALUES (@tenant_id, @name, @default_dose, @default_frequency, @default_duration, @default_instructions, @created_by)
RETURNING id;

-- name: UpdateDrug :exec
UPDATE drug_catalog SET name = @name, default_dose = @default_dose, default_frequency = @default_frequency,
  default_duration = @default_duration, default_instructions = @default_instructions, is_active = @is_active, updated_at = now()
WHERE tenant_id = @tenant_id AND id = @id AND deleted_at IS NULL;

-- name: DeleteDrug :exec
UPDATE drug_catalog SET deleted_at = now(), is_active = false
WHERE tenant_id = @tenant_id AND id = @id;

-- name: ClearDrugAllergens :exec
DELETE FROM drug_allergens WHERE tenant_id = @tenant_id AND drug_id = @drug_id;

-- name: AddDrugAllergen :exec
INSERT INTO drug_allergens (tenant_id, drug_id, allergen_id)
VALUES (@tenant_id, @drug_id, @allergen_id)
ON CONFLICT DO NOTHING;
