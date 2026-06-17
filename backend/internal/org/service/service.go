// Package service implements the organisation module use-cases. All access is
// tenant-scoped via kernel/db.WithTx (RLS enforced).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
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
			PaymentMode: r.PaymentMode,
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
	if in.PaymentMode != "reception" && in.PaymentMode != "cashier" {
		in.PaymentMode = "reception"
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
			PaymentMode: in.PaymentMode, TenantID: tenantID, ID: cur.ID,
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
		var e error
		id, e = q.CreateBranch(ctx, orgdb.CreateBranchParams{
			TenantID: tenantID, ClinicID: clinicID, Name: in.Name, Code: in.Code,
			Address: strPtr(in.Address), Phone: strPtr(in.Phone), OpeningHours: jsonOrEmpty(in.OpeningHours), CreatedBy: actorID,
		})
		return e
	})
	if err != nil {
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
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return orgdb.New(tx).SoftDeleteBranch(ctx, orgdb.SoftDeleteBranchParams{TenantID: tenantID, ID: id})
	})
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
