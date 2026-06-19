// Package billing defines the public contracts of the billing module. Phase 3a
// covers only the card / consultation fee (the appointment-gated "free
// follow-up" rule); later phases add invoices, service charges, and price lists.
package billing

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	ReceiptNo     *int64     `json:"receipt_no,omitempty"`
}

// Provider is a staff member who performs a service.
type Provider struct {
	ID       uuid.UUID `json:"-"`
	FullName string    `json:"full_name"`
}

// CashLine / CashSummary power the owner's finance view.
type CashLine struct {
	Source string `json:"source"`
	Total  string `json:"total"`
	Count  int    `json:"count"`
}

// CashGroup is a generic labelled total (by method, by cashier).
type CashGroup struct {
	Label string `json:"label"`
	Total string `json:"total"`
	Count int    `json:"count"`
}

type CashSummary struct {
	Collected        string      `json:"collected"` // net of refunds
	CollectedCount   int         `json:"collected_count"`
	Waived           string      `json:"waived"`
	WaivedCount      int         `json:"waived_count"`
	Outstanding      string      `json:"outstanding"`
	OutstandingCount int         `json:"outstanding_count"`
	Refunded         string      `json:"refunded"`
	RefundedCount    int         `json:"refunded_count"`
	BySource         []CashLine  `json:"by_source"`  // gross collected per line (excludes refunds)
	ByMethod         []CashGroup `json:"by_method"`  // collected per payment method
	ByCashier        []CashGroup `json:"by_cashier"` // collected per cashier
	ByBranch         []CashGroup `json:"by_branch"`  // collected per branch
}

// ExpectedDay is a cashier's drawer for one business day (the Z-report basis).
type ExpectedDay struct {
	BusinessDate   string          `json:"business_date"`
	ByMethod       []CashGroup     `json:"by_method"`
	ExpectedTotal  string          `json:"expected_total"`
	Closed         bool            `json:"closed"`
	Reconciliation *Reconciliation `json:"reconciliation,omitempty"`
}

// CloseDayInput records a counted drawer against the expected total.
type CloseDayInput struct {
	BusinessDate string // YYYY-MM-DD
	Counted      string
	Note         string
}

// Reconciliation is a stored end-of-day cash closeout.
type Reconciliation struct {
	ID            uuid.UUID `json:"-"`
	CashierID     uuid.UUID `json:"-"`
	Cashier       string    `json:"cashier"`
	BusinessDate  string    `json:"business_date"`
	ExpectedTotal string    `json:"expected_total"`
	CountedTotal  string    `json:"counted_total"`
	Variance      string    `json:"variance"`
	Note          string    `json:"note,omitempty"`
	ClosedAt      time.Time `json:"closed_at"`
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
	// Service providers — which staff perform a service.
	SetServiceProviders(ctx context.Context, serviceID uuid.UUID, userIDs []uuid.UUID) error
	ServiceProviderIDs(ctx context.Context, serviceID uuid.UUID) ([]uuid.UUID, error)
	ProvidersForServices(ctx context.Context, serviceIDs []uuid.UUID) ([]Provider, error)

	// Charges + cashier.
	RaiseCharge(ctx context.Context, in ChargeInput) (uuid.UUID, error)
	PendingCharges(ctx context.Context) ([]PendingCharge, error)
	PatientCharges(ctx context.Context, patientID uuid.UUID) ([]ChargeRow, error)
	SettleCharge(ctx context.Context, id uuid.UUID, method string) error
	WaiveCharge(ctx context.Context, id uuid.UUID, reason string) error
	VoidCharge(ctx context.Context, id uuid.UUID, reason string) error
	RefundCharge(ctx context.Context, id uuid.UUID, reason string) error
	WaiverReasons() []string

	// Owner finance view.
	CashSince(ctx context.Context, since time.Time) (*CashSummary, error)

	// Cash control (BILL-B): end-of-day drawer reconciliation (Z-report).
	ExpectedForDay(ctx context.Context, date string) (*ExpectedDay, error)
	CloseDay(ctx context.Context, in CloseDayInput) (*Reconciliation, error)
	Reconciliations(ctx context.Context, all bool) ([]Reconciliation, error)
}

// Charger is the slice of billing that other modules (lab, pharmacy) use to bill
// their own services inside the caller's transaction — so the clinical record and
// its charge commit atomically. Mirrors the tx-passing of events.Publisher.
type Charger interface {
	RaiseChargeTx(ctx context.Context, tx pgx.Tx, in ChargeInput) (uuid.UUID, error)
	// ChargeStatusTx reports a charge's status ('pending'|'paid'|'waived'|'void')
	// for a pre-pay gate; returns NotFound if the charge is missing.
	ChargeStatusTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (string, error)
	// RaiseIntakeChargesTx raises the catalog's default-service charges (routed) for a
	// patient entering via walk-in / appointment check-in, so settlement gates the
	// queue entry. Returns how many charges were raised (0 = no default fee → enqueue free).
	RaiseIntakeChargesTx(ctx context.Context, tx pgx.Tx, in IntakeInput) (int, error)
}

// IntakeInput routes the default intake charges so advanceIfPaid enqueues on payment.
type IntakeInput struct {
	PatientID    uuid.UUID
	BranchID     uuid.UUID
	DepartmentID uuid.UUID
	ToTriage     bool
	ProviderID   *uuid.UUID
}
