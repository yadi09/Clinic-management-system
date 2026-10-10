// Package service implements the organisation module use-cases. All access is
// tenant-scoped via kernel/db.WithTx (RLS enforced).
package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/org"
	orgdb "github.com/reicb/clinicsaas/internal/org/repo/gen"
)

// Service implements org.Service.
type Service struct{ db *kerneldb.DB }

var _ org.Service = (*Service)(nil)

// NewService constructs an org Service.
func NewService(db *kerneldb.DB) *Service { return &Service{db: db} }

func (s *Service) GetClinic(ctx context.Context) (*org.Clinic, error) {
	tenantID, _ := actor(ctx)
	var c *org.Clinic
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		row, e := orgdb.New(tx).GetClinic(ctx, tenantID)
		if e != nil {
			return e
		}
		c = &org.Clinic{ID: row.ID, Name: row.Name, Timezone: row.Timezone, Locale: row.Locale}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("CLINIC_NOT_CONFIGURED", "clinic profile not configured")
		}
		return nil, apperr.Internal(err)
	}
	return c, nil
}

// SaveClinic upserts the tenant's clinic profile (creates on first save).
func (s *Service) SaveClinic(ctx context.Context, in org.ClinicInput) (*org.Clinic, error) {
	tenantID, actorID := actor(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := orgdb.New(tx)
		existing, e := q.GetClinic(ctx, tenantID)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if errors.Is(e, pgx.ErrNoRows) {
			_, e = q.CreateClinic(ctx, orgdb.CreateClinicParams{
				TenantID: tenantID, Name: in.Name,
				Timezone: defaultStr(in.Timezone, "Africa/Addis_Ababa"), Locale: defaultStr(in.Locale, "en"),
				CreatedBy: actorID,
			})
			return e
		}
		return q.UpdateClinic(ctx, orgdb.UpdateClinicParams{
			TenantID: tenantID, ID: existing.ID, Name: in.Name,
			Timezone: defaultStr(in.Timezone, existing.Timezone), Locale: defaultStr(in.Locale, existing.Locale),
		})
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.GetClinic(ctx)
}

// GetWorkspace returns the tenant's workspace handle (login slug) and name.
func (s *Service) GetWorkspace(ctx context.Context) (*org.Workspace, error) {
	tenantID, _ := actor(ctx)
	var ws *org.Workspace
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		row, e := orgdb.New(tx).GetTenantForOrg(ctx, tenantID)
		if e != nil {
			return e
		}
		ws = &org.Workspace{Name: row.Name, Slug: row.Slug}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("WORKSPACE_NOT_FOUND", "workspace not found")
		}
		return nil, apperr.Internal(err)
	}
	return ws, nil
}

// UpdateWorkspace changes the tenant's login slug. It must stay URL-safe and
// globally unique — everyone in the clinic signs in with the new handle.
func (s *Service) UpdateWorkspace(ctx context.Context, slug string) (*org.Workspace, error) {
	tenantID, _ := actor(ctx)
	slug = strings.ToLower(strings.TrimSpace(slug))
	if !validSlug(slug) {
		return nil, apperr.Validation("the workspace name must be 3–40 characters using lowercase letters, numbers, and hyphens")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		e := orgdb.New(tx).UpdateTenantSlug(ctx, orgdb.UpdateTenantSlugParams{ID: tenantID, Slug: slug})
		if e != nil {
			var pgErr *pgconn.PgError
			if errors.As(e, &pgErr) && pgErr.Code == "23505" { // unique_violation
				return apperr.Conflict("WORKSPACE_TAKEN", "that workspace name is already taken")
			}
			return e
		}
		return nil
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		return nil, apperr.Internal(err)
	}
	return s.GetWorkspace(ctx)
}

// validSlug enforces a URL-safe handle: 3–40 chars, lowercase alphanumerics and
// internal hyphens, no leading/trailing hyphen.
func validSlug(s string) bool {
	if len(s) < 3 || len(s) > 40 {
		return false
	}
	if s[0] == '-' || s[len(s)-1] == '-' {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// GetSettings returns the clinic's flow configuration (card fee, triage, etc.).
func (s *Service) GetSettings(ctx context.Context) (*org.Settings, error) {
	tenantID, _ := actor(ctx)
	var out *org.Settings
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := orgdb.New(tx).GetClinicSettings(ctx, tenantID)
		if e != nil {
			return e
		}
		out = &org.Settings{
			CardFeeEnabled: r.CardFeeEnabled, CardFeeAmount: r.CardFeeAmount, CardCurrency: r.CardCurrency,
			FreeWindowDays: int(r.FreeWindowDays), TriageRequired: r.TriageRequired, DoctorAssignment: r.DoctorAssignment,
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("CLINIC_NOT_CONFIGURED", "clinic profile not configured")
		}
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SaveSettings updates the clinic's flow configuration.
func (s *Service) SaveSettings(ctx context.Context, in org.SettingsInput) (*org.Settings, error) {
	tenantID, _ := actor(ctx)
	if in.DoctorAssignment != "manual" && in.DoctorAssignment != "auto" {
		in.DoctorAssignment = "manual"
	}
	if strings.TrimSpace(in.CardCurrency) == "" {
		in.CardCurrency = "ETB"
	}
	if strings.TrimSpace(in.CardFeeAmount) == "" {
		in.CardFeeAmount = "0"
	}
	if in.FreeWindowDays < 0 {
		in.FreeWindowDays = 0
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := orgdb.New(tx)
		cur, e := q.GetClinicSettings(ctx, tenantID)
		if e != nil {
			return e
		}
		return q.UpdateClinicSettings(ctx, orgdb.UpdateClinicSettingsParams{
			CardFeeEnabled: in.CardFeeEnabled, CardFeeAmount: in.CardFeeAmount, CardCurrency: in.CardCurrency,
			FreeWindowDays: int32(in.FreeWindowDays), TriageRequired: in.TriageRequired, DoctorAssignment: in.DoctorAssignment,
			TenantID: tenantID, ID: cur.ID,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("CLINIC_NOT_CONFIGURED", "configure the clinic profile first")
		}
		return nil, apperr.Internal(err)
	}
	return s.GetSettings(ctx)
}

func (s *Service) ListBranches(ctx context.Context) ([]org.Branch, error) {
	tenantID, _ := actor(ctx)
	var out []org.Branch
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := orgdb.New(tx).ListBranches(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, org.Branch{ID: r.ID, ClinicID: r.ClinicID, Name: r.Name, Code: r.Code, Address: deref(r.Address), Phone: deref(r.Phone), IsActive: r.IsActive})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateBranch(ctx context.Context, in org.BranchInput) (*org.Branch, error) {
	tenantID, actorID := actor(ctx)
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Code) == "" {
		return nil, apperr.Validation("branch name and code are required")
	}
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := orgdb.New(tx)
		// Enforce the effective branch cap (per-clinic override, else plan; nil = unlimited).
		limit, e := limits.BranchLimit(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		if limit != nil {
			n, e := q.CountBranches(ctx, tenantID)
			if e != nil {
				return e
			}
			if n >= *limit {
				return apperr.Conflict("BRANCH_LIMIT", fmt.Sprintf("your plan allows up to %d branch(es) — upgrade to add more", *limit))
			}
		}
		clinicID := uuid.Nil
		if in.ClinicID != nil {
			clinicID = *in.ClinicID
		} else {
			cl, e := q.GetClinic(ctx, tenantID)
			if e != nil {
				return e
			}
			clinicID = cl.ID
		}
		id, e = q.CreateBranch(ctx, orgdb.CreateBranchParams{
			TenantID: tenantID, ClinicID: clinicID, Name: in.Name, Code: in.Code,
			Address: strPtr(in.Address), Phone: strPtr(in.Phone), OpeningHours: jsonOrEmpty(in.OpeningHours), CreatedBy: actorID,
		})
		return e
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.Conflict("CLINIC_NOT_CONFIGURED", "configure the clinic profile before adding branches")
		}
		return nil, mapWriteErr(err, "BRANCH_CODE_TAKEN", "a branch with this code already exists")
	}
	return s.getBranch(ctx, id)
}

func (s *Service) UpdateBranch(ctx context.Context, id uuid.UUID, in org.BranchInput) (*org.Branch, error) {
	tenantID, _ := actor(ctx)
	isActive := true
	if in.IsActive != nil {
		isActive = *in.IsActive
	}
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return orgdb.New(tx).UpdateBranch(ctx, orgdb.UpdateBranchParams{
			TenantID: tenantID, ID: id, Name: in.Name, Code: in.Code,
			Address: strPtr(in.Address), Phone: strPtr(in.Phone), OpeningHours: jsonOrEmpty(in.OpeningHours), IsActive: isActive,
		})
	}); err != nil {
		return nil, mapWriteErr(err, "BRANCH_CODE_TAKEN", "a branch with this code already exists")
	}
	return s.getBranch(ctx, id)
}

func (s *Service) DeleteBranch(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actor(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// A branch with any activity must be deactivated, not deleted, so its
		// history (encounters, visits, payments) stays intact and attributable.
		var used bool
		if e := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM encounters WHERE tenant_id=$1 AND branch_id=$2)
			     OR EXISTS(SELECT 1 FROM appointments WHERE tenant_id=$1 AND branch_id=$2)
			     OR EXISTS(SELECT 1 FROM queue_entries WHERE tenant_id=$1 AND branch_id=$2)`,
			tenantID, id).Scan(&used); e != nil {
			return e
		}
		if used {
			return apperr.Conflict("BRANCH_IN_USE", "this branch has activity — deactivate it instead of deleting")
		}
		return orgdb.New(tx).SoftDeleteBranch(ctx, orgdb.SoftDeleteBranchParams{TenantID: tenantID, ID: id})
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return ae
		}
		return apperr.Internal(err)
	}
	return nil
}

// branchModuleFlags are the modules that can be toggled per branch (one branch
// can run a lab or pharmacy while another does not).
var branchModuleFlags = []string{"laboratory", "pharmacy", "inventory", "maternity", "inpatient", "dental"}

// BranchUsage reports how many branches exist against the plan's cap.
func (s *Service) BranchUsage(ctx context.Context) (*org.BranchUsage, error) {
	tenantID, _ := actor(ctx)
	var out org.BranchUsage
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := orgdb.New(tx)
		n, e := q.CountBranches(ctx, tenantID)
		if e != nil {
			return e
		}
		out.Used = int(n)
		limit, e := q.GetBranchLimit(ctx, tenantID)
		if e != nil {
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		} else if limit != nil {
			l := int(*limit)
			out.Limit = &l
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// StorageUsage reports the tenant's stored bytes against the plan's storage cap.
func (s *Service) PlanUsage(ctx context.Context) (*org.PlanUsage, error) {
	tenantID, _ := actor(ctx)
	var out org.PlanUsage
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		l, e := limits.Effective(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		storage, e := limits.StorageUsed(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		patients, e := limits.PatientCount(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		users, e := limits.UserCount(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		branches, e := limits.BranchCount(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		out = org.PlanUsage{
			PlanName: l.PlanName,
			Storage:  org.UsageLine{Used: storage, Limit: limitOrUnlimited(l.StorageBytes)},
			Patients: org.UsageLine{Used: patients, Limit: limitOrUnlimited(l.Patients)},
			Users:    org.UsageLine{Used: users, Limit: limitOrUnlimited(l.Users)},
			Branches: org.UsageLine{Used: branches, Limit: limitOrUnlimited(l.Branches)},
		}
		feats, e := planFeatures(ctx, tx, tenantID)
		if e != nil {
			return e
		}
		out.Features = feats
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// planFeatures answers, for each paid feature, "do we have this, and if not who
// does". One query: the catalogue, this clinic's effective answer (its own
// entitlement over its plan's), and the other plans of the same type that include
// it — so the upsell names a real plan the clinic could actually move to rather
// than a tier invented in the frontend.
func planFeatures(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) ([]org.PlanFeature, error) {
	rows, err := tx.Query(ctx, `
		WITH me AS (
		    SELECT t.id AS tenant_id, t.plan_id, t.clinic_type FROM tenants t WHERE t.id = $1
		)
		SELECT f.code, f.name, coalesce(f.detail, ''), f.category,
		       coalesce(te.enabled, pf.enabled, false) AS included,
		       coalesce((
		         -- Cheapest first, except a 0 price means "let's talk" (Custom) and
		         -- belongs last: naming it first would answer "what would it take?"
		         -- with the tier that has no price on it.
		         SELECT array_agg(p2.name ORDER BY (coalesce(p2.price_monthly,0) = 0), p2.price_monthly)
		           FROM plan_features pf2
		           JOIN plans p2 ON p2.id = pf2.plan_id
		          WHERE pf2.feature = f.code AND pf2.enabled
		            AND p2.status = 'active'
		            AND p2.clinic_type IN ('all', (SELECT clinic_type FROM me))
		       ), '{}')::text[] AS on_plans
		  FROM features f
		  LEFT JOIN plan_features pf ON pf.plan_id = (SELECT plan_id FROM me) AND pf.feature = f.code
		  LEFT JOIN tenant_entitlements te ON te.tenant_id = $1 AND te.feature = f.code
		 WHERE f.clinic_type IN ('all', (SELECT clinic_type FROM me))
		 ORDER BY f.sort`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []org.PlanFeature{}
	for rows.Next() {
		var f org.PlanFeature
		if err := rows.Scan(&f.Code, &f.Name, &f.Detail, &f.Category, &f.Included, &f.OnPlans); err != nil {
			return nil, err
		}
		if f.Included {
			f.OnPlans = nil
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// limitOrUnlimited maps a nil (unlimited) cap to -1 for the JSON contract.
func limitOrUnlimited(v *int64) int64 {
	if v == nil {
		return -1
	}
	return *v
}

// GetBranchModules returns each toggleable module with its effective state for
// the branch (branch override if present, otherwise the tenant default).
func (s *Service) GetBranchModules(ctx context.Context, branchID uuid.UUID) ([]org.ModuleFlag, error) {
	tenantID, _ := actor(ctx)
	defaults := map[string]bool{}
	overrides := map[string]bool{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := orgdb.New(tx)
		d, e := q.GetTenantModuleDefaults(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, f := range d {
			defaults[f.Flag] = f.Enabled
		}
		bid := branchID
		o, e := q.GetBranchModuleOverrides(ctx, orgdb.GetBranchModuleOverridesParams{TenantID: tenantID, BranchID: &bid})
		if e != nil {
			return e
		}
		for _, f := range o {
			overrides[f.Flag] = f.Enabled
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	out := make([]org.ModuleFlag, 0, len(branchModuleFlags))
	for _, flag := range branchModuleFlags {
		ov, has := overrides[flag]
		enabled := defaults[flag]
		if has {
			enabled = ov
		}
		out = append(out, org.ModuleFlag{Flag: flag, Enabled: enabled, Overridden: has})
	}
	return out, nil
}

// SetBranchModules applies per-branch module overrides. A nil value clears the
// override (the branch then follows the tenant default).
func (s *Service) SetBranchModules(ctx context.Context, branchID uuid.UUID, modules map[string]*bool) error {
	tenantID, _ := actor(ctx)
	allowed := map[string]bool{}
	for _, f := range branchModuleFlags {
		allowed[f] = true
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := orgdb.New(tx)
		bid := branchID
		for flag, val := range modules {
			if !allowed[flag] {
				continue
			}
			if val == nil {
				if e := q.DeleteBranchModule(ctx, orgdb.DeleteBranchModuleParams{TenantID: tenantID, BranchID: &bid, Flag: flag}); e != nil {
					return e
				}
				continue
			}
			if e := q.UpsertBranchModule(ctx, orgdb.UpsertBranchModuleParams{TenantID: tenantID, Flag: flag, Enabled: *val, BranchID: &bid}); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) getBranch(ctx context.Context, id uuid.UUID) (*org.Branch, error) {
	tenantID, _ := actor(ctx)
	var b *org.Branch
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := orgdb.New(tx).GetBranch(ctx, orgdb.GetBranchParams{TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		b = &org.Branch{ID: r.ID, ClinicID: r.ClinicID, Name: r.Name, Code: r.Code, Address: deref(r.Address), Phone: deref(r.Phone), OpeningHours: rawOrNil(r.OpeningHours), IsActive: r.IsActive}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("BRANCH_NOT_FOUND", "branch not found")
		}
		return nil, apperr.Internal(err)
	}
	return b, nil
}

func (s *Service) ListDepartments(ctx context.Context) ([]org.Department, error) {
	tenantID, _ := actor(ctx)
	var out []org.Department
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := orgdb.New(tx).ListDepartments(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, org.Department{ID: r.ID, BranchID: r.BranchID, Name: r.Name, Specialty: deref(r.Specialty)})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateDepartment(ctx context.Context, in org.DepartmentInput) (*org.Department, error) {
	tenantID, actorID := actor(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return nil, apperr.Validation("department name is required")
	}
	var id uuid.UUID
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = orgdb.New(tx).CreateDepartment(ctx, orgdb.CreateDepartmentParams{
			TenantID: tenantID, BranchID: in.BranchID, Name: in.Name, Specialty: strPtr(in.Specialty), CreatedBy: actorID,
		})
		return e
	}); err != nil {
		return nil, mapWriteErr(err, "", "")
	}
	return &org.Department{ID: id, BranchID: in.BranchID, Name: in.Name, Specialty: in.Specialty}, nil
}

func (s *Service) UpdateDepartment(ctx context.Context, id uuid.UUID, in org.DepartmentInput) (*org.Department, error) {
	tenantID, _ := actor(ctx)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return orgdb.New(tx).UpdateDepartment(ctx, orgdb.UpdateDepartmentParams{TenantID: tenantID, ID: id, Name: in.Name, Specialty: strPtr(in.Specialty)})
	}); err != nil {
		return nil, apperr.Internal(err)
	}
	return &org.Department{ID: id, BranchID: in.BranchID, Name: in.Name, Specialty: in.Specialty}, nil
}

func (s *Service) DeleteDepartment(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actor(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return orgdb.New(tx).SoftDeleteDepartment(ctx, orgdb.SoftDeleteDepartmentParams{TenantID: tenantID, ID: id})
	})
}

func (s *Service) ListResources(ctx context.Context) ([]org.Resource, error) {
	tenantID, _ := actor(ctx)
	var out []org.Resource
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := orgdb.New(tx).ListResources(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, org.Resource{ID: r.ID, BranchID: r.BranchID, DepartmentID: r.DepartmentID, Name: r.Name, Type: r.Type})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateResource(ctx context.Context, in org.ResourceInput) (*org.Resource, error) {
	tenantID, actorID := actor(ctx)
	if in.Type != "room" && in.Type != "chair" && in.Type != "equipment" {
		return nil, apperr.Validation("type must be room, chair, or equipment")
	}
	var id uuid.UUID
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = orgdb.New(tx).CreateResource(ctx, orgdb.CreateResourceParams{
			TenantID: tenantID, BranchID: in.BranchID, DepartmentID: in.DepartmentID, Name: in.Name, Type: in.Type, CreatedBy: actorID,
		})
		return e
	}); err != nil {
		return nil, apperr.Internal(err)
	}
	return &org.Resource{ID: id, BranchID: in.BranchID, DepartmentID: in.DepartmentID, Name: in.Name, Type: in.Type}, nil
}

func (s *Service) DeleteResource(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actor(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return orgdb.New(tx).SoftDeleteResource(ctx, orgdb.SoftDeleteResourceParams{TenantID: tenantID, ID: id})
	})
}

// --- helpers ---

func actor(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func strPtr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

func defaultStr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

func jsonOrEmpty(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	return string(raw)
}

func rawOrNil(p *string) json.RawMessage {
	if p == nil || *p == "" {
		return nil
	}
	return json.RawMessage(*p)
}

func mapWriteErr(err error, conflictCode, conflictMsg string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if (strings.Contains(msg, "duplicate key") || strings.Contains(msg, "unique constraint")) && conflictCode != "" {
		return apperr.Conflict(conflictCode, conflictMsg)
	}
	return apperr.Internal(err)
}

// maxPrintSettings bounds the settings document. Real ones are a few KB; the cap is
// there so the column cannot be used as a place to keep arbitrary data.
const maxPrintSettings = 64 * 1024

// maxLogoBytes bounds the decoded logo image.
const maxLogoBytes = 400 * 1024

// logoMagic checks that bytes really are the image type the data URL claims, so the
// column cannot hold a script or an arbitrary file under an image label.
func logoMagic(mime string, b []byte) bool {
	switch mime {
	case "image/png":
		return len(b) > 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/jpeg":
		return len(b) > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF
	case "image/webp":
		return len(b) > 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP"
	}
	return false
}

// checkLogo validates a logo data URL: an image type we draw, within the size cap,
// whose bytes match its type.
func checkLogo(dataURL string) error {
	const marker = ";base64,"
	i := strings.Index(dataURL, marker)
	if !strings.HasPrefix(dataURL, "data:image/") || i < 0 {
		return apperr.Validation("the logo must be a PNG, JPEG or WebP image")
	}
	mime := strings.TrimPrefix(dataURL[:i], "data:")
	raw, e := base64.StdEncoding.DecodeString(dataURL[i+len(marker):])
	if e != nil || !logoMagic(mime, raw) {
		return apperr.Validation("the logo must be a PNG, JPEG or WebP image")
	}
	if len(raw) > maxLogoBytes {
		return apperr.Validation("the logo is too large — use an image under 400 KB")
	}
	return nil
}

func (s *Service) GetPrintSettings(ctx context.Context) (*org.PrintSettings, error) {
	tenantID, _ := actor(ctx)
	out := &org.PrintSettings{Settings: json.RawMessage(`{}`)}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var raw []byte
		var logo *string
		e := tx.QueryRow(ctx, `SELECT settings, logo FROM print_settings WHERE tenant_id = $1`, tenantID).Scan(&raw, &logo)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil // never customised: the defaults apply
		}
		if e != nil {
			return e
		}
		out.Settings = json.RawMessage(raw)
		if logo != nil {
			out.Logo = *logo
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) SavePrintSettings(ctx context.Context, in org.PrintSettingsInput) (*org.PrintSettings, error) {
	tenantID, user := actor(ctx)
	var obj map[string]any
	if len(in.Settings) == 0 || len(in.Settings) > maxPrintSettings || json.Unmarshal(in.Settings, &obj) != nil || obj == nil {
		return nil, apperr.Validation("the print settings are not valid")
	}
	if in.Logo != nil && *in.Logo != "" {
		if e := checkLogo(*in.Logo); e != nil {
			return nil, e
		}
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// The logo is replaced only when the caller said so; the settings always are.
		_, e := tx.Exec(ctx, `
			INSERT INTO print_settings (tenant_id, settings, logo, updated_by)
			VALUES ($1, $2, CASE WHEN $4 THEN NULLIF($3, '') END, $5)
			ON CONFLICT (tenant_id) DO UPDATE
			   SET settings = EXCLUDED.settings,
			       logo = CASE WHEN $4 THEN NULLIF($3, '') ELSE print_settings.logo END,
			       updated_at = now(), updated_by = EXCLUDED.updated_by`,
			tenantID, []byte(in.Settings), deref(in.Logo), in.Logo != nil, user)
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.GetPrintSettings(ctx)
}

func (s *Service) LogPrint(ctx context.Context, kind, ref string) (*org.PrintMark, error) {
	tenantID, user := actor(ctx)
	kind, ref = strings.TrimSpace(kind), strings.TrimSpace(ref)
	if kind == "" || len(kind) > 32 || ref == "" || len(ref) > 64 {
		return nil, apperr.Validation("a document kind and reference are required")
	}
	var m org.PrintMark
	var firstAt, lastAt time.Time
	var firstBy, lastBy *string
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			WITH up AS (
			  INSERT INTO print_log (tenant_id, kind, ref, first_by, last_by)
			  VALUES ($1, $2, $3, $4, $4)
			  ON CONFLICT (tenant_id, kind, ref) DO UPDATE
			     SET count = print_log.count + 1, last_at = now(), last_by = EXCLUDED.last_by
			  RETURNING count, first_at, first_by, last_at, last_by)
			SELECT up.count, up.first_at, coalesce(f.full_name, ''), up.last_at, coalesce(l.full_name, '')
			  FROM up
			  LEFT JOIN users f ON f.id = up.first_by AND f.tenant_id = $1
			  LEFT JOIN users l ON l.id = up.last_by AND l.tenant_id = $1`,
			tenantID, kind, ref, user).Scan(&m.Count, &firstAt, &firstBy, &lastAt, &lastBy)
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	m.FirstAt, m.LastAt = firstAt.Format(time.RFC3339), lastAt.Format(time.RFC3339)
	if firstBy != nil {
		m.FirstBy = *firstBy
	}
	if lastBy != nil {
		m.LastBy = *lastBy
	}
	return &m, nil
}

func (s *Service) PeekPrint(ctx context.Context, kind, ref string) (*org.PrintMark, error) {
	tenantID, _ := actor(ctx)
	kind, ref = strings.TrimSpace(kind), strings.TrimSpace(ref)
	if kind == "" || len(kind) > 32 || ref == "" || len(ref) > 64 {
		return nil, apperr.Validation("a document kind and reference are required")
	}
	m := &org.PrintMark{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var firstAt, lastAt time.Time
		var firstBy, lastBy string
		e := tx.QueryRow(ctx, `
			SELECT p.count, p.first_at, coalesce(f.full_name, ''), p.last_at, coalesce(l.full_name, '')
			  FROM print_log p
			  LEFT JOIN users f ON f.id = p.first_by AND f.tenant_id = p.tenant_id
			  LEFT JOIN users l ON l.id = p.last_by AND l.tenant_id = p.tenant_id
			 WHERE p.tenant_id = $1 AND p.kind = $2 AND p.ref = $3`, tenantID, kind, ref).
			Scan(&m.Count, &firstAt, &firstBy, &lastAt, &lastBy)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil // never printed: count 0
		}
		m.FirstAt, m.FirstBy, m.LastAt, m.LastBy = firstAt.Format(time.RFC3339), firstBy, lastAt.Format(time.RFC3339), lastBy
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return m, nil
}
