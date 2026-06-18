// Package billing defines the public contracts of the billing module. Phase 3a
// covers only the card / consultation fee (the appointment-gated "free
// follow-up" rule); later phases add invoices, service charges, and price lists.
package billing

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Assessment is the card-fee decision for a visit.
type Assessment struct {
	RequiresPayment bool   `json:"requires_payment"`
	CardEnabled     bool   `json:"card_enabled"`
	Amount          string `json:"amount"`
	Currency        string `json:"currency"`
	Reason          string `json:"reason"`
}

// AssessInput identifies the patient and, when checking in for an appointment,
// that appointment (so a covered follow-up can be detected).
type AssessInput struct {
	PatientID     uuid.UUID
	AppointmentID *uuid.UUID
}

// CollectInput records a card-fee payment (or a waiver).
type CollectInput struct {
	PatientID     uuid.UUID
	BranchID      uuid.UUID
	AppointmentID *uuid.UUID
	Waived        bool
	WaiveReason   string
}

// Payment is a recorded card-fee receipt.
type Payment struct {
	ID          uuid.UUID `json:"-"`
	Amount      string    `json:"amount"`
	Currency    string    `json:"currency"`
	Waived      bool      `json:"waived"`
	WaiveReason string    `json:"waive_reason,omitempty"`
	PaidAt      time.Time `json:"paid_at"`
}

// ---- Billing-1: service catalog + charges + cashier + cash summary ----

// ServiceItem is a billable service in the catalog (what's billable, how much).
type ServiceItem struct {
	ID        uuid.UUID `json:"-"`
	Code      string    `json:"code"`
	Name      string    `json:"name"`
	Category  string    `json:"category"`
	Price     string    `json:"price"`
	Currency  string    `json:"currency"`
	IsActive  bool      `json:"is_active"`
	IsDefault bool      `json:"is_default"`
}

// ServiceItemInput is an admin write payload for the catalog.
type ServiceItemInput struct {
	Code, Name, Category, Price string
}

// ChargeInput raises a charge against a patient. Routing fields are set only for a
// cashier-mode consultation charge (so settlement can enqueue the patient).
type ChargeInput struct {
	PatientID     uuid.UUID
	EncounterID   *uuid.UUID
	ServiceItemID *uuid.UUID
	Source        string
	Description   string
	Amount        string
	BranchID      *uuid.UUID
	DepartmentID  *uuid.UUID
	ToTriage      bool
	ProviderID    *uuid.UUID
}

// PendingCharge is a row on the cashier's pending-payments worklist.
type PendingCharge struct {
	ID          uuid.UUID `json:"-"`
	Source      string    `json:"source"`
	Description string    `json:"description"`
	Amount      string    `json:"amount"`
	Currency    string    `json:"currency"`
	CreatedAt   time.Time `json:"created_at"`
	PatientID   uuid.UUID `json:"-"`
	PatientName string    `json:"patient_name"`
	MRN         string    `json:"mrn"`
}

// ChargeRow is one charge on a patient's billing history.
type ChargeRow struct {
	ID            uuid.UUID  `json:"-"`
	Source        string     `json:"source"`
	Description   string     `json:"description"`
	Amount        string     `json:"amount"`
	Currency      string     `json:"currency"`
	Status        string     `json:"status"`
	PaymentMethod string     `json:"payment_method,omitempty"`
	WaiveReason   string     `json:"waive_reason,omitempty"`
	SettledAt     *time.Time `json:"settled_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
}

// CashLine / CashSummary power the owner's finance view.
type CashLine struct {
	Source string `json:"source"`
	Total  string `json:"total"`
	Count  int    `json:"count"`
}
type CashSummary struct {
	Collected        string     `json:"collected"`
	CollectedCount   int        `json:"collected_count"`
	Waived           string     `json:"waived"`
	WaivedCount      int        `json:"waived_count"`
	Outstanding      string     `json:"outstanding"`
	OutstandingCount int        `json:"outstanding_count"`
	BySource         []CashLine `json:"by_source"`
}

// Service is the billing module API.
type Service interface {
	Assess(ctx context.Context, in AssessInput) (*Assessment, error)
	Collect(ctx context.Context, in CollectInput) (*Payment, error)
	History(ctx context.Context, patientID uuid.UUID) ([]Payment, error)

	// Service catalog.
	ListServices(ctx context.Context, activeOnly bool) ([]ServiceItem, error)
	CreateService(ctx context.Context, in ServiceItemInput) (*ServiceItem, error)
	UpdateService(ctx context.Context, id uuid.UUID, in ServiceItemInput) error
	SetServiceActive(ctx context.Context, id uuid.UUID, active bool) error
	SetServiceDefault(ctx context.Context, id uuid.UUID, isDefault bool) error
	DeleteService(ctx context.Context, id uuid.UUID) error

	// Charges + cashier.
	RaiseCharge(ctx context.Context, in ChargeInput) (uuid.UUID, error)
	PendingCharges(ctx context.Context) ([]PendingCharge, error)
	PatientCharges(ctx context.Context, patientID uuid.UUID) ([]ChargeRow, error)
	SettleCharge(ctx context.Context, id uuid.UUID, method string) error
	WaiveCharge(ctx context.Context, id uuid.UUID, reason string) error
	WaiverReasons() []string

	// Owner finance view.
	CashSince(ctx context.Context, since time.Time) (*CashSummary, error)
}
