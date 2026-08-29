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
	// Who may put this service on a patient: reception | clinician | either.
	// Enforced server-side wherever a charge is raised, not just hidden in the UI.
	AssignableBy string `json:"assignable_by"`
}

// ServiceItemInput is an admin write payload for the catalog.
type ServiceItemInput struct {
	Code, Name, Category, Price string
	AssignableBy                string
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

// ChargeBatchItem is one service line of a reception registration.
type ChargeBatchItem struct {
	ServiceItemID *uuid.UUID
	Source        string
	Description   string
	Amount        string
}

// ChargeBatchInput registers a whole visit's charges at once (reception → cashier).
// Raising them atomically lets the service reject a duplicate registration before
// any line is written, so the same patient can't be billed to the cashier twice.
type ChargeBatchInput struct {
	PatientID    uuid.UUID
	BranchID     uuid.UUID
	DepartmentID uuid.UUID
	ToTriage     bool
	ProviderID   *uuid.UUID
	Items        []ChargeBatchItem
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
	// Who actually took the money. A reprinted receipt used to carry whoever was
	// logged in at the time of printing, which is a different person on a different
	// shift — and the name on a receipt is an accountability record.
	SettledBy string `json:"settled_by,omitempty"`
}

// PatientLedger is a patient's charges plus the totals of the WHOLE account.
//
// The rows are a page (newest 50); the totals are not. A printed statement carries a
// signature and a stamp, and one that silently totals only the newest fifty charges
// understates a long-standing patient's account by however much came before — under
// a heading that says otherwise.
type PatientLedger struct {
	Rows []ChargeRow `json:"rows"`
	// Every non-void, non-refund charge ever raised for this patient.
	Charged string `json:"charged"`
	// Settled minus refunded — what the clinic actually holds.
	Paid       string `json:"paid"`
	Refunded   string `json:"refunded"`
	Awaiting   string `json:"awaiting"`
	Waived     string `json:"waived"`
	TotalCount int    `json:"total_count"`
	Truncated  bool   `json:"truncated"`
}

// PaidLine is one service on a completed payment.
type PaidLine struct {
	Description string `json:"description"`
	Amount      string `json:"amount"`
}

// PaidVisit is a completed checkout (one receipt) on the cashier's "Paid today" list.
type PaidVisit struct {
	ReceiptNo   int64     `json:"receipt_no"`
	PatientID   uuid.UUID `json:"-"`
	PatientName string    `json:"patient_name"`
	MRN         string    `json:"mrn"`
	Total       string    `json:"total"`
	Currency    string    `json:"currency"`
	Method      string    `json:"method,omitempty"`
	// What the desk actually chose ("Telebirr"), and the transaction reference it
	// recorded. Method is the stored key, kept because older receipts have only that.
	MethodLabel string     `json:"method_label,omitempty"`
	Reference   string     `json:"reference,omitempty"`
	SettledAt   *time.Time `json:"settled_at,omitempty"`
	Refunded    bool       `json:"refunded"` // every line reversed
	// The cashier who took the payment. A reprint must name them, not whoever
	// happens to be at the terminal now.
	SettledBy string     `json:"settled_by,omitempty"`
	Lines     []PaidLine `json:"lines"`
}

// VisitSettlement is the result of a one-click visit checkout (all of a patient's
// pending charges settled together under one receipt).
type VisitSettlement struct {
	ReceiptNo int64  `json:"receipt_no"`
	Total     string `json:"total"`
	Count     int    `json:"count"`
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

// SettleInput is how the money arrived.
//
// RailID is the clinic's configured payment method; Method is the older free-text
// value, kept so an unconfigured clinic and any client that has not been updated
// still work exactly as before. Reference is the transaction reference for a
// transfer or wallet payment — the evidence that used to be thrown away.
type SettleInput struct {
	RailID    *uuid.UUID
	Method    string
	Reference string
	// Force takes a payment the bank has contradicted. Requires payment.waive and is
	// recorded on the payment event — it is a decision somebody made, not a default.
	Force       bool
	ForceReason string
	// ChargeIDs limits the checkout to these charges. Empty means every pending
	// charge the patient has, which is what the cashier wants — it is looking at all
	// of them and its button names the true total.
	//
	// Reception needs the opposite. A patient arriving with a 42-day-old 1,200 ETB
	// debt and a 300 ETB visit fee must not have 1,500 taken by a button that says
	// 300. Old debt is surfaced there and settled deliberately, never swept into
	// today's receipt.
	ChargeIDs []uuid.UUID
}

// VerifyInput is a claimed payment to check with the bank.
type VerifyInput struct {
	RailID    *uuid.UUID
	Reference string
	// Expected is what the clinic is owed. Empty skips the amount comparison.
	Expected  string
	PatientID uuid.UUID
}

// VerifyResult is what the desk is told.
type VerifyResult struct {
	State  string `json:"state"` // verified | rejected | review | pending | unchecked
	Reason string `json:"reason"`
	// What the bank says, so the desk can compare it with the patient's phone.
	Amount      string `json:"amount,omitempty"`
	Sender      string `json:"sender,omitempty"`
	Account     string `json:"account,omitempty"`
	When        string `json:"when,omitempty"`
	AlreadyUsed bool   `json:"already_used,omitempty"`
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

// DaySummary is one business day on the cashier's close-out overview: what was
// collected that day and whether it has been closed off (Z-report filed). Days
// with activity OR an existing closeout are listed, so a forgotten day surfaces.
type DaySummary struct {
	BusinessDate  string     `json:"business_date"`
	ExpectedTotal string     `json:"expected_total"`
	Count         int        `json:"count"`
	Closed        bool       `json:"closed"`
	CountedTotal  string     `json:"counted_total,omitempty"`
	Variance      string     `json:"variance,omitempty"`
	Note          string     `json:"note,omitempty"`
	ClosedAt      *time.Time `json:"closed_at,omitempty"`
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
	RaiseChargeBatch(ctx context.Context, in ChargeBatchInput) ([]uuid.UUID, error)
	PendingCharges(ctx context.Context) ([]PendingCharge, error)
	PatientCharges(ctx context.Context, patientID uuid.UUID) (*PatientLedger, error)
	// VerifyPayment asks the bank whether a claimed transfer is real, for this
	// amount, and into this clinic's account. It settles nothing.
	VerifyPayment(ctx context.Context, in VerifyInput) (*VerifyResult, error)
	VerificationAvailable() bool

	SettleCharge(ctx context.Context, id uuid.UUID, in SettleInput) error
	SettleVisit(ctx context.Context, patientID uuid.UUID, in SettleInput) (*VisitSettlement, error)
	// DeferVisit lets a patient be treated now and billed later: the charges stay
	// pending and owed, but stop holding them at the door.
	DeferVisit(ctx context.Context, patientID uuid.UUID, reason string, chargeIDs []uuid.UUID) (int, error)
	WaiveCharge(ctx context.Context, id uuid.UUID, reason string) error
	VoidCharge(ctx context.Context, id uuid.UUID, reason string) error
	RefundCharge(ctx context.Context, id uuid.UUID, reason string) error
	RefundVisit(ctx context.Context, receiptNo int64, reason string) error
	PaymentsSince(ctx context.Context, since time.Time, until *time.Time) ([]PaidVisit, error)
	WaiverReasons() []string

	// Owner finance view.
	CashSince(ctx context.Context, since time.Time, until *time.Time) (*CashSummary, error)

	// Cash control (BILL-B): end-of-day drawer reconciliation (Z-report).
	ExpectedForDay(ctx context.Context, date string) (*ExpectedDay, error)
	// DayCloses lists each business day in [from,to] with its takings and whether
	// it has been closed — so an unclosed earlier day can be caught up.
	DayCloses(ctx context.Context, from, to string) ([]DaySummary, error)
	CloseDay(ctx context.Context, in CloseDayInput) (*Reconciliation, error)
	Reconciliations(ctx context.Context, all bool) ([]Reconciliation, error)
}

// Charger is the slice of billing that other modules (lab, pharmacy) use to bill
// their own services inside the caller's transaction — so the clinical record and
// its charge commit atomically. Mirrors the tx-passing of events.Publisher.
type Charger interface {
	RaiseChargeTx(ctx context.Context, tx pgx.Tx, in ChargeInput) (uuid.UUID, error)
	// VoidChargeTx voids a still-pending charge within the caller's tx — e.g. a
	// module reversing a mistaken collect. Conflict if the charge isn't pending.
	VoidChargeTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) error
	// WaiveChargeTx writes a charge off within the caller's tx — treatment given and
	// deliberately not charged for. Conflict if the charge isn't pending; a reason is
	// required, because "we did not charge for this" must be a recorded decision
	// rather than an absence.
	WaiveChargeTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) error
	// UnwaiveChargeTx voids a written-off charge, so reversing a write-off also stops
	// it counting as money the clinic forgave.
	UnwaiveChargeTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) error
	// ChargeStatusTx reports a charge's status ('pending'|'paid'|'waived'|'void')
	// for a pre-pay gate; returns NotFound if the charge is missing.
	ChargeStatusTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (string, error)
	// RaiseIntakeChargesTx raises the catalog's default-service charges (routed) for a
	// patient entering via walk-in / appointment check-in, so settlement gates the
	// queue entry. Returns how many charges were raised (0 = no default fee → enqueue free).
	RaiseIntakeChargesTx(ctx context.Context, tx pgx.Tx, in IntakeInput) (int, error)
	// RaiseIntakeChargeIDsTx is the same act, reporting WHICH charges it raised, so a
	// caller can collect exactly this visit and not everything the patient owes.
	RaiseIntakeChargeIDsTx(ctx context.Context, tx pgx.Tx, in IntakeInput) ([]uuid.UUID, error)
}

// IntakeInput routes the default intake charges so advanceIfPaid enqueues on payment.
// AppointmentID, when set, lets the intake honour a covered follow-up (free within
// its window): no intake charge is raised and the patient enqueues immediately.
type IntakeInput struct {
	PatientID     uuid.UUID
	BranchID      uuid.UUID
	DepartmentID  uuid.UUID
	ToTriage      bool
	ProviderID    *uuid.UUID
	AppointmentID *uuid.UUID
}
