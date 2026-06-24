// Package platform is the vendor-side super-admin surface: it provisions and
// manages tenants (clinics) across the multi-tenant boundary. It is NOT tenant
// scoped and runs on a privileged (RLS-bypassing) DB connection.
package platform

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// ProvisionInput creates a new clinic + its owner.
type ProvisionInput struct {
	ClinicName    string
	Slug          string
	OwnerEmail    string
	OwnerName     string
	OwnerPassword string          // optional; a temp password is generated when empty
	Modules       map[string]bool // optional module entitlements (e.g. {"laboratory":true,"pharmacy":false})
}

// ModuleFlags are the module entitlements a platform admin can toggle per clinic.
// Only modules that are built + flag-gated today are exposed.
var ModuleFlags = []struct{ Key, Label string }{
	{"laboratory", "Laboratory"},
	{"pharmacy", "Pharmacy"},
}

// ClinicSummary is one clinic on the platform roster.
type ClinicSummary struct {
	TenantID   uuid.UUID `json:"-"`
	Name       string    `json:"name"`
	Slug       string    `json:"slug"`
	Status     string    `json:"status"`
	OwnerEmail string    `json:"owner_email,omitempty"`
	Users      int       `json:"users"`
	Patients   int       `json:"patients"`
	CreatedAt  time.Time `json:"created_at"`
}

// ProvisionResult returns the new clinic plus the owner's initial credentials so
// the operator can hand them over (a proper invite flow lands in PLAT-B).
type ProvisionResult struct {
	Clinic        ClinicSummary `json:"clinic"`
	OwnerEmail    string        `json:"owner_email"`
	TempPassword  string        `json:"temp_password,omitempty"`
	WorkspaceSlug string        `json:"workspace_slug"`
}

// Login is the platform-admin credential check returning an access token.
type Login struct {
	Token     string    `json:"access_token"`
	ExpiresAt time.Time `json:"expires_at"`
	Email     string    `json:"email"`
}

// Service is the platform (super-admin) API.
type Service interface {
	Authenticate(ctx context.Context, email, password string) (*Login, error)
	ProvisionClinic(ctx context.Context, in ProvisionInput) (*ProvisionResult, error)
	ListClinics(ctx context.Context) ([]ClinicSummary, error)
	SetClinicStatus(ctx context.Context, tenantID uuid.UUID, status string) error
	GetClinicModules(ctx context.Context, tenantID uuid.UUID) (map[string]bool, error)
	SetClinicModules(ctx context.Context, tenantID uuid.UUID, modules map[string]bool) error
}
