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

// Service is the billing module API.
type Service interface {
	Assess(ctx context.Context, in AssessInput) (*Assessment, error)
	Collect(ctx context.Context, in CollectInput) (*Payment, error)
	History(ctx context.Context, patientID uuid.UUID) ([]Payment, error)
}
