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
	{"queue.manage", "Manage department queues"},
	{"encounter.manage", "Conduct consultations and EMR"},
	{"prescription.create", "Create prescriptions"},
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
		for _, r := range tenantRoles {
			var rid uuid.UUID
			if err := tx.QueryRow(ctx,
				`INSERT INTO roles (tenant_id, code, name, is_system) VALUES ($1,$2,$3,true)
				 ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
				 RETURNING id`, tenantID, r.Code, r.Name).Scan(&rid); err != nil {
				return fmt.Errorf("role %s: %w", r.Code, err)
			}
			if r.Code == "tenant_owner" {
				ownerRoleID = rid
			}
		}
		// Grant the owner role every permission.
		if _, err := tx.Exec(ctx,
			`INSERT INTO role_permissions (tenant_id, role_id, permission_id)
			 SELECT $1, $2, p.id FROM permissions p
			 ON CONFLICT (role_id, permission_id) DO NOTHING`, tenantID, ownerRoleID); err != nil {
			return fmt.Errorf("grant owner permissions: %w", err)
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
		return nil
	}); err != nil {
		log.Fatalf("seed (tenant): %v", err)
	}

	fmt.Println("✔ Seed complete")
	fmt.Printf("  Workspace : %s\n", workspace)
	fmt.Printf("  Email     : %s\n", ownerEmail)
	fmt.Printf("  Password  : %s\n", ownerPass)
	fmt.Printf("  Tenant ID : %s\n", tenantID)
}
