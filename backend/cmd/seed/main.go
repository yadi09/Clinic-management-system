// Command seed bootstraps a development tenant: one workspace, its owner user
// (password + optional MFA), the tenant-side system roles, a baseline
// permission catalog, the owner's full permission grant, a Business-tier plan
// with module flags enabled, and a subscription. Idempotent (safe to re-run).
//
// Env:
//
//	DATABASE_URL          (required)
//	SEED_WORKSPACE        (default "demo")
//	SEED_OWNER_EMAIL      (default "owner@demo.clinic")
//	SEED_OWNER_PASSWORD   (default "ChangeMe123!")
//	SEED_OWNER_NAME       (default "Demo Owner")
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

// Tenant-side system roles (Part 1 §3.7.1; platform roles are vendor-side).
var tenantRoles = []struct{ Code, Name string }{
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

// demoStaff is one login per operational role, created when SEED_DEMO=1 so the
// platform can be exercised end-to-end as each real user (shared password via
// SEED_DEMO_PASSWORD). Names are illustrative (Ethiopian) for the demo tenant.
var demoStaff = []struct{ Email, Name, Role string }{
	{"admin@demo.clinic", "Selam Tadesse (Clinic Admin)", "clinic_admin"},
	{"reception@demo.clinic", "Hanna Girma (Reception)", "receptionist"},
	{"nurse@demo.clinic", "Kebede Worku (Nurse)", "nurse"},
	{"doctor@demo.clinic", "Dr. Meron Haile", "doctor"},
	{"labtech@demo.clinic", "Yonas Tesfaye (Lab Tech)", "lab_technician"},
	{"labmgr@demo.clinic", "Tigist Bekele (Lab Manager)", "lab_manager"},
	{"pharmacist@demo.clinic", "Dawit Solomon (Pharmacist)", "pharmacist"},
	{"pharmacymgr@demo.clinic", "Sara Mengistu (Pharmacy Manager)", "pharmacy_manager"},
	{"cashier@demo.clinic", "Bethel Assefa (Cashier)", "cashier"},
}

// Baseline permission catalog (grows per phase). Owner is granted all.
var basePermissions = []struct{ Code, Desc string }{
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
	{"payment.collect", "Collect the card / consultation fee"},
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
}

// Business-tier flag defaults.
var businessFlags = map[string]bool{
	"laboratory":       true,
	"pharmacy":         true,
	"inventory":        true,
	"finance_advanced": true,
	"insurance":        false,
	"telemedicine":     false,
	"hr":               false,
}

// seedDiagnosisCatalog inserts a small starter set of disease categories and
// diagnoses (admins extend it in Settings). Idempotent.
func seedDiagnosisCatalog(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	categories := []string{"Respiratory", "Infectious", "Gastrointestinal", "Cardiovascular", "General"}
	type dx struct{ Cat, Code, Name string }
	entries := []dx{
		{"Respiratory", "J02.9", "Acute pharyngitis"},
		{"Respiratory", "J06.9", "Upper respiratory infection"},
		{"Respiratory", "J45.909", "Asthma, unspecified"},
		{"Infectious", "A09", "Infectious gastroenteritis"},
		{"Infectious", "B34.9", "Viral infection, unspecified"},
		{"Gastrointestinal", "K21.9", "Gastro-oesophageal reflux disease"},
		{"Gastrointestinal", "K59.00", "Constipation, unspecified"},
		{"Cardiovascular", "I10", "Essential hypertension"},
		{"General", "R50.9", "Fever, unspecified"},
		{"General", "R51", "Headache"},
	}
	catID := map[string]uuid.UUID{}
	for i, name := range categories {
		var cid uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM diagnosis_categories WHERE tenant_id=$1 AND lower(name)=lower($2) AND deleted_at IS NULL`,
			tenantID, name).Scan(&cid)
		if errors.Is(err, pgx.ErrNoRows) {
			if err = tx.QueryRow(ctx,
				`INSERT INTO diagnosis_categories (tenant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
				tenantID, name, i+1).Scan(&cid); err != nil {
				return fmt.Errorf("diagnosis category %s: %w", name, err)
			}
		} else if err != nil {
			return fmt.Errorf("diagnosis category %s: %w", name, err)
		}
		catID[name] = cid
	}
	for _, e := range entries {
		if _, err := tx.Exec(ctx,
			`INSERT INTO diagnosis_catalog (tenant_id, category_id, code, name) VALUES ($1,$2,$3,$4)
			 ON CONFLICT DO NOTHING`,
			tenantID, catID[e.Cat], e.Code, e.Name); err != nil {
			return fmt.Errorf("diagnosis entry %s: %w", e.Code, err)
		}
	}
	return nil
}

// seedPharmacy inserts a starter drug catalog and stock batches (managers extend
// it). Idempotent.
func seedPharmacy(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	type drug struct {
		Name, Form, Class, Price string
		Controlled               bool
		Reorder                  int
	}
	drugs := []drug{
		{"Azithromycin 500mg", "Tablet", "Macrolide", "2.50", false, 50},
		{"Amoxicillin 500mg", "Capsule", "Penicillin", "0.80", false, 60},
		{"Cetirizine 10mg", "Tablet", "Antihistamine", "0.30", false, 100},
		{"Tramadol 50mg", "Capsule", "Opioid", "1.20", true, 20},
		{"Salbutamol inhaler", "Inhaler", "Bronchodilator", "6.40", false, 30},
		{"Metformin 500mg", "Tablet", "Biguanide", "0.20", false, 150},
	}
	drugID := map[string]uuid.UUID{}
	for _, d := range drugs {
		var did uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM drugs WHERE tenant_id=$1 AND lower(name)=lower($2) AND deleted_at IS NULL`,
			tenantID, d.Name).Scan(&did)
		if errors.Is(err, pgx.ErrNoRows) {
			if err = tx.QueryRow(ctx,
				`INSERT INTO drugs (tenant_id, name, form, drug_class, is_controlled, unit_price, reorder_level)
				 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
				tenantID, d.Name, d.Form, d.Class, d.Controlled, d.Price, d.Reorder).Scan(&did); err != nil {
				return fmt.Errorf("drug %s: %w", d.Name, err)
			}
		} else if err != nil {
			return fmt.Errorf("drug %s: %w", d.Name, err)
		}
		drugID[d.Name] = did
	}
	type batch struct {
		Drug, No, Expiry string
		Qty              int
	}
	batches := []batch{
		{"Amoxicillin 500mg", "AM-2025-11", "2025-11-01", 40},
		{"Azithromycin 500mg", "AZ-2026-04", "2027-04-01", 240},
		{"Cetirizine 10mg", "CT-2024-09", "2024-09-01", 0},
		{"Cetirizine 10mg", "CT-2026-01", "2027-01-01", 520},
		{"Salbutamol inhaler", "SB-2026-02", "2027-02-01", 45},
		{"Tramadol 50mg", "TR-2025-12", "2025-12-01", 20},
		{"Metformin 500mg", "MF-2026-03", "2027-03-01", 700},
	}
	for _, b := range batches {
		if _, err := tx.Exec(ctx,
			`INSERT INTO drug_batches (tenant_id, drug_id, batch_no, expiry_date, qty_on_hand)
			 SELECT $1,$2,$3,$4::date,$5
			 WHERE NOT EXISTS (SELECT 1 FROM drug_batches WHERE tenant_id=$1 AND drug_id=$2 AND batch_no=$3)`,
			tenantID, drugID[b.Drug], b.No, b.Expiry, b.Qty); err != nil {
			return fmt.Errorf("batch %s: %w", b.No, err)
		}
	}
	return nil
}

// seedLab inserts a starter lab test catalog with analytes + reference ranges
// (lab managers extend it). Idempotent.
func seedLab(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	f := func(v float64) *float64 { return &v }
	type an struct {
		Name, Unit             string
		Lo, Hi, CLo, CHi       *float64
	}
	type tst struct {
		Code, Name, Specimen string
		Analytes             []an
	}
	tests := []tst{
		{"CBC", "Complete blood count", "Blood", []an{
			{"WBC", "10^9/L", f(4.0), f(11.0), f(2.0), f(30.0)},
			{"RBC", "10^12/L", f(4.2), f(5.4), nil, nil},
			{"Hemoglobin", "g/dL", f(12.0), f(16.0), nil, nil},
			{"Hematocrit", "%", f(36), f(46), nil, nil},
			{"Platelets", "10^9/L", f(150), f(400), f(50), f(1000)},
			{"Neutrophils", "%", f(40), f(75), nil, nil},
			{"Lymphocytes", "%", f(20), f(40), nil, nil},
		}},
		{"CRP", "C-reactive protein", "Blood", []an{{"CRP", "mg/L", f(0), f(5), nil, nil}}},
		{"HBA1C", "HbA1c", "Blood", []an{{"HbA1c", "%", f(4), f(5.6), nil, f(10)}}},
		{"TROP", "Troponin", "Blood", []an{{"Troponin", "ng/mL", f(0), f(0.04), nil, f(0.4)}}},
		{"LIPID", "Lipid panel", "Blood", []an{
			{"Total cholesterol", "mg/dL", f(0), f(200), nil, nil},
			{"LDL", "mg/dL", f(0), f(130), nil, nil},
			{"HDL", "mg/dL", f(40), f(200), nil, nil},
			{"Triglycerides", "mg/dL", f(0), f(150), nil, nil},
		}},
		{"UA", "Urinalysis", "Urine", []an{{"Urine glucose", "mg/dL", f(0), f(15), nil, nil}}},
		{"STREP", "Rapid strep test", "Throat swab", []an{{"Result", "", nil, nil, nil, nil}}},
	}
	for _, t := range tests {
		var tid uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM lab_tests WHERE tenant_id=$1 AND lower(code)=lower($2) AND deleted_at IS NULL`,
			tenantID, t.Code).Scan(&tid)
		if errors.Is(err, pgx.ErrNoRows) {
			if err = tx.QueryRow(ctx,
				`INSERT INTO lab_tests (tenant_id, code, name, specimen) VALUES ($1,$2,$3,$4) RETURNING id`,
				tenantID, t.Code, t.Name, t.Specimen).Scan(&tid); err != nil {
				return fmt.Errorf("lab test %s: %w", t.Code, err)
			}
		} else if err != nil {
			return fmt.Errorf("lab test %s: %w", t.Code, err)
		}
		for i, a := range t.Analytes {
			if _, err := tx.Exec(ctx,
				`INSERT INTO lab_analytes (tenant_id, test_id, name, unit, ref_low, ref_high, critical_low, critical_high, sort_order)
				 SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
				 WHERE NOT EXISTS (SELECT 1 FROM lab_analytes WHERE test_id=$2 AND name=$3)`,
				tenantID, tid, a.Name, a.Unit, a.Lo, a.Hi, a.CLo, a.CHi, i); err != nil {
				return fmt.Errorf("lab analyte %s: %w", a.Name, err)
			}
		}
	}
	return nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	workspace := env("SEED_WORKSPACE", "demo")
	ownerEmail := env("SEED_OWNER_EMAIL", "owner@demo.clinic")
	ownerPass := env("SEED_OWNER_PASSWORD", "ChangeMe123!")
	ownerName := env("SEED_OWNER_NAME", "Demo Owner")

	ctx := context.Background()
	db, err := kerneldb.Connect(ctx, dsn)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer db.Close()

	passwordHash, err := auth.HashPassword(ownerPass)
	if err != nil {
		log.Fatalf("hash password: %v", err)
	}

	// Optional: per-role demo logins (SEED_DEMO=1).
	seedDemo := os.Getenv("SEED_DEMO") == "1"
	demoPass := env("SEED_DEMO_PASSWORD", "Test1234!")
	var demoHash string
	if seedDemo {
		if demoHash, err = auth.HashPassword(demoPass); err != nil {
			log.Fatalf("hash demo password: %v", err)
		}
	}

	// Phase 1: global + registry rows (no tenant RLS).
	var planID, tenantID uuid.UUID
	if err := db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO plans (code, name, branch_limit, user_limit, storage_gb, audit_retention_days, price_monthly)
			 VALUES ('business','Business',10,100,500,1095,0)
			 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
			 RETURNING id`).Scan(&planID); err != nil {
			return fmt.Errorf("plan: %w", err)
		}
		for _, p := range basePermissions {
			if _, err := tx.Exec(ctx,
				`INSERT INTO permissions (code, description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`,
				p.Code, p.Desc); err != nil {
				return fmt.Errorf("permission %s: %w", p.Code, err)
			}
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO tenants (name, slug, status, plan_id, onboarded_at)
			 VALUES ($1, $2, 'active', $3, now())
			 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, status = 'active'
			 RETURNING id`, "Demo Clinic", workspace, planID).Scan(&tenantID); err != nil {
			return fmt.Errorf("tenant: %w", err)
		}
		return nil
	}); err != nil {
		log.Fatalf("seed (global): %v", err)
	}

	// Phase 2: tenant-owned rows (RLS enforced; GUC set to tenantID).
	var ownerUserID, ownerRoleID uuid.UUID
	if err := db.WithTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		// Subscription + billing.
		if _, err := tx.Exec(ctx,
			`INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES ($1,$2,'active')
			 ON CONFLICT DO NOTHING`, tenantID, planID); err != nil {
			return fmt.Errorf("subscription: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO billing_accounts (tenant_id, billing_email, currency) VALUES ($1,$2,'ETB')
			 ON CONFLICT (tenant_id) DO NOTHING`, tenantID, ownerEmail); err != nil {
			return fmt.Errorf("billing: %w", err)
		}
		// Feature flags.
		for flag, enabled := range businessFlags {
			if _, err := tx.Exec(ctx,
				`INSERT INTO feature_flags (tenant_id, flag, enabled, source) VALUES ($1,$2,$3,'plan')
				 ON CONFLICT (tenant_id, flag) DO UPDATE SET enabled = EXCLUDED.enabled`,
				tenantID, flag, enabled); err != nil {
				return fmt.Errorf("flag %s: %w", flag, err)
			}
		}
		// Roles.
		roleIDs := map[string]uuid.UUID{}
		for _, r := range tenantRoles {
			var rid uuid.UUID
			if err := tx.QueryRow(ctx,
				`INSERT INTO roles (tenant_id, code, name, is_system) VALUES ($1,$2,$3,true)
				 ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
				 RETURNING id`, tenantID, r.Code, r.Name).Scan(&rid); err != nil {
				return fmt.Errorf("role %s: %w", r.Code, err)
			}
			roleIDs[r.Code] = rid
			if r.Code == "tenant_owner" {
				ownerRoleID = rid
			}
		}
		// tenant_owner and clinic_admin get every permission.
		for _, code := range []string{"tenant_owner", "clinic_admin"} {
			rid, ok := roleIDs[code]
			if !ok {
				continue
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO role_permissions (tenant_id, role_id, permission_id)
				 SELECT $1, $2, p.id FROM permissions p
				 ON CONFLICT (role_id, permission_id) DO NOTHING`, tenantID, rid); err != nil {
				return fmt.Errorf("grant %s permissions: %w", code, err)
			}
		}
		// Default permission sets for the operational roles (Phase 3b-2), so each
		// role can be invited and tested with a realistic scoped view.
		roleGrants := map[string][]string{
			"branch_manager": {"patient.create", "patient.read", "patient.update", "patient.search", "appointment.manage", "queue.manage", "triage.manage", "payment.collect", "user.read"},
			"receptionist":   {"patient.create", "patient.read", "patient.update", "patient.search", "appointment.manage", "queue.manage", "payment.collect"},
			"doctor":         {"patient.read", "patient.search", "encounter.manage", "prescription.create", "queue.manage", "appointment.manage", "lab.order"},
			"nurse":          {"patient.read", "patient.search", "triage.manage", "queue.manage"},
			"cashier":        {"payment.collect", "patient.read", "patient.search"},
			"pharmacist":      {"patient.read", "patient.search", "pharmacy.read", "pharmacy.dispense", "pharmacy.stock", "pharmacy.sell"},
			"pharmacy_manager": {"patient.read", "patient.search", "pharmacy.read", "pharmacy.dispense", "pharmacy.stock", "pharmacy.sell", "pharmacy.manage"},
			"lab_technician":   {"patient.read", "patient.search", "lab.process"},
			"lab_manager":      {"patient.read", "patient.search", "lab.process", "lab.validate", "lab.manage"},
		}
		for code, perms := range roleGrants {
			rid, ok := roleIDs[code]
			if !ok {
				continue
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO role_permissions (tenant_id, role_id, permission_id)
				 SELECT $1, $2, p.id FROM permissions p WHERE p.code = ANY($3::text[])
				 ON CONFLICT (role_id, permission_id) DO NOTHING`, tenantID, rid, perms); err != nil {
				return fmt.Errorf("grant %s permissions: %w", code, err)
			}
		}
		// Owner user (re-seed resets the password).
		if err := tx.QueryRow(ctx,
			`INSERT INTO users (tenant_id, email, password_hash, full_name, status)
			 VALUES ($1,$2,$3,$4,'active')
			 ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'
			 RETURNING id`, tenantID, ownerEmail, passwordHash, ownerName).Scan(&ownerUserID); err != nil {
			return fmt.Errorf("owner user: %w", err)
		}
		// Owner role assignment (tenant-wide).
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
			 ON CONFLICT (user_id, role_id, branch_id, department_id) DO NOTHING`,
			tenantID, ownerUserID, ownerRoleID); err != nil {
			return fmt.Errorf("owner role assignment: %w", err)
		}
		// Optional per-role demo staff (SEED_DEMO=1): one active login per role,
		// sharing demoPass, each assigned its matching system role tenant-wide.
		if seedDemo {
			for _, s := range demoStaff {
				rid, ok := roleIDs[s.Role]
				if !ok {
					continue
				}
				var uid uuid.UUID
				if err := tx.QueryRow(ctx,
					`INSERT INTO users (tenant_id, email, password_hash, full_name, status)
					 VALUES ($1,$2,$3,$4,'active')
					 ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name, status = 'active'
					 RETURNING id`, tenantID, s.Email, demoHash, s.Name).Scan(&uid); err != nil {
					return fmt.Errorf("demo user %s: %w", s.Email, err)
				}
				if _, err := tx.Exec(ctx,
					`INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
					 ON CONFLICT (user_id, role_id, branch_id, department_id) DO NOTHING`,
					tenantID, uid, rid); err != nil {
					return fmt.Errorf("demo role %s: %w", s.Email, err)
				}
			}
		}

		// Default clinic + main branch.
		var clinicID uuid.UUID
		e := tx.QueryRow(ctx, `SELECT id FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL LIMIT 1`, tenantID).Scan(&clinicID)
		if errors.Is(e, pgx.ErrNoRows) {
			if e = tx.QueryRow(ctx,
				`INSERT INTO clinics (tenant_id, name) VALUES ($1, $2) RETURNING id`,
				tenantID, "Demo Clinic").Scan(&clinicID); e != nil {
				return fmt.Errorf("clinic: %w", e)
			}
		} else if e != nil {
			return fmt.Errorf("clinic lookup: %w", e)
		}
		if _, e := tx.Exec(ctx,
			`INSERT INTO branches (tenant_id, clinic_id, name, code) VALUES ($1, $2, 'Main Branch', 'MAIN')
			 ON CONFLICT (tenant_id, code) DO NOTHING`, tenantID, clinicID); e != nil {
			return fmt.Errorf("branch: %w", e)
		}
		// Starter diagnosis catalog (admins extend it in Settings).
		if e := seedDiagnosisCatalog(ctx, tx, tenantID); e != nil {
			return e
		}
		// Starter drug catalog + stock (pharmacy managers extend it).
		if e := seedPharmacy(ctx, tx, tenantID); e != nil {
			return e
		}
		// Starter lab test catalog (lab managers extend it).
		if e := seedLab(ctx, tx, tenantID); e != nil {
			return e
		}
		return nil
	}); err != nil {
		log.Fatalf("seed (tenant): %v", err)
	}

	fmt.Println("✔ Seed complete")
	fmt.Printf("  Workspace : %s\n", workspace)
	fmt.Printf("  Email     : %s\n", ownerEmail)
	fmt.Printf("  Password  : %s\n", ownerPass)
	fmt.Printf("  Tenant ID : %s\n", tenantID)
	if seedDemo {
		fmt.Printf("  Demo staff: %d role logins (password %q)\n", len(demoStaff), demoPass)
		for _, s := range demoStaff {
			fmt.Printf("    - %-22s %s\n", s.Email, s.Role)
		}
	}
}
