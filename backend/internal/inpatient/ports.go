// Package inpatient is the per-clinic-gated bed/inpatient surface: wards → beds
// configuration, patient admission/discharge/transfer, and occupancy/revenue
// reporting. Bed fees bill through the billing.Charger spine (source='bed').
package inpatient

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type Ward struct {
	ID       uuid.UUID `json:"-"`
	BranchID uuid.UUID `json:"-"`
	Name     string    `json:"name"`
	IsActive bool      `json:"is_active"`
	BedCount int       `json:"bed_count"`
}

type WardInput struct {
	Name     string
	IsActive *bool
}

type Bed struct {
	ID           uuid.UUID `json:"-"`
	WardID       uuid.UUID `json:"-"`
	WardName     string    `json:"ward_name"`
	Label        string    `json:"label"`
	BedType      string    `json:"bed_type"`
	DailyRate    string    `json:"daily_rate"`
	OutOfService bool      `json:"out_of_service"`
	IsActive     bool      `json:"is_active"`
	Note         string    `json:"note,omitempty"`
}

type BedInput struct {
	WardID       uuid.UUID
	Label        string
	BedType      string
	DailyRate    string
	OutOfService *bool
	IsActive     *bool
	Note         string
}

// BoardBed is a bed on the live board, with derived occupancy.
type BoardBed struct {
	ID           uuid.UUID  `json:"-"`
	WardID       uuid.UUID  `json:"-"`
	WardName     string     `json:"ward_name"`
	Label        string     `json:"label"`
	BedType      string     `json:"bed_type"`
	DailyRate    string     `json:"daily_rate"`
	OutOfService bool       `json:"out_of_service"`
	Occupied     bool       `json:"occupied"`
	AdmissionID  *uuid.UUID `json:"-"`
	PatientID    *uuid.UUID `json:"-"`
	PatientName  string     `json:"patient_name,omitempty"`
	MRN          string     `json:"mrn,omitempty"`
	AdmittedAt   *time.Time `json:"admitted_at,omitempty"`
	Days         int        `json:"days"`
	EstCost      string     `json:"est_cost,omitempty"`
	PaymentDueAt *time.Time `json:"payment_due_at,omitempty"`
	Overdue      bool       `json:"overdue"`

	// What the family has actually paid, and what is still to come. A bed card
	// that shows only a running total tells a nurse nothing they can act on.
	Paid string `json:"paid,omitempty"`
	// Accrued but never raised as a charge: the cashier cannot collect this
	// until someone asks for it, which is what Ask for a top-up does.
	Unbilled      string     `json:"unbilled,omitempty"`
	Outstanding   string     `json:"outstanding,omitempty"`
	CoveredNights int        `json:"covered_nights"`
	CoveredThru   *time.Time `json:"covered_thru,omitempty"`
	// Nights the stay was booked for, when one was given at admission, and the day
	// it was booked to end. The board could say "2 nights" and nothing else: not
	// when the patient came in, not when they are due out, and so not whether they
	// are past it — which is the question a ward round actually asks of a bed.
	PlannedNights     int     `json:"planned_nights,omitempty"`
	ExpectedDischarge *string `json:"expected_discharge,omitempty"`
}

// TopUpInput asks the family for more of the running bed bill. Nights is what staff
// actually think in — "another ten days" — and is converted at the bed's own rate;
// Amount is the escape hatch for a part payment that is not a whole number of nights.
type TopUpInput struct {
	Nights int
	Amount string
}

type AdmitInput struct {
	PatientID         uuid.UUID
	BedID             uuid.UUID
	DepositAmount     string
	PaymentDueAt      *time.Time
	ExpectedDischarge *time.Time
	Note              string
}

// Admission is an admission row (active or for the overdue list).
type Admission struct {
	ID           uuid.UUID  `json:"-"`
	PatientID    uuid.UUID  `json:"-"`
	BedID        uuid.UUID  `json:"-"`
	PatientName  string     `json:"patient_name"`
	MRN          string     `json:"mrn"`
	WardName     string     `json:"ward_name"`
	BedLabel     string     `json:"bed_label"`
	AdmittedAt   time.Time  `json:"admitted_at"`
	DischargedAt *time.Time `json:"discharged_at,omitempty"`
	Status       string     `json:"status"`
	DailyRate    string     `json:"daily_rate"`
	Days         int        `json:"days"`
	EstCost      string     `json:"est_cost"`
	PaymentDueAt *time.Time `json:"payment_due_at,omitempty"`
	Overdue      bool       `json:"overdue"`
}

type WardOccupancy struct {
	Ward     string `json:"ward"`
	Total    int    `json:"total"`
	Occupied int    `json:"occupied"`
}

type Report struct {
	TotalBeds       int             `json:"total_beds"`
	Occupied        int             `json:"occupied"`
	Available       int             `json:"available"`
	ByWard          []WardOccupancy `json:"by_ward"`
	CurrentPatients int             `json:"current_patients"`
	AvgLOSDays      float64         `json:"avg_los_days"`
	BedRevenue      string          `json:"bed_revenue"`
	Overdue         []Admission     `json:"overdue"`
}

// Service is the inpatient module API.
type Service interface {
	ListWards(ctx context.Context) ([]Ward, error)
	CreateWard(ctx context.Context, in WardInput) (*Ward, error)
	UpdateWard(ctx context.Context, id uuid.UUID, in WardInput) error

	ListBeds(ctx context.Context) ([]Bed, error)
	CreateBed(ctx context.Context, in BedInput) (*Bed, error)
	UpdateBed(ctx context.Context, id uuid.UUID, in BedInput) error

	Board(ctx context.Context) ([]BoardBed, error)
	Admit(ctx context.Context, in AdmitInput) (*Admission, error)
	Discharge(ctx context.Context, admissionID uuid.UUID) (*Admission, error)
	Transfer(ctx context.Context, admissionID, newBedID uuid.UUID) error
	TopUp(ctx context.Context, admissionID uuid.UUID, in TopUpInput) (*Admission, error)
	Report(ctx context.Context) (*Report, error)
}
