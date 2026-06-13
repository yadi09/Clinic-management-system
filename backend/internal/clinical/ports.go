// Package clinical defines the public contracts of the clinical module: the
// encounter (the visit spine, one per queue entry) and triage vitals. Phase 3b
// extends encounters with clinical notes, diagnoses, and prescriptions.
package clinical

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// VitalsInput is a set of triage measurements (all optional).
type VitalsInput struct {
	Systolic  *int
	Diastolic *int
	Pulse     *int
	RespRate  *int
	Spo2      *int
	TempC     *float64
	WeightKg  *float64
	HeightCm  *float64
	Notes     string
}

// RecordVitalsInput identifies the visit (queue entry) and the measurements.
type RecordVitalsInput struct {
	QueueEntryID uuid.UUID
	PatientID    uuid.UUID
	BranchID     uuid.UUID
	DepartmentID *uuid.UUID
	ProviderID   *uuid.UUID
	Vitals       VitalsInput
}

// Encounter is the visit spine. Opened lazily on the first clinical touch.
type Encounter struct {
	ID           uuid.UUID  `json:"-"`
	PatientID    uuid.UUID  `json:"-"`
	ProviderID   *uuid.UUID `json:"-"`
	DepartmentID *uuid.UUID `json:"-"`
	Status       string     `json:"status"`
	StartedAt    time.Time  `json:"started_at"`
}

// Vitals is a recorded measurement set (decimals rendered as strings).
type Vitals struct {
	ID         uuid.UUID `json:"-"`
	Systolic   *int      `json:"systolic,omitempty"`
	Diastolic  *int      `json:"diastolic,omitempty"`
	Pulse      *int      `json:"pulse,omitempty"`
	RespRate   *int      `json:"resp_rate,omitempty"`
	Spo2       *int      `json:"spo2,omitempty"`
	TempC      *string   `json:"temp_c,omitempty"`
	WeightKg   *string   `json:"weight_kg,omitempty"`
	HeightCm   *string   `json:"height_cm,omitempty"`
	Notes      string    `json:"notes,omitempty"`
	RecordedAt time.Time `json:"recorded_at"`
}

// Service is the clinical module API.
type Service interface {
	// RecordVitals opens (or reuses) the encounter for a queue entry and appends
	// a vitals set.
	RecordVitals(ctx context.Context, in RecordVitalsInput) (*Encounter, *Vitals, error)
	// GetVisit returns the encounter for a queue entry (nil if not opened yet)
	// and its recorded vitals, newest first.
	GetVisit(ctx context.Context, queueEntryID uuid.UUID) (*Encounter, []Vitals, error)
}
