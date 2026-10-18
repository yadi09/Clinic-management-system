package service

// Branches as separate workspaces.
//
// A branch is a workspace of its own — a tenant — so its patients, notes, money,
// stock and staff sit behind the same database wall that separates two clinics.
// Workspaces of one clinic share an organization, which carries nothing but which
// workspaces belong together and which people (the owner, branch admins) may move
// between them.
//
// A new branch starts with a copy of the clinic's SETTINGS — its price list,
// procedures, tooth conditions, payment methods, printing, portal and so on — so it
// opens ready to work. It starts with no patients, no notes, no bills and no stock:
// none of that is ever copied. After that day the two are independent.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/platform"
	"github.com/reicb/clinicsaas/internal/platform/provision"
)

// settingsTables is what a new branch inherits, parents before children. Every one
// is configuration. Patient, clinical, money, stock, message and audit tables are
// deliberately absent: a branch must never start with another branch's data.
var settingsTables = []struct{ name, where string }{
	{"allergen_catalog", ""},
	{"diagnosis_categories", ""},
	{"diagnosis_catalog", ""},
	{"service_items", ""},
	{"dental_procedures", ""},
	{"dental_tooth_statuses", ""},
	{"dental_settings", ""},
	{"drug_catalog", ""},
	{"lab_tests", ""},
	{"lab_analytes", ""},
	{"payment_rails", ""},
	{"print_settings", ""},
	{"portal_settings", ""},
	{"registration_fee_policies", ""},
	{"vital_field_defs", ""},
	{"message_templates", ""},
	{"message_rules", ""},
	{"dhis2_diseases", ""},
	{"dhis2_disease_map", ""},
	{"dhis2_config", ""},
	// Module switches: the clinic-wide defaults only. Per-branch overrides belonged
	// to the old in-workspace branches and mean nothing in a new workspace.
	{"feature_flags", "branch_id IS NULL"},
	{"tenant_entitlements", ""},
}

// The clinic-level choices on the tenant row itself that a branch shares.
const tenantSettingsCols = `clinic_type, timezone, locale, currency, doctor_registers_patients,
	storage_gb_override, patient_limit_override, user_limit_override, sms_monthly_override`

type colInfo struct {
	name     string
	dataType string
	nullable bool
}

// copySettings copies every settings table from src to dst, inside tx (the vendor's
// privileged connection). It is driven by the database's own description of each
// table — its columns and its foreign keys — so a settings column added next year
// is copied without anyone remembering to add it here:
//
//   - a row's own uuid id gets a fresh id, remembered so children can follow it;
//   - a reference to another copied table follows to the copy;
//   - a reference to the branch, clinic or department becomes the new workspace's;
//   - a reference to a shared catalogue (features, plans) stays as it is;
//   - a reference to anything else (who created it, a patient…) is left empty —
//     and a table that would need one filled is refused rather than half-copied.
func copySettings(ctx context.Context, tx pgx.Tx, src, dst, branch, clinic, dept uuid.UUID) ([]string, error) {
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE IF NOT EXISTS branch_copy_map (tbl text, old uuid, new uuid, PRIMARY KEY (tbl, old)) ON COMMIT DROP`); err != nil {
		return nil, err
	}
	present := map[string]bool{}
	for _, t := range settingsTables {
		var ok bool
		if err := tx.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, t.name).Scan(&ok); err != nil {
			return nil, err
		}
		present[t.name] = ok
	}
	// What the new workspace was seeded with (standard allergens, default methods,
	// module defaults) is replaced by the clinic's own, children first.
	for i := len(settingsTables) - 1; i >= 0; i-- {
		t := settingsTables[i]
		if !present[t.name] {
			continue
		}
		q := fmt.Sprintf(`DELETE FROM %q WHERE tenant_id = $1`, t.name)
		if t.where != "" {
			q += " AND " + t.where
		}
		if _, err := tx.Exec(ctx, q, dst); err != nil {
			return nil, fmt.Errorf("clear %s: %w", t.name, err)
		}
	}

	// Which tables belong to one clinic (they carry tenant_id) and which are shared.
	perClinic := map[string]bool{}
	prow, err := tx.Query(ctx, `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'`)
	if err != nil {
		return nil, err
	}
	for prow.Next() {
		var n string
		if err := prow.Scan(&n); err != nil {
			prow.Close()
			return nil, err
		}
		perClinic[n] = true
	}
	prow.Close()

	copied := []string{}
	for _, t := range settingsTables {
		if !present[t.name] {
			continue
		}
		cols, err := columnsOf(ctx, tx, t.name)
		if err != nil {
			return nil, err
		}
		fks, err := foreignKeysOf(ctx, tx, t.name)
		if err != nil {
			return nil, err
		}
		hasID := false
		for _, c := range cols {
			if c.name == "id" && c.dataType == "uuid" {
				hasID = true
			}
		}
		where := "s.tenant_id = $1"
		if t.where != "" {
			where += " AND s." + t.where
		}
		if hasID {
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`INSERT INTO branch_copy_map SELECT %s, s.id, gen_random_uuid() FROM %q s WHERE %s`,
				quoteLit(t.name), t.name, where), src); err != nil {
				return nil, fmt.Errorf("map %s: %w", t.name, err)
			}
		}
		var names, values []string
		for _, c := range cols {
			var v string
			ref := fks[c.name]
			switch {
			case c.name == "tenant_id":
				v = "$2"
			case c.name == "id" && hasID:
				v = "m.new"
			// The new workspace's own rows. Written into the statement: they are uuids
			// this server just made, not anything a caller sent.
			case ref == "branches":
				v = quoteLit(branch.String()) + "::uuid"
			case ref == "clinics":
				v = quoteLit(clinic.String()) + "::uuid"
			case ref == "departments":
				v = quoteLit(dept.String()) + "::uuid"
			// A shared catalogue every clinic points at (the feature list, plans,
			// permissions) is not a clinic's own row: the reference stays as it is.
			case ref != "" && !perClinic[ref]:
				v = fmt.Sprintf("s.%q", c.name)
			case ref != "" && present[ref]:
				v = fmt.Sprintf(`(SELECT x.new FROM branch_copy_map x WHERE x.tbl = %s AND x.old = s.%q)`, quoteLit(ref), c.name)
			case ref != "":
				if !c.nullable {
					return nil, fmt.Errorf("copy %s: column %s must point at a %s row, which a new branch cannot have", t.name, c.name, ref)
				}
				v = "NULL"
			default:
				v = fmt.Sprintf("s.%q", c.name)
			}
			names = append(names, fmt.Sprintf("%q", c.name))
			values = append(values, v)
		}
		join := ""
		if hasID {
			join = fmt.Sprintf(`JOIN branch_copy_map m ON m.tbl = %s AND m.old = s.id`, quoteLit(t.name))
		}
		q := fmt.Sprintf(`INSERT INTO %q (%s) SELECT %s FROM %q s %s WHERE %s`,
			t.name, strings.Join(names, ", "), strings.Join(values, ", "), t.name, join, where)
		ct, err := tx.Exec(ctx, q, src, dst)
		if err != nil {
			return nil, fmt.Errorf("copy %s: %w", t.name, err)
		}
		if ct.RowsAffected() > 0 {
			copied = append(copied, t.name)
		}
	}
	return copied, nil
}

func quoteLit(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// columnsOf lists a table's writable columns (generated and identity columns are
// the database's to fill).
func columnsOf(ctx context.Context, tx pgx.Tx, table string) ([]colInfo, error) {
	rows, err := tx.Query(ctx, `
		SELECT column_name, data_type, is_nullable = 'YES'
		  FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = $1
		   AND is_generated = 'NEVER' AND is_identity = 'NO'
		   AND NOT (column_default LIKE 'nextval(%' AND column_name = 'id')
		 ORDER BY ordinal_position`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []colInfo
	for rows.Next() {
		var c colInfo
		if err := rows.Scan(&c.name, &c.dataType, &c.nullable); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// foreignKeysOf maps each single-column foreign key of a table to the table it points at.
func foreignKeysOf(ctx context.Context, tx pgx.Tx, table string) (map[string]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT a.attname, ref.relname
		  FROM pg_constraint co
		  JOIN pg_class tbl ON tbl.oid = co.conrelid
		  JOIN pg_class ref ON ref.oid = co.confrelid
		  JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = co.conkey[1]
		 WHERE co.contype = 'f' AND array_length(co.conkey, 1) = 1
		   AND tbl.relname = $1 AND tbl.relnamespace = 'public'::regnamespace`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var col, ref string
		if err := rows.Scan(&col, &ref); err != nil {
			return nil, err
		}
		out[col] = ref
	}
	return out, rows.Err()
}

// ListBranches lists every workspace in the clinic's organization. A clinic that has
// never had a second branch is listed alone, as its own main workspace.
func (s *Service) ListBranches(ctx context.Context, tenantID uuid.UUID) ([]platform.Branch, error) {
	// The main workspace is the clinic's first; the others were added as branches.
	rows, err := s.db.Pool.Query(ctx, `
		SELECT t.id, t.name, t.slug, t.status, t.created_at
		  FROM tenants t
		 WHERE t.deleted_at IS NULL
		   AND (t.id = $1 OR (t.organization_id IS NOT NULL
		        AND t.organization_id = (SELECT organization_id FROM tenants WHERE id = $1)))
		 ORDER BY t.created_at`, tenantID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []platform.Branch{}
	for rows.Next() {
		var b platform.Branch
		if err := rows.Scan(&b.TenantID, &b.Name, &b.Slug, &b.Status, &b.CreatedAt); err != nil {
			return nil, apperr.Internal(err)
		}
		b.ID = id.Encode(id.PrefixTenant, b.TenantID)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Internal(err)
	}
	if len(out) == 0 {
		return nil, apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
	}
	out[0].Main = true
	return out, nil
}

// CreateBranch adds a branch workspace to the clinic that owns tenantID.
func (s *Service) CreateBranch(ctx context.Context, tenantID uuid.UUID, in platform.BranchInput) (*platform.BranchResult, error) {
	name := strings.TrimSpace(in.Name)
	slug := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(in.Slug)), "-"), "-")
	if name == "" || slug == "" {
		return nil, apperr.Validation("the branch needs a name and its own workspace name")
	}
	out := &platform.BranchResult{Admins: []string{}}
	err := s.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		// The clinic, locked so two branches added at once cannot both squeeze under the cap.
		var mainName, status, planCode, clinicType string
		var org *uuid.UUID
		e := tx.QueryRow(ctx, `
			SELECT t.name, t.status, p.code, t.clinic_type, t.organization_id
			  FROM tenants t JOIN plans p ON p.id = t.plan_id
			 WHERE t.id = $1 AND t.deleted_at IS NULL FOR UPDATE OF t`, tenantID).
			Scan(&mainName, &status, &planCode, &clinicType, &org)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
		}
		if e != nil {
			return e
		}
		if status != "active" && status != "onboarding" {
			return apperr.Conflict("CLINIC_INACTIVE", "this clinic is not active")
		}
		if org == nil {
			var oid uuid.UUID
			if e := tx.QueryRow(ctx, `INSERT INTO organizations (name) VALUES ($1) RETURNING id`, mainName).Scan(&oid); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `UPDATE tenants SET organization_id = $2 WHERE id = $1`, tenantID, oid); e != nil {
				return e
			}
			org = &oid
		}
		// The plan's branch count is the number of workspaces in the clinic.
		lim, e := limits.BranchLimit(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		var have int64
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM tenants WHERE organization_id = $1 AND deleted_at IS NULL`, *org).Scan(&have); e != nil {
			return e
		}
		if lim != nil && have >= *lim {
			return apperr.Conflict("BRANCH_LIMIT", fmt.Sprintf("this clinic's plan allows %d branch(es) — change the plan or its branch limit first", *lim))
		}
		var taken bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tenants WHERE slug = $1)`, slug).Scan(&taken); e != nil {
			return e
		}
		if taken {
			return apperr.Conflict("SLUG_TAKEN", "that workspace name is taken — choose another")
		}

		// The people who move between branches. On the first new branch, that is the
		// clinic's owners; they are linked to the main workspace now.
		if _, e := tx.Exec(ctx, `
			INSERT INTO org_links (person_id, organization_id, tenant_id, user_id)
			SELECT gen_random_uuid(), $2, $1, u.id
			  FROM users u
			  JOIN user_role_scopes urs ON urs.user_id = u.id AND urs.tenant_id = u.tenant_id
			  JOIN roles r ON r.id = urs.role_id AND r.tenant_id = u.tenant_id AND r.code = 'tenant_owner'
			 WHERE u.tenant_id = $1 AND u.deleted_at IS NULL AND u.status = 'active'
			   AND NOT EXISTS (SELECT 1 FROM org_links l WHERE l.tenant_id = $1 AND l.user_id = u.id)
			ON CONFLICT DO NOTHING`, tenantID, *org); e != nil {
			return e
		}
		type person struct {
			id                     uuid.UUID
			email, name            string
			phone, hash, mfaSecret *string
			mfa                    bool
		}
		var people []person
		rows, e := tx.Query(ctx, `
			SELECT DISTINCT ON (l.person_id) l.person_id, u.email, u.full_name, u.phone, u.password_hash, u.mfa_enabled, u.mfa_secret
			  FROM org_links l JOIN users u ON u.id = l.user_id AND u.tenant_id = l.tenant_id
			 WHERE l.organization_id = $1 AND u.deleted_at IS NULL
			 ORDER BY l.person_id, (l.tenant_id = $2) DESC, l.created_at`, *org, tenantID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var p person
			if e := rows.Scan(&p.id, &p.email, &p.name, &p.phone, &p.hash, &p.mfa, &p.mfaSecret); e != nil {
				rows.Close()
				return e
			}
			people = append(people, p)
		}
		rows.Close()
		if len(people) == 0 || people[0].hash == nil {
			return apperr.Conflict("OWNER_NOT_FOUND", "this clinic has no active owner to run the new branch")
		}

		first := people[0]
		res, e := provision.BootstrapTenant(ctx, tx, provision.Params{
			Name: name, Slug: slug, OwnerEmail: first.email, OwnerName: first.name, OwnerPhone: deref(first.phone),
			OwnerPasswordHash: *first.hash, OwnerStatus: "active", ClinicType: clinicType, PlanCode: planCode,
		})
		if e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `UPDATE tenants t SET organization_id = $3, (`+tenantSettingsCols+`) =
			(SELECT `+tenantSettingsCols+` FROM tenants m WHERE m.id = $2) WHERE t.id = $1`, res.TenantID, tenantID, *org); e != nil {
			return e
		}
		var ownerRole uuid.UUID
		if e := tx.QueryRow(ctx, `SELECT id FROM roles WHERE tenant_id = $1 AND code = 'tenant_owner'`, res.TenantID).Scan(&ownerRole); e != nil {
			return e
		}
		for i, p := range people {
			uid := res.OwnerUserID
			if i > 0 {
				if e := tx.QueryRow(ctx, `
					INSERT INTO users (tenant_id, email, password_hash, full_name, status, phone)
					VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`, res.TenantID, p.email, p.hash, p.name, p.phone).Scan(&uid); e != nil {
					return e
				}
				if _, e := tx.Exec(ctx, `INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, res.TenantID, uid, ownerRole); e != nil {
					return e
				}
			}
			// The same person signs in the same way everywhere, second step included.
			if _, e := tx.Exec(ctx, `UPDATE users SET mfa_enabled = $3, mfa_secret = $4 WHERE tenant_id = $1 AND id = $2`,
				res.TenantID, uid, p.mfa, p.mfaSecret); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `INSERT INTO org_links (person_id, organization_id, tenant_id, user_id) VALUES ($1,$2,$3,$4)`,
				p.id, *org, res.TenantID, uid); e != nil {
				return e
			}
			out.Admins = append(out.Admins, p.email)
		}

		copied, e := copySettings(ctx, tx, tenantID, res.TenantID, res.BranchID, res.ClinicID, res.DeptID)
		if e != nil {
			return e
		}
		out.Copied = copied
		out.Branch = platform.Branch{TenantID: res.TenantID, ID: id.Encode(id.PrefixTenant, res.TenantID), Name: name, Slug: slug, Status: "active", CreatedAt: time.Now()}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
