package http

import (
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/scheduling"
)

// --- requests ---

type bookRequest struct {
	BranchID          string `json:"branch_id" binding:"required"`
	PatientID         string `json:"patient_id" binding:"required"`
	ProviderID        string `json:"provider_id" binding:"required"`
	DepartmentID      string `json:"department_id"`
	ResourceID        string `json:"resource_id"`
	StartsAt          string `json:"starts_at" binding:"required"` // RFC3339
	DurationMin       int    `json:"duration_min"`
	Reason            string `json:"reason"`
	IsFollowup        bool   `json:"is_followup"`
	FreeUntil         string `json:"free_until"`          // RFC3339; optional
	OriginEncounterID string `json:"origin_encounter_id"` // enc_… the visit that ordered it
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
	Priority   int    `json:"priority"`
	ToTriage   bool   `json:"to_triage"`
	ProviderID string `json:"provider_id"`
	// Rescues an appointment booked before a department was required. Ignored when
	// the appointment already has one.
	DepartmentID string `json:"department_id"`
	// Earlier unpaid bills the patient agreed to pay now.
	SelectChargeIDs []string `json:"select_charge_ids"`
}

type walkInRequest struct {
	// Optional: defaults to the branch this session is working in. Reception sends no
	// branch (it has one active branch, not a choice to make), and requiring it here
	// meant every walk-in from the front desk was refused with a 400.
	BranchID     string `json:"branch_id"`
	DepartmentID string `json:"department_id" binding:"required"`
	PatientID    string `json:"patient_id" binding:"required"`
	Priority     int    `json:"priority"`
	ToTriage     bool   `json:"to_triage"`
	ProviderID   string `json:"provider_id"`
	// Earlier unpaid bills the patient agreed to pay now.
	SelectChargeIDs []string `json:"select_charge_ids"`
}

type transitionRequest struct {
	State string `json:"state" binding:"required"`
}

type priorityRequest struct {
	Priority int `json:"priority"`
}

type assignRequest struct {
	ProviderID string `json:"provider_id" binding:"required"`
}

type reassignRequest struct {
	ProviderID string `json:"provider_id" binding:"required"`
	Note       string `json:"note"`
}

type followupRequest struct {
	FreeUntil string `json:"free_until"` // RFC3339; optional (defaults applied by caller)
}

// --- responses (prefixed external IDs; times serialize as RFC3339) ---

type appointmentDTO struct {
	ID                string  `json:"id"`
	PatientID         string  `json:"patient_id"`
	ProviderID        string  `json:"provider_id"`
	DepartmentID      *string `json:"department_id"`
	ResourceID        *string `json:"resource_id"`
	OrderedBy         *string `json:"ordered_by"`
	OriginEncounterID *string `json:"origin_encounter_id"`
	scheduling.Appointment
}

func toAppointmentDTO(a scheduling.Appointment) appointmentDTO {
	return appointmentDTO{
		ID:                id.Encode(id.PrefixAppointment, a.ID),
		PatientID:         id.Encode(id.PrefixPatient, a.PatientID),
		ProviderID:        id.Encode(id.PrefixUser, a.ProviderID),
		DepartmentID:      encodePtr(id.PrefixDepartment, a.DepartmentID),
		ResourceID:        encodePtr(id.PrefixResource, a.ResourceID),
		OrderedBy:         encodePtr(id.PrefixUser, a.OrderedBy),
		OriginEncounterID: encodePtr(id.PrefixEncounter, a.OriginEncounterID),
		Appointment:       a,
	}
}

type queueEntryDTO struct {
	ID                 string  `json:"id"`
	PatientID          string  `json:"patient_id"`
	AssignedProviderID *string `json:"assigned_provider_id"`
	scheduling.QueueEntry
}

func toQueueDTO(q scheduling.QueueEntry) queueEntryDTO {
	return queueEntryDTO{
		ID:                 id.Encode(id.PrefixQueueEntry, q.ID),
		PatientID:          id.Encode(id.PrefixPatient, q.PatientID),
		AssignedProviderID: encodePtr(id.PrefixUser, q.AssignedProviderID),
		QueueEntry:         q,
	}
}

type worklistDTO struct {
	ID           string `json:"id"`
	PatientID    string `json:"patient_id"`
	DepartmentID string `json:"department_id"`
	scheduling.WorklistEntry
}

func toWorklistDTO(w scheduling.WorklistEntry) worklistDTO {
	return worklistDTO{
		ID:            id.Encode(id.PrefixQueueEntry, w.ID),
		PatientID:     id.Encode(id.PrefixPatient, w.PatientID),
		DepartmentID:  id.Encode(id.PrefixDepartment, w.DepartmentID),
		WorklistEntry: w,
	}
}

func encodePtr(prefix string, u *uuid.UUID) *string {
	if u == nil {
		return nil
	}
	s := id.Encode(prefix, *u)
	return &s
}
