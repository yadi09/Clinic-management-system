package http

import (
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/scheduling"
)

// --- requests ---

type bookRequest struct {
	BranchID     string `json:"branch_id" binding:"required"`
	PatientID    string `json:"patient_id" binding:"required"`
	ProviderID   string `json:"provider_id" binding:"required"`
	DepartmentID string `json:"department_id"`
	ResourceID   string `json:"resource_id"`
	StartsAt     string `json:"starts_at" binding:"required"` // RFC3339
	DurationMin  int    `json:"duration_min"`
	Reason       string `json:"reason"`
}

type rescheduleRequest struct {
	StartsAt     string `json:"starts_at" binding:"required"`
	DurationMin  int    `json:"duration_min"`
	ProviderID   string `json:"provider_id" binding:"required"`
	DepartmentID string `json:"department_id"`
	ResourceID   string `json:"resource_id"`
	Reason       string `json:"reason"`
}

type statusRequest struct {
	Status       string `json:"status" binding:"required"`
	CancelReason string `json:"cancel_reason"`
}

type checkInRequest struct {
	Priority int `json:"priority"`
}

type walkInRequest struct {
	BranchID     string `json:"branch_id" binding:"required"`
	DepartmentID string `json:"department_id" binding:"required"`
	PatientID    string `json:"patient_id" binding:"required"`
	Priority     int    `json:"priority"`
}

type transitionRequest struct {
	State string `json:"state" binding:"required"`
}

type priorityRequest struct {
	Priority int `json:"priority"`
}

// --- responses (prefixed external IDs; times serialize as RFC3339) ---

type appointmentDTO struct {
	ID           string  `json:"id"`
	PatientID    string  `json:"patient_id"`
	ProviderID   string  `json:"provider_id"`
	DepartmentID *string `json:"department_id"`
	ResourceID   *string `json:"resource_id"`
	scheduling.Appointment
}

func toAppointmentDTO(a scheduling.Appointment) appointmentDTO {
	return appointmentDTO{
		ID:           id.Encode(id.PrefixAppointment, a.ID),
		PatientID:    id.Encode(id.PrefixPatient, a.PatientID),
		ProviderID:   id.Encode(id.PrefixUser, a.ProviderID),
		DepartmentID: encodePtr(id.PrefixDepartment, a.DepartmentID),
		ResourceID:   encodePtr(id.PrefixResource, a.ResourceID),
		Appointment:  a,
	}
}

type queueEntryDTO struct {
	ID        string `json:"id"`
	PatientID string `json:"patient_id"`
	scheduling.QueueEntry
}

func toQueueDTO(q scheduling.QueueEntry) queueEntryDTO {
	return queueEntryDTO{
		ID:         id.Encode(id.PrefixQueueEntry, q.ID),
		PatientID:  id.Encode(id.PrefixPatient, q.PatientID),
		QueueEntry: q,
	}
}

func encodePtr(prefix string, u *uuid.UUID) *string {
	if u == nil {
		return nil
	}
	s := id.Encode(prefix, *u)
	return &s
}
