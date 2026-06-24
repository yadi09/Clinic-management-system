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
	"github.com/reicb/clinicsaas/internal/platform/provision"
)

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
		Name, Unit       string
		Lo, Hi, CLo, CHi *float64
	}
	type tst struct {
		Code, Name, Specimen string
		Price                float64
		Analytes             []an
	}
	tests := []tst{
		{"CBC", "Complete blood count", "Blood", 120, []an{
			{"WBC", "10^9/L", f(4.0), f(11.0), f(2.0), f(30.0)},
			{"RBC", "10^12/L", f(4.2), f(5.4), nil, nil},
			{"Hemoglobin", "g/dL", f(12.0), f(16.0), nil, nil},
			{"Hematocrit", "%", f(36), f(46), nil, nil},
			{"Platelets", "10^9/L", f(150), f(400), f(50), f(1000)},
			{"Neutrophils", "%", f(40), f(75), nil, nil},
			{"Lymphocytes", "%", f(20), f(40), nil, nil},
		}},
		{"CRP", "C-reactive protein", "Blood", 90, []an{{"CRP", "mg/L", f(0), f(5), nil, nil}}},
		{"HBA1C", "HbA1c", "Blood", 250, []an{{"HbA1c", "%", f(4), f(5.6), nil, f(10)}}},
		{"TROP", "Troponin", "Blood", 350, []an{{"Troponin", "ng/mL", f(0), f(0.04), nil, f(0.4)}}},
		{"LIPID", "Lipid panel", "Blood", 200, []an{
			{"Total cholesterol", "mg/dL", f(0), f(200), nil, nil},
			{"LDL", "mg/dL", f(0), f(130), nil, nil},
			{"HDL", "mg/dL", f(40), f(200), nil, nil},
			{"Triglycerides", "mg/dL", f(0), f(150), nil, nil},
		}},
		{"UA", "Urinalysis", "Urine", 60, []an{{"Urine glucose", "mg/dL", f(0), f(15), nil, nil}}},
		{"STREP", "Rapid strep test", "Throat swab", 80, []an{{"Result", "", nil, nil, nil, nil}}},
	}
	for _, t := range tests {
		var tid uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM lab_tests WHERE tenant_id=$1 AND lower(code)=lower($2) AND deleted_at IS NULL`,
			tenantID, t.Code).Scan(&tid)
		if errors.Is(err, pgx.ErrNoRows) {
			if err = tx.QueryRow(ctx,
				`INSERT INTO lab_tests (tenant_id, code, name, specimen, price) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
				tenantID, t.Code, t.Name, t.Specimen, t.Price).Scan(&tid); err != nil {
				return fmt.Errorf("lab test %s: %w", t.Code, err)
			}
		} else if err != nil {
			return fmt.Errorf("lab test %s: %w", t.Code, err)
		} else {
			// keep prices in sync on reseed
			if _, err = tx.Exec(ctx, `UPDATE lab_tests SET price=$3 WHERE tenant_id=$1 AND id=$2`, tenantID, tid, t.Price); err != nil {
				return fmt.Errorf("lab test price %s: %w", t.Code, err)
			}
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

// seedBillingServices inserts a starter set of billable services (admins re-price
// / extend / re-tag). Idempotent by code. Services tagged `is_default` are the ones
// reception pre-selects (the registration / consultation fee that anchors a visit).
func seedBillingServices(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	type svc struct {
		Code, Name, Category, Price string
		Default                     bool
	}
	items := []svc{
		{"REG", "Registration fee", "registration", "50.00", true},
		{"CONSULT", "Consultation", "consultation", "100.00", true},
		{"DRESS", "Wound dressing", "procedure", "60.00", false},
		{"INJECT", "Injection", "procedure", "40.00", false},
		{"SUTURE", "Suturing", "procedure", "250.00", false},
		{"NEB", "Nebulization", "procedure", "80.00", false},
		{"BP", "Blood pressure check", "general", "20.00", false},
	}
	for _, s := range items {
		if _, err := tx.Exec(ctx,
			`INSERT INTO service_items (tenant_id, code, name, category, price, is_default)
			 SELECT $1,$2,$3,$4,$5::numeric,$6
			 WHERE NOT EXISTS (SELECT 1 FROM service_items WHERE tenant_id=$1 AND lower(code)=lower($2) AND deleted_at IS NULL)`,
			tenantID, s.Code, s.Name, s.Category, s.Price, s.Default); err != nil {
			return fmt.Errorf("service %s: %w", s.Code, err)
		}
	}
	return nil
}

// seedServiceProviders assigns the demo staff who perform each service, so
// reception's "assign" dropdown is filtered to real providers. Idempotent.
func seedServiceProviders(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	assign := map[string][]string{
		"CONSULT": {"doctor@demo.clinic"},
		"SUTURE":  {"doctor@demo.clinic"},
		"NEB":     {"doctor@demo.clinic", "nurse@demo.clinic"},
		"DRESS":   {"nurse@demo.clinic"},
		"INJECT":  {"nurse@demo.clinic"},
		"BP":      {"nurse@demo.clinic"},
	}
	for code, emails := range assign {
		var sid uuid.UUID
		e := tx.QueryRow(ctx, `SELECT id FROM service_items WHERE tenant_id=$1 AND lower(code)=lower($2) AND deleted_at IS NULL`, tenantID, code).Scan(&sid)
		if errors.Is(e, pgx.ErrNoRows) {
			continue
		}
		if e != nil {
			return fmt.Errorf("service %s: %w", code, e)
		}
		for _, email := range emails {
			var uid uuid.UUID
			e := tx.QueryRow(ctx, `SELECT id FROM users WHERE tenant_id=$1 AND email=$2`, tenantID, email).Scan(&uid)
			if errors.Is(e, pgx.ErrNoRows) {
				continue
			}
			if e != nil {
				return fmt.Errorf("user %s: %w", email, e)
			}
			if _, e := tx.Exec(ctx,
				`INSERT INTO service_providers (tenant_id, service_item_id, user_id) VALUES ($1,$2,$3)
				 ON CONFLICT (service_item_id, user_id) DO NOTHING`, tenantID, sid, uid); e != nil {
				return fmt.Errorf("provider %s/%s: %w", code, email, e)
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

	// Bootstrap the tenant structure (shared with platform provisioning), then
	// layer the demo staff + richer starter catalogs on top.
	var tenantID uuid.UUID
	if err := db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		res, e := provision.BootstrapTenant(ctx, tx, provision.Params{
			Name: "Demo Clinic", Slug: workspace, OwnerEmail: ownerEmail, OwnerName: ownerName, OwnerPasswordHash: passwordHash,
		})
		if e != nil {
			return e
		}
		tenantID = res.TenantID
		if seedDemo {
			for _, st := range demoStaff {
				rid, ok := res.RoleIDs[st.Role]
				if !ok {
					continue
				}
				var uid uuid.UUID
				if e := tx.QueryRow(ctx,
					`INSERT INTO users (tenant_id, email, password_hash, full_name, status)
					 VALUES ($1,$2,$3,$4,'active')
					 ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name, status = 'active'
					 RETURNING id`, tenantID, st.Email, demoHash, st.Name).Scan(&uid); e != nil {
					return fmt.Errorf("demo user %s: %w", st.Email, e)
				}
				if _, e := tx.Exec(ctx,
					`INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1,$2,$3)
					 ON CONFLICT (user_id, role_id, branch_id, department_id) DO NOTHING`,
					tenantID, uid, rid); e != nil {
					return fmt.Errorf("demo role %s: %w", st.Email, e)
				}
			}
		}
		if e := seedDiagnosisCatalog(ctx, tx, tenantID); e != nil {
			return e
		}
		if e := seedPharmacy(ctx, tx, tenantID); e != nil {
			return e
		}
		if e := seedLab(ctx, tx, tenantID); e != nil {
			return e
		}
		if e := seedBillingServices(ctx, tx, tenantID); e != nil {
			return e
		}
		if seedDemo {
			if e := seedServiceProviders(ctx, tx, tenantID); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		log.Fatalf("seed: %v", err)
	}

	// Platform (super-admin) operator — vendor-side, not tenant-scoped.
	platformEmail := env("SEED_PLATFORM_EMAIL", "super@clinicos.local")
	platformPass := env("SEED_PLATFORM_PASSWORD", "ChangeMe123!")
	platHash, err := auth.HashPassword(platformPass)
	if err != nil {
		log.Fatalf("hash platform password: %v", err)
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO platform_admins (email, password_hash, full_name, status)
		 VALUES ($1,$2,$3,'active')
		 ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
		platformEmail, platHash, "Platform Super Admin"); err != nil {
		log.Fatalf("platform admin: %v", err)
	}

	fmt.Println("✔ Seed complete")
	fmt.Printf("  Platform  : %s / %s  (super-admin)\n", platformEmail, platformPass)
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
