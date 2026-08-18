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
	Report(ctx context.Context) (*Report, error)
}
