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
	// Features is what this plan does and does not include, with the names of the
	// plans that do include the missing ones. It is what lets a clinic owner see
	// why a page is not there and what it would take, rather than a link that
	// silently vanished.
	Features []PlanFeature `json:"features"`
}

// PlanFeature is one paid feature from the clinic's point of view.
type PlanFeature struct {
	Code     string   `json:"code"`
	Name     string   `json:"name"`
	Detail   string   `json:"detail,omitempty"`
	Category string   `json:"category"`
	Included bool     `json:"included"`
	// OnPlans names the active plans of this clinic's type that include it —
	// empty when the clinic already has it.
	OnPlans []string `json:"on_plans,omitempty"`
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

	// activeOnly is what the desk asks for; settings asks for everything so a
	// switched-off rail can be switched back on.
	ListPaymentRails(ctx context.Context, activeOnly bool) ([]PaymentRail, error)
	CreatePaymentRail(ctx context.Context, in PaymentRailInput) (*PaymentRail, error)
	UpdatePaymentRail(ctx context.Context, id uuid.UUID, in PaymentRailInput) (*PaymentRail, error)
	DeletePaymentRail(ctx context.Context, id uuid.UUID) error
}

// PaymentRail is one real way this clinic takes money.
//
// It replaces four hard-coded words (cash, card, mobile, transfer) that were
// duplicated across reception, the cashier and the pharmacy counter. Two of them
// were not payment methods but categories — "mobile" is Telebirr or M-Pesa or CBE
// Birr, and the clinic cannot reconcile a day's takings against a statement called
// "mobile".
//
// BankKey and AccountNumber are the clinic describing how it gets paid. They are
// also, not by accident, exactly what a receipt-verification service needs to check
// that a transfer reached THIS clinic's account.
type PaymentRail struct {
	ID             uuid.UUID `json:"-"`
	Key            string    `json:"key"`   // stable; written to charges.payment_method
	Label          string    `json:"label"` // what the desk reads
	Kind           string    `json:"kind"`  // cash | card | wallet | bank
	BankKey        string    `json:"bank_key,omitempty"`
	AccountName    string    `json:"account_name,omitempty"`
	AccountNumber  string    `json:"account_number,omitempty"`
	NeedsReference bool      `json:"needs_reference"`
	Active         bool      `json:"active"`
	SortOrder      int       `json:"sort_order"`
}

// PaymentRailInput creates or updates a rail. Key is immutable after creation —
// every settled charge and every report groups on it.
type PaymentRailInput struct {
	Key            string
	Label          string
	Kind           string
	BankKey        string
	AccountName    string
	AccountNumber  string
	NeedsReference bool
	Active         bool
	SortOrder      int
}
