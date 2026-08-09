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
	ClinicType    string          // "general" (default) | "dental" — applies a flag preset
	PlanCode      string          // subscription plan code (default "business")
	Modules       map[string]bool // optional module entitlements (e.g. {"laboratory":true,"pharmacy":false})
}

// Plan is a subscription tier the super-admin manages. A nil limit = unlimited.
type Plan struct {
	ID               uuid.UUID `json:"-"`
	Code             string    `json:"code"`
	Name             string    `json:"name"`
	ClinicType       string    `json:"clinic_type"` // "all" | "general" | "dental"
	BranchLimit      *int      `json:"branch_limit"`
	UserLimit        *int      `json:"user_limit"`
	StorageGB        *int      `json:"storage_gb"`
	PatientLimit     *int      `json:"patient_limit"`
	ImagesPerPatient *int      `json:"images_per_patient"`
	PriceMonthly     string    `json:"price_monthly"`
	InUse            int       `json:"in_use"` // how many clinics are on this plan
}

// PlanInput writes a plan. nil limit fields mean unlimited.
type PlanInput struct {
	Code             string // create only; ignored on update
	Name             string
	ClinicType       string // "all" (default) | "general" | "dental"
	BranchLimit      *int
	UserLimit        *int
	StorageGB        *int
	PatientLimit     *int
	ImagesPerPatient *int
	PriceMonthly     string
}

// ClinicPlanInput assigns a clinic to a plan and sets its per-clinic overrides.
// Each override: nil = inherit the plan, negative = unlimited, >= 0 = explicit cap.
type ClinicPlanInput struct {
	PlanID               uuid.UUID
	StorageGBOverride    *int
	PatientLimitOverride *int
	UserLimitOverride    *int
	BranchLimitOverride  *int
}

// UsageLine is used vs cap for one dimension (Limit -1 = unlimited).
type UsageLine struct {
	Used  int64 `json:"used"`
	Limit int64 `json:"limit"`
}

// ClinicUsage is a clinic's plan name + usage vs caps (super-admin view).
type ClinicUsage struct {
	PlanName             string    `json:"plan_name"`
	Storage              UsageLine `json:"storage"`
	Patients             UsageLine `json:"patients"`
	Users                UsageLine `json:"users"`
	Branches             UsageLine `json:"branches"`
	StorageGBOverride    *int      `json:"storage_gb_override"`
	PatientLimitOverride *int      `json:"patient_limit_override"`
	UserLimitOverride    *int      `json:"user_limit_override"`
	BranchLimitOverride  *int      `json:"branch_limit_override"`
}

// ModuleFlags are the module entitlements a platform admin can toggle per clinic.
// Only modules that are built + flag-gated today are exposed.
var ModuleFlags = []struct{ Key, Label string }{
	{"laboratory", "Laboratory"},
	{"pharmacy", "Pharmacy"},
	{"dental", "Dental"},
	{"maternity", "Maternity"},
	{"inpatient", "Inpatient (beds)"},
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
	ClinicType string    `json:"clinic_type,omitempty"`
	PlanCode   string    `json:"plan_code,omitempty"`
	PlanName   string    `json:"plan_name,omitempty"`
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

// Impersonation is a platform-admin "sign in as the clinic owner" grant: a
// ready-to-use tenant access token for the clinic's owner, plus who it's for.
type Impersonation struct {
	AccessToken   string
	ExpiresIn     int
	WorkspaceSlug string
	User          ImpersonatedUser
}

// ImpersonatedUser is the tenant owner the platform admin is signing in as.
type ImpersonatedUser struct {
	ID       uuid.UUID
	TenantID uuid.UUID
	Email    string
	FullName string
	Roles    []string
}

// PartnerLeadInput is a referral/partner sign-up captured on a public partner page.
type PartnerLeadInput struct {
	Name            string
	Phone           string
	Email           string
	Region          string
	Audience        string // influencer | clinic_owner | professional | sales | other
	ClinicsEstimate string // 1-3 | 4-10 | 11-20 | 20+
	Goal            string
	Source          string // partner link slug and/or ?ref= that referred them
	IP              string
	UserAgent       string
}

// PartnerLead is a captured lead for the platform admin's leads list.
type PartnerLead struct {
	ID              uuid.UUID `json:"-"`
	Name            string    `json:"name"`
	Phone           string    `json:"phone,omitempty"`
	Email           string    `json:"email,omitempty"`
	Region          string    `json:"region,omitempty"`
	Audience        string    `json:"audience,omitempty"`
	ClinicsEstimate string    `json:"clinics_estimate,omitempty"`
	Goal            string    `json:"goal,omitempty"`
	Source          string    `json:"source,omitempty"`
	Status          string    `json:"status"`
	CreatedAt       time.Time `json:"created_at"`
}

// Service is the platform (super-admin) API.
type Service interface {
	Authenticate(ctx context.Context, email, password string) (*Login, error)
	ProvisionClinic(ctx context.Context, in ProvisionInput) (*ProvisionResult, error)
	ListClinics(ctx context.Context) ([]ClinicSummary, error)
	SetClinicStatus(ctx context.Context, tenantID uuid.UUID, status string) error
	GetClinicModules(ctx context.Context, tenantID uuid.UUID) (map[string]bool, error)
	SetClinicModules(ctx context.Context, tenantID uuid.UUID, modules map[string]bool) error
	ImpersonateOwner(ctx context.Context, tenantID uuid.UUID) (*Impersonation, error)
	// Subscription plans (super-admin only, privileged connection).
	ListPlans(ctx context.Context) ([]Plan, error)
	CreatePlan(ctx context.Context, in PlanInput) (*Plan, error)
	UpdatePlan(ctx context.Context, id uuid.UUID, in PlanInput) error
	SetClinicPlan(ctx context.Context, tenantID uuid.UUID, in ClinicPlanInput) error
	ClinicUsage(ctx context.Context, tenantID uuid.UUID) (*ClinicUsage, error)
	// CaptureLead stores a public partner-page sign-up (unauthenticated).
	CaptureLead(ctx context.Context, in PartnerLeadInput) error
	ListPartnerLeads(ctx context.Context) ([]PartnerLead, error)
	SetLeadStatus(ctx context.Context, id uuid.UUID, status string) error
}
