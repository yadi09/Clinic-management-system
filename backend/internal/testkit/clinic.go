package testkit

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/platform/provision"
)

// StaffPassword is every test user's password. Test databases only.
const StaffPassword = "Regress#2026"

var (
	hashOnce sync.Once
	hashed   string
)

func passwordHash(t testing.TB) string {
	hashOnce.Do(func() {
		h, err := auth.HashPassword(StaffPassword)
		if err != nil {
			t.Fatalf("hash: %v", err)
		}
		hashed = h
	})
	return hashed
}

// Staff is one signed-in-able user of a clinic.
type Staff struct {
	ID    uuid.UUID
	Email string
	Role  string
}

// Clinic is a fully provisioned clinic: owner plus one user per operational role.
type Clinic struct {
	Slug     string
	TenantID uuid.UUID
	BranchID uuid.UUID
	DeptID   uuid.UUID
	Owner    Staff
	// By role code: receptionist, doctor, nurse, cashier, branch_manager.
	Staff map[string]Staff
}

// Roles every test clinic gets a user for.
var Roles = []string{"receptionist", "doctor", "nurse", "cashier", "branch_manager"}

// ClinicOpts tune a test clinic. Zero value: a dental clinic on the default plan.
type ClinicOpts struct {
	ClinicType string // "dental" (default) or "general"
	PlanCode   string
	Flags      map[string]bool
}

// NewClinic provisions a clinic through provision.BootstrapTenant — the same code the
// platform console runs — with a unique slug, so tests never share rows.
func NewClinic(t testing.TB, db *kerneldb.DB, o ClinicOpts) *Clinic {
	t.Helper()
	if o.ClinicType == "" {
		o.ClinicType = "dental"
	}
	ctx := context.Background()
	slug := "rg-" + strings.ReplaceAll(uuid.NewString()[:12], "-", "")
	c := &Clinic{Slug: slug, Staff: map[string]Staff{}}
	var res provision.Result
	err := db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var e error
		res, e = provision.BootstrapTenant(ctx, tx, provision.Params{
			Name: "Regression " + slug, Slug: slug, OwnerEmail: "owner@" + slug + ".test", OwnerName: "Owner " + slug,
			OwnerPasswordHash: passwordHash(t), ClinicType: o.ClinicType, PlanCode: o.PlanCode, Flags: o.Flags,
		})
		if e != nil {
			return e
		}
		for _, role := range Roles {
			roleID, ok := res.RoleIDs[role]
			if !ok {
				continue
			}
			email := role + "@" + slug + ".test"
			var uid uuid.UUID
			if e := tx.QueryRow(ctx,
				`INSERT INTO users (tenant_id, email, password_hash, full_name, status)
				 VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
				res.TenantID, email, passwordHash(t), strings.ToUpper(role[:1])+role[1:]+" "+slug[:7]).Scan(&uid); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx,
				`INSERT INTO user_role_scopes (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
				res.TenantID, uid, roleID); e != nil {
				return e
			}
			c.Staff[role] = Staff{ID: uid, Email: email, Role: role}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("provision clinic: %v", err)
	}
	c.TenantID, c.BranchID, c.DeptID = res.TenantID, res.BranchID, res.DeptID
	c.Owner = Staff{ID: res.OwnerUserID, Email: "owner@" + slug + ".test", Role: "tenant_owner"}
	return c
}
