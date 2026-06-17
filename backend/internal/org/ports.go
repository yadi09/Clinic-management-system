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
	PaymentMode      string `json:"payment_mode"` // reception | cashier
}

// SettingsInput updates the clinic flow settings.
type SettingsInput struct {
	CardFeeEnabled   bool
	CardFeeAmount    string
	CardCurrency     string
	FreeWindowDays   int
	TriageRequired   bool
	DoctorAssignment string
	PaymentMode      string
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

// Service is the organisation module API.
type Service interface {
	GetClinic(ctx context.Context) (*Clinic, error)
	SaveClinic(ctx context.Context, in ClinicInput) (*Clinic, error)

	GetSettings(ctx context.Context) (*Settings, error)
	SaveSettings(ctx context.Context, in SettingsInput) (*Settings, error)

	ListBranches(ctx context.Context) ([]Branch, error)
	CreateBranch(ctx context.Context, in BranchInput) (*Branch, error)
	UpdateBranch(ctx context.Context, id uuid.UUID, in BranchInput) (*Branch, error)
	DeleteBranch(ctx context.Context, id uuid.UUID) error

	ListDepartments(ctx context.Context) ([]Department, error)
	CreateDepartment(ctx context.Context, in DepartmentInput) (*Department, error)
	UpdateDepartment(ctx context.Context, id uuid.UUID, in DepartmentInput) (*Department, error)
	DeleteDepartment(ctx context.Context, id uuid.UUID) error

	ListResources(ctx context.Context) ([]Resource, error)
	CreateResource(ctx context.Context, in ResourceInput) (*Resource, error)
	DeleteResource(ctx context.Context, id uuid.UUID) error
}
