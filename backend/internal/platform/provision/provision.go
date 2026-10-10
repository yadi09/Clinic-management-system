// Package provision holds the canonical "bootstrap a tenant" logic so the seed
// and the platform (super-admin) provisioning create identical clinics. It runs
// raw SQL inside a caller-supplied transaction on a privileged (RLS-bypassing)
// connection — it writes across the global + tenant boundary in one go.
package provision

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/allergy"
)

// TenantRoles are the tenant-side system roles (Part 1 §3.7.1).
var TenantRoles = []struct{ Code, Name string }{
	{"tenant_owner", "Tenant Owner"},
	{"clinic_admin", "Clinic Administrator"},
	{"branch_manager", "Branch Manager"},
	{"receptionist", "Receptionist"},
	{"doctor", "Doctor"},
	{"nurse", "Nurse"},
	{"lab_technician", "Laboratory Technician"},
	{"lab_manager", "Laboratory Manager"},
	{"pharmacist", "Pharmacist"},
	{"pharmacy_manager", "Pharmacy Manager"},
	{"cashier", "Cashier"},
	{"accountant", "Accountant"},
	{"inventory_manager", "Inventory Manager"},
	{"hr_manager", "HR Manager"},
	{"patient_portal_user", "Patient Portal User"},
}

// BasePermissions is the baseline permission catalogue (owner/admin get all).
var BasePermissions = []struct{ Code, Desc string }{
	{"clinic.manage", "Configure clinic, branches, departments"},
	{"user.invite", "Invite staff users"},
	{"user.read", "View users"},
	{"user.update", "Update users"},
	{"role.assign", "Assign roles and scopes"},
	{"patient.create", "Register patients"},
	{"patient.read", "View patient records"},
	{"patient.update", "Update patient records"},
	{"patient.search", "Search patients"},
	{"appointment.manage", "Book/reschedule/cancel appointments"},
	{"queue.manage", "Manage department queues and routing"},
	{"triage.manage", "Record triage vitals"},
	{"payment.charge", "Raise a charge / register a payable visit (without collecting cash)"},
	{"payment.collect", "Collect payment and settle charges (cashier)"},
	{"payment.waive", "Waive a charge / fee with a documented reason"},
	{"billing.manage", "Manage the service catalog and view the finance dashboard"},
	{"encounter.manage", "Conduct consultations and EMR"},
	{"prescription.create", "Create prescriptions"},
	{"pharmacy.read", "View the drug catalog and stock"},
	{"pharmacy.dispense", "Dispense prescriptions"},
	{"pharmacy.stock", "Adjust pharmacy stock"},
	{"pharmacy.sell", "Make OTC counter sales"},
	{"pharmacy.manage", "Manage the drug catalog, purchasing and reports"},
	{"lab.order", "Order laboratory tests"},
	{"lab.process", "Accession samples and enter lab results"},
	{"lab.validate", "Validate and release lab results"},
	{"lab.manage", "Manage the lab test catalog"},
	{"settings.manage", "Manage tenant/branch settings"},
	{"audit.read", "View audit logs"},
	{"bed.manage", "Configure wards/beds and view bed reports"},
	{"bed.assign", "Admit, discharge and transfer patients between beds"},
	{"dental.manage", "Manage the tooth chart, treatment plan, dental visits and dental bills"},
	{"dental.read", "View the tooth chart, treatment plans, session dates and dental balance (front desk)"},
	{"message.manage", "Configure patient messaging: templates, timing and sending settings"},
	{"message.send", "Send messages to patients"},
}

// BusinessFlags are the default feature flags for a Business-tier tenant.
var BusinessFlags = map[string]bool{
	"laboratory":       true,
	"pharmacy":         true,
	"inventory":        true,
	"finance_advanced": true,
	"insurance":        false,
	"telemedicine":     false,
	"hr":               false,
	"maternity":        false,
	"inpatient":        false,
	"dental":           false,
}

// ClinicPresets map a clinic type to the flag overrides that specialization
// implies. Applied on top of BusinessFlags at provisioning, then overridden by
// any explicit caller choices. A dental clinic runs the dental workspace and
// turns off the general-medical satellites (lab/pharmacy/inventory) it doesn't use.
var ClinicPresets = map[string]map[string]bool{
	"dental": {
		"dental":     true,
		"laboratory": false,
		"pharmacy":   false,
		"inventory":  false,
		"maternity":  false,
		"inpatient":  false,
	},
}

// RoleGrants is the canonical permission set per operational role.
var RoleGrants = map[string][]string{
	"branch_manager":   {"patient.create", "patient.read", "patient.update", "patient.search", "appointment.manage", "queue.manage", "triage.manage", "payment.charge", "payment.collect", "payment.waive", "billing.manage", "user.read", "bed.manage", "bed.assign", "dental.read", "message.send", "message.manage"},
	"receptionist":     {"patient.create", "patient.read", "patient.update", "patient.search", "appointment.manage", "queue.manage", "payment.charge", "bed.assign", "dental.read", "message.send"},
	"doctor":           {"patient.read", "patient.search", "encounter.manage", "prescription.create", "queue.manage", "appointment.manage", "lab.order", "bed.assign", "dental.manage", "dental.read"},
	"nurse":            {"patient.read", "patient.search", "triage.manage", "queue.manage", "bed.assign"},
	"cashier":          {"payment.charge", "payment.collect", "payment.waive", "patient.read", "patient.search", "dental.read"},
	"pharmacist":       {"patient.read", "patient.search", "pharmacy.read", "pharmacy.dispense", "pharmacy.stock", "pharmacy.sell"},
	"pharmacy_manager": {"patient.read", "patient.search", "pharmacy.read", "pharmacy.dispense", "pharmacy.stock", "pharmacy.sell", "pharmacy.manage"},
	"lab_technician":   {"patient.read", "patient.search", "lab.process"},
	"lab_manager":      {"patient.read", "patient.search", "lab.process", "lab.validate", "lab.manage"},
}

// Params bootstraps one tenant + its owner.
type Params struct {
	Name              string // clinic display name
	Slug              string // workspace identifier (login)
	OwnerEmail        string
	OwnerName         string
	OwnerPhone        string          // local 09… form; blank leaves it unset
	OwnerPasswordHash string          // pre-hashed (Argon2id)
	OwnerStatus       string          // "active" (seed/provision) — invited owners may differ later
	ClinicType        string          // "general" (default) | "dental" — applies a flag preset
	PlanCode          string          // subscription plan code (default "business")
	Flags             map[string]bool // optional module-entitlement overrides (merged over BusinessFlags + preset)
}

// Result returns the created ids so callers can layer more on (demo staff, catalogs).
type Result struct {
	TenantID    uuid.UUID
	OwnerUserID uuid.UUID
	ClinicID    uuid.UUID
	BranchID    uuid.UUID
	DeptID      uuid.UUID
	PlanID      uuid.UUID
	RoleIDs     map[string]uuid.UUID
	// DoctorRegisters is the clinic's stored answer to "may a doctor register a
	// patient?". Read back from the row rather than assumed, so re-provisioning
	// reconciles grants against the decision already made about this clinic.
	DoctorRegisters bool
}

// BootstrapTenant creates the full structural baseline for a clinic: plan +
// permission catalogue (global, idempotent), tenant, subscription, billing
// account, feature flags, system roles + permission grants, the owner user +
// tenant-wide role, a clinic with a main branch + default department, and the
// default Registration/Consultation services (so the billing gate works). It is
// idempotent on (slug) so a re-seed is safe; callers that must reject an existing
// clinic should check the slug first.
func BootstrapTenant(ctx context.Context, tx pgx.Tx, p Params) (Result, error) {
	res := Result{RoleIDs: map[string]uuid.UUID{}}
	if p.OwnerStatus == "" {
		p.OwnerStatus = "active"
	}
	if p.ClinicType == "" {
		p.ClinicType = "general"
	}

	// Plan (global) + permission catalogue. Ensure the baseline 'business' plan
	// exists (idempotent seed), then resolve the requested plan by code (sample
	// plans are seeded by migration 00036); fall back to business when unknown.
	var businessID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO plans (code, name, branch_limit, user_limit, storage_gb, audit_retention_days, price_monthly)
		 VALUES ('business','Business',10,100,500,1095,0)
		 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`).Scan(&businessID); err != nil {
		return res, fmt.Errorf("plan: %w", err)
	}
	res.PlanID = businessID
	if code := p.PlanCode; code != "" && code != "business" {
		// Only accept a plan scoped to this clinic's type (or a universal 'all' plan);
		// otherwise keep the business fallback.
		var pid uuid.UUID
		if e := tx.QueryRow(ctx,
			`SELECT id FROM plans WHERE code = $1 AND clinic_type IN ('all', $2)`,
			code, p.ClinicType).Scan(&pid); e == nil {
			res.PlanID = pid
		}
	}
	for _, perm := range BasePermissions {
		if _, err := tx.Exec(ctx,
			`INSERT INTO permissions (code, description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`,
			perm.Code, perm.Desc); err != nil {
			return res, fmt.Errorf("permission %s: %w", perm.Code, err)
		}
	}

	// Tenant. A dental clinic starts able to register from the chair: it is usually
	// one or two dentists with no front desk to hand the job to. A general clinic
	// starts with the separation, and the platform admin can flip either.
	// Re-provisioning an existing clinic must not overwrite a decision already made
	// about it, hence COALESCE onto the stored value rather than EXCLUDED.
	if err := tx.QueryRow(ctx,
		`INSERT INTO tenants (name, slug, status, plan_id, clinic_type, onboarded_at, doctor_registers_patients)
		 VALUES ($1, $2, 'active', $3, $4, now(), $4 = 'dental')
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = 'active', clinic_type = EXCLUDED.clinic_type
		 RETURNING id, doctor_registers_patients`,
		p.Name, p.Slug, res.PlanID, p.ClinicType).Scan(&res.TenantID, &res.DoctorRegisters); err != nil {
		return res, fmt.Errorf("tenant: %w", err)
	}

	// Subscription + billing account.
	if _, err := tx.Exec(ctx,
		`INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1,$2,'active') ON CONFLICT DO NOTHING`,
		res.TenantID, res.PlanID); err != nil {
		return res, fmt.Errorf("subscription: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO billing_accounts (tenant_id, billing_email, currency) VALUES ($1,$2,'ETB')
		 ON CONFLICT (tenant_id) DO NOTHING`, res.TenantID, p.OwnerEmail); err != nil {
		return res, fmt.Errorf("billing account: %w", err)
	}

	// Feature flags (module entitlements): BusinessFlags defaults, then the clinic
	// type's preset, then any caller-supplied choices for known flags (each layer
	// wins over the previous). This is how a dental clinic gets the dental module on
	// and its unused general-medical satellites off out of the box.
	flags := map[string]bool{}
	for k, v := range BusinessFlags {
		flags[k] = v
	}
	for k, v := range ClinicPresets[p.ClinicType] {
		if _, known := BusinessFlags[k]; known {
			flags[k] = v
		}
	}
	for k, v := range p.Flags {
		if _, known := BusinessFlags[k]; known {
			flags[k] = v
		}
	}
	for flag, enabled := range flags {
		if _, err := tx.Exec(ctx,
			// Tenant-default flags carry no branch_id, so target the partial unique
			// index (tenant_id, flag) WHERE branch_id IS NULL (branch overrides use a
			// separate partial index — see migration 00026).
			`INSERT INTO feature_flags (tenant_id, flag, enabled, source) VALUES ($1,$2,$3,'plan')
			 ON CONFLICT (tenant_id, flag) WHERE branch_id IS NULL DO UPDATE SET enabled = EXCLUDED.enabled`,
			res.TenantID, flag, enabled); err != nil {
			return res, fmt.Errorf("flag %s: %w", flag, err)
		}
	}

	// Roles.
	var ownerRoleID uuid.UUID
	for _, r := range TenantRoles {
		var rid uuid.UUID
		if err := tx.QueryRow(ctx,
			`INSERT INTO roles (tenant_id, code, name, is_system) VALUES ($1,$2,$3,true)
			 ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
			res.TenantID, r.Code, r.Name).Scan(&rid); err != nil {
			return res, fmt.Errorf("role %s: %w", r.Code, err)
		}
		res.RoleIDs[r.Code] = rid
		if r.Code == "tenant_owner" {
			ownerRoleID = rid
		}
	}

	// tenant_owner + clinic_admin get every permission.
	for _, code := range []string{"tenant_owner", "clinic_admin"} {
		rid := res.RoleIDs[code]
		if _, err := tx.Exec(ctx,
			`INSERT INTO role_permissions (tenant_id, role_id, permission_id)
			 SELECT $1, $2, p.id FROM permissions p ON CONFLICT (role_id, permission_id) DO NOTHING`,
			res.TenantID, rid); err != nil {
			return res, fmt.Errorf("grant %s: %w", code, err)
		}
	}
	// Operational roles: reconcile to exactly the canonical set, plus whatever this
	// clinic has been allowed on top of it. The reconcile is a DELETE ... NOT IN, so
	// a per-clinic grant that is not folded in here is silently revoked.
	for code, perms := range RoleGrants {
		rid, ok := res.RoleIDs[code]
		if !ok {
			continue
		}
		if code == "doctor" && res.DoctorRegisters {
			perms = append(append([]string{}, perms...), "patient.create")
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2
			   AND permission_id NOT IN (SELECT id FROM permissions WHERE code = ANY($3::text[]))`,
			res.TenantID, rid, perms); err != nil {
			return res, fmt.Errorf("reconcile %s: %w", code, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO role_permissions (tenant_id, role_id, permission_id)
			 SELECT $1, $2, p.id FROM permissions p WHERE p.code = ANY($3::text[])
			 ON CONFLICT (role_id, permission_id) DO NOTHING`, res.TenantID, rid, perms); err != nil {
			return res, fmt.Errorf("grant %s: %w", code, err)
		}
	}

	// Owner user + tenant-wide role.
	if err := tx.QueryRow(ctx,
		`INSERT INTO users (tenant_id, email, password_hash, full_name, status, phone)
		 VALUES ($1,$2,$3,$4,$5,nullif($6,''))
		 ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = EXCLUDED.status,
		     phone = coalesce(EXCLUDED.phone, users.phone)
		 RETURNING id`, res.TenantID, p.OwnerEmail, p.OwnerPasswordHash, p.OwnerName, p.OwnerStatus, p.OwnerPhone).Scan(&res.OwnerUserID); err != nil {
		return res, fmt.Errorf("owner user: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
		 ON CONFLICT (user_id, role_id, branch_id, department_id) DO NOTHING`,
		res.TenantID, res.OwnerUserID, ownerRoleID); err != nil {
		return res, fmt.Errorf("owner role: %w", err)
	}

	// Clinic + main branch + default department.
	e := tx.QueryRow(ctx, `SELECT id FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL LIMIT 1`, res.TenantID).Scan(&res.ClinicID)
	if e == pgx.ErrNoRows {
		if e = tx.QueryRow(ctx, `INSERT INTO clinics (tenant_id, name) VALUES ($1, $2) RETURNING id`,
			res.TenantID, p.Name).Scan(&res.ClinicID); e != nil {
			return res, fmt.Errorf("clinic: %w", e)
		}
	} else if e != nil {
		return res, fmt.Errorf("clinic lookup: %w", e)
	}
	if err := tx.QueryRow(ctx,
		`INSERT INTO branches (tenant_id, clinic_id, name, code) VALUES ($1, $2, 'Main Branch', 'MAIN')
		 ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		res.TenantID, res.ClinicID).Scan(&res.BranchID); err != nil {
		return res, fmt.Errorf("branch: %w", err)
	}
	// Default department (idempotent on name within the branch).
	e = tx.QueryRow(ctx, `SELECT id FROM departments WHERE tenant_id = $1 AND branch_id = $2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, res.TenantID, res.BranchID).Scan(&res.DeptID)
	if e == pgx.ErrNoRows {
		if e = tx.QueryRow(ctx,
			`INSERT INTO departments (tenant_id, branch_id, name, specialty) VALUES ($1,$2,'General Practice','general') RETURNING id`,
			res.TenantID, res.BranchID).Scan(&res.DeptID); e != nil {
			return res, fmt.Errorf("department: %w", e)
		}
	} else if e != nil {
		return res, fmt.Errorf("department lookup: %w", e)
	}

	// The allergy picker starts with the standard names (idempotent; a clinic's own
	// entries are never overwritten).
	for _, name := range allergy.StandardAllergens {
		if _, e := tx.Exec(ctx,
			`INSERT INTO allergen_catalog (tenant_id, name) VALUES ($1, $2)
			 ON CONFLICT (tenant_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING`,
			res.TenantID, name); e != nil {
			return res, fmt.Errorf("standard allergens: %w", e)
		}
	}

	// Default intake services. A general clinic charges Registration + Consultation
	// on every visit (both default → auto-selected at reception). A dental clinic
	// bills through the treatment plan instead, so reception should NOT force a
	// per-visit charge: seed a single optional Registration/Visit fee (not default)
	// and no Consultation.
	type svc struct {
		Code, Name string
		Price      string
		IsDefault  bool
	}
	services := []svc{
		{"REG", "Registration fee", "50", true},
		{"CONSULT", "Consultation", "200", true},
	}
	if p.ClinicType == "dental" {
		services = []svc{{"REG", "Registration / visit fee", "100", false}}
	}
	for _, s := range services {
		if _, err := tx.Exec(ctx,
			`INSERT INTO service_items (tenant_id, code, name, category, price, is_default)
			 VALUES ($1,$2,$3,'general',$4,$5)
			 ON CONFLICT (tenant_id, lower(code)) WHERE deleted_at IS NULL DO NOTHING`,
			res.TenantID, s.Code, s.Name, s.Price, s.IsDefault); err != nil {
			return res, fmt.Errorf("default service %s: %w", s.Code, err)
		}
	}

	// The ways a patient can pay. Migration 00063 gave every clinic that existed then
	// these four, but provisioning never did, so the first clinic created afterwards
	// had none: the cashier's method picker was empty and every payment — Telebirr
	// included — was recorded as cash, which the day close then expected in the
	// drawer. The clinic renames them, or adds its named accounts, in Settings.
	for i, r := range []struct{ key, label, kind string }{
		{"cash", "Cash", "cash"}, {"card", "Card", "card"},
		{"mobile", "Mobile money", "wallet"}, {"transfer", "Bank transfer", "bank"},
	} {
		if _, err := tx.Exec(ctx,
			`INSERT INTO payment_rails (tenant_id, key, label, kind, needs_reference, sort_order)
			 VALUES ($1,$2,$3,$4,false,$5) ON CONFLICT (tenant_id, key) DO NOTHING`,
			res.TenantID, r.key, r.label, r.kind, i); err != nil {
			return res, fmt.Errorf("default payment method %s: %w", r.key, err)
		}
	}

	return res, nil
}
