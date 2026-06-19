// Package scheduling defines the public contracts of the scheduling module:
// appointments (free booking with conflict prevention) and the live department
// queue.
package scheduling

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// BookInput books an appointment (free model: start + duration).
type BookInput struct {
	BranchID     uuid.UUID
	PatientID    uuid.UUID
	ProviderID   uuid.UUID
	DepartmentID *uuid.UUID
	ResourceID   *uuid.UUID
	StartsAt     time.Time
	DurationMin  int
	Reason       string
}

// RescheduleInput changes an appointment's time/provider/resource.
type RescheduleInput struct {
	StartsAt     time.Time
	DurationMin  int
	ProviderID   uuid.UUID
	DepartmentID *uuid.UUID
	ResourceID   *uuid.UUID
	Reason       string
}

// Appointment is an enriched calendar row.
type Appointment struct {
	ID             uuid.UUID  `json:"-"`
	PatientID      uuid.UUID  `json:"-"`
	ProviderID     uuid.UUID  `json:"-"`
	DepartmentID   *uuid.UUID `json:"-"`
	ResourceID     *uuid.UUID `json:"-"`
	StartsAt       time.Time  `json:"starts_at"`
	EndsAt         time.Time  `json:"ends_at"`
	Status         string     `json:"status"`
	Reason         string     `json:"reason,omitempty"`
	PatientName    string     `json:"patient_name"`
	MRN            string     `json:"mrn"`
	ProviderName   string     `json:"provider_name"`
	DepartmentName string     `json:"department_name,omitempty"`
}

// QueueEntry is a row on the department queue board.
type QueueEntry struct {
	ID                 uuid.UUID  `json:"-"`
	PatientID          uuid.UUID  `json:"-"`
	AppointmentID      *uuid.UUID `json:"-"`
	AssignedProviderID *uuid.UUID `json:"-"`
	State              string     `json:"state"`
	Stage              string     `json:"stage"`
	Priority           int        `json:"priority"`
	EnqueuedAt         time.Time  `json:"enqueued_at"`
	CalledAt           *time.Time `json:"called_at,omitempty"`
	StartedAt          *time.Time `json:"started_at,omitempty"`
	EndedAt            *time.Time `json:"ended_at,omitempty"`
	PatientName        string     `json:"patient_name"`
	MRN                string     `json:"mrn"`
	ProviderName       string     `json:"provider_name,omitempty"`
}

// WorklistEntry is a patient on a doctor's personal worklist.
type WorklistEntry struct {
	ID             uuid.UUID  `json:"-"`
	PatientID      uuid.UUID  `json:"-"`
	DepartmentID   uuid.UUID  `json:"-"`
	State          string     `json:"state"`
	Stage          string     `json:"stage"`
	Priority       int        `json:"priority"`
	EnqueuedAt     time.Time  `json:"enqueued_at"`
	CalledAt       *time.Time `json:"called_at,omitempty"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	PatientName    string     `json:"patient_name"`
	MRN            string     `json:"mrn"`
	DepartmentName string     `json:"department_name,omitempty"`
}

// WalkInInput enqueues a patient without a prior appointment.
type WalkInInput struct {
	BranchID     uuid.UUID
	DepartmentID uuid.UUID
	PatientID    uuid.UUID
	Priority     int
	ToTriage     bool
	ProviderID   *uuid.UUID
}

// CheckInInput controls how an appointment patient is routed on check-in.
type CheckInInput struct {
	Priority   int
	ToTriage   bool
	ProviderID *uuid.UUID
}

// Service is the scheduling module API.
type Service interface {
	Book(ctx context.Context, in BookInput) (*Appointment, error)
	List(ctx context.Context, branchID uuid.UUID, from, to time.Time, providerID *uuid.UUID) ([]Appointment, error)
	Reschedule(ctx context.Context, id uuid.UUID, in RescheduleInput) (*Appointment, error)
	SetStatus(ctx context.Context, id uuid.UUID, status, cancelReason string) error
	MarkFollowup(ctx context.Context, id uuid.UUID, freeUntil time.Time) error
	// CheckIn / EnqueueWalkIn return gated=true when an intake charge was raised and
	// the patient must pay before entering the queue (vs. enqueued immediately when free).
	CheckIn(ctx context.Context, id uuid.UUID, in CheckInInput) (gated bool, err error)
	EnqueueWalkIn(ctx context.Context, in WalkInInput) (gated bool, err error)

	ListQueue(ctx context.Context, departmentID uuid.UUID, stage string) ([]QueueEntry, error)
	ListWorklist(ctx context.Context, providerID uuid.UUID) ([]WorklistEntry, error)
	AssignProvider(ctx context.Context, id, providerID uuid.UUID) error
	TransitionQueue(ctx context.Context, id uuid.UUID, state string) error
	SetQueuePriority(ctx context.Context, id uuid.UUID, priority int) error
}
