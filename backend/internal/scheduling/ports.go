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
	ID            uuid.UUID  `json:"-"`
	PatientID     uuid.UUID  `json:"-"`
	AppointmentID *uuid.UUID `json:"-"`
	State         string     `json:"state"`
	Priority      int        `json:"priority"`
	EnqueuedAt    time.Time  `json:"enqueued_at"`
	CalledAt      *time.Time `json:"called_at,omitempty"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	EndedAt       *time.Time `json:"ended_at,omitempty"`
	PatientName   string     `json:"patient_name"`
	MRN           string     `json:"mrn"`
}

// WalkInInput enqueues a patient without a prior appointment.
type WalkInInput struct {
	BranchID     uuid.UUID
	DepartmentID uuid.UUID
	PatientID    uuid.UUID
	Priority     int
}

// Service is the scheduling module API.
type Service interface {
	Book(ctx context.Context, in BookInput) (*Appointment, error)
	List(ctx context.Context, branchID uuid.UUID, from, to time.Time, providerID *uuid.UUID) ([]Appointment, error)
	Reschedule(ctx context.Context, id uuid.UUID, in RescheduleInput) (*Appointment, error)
	SetStatus(ctx context.Context, id uuid.UUID, status, cancelReason string) error
	CheckIn(ctx context.Context, id uuid.UUID, priority int) error
	EnqueueWalkIn(ctx context.Context, in WalkInInput) error

	ListQueue(ctx context.Context, departmentID uuid.UUID) ([]QueueEntry, error)
	TransitionQueue(ctx context.Context, id uuid.UUID, state string) error
	SetQueuePriority(ctx context.Context, id uuid.UUID, priority int) error
}
