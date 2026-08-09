// Package org defines the public contracts of the organisation module:
// the clinic profile, branches, departments, and bookable resources.
package org

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

type Clinic struct {
	ID       uuid.UUID `json:"-"`
	Name     string    `json:"name"`
	Timezone string    `json:"timezone"`
	Locale   string    `json:"locale"`
}

// Workspace is the tenant's login handle (slug) plus its display name.
type Workspace struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type Branch struct {
	ID           uuid.UUID       `json:"-"`
	ClinicID     uuid.UUID       `json:"-"`
	Name         string          `json:"name"`
	Code         string          `json:"code"`
	Address      string          `json:"address,omitempty"`
	Phone        string          `json:"phone,omitempty"`
	OpeningHours json.RawMessage `json:"opening_hours,omitempty"`
	IsActive     bool            `json:"is_active"`
}

type Department struct {
	ID        uuid.UUID `json:"-"`
	BranchID  uuid.UUID `json:"-"`
	Name      string    `json:"name"`
	Specialty string    `json:"specialty,omitempty"`
}

type Resource struct {
	ID           uuid.UUID  `json:"-"`
	BranchID     uuid.UUID  `json:"-"`
	DepartmentID *uuid.UUID `json:"-"`
	Name         string     `json:"name"`
	Type         string     `json:"type"`
}

// Settings holds the per-clinic flow configuration (Phase 3a).
type Settings struct {
	CardFeeEnabled   bool   `json:"card_fee_enabled"`
	CardFeeAmount    string `json:"card_fee_amount"`
	CardCurrency     string `json:"card_currency"`
	FreeWindowDays   int    `json:"free_window_days"`
	TriageRequired   bool   `json:"triage_required"`
	DoctorAssignment string `json:"doctor_assignment"`
}

// SettingsInput updates the clinic flow settings.
type SettingsInput struct {
	CardFeeEnabled   bool
	CardFeeAmount    string
	CardCurrency     string
	FreeWindowDays   int
	TriageRequired   bool
	DoctorAssignment string
}

type ClinicInput struct{ Name, Timezone, Locale string }

type BranchInput struct {
	ClinicID     *uuid.UUID
	Name         string
	Code         string
	Address      string
	Phone        string
	OpeningHours json.RawMessage
	IsActive     *bool
}

type DepartmentInput struct {
	BranchID  uuid.UUID
	Name      string
	Specialty string
}

type ResourceInput struct {
	BranchID     uuid.UUID
	DepartmentID *uuid.UUID
	Name         string
	Type         string
}

// ModuleFlag is a per-branch feature toggle (e.g. laboratory, pharmacy).
type ModuleFlag struct {
	Flag       string `json:"flag"`
	Enabled    bool   `json:"enabled"`    // effective for the branch (override or tenant default)
	Overridden bool   `json:"overridden"` // true when a branch-specific override exists
}

// BranchUsage reports how many branches exist against the plan's cap.
type BranchUsage struct {
	Used  int  `json:"used"`
	Limit *int `json:"limit,omitempty"` // nil = unlimited
}

// UsageLine is one metered dimension: how much is used vs the effective cap
// (Limit -1 = unlimited). Storage is in bytes; the others are counts.
type UsageLine struct {
	Used  int64 `json:"used"`
	Limit int64 `json:"limit"`
}

// PlanUsage is the tenant's plan name plus usage vs cap for each dimension.
type PlanUsage struct {
	PlanName string    `json:"plan_name"`
	Storage  UsageLine `json:"storage"`
	Patients UsageLine `json:"patients"`
	Users    UsageLine `json:"users"`
	Branches UsageLine `json:"branches"`
}

// Service is the organisation module API.
type Service interface {
	GetClinic(ctx context.Context) (*Clinic, error)
	SaveClinic(ctx context.Context, in ClinicInput) (*Clinic, error)

	GetWorkspace(ctx context.Context) (*Workspace, error)
	UpdateWorkspace(ctx context.Context, slug string) (*Workspace, error)

	GetSettings(ctx context.Context) (*Settings, error)
	SaveSettings(ctx context.Context, in SettingsInput) (*Settings, error)

	ListBranches(ctx context.Context) ([]Branch, error)
	CreateBranch(ctx context.Context, in BranchInput) (*Branch, error)
	UpdateBranch(ctx context.Context, id uuid.UUID, in BranchInput) (*Branch, error)
	DeleteBranch(ctx context.Context, id uuid.UUID) error
	BranchUsage(ctx context.Context) (*BranchUsage, error)
	PlanUsage(ctx context.Context) (*PlanUsage, error)
	GetBranchModules(ctx context.Context, branchID uuid.UUID) ([]ModuleFlag, error)
	SetBranchModules(ctx context.Context, branchID uuid.UUID, modules map[string]*bool) error

	ListDepartments(ctx context.Context) ([]Department, error)
	CreateDepartment(ctx context.Context, in DepartmentInput) (*Department, error)
	UpdateDepartment(ctx context.Context, id uuid.UUID, in DepartmentInput) (*Department, error)
	DeleteDepartment(ctx context.Context, id uuid.UUID) error

	ListResources(ctx context.Context) ([]Resource, error)
	CreateResource(ctx context.Context, in ResourceInput) (*Resource, error)
	DeleteResource(ctx context.Context, id uuid.UUID) error
}
