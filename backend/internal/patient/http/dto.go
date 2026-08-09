package http

import (
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/patient"
)

// --- requests ---

type patientRequest struct {
	MRN              string `json:"mrn"` // optional: preserve an existing card ID on import
	FirstName        string `json:"first_name" binding:"required"`
	MiddleName       string `json:"middle_name"`
	LastName         string `json:"last_name" binding:"required"`
	Gender           string `json:"gender"`
	DOB              string `json:"dob" binding:"required"`
	NationalID       string `json:"national_id"`
	PassportNo       string `json:"passport_no"`
	Phone            string `json:"phone"`
	Email            string `json:"email"`
	BloodGroup       string `json:"blood_group"`
	Address          any    `json:"address"`
	EmergencyContact any    `json:"emergency_contact"`
	Force            bool   `json:"force"`
}

type allergyRequest struct {
	Substance string `json:"substance" binding:"required"`
	Reaction  string `json:"reaction"`
	Severity  string `json:"severity"`
}

type conditionRequest struct {
	ICDCode     string `json:"icd_code"`
	Description string `json:"description" binding:"required"`
	Status      string `json:"status"`
	OnsetDate   string `json:"onset_date"`
}

type guardianRequest struct {
	GuardianPatientID string `json:"guardian_patient_id"`
	Relationship      string `json:"relationship" binding:"required"`
}

type signUploadRequest struct {
	Filename string `json:"filename" binding:"required"`
	Type     string `json:"type" binding:"required"` // pdf|image|report|scan
}

type recordAttachmentRequest struct {
	Type       string `json:"type" binding:"required"`
	StorageKey string `json:"storage_key" binding:"required"`
	Filename   string `json:"filename" binding:"required"`
	MimeType   string `json:"mime_type" binding:"required"`
	SizeBytes  int64  `json:"size_bytes"`
}

// --- responses (external prefixed IDs) ---

type patientDTO struct {
	ID string `json:"id"`
	patient.Patient
}

func toPatientDTO(p patient.Patient) patientDTO {
	return patientDTO{ID: id.Encode(id.PrefixPatient, p.ID), Patient: p}
}

type summaryDTO struct {
	ID string `json:"id"`
	patient.Summary
}

type duplicateDTO struct {
	ID string `json:"id"`
	patient.Duplicate
}

type allergyDTO struct {
	ID string `json:"id"`
	patient.Allergy
}

type conditionDTO struct {
	ID string `json:"id"`
	patient.Condition
}

type attachmentDTO struct {
	ID string `json:"id"`
	patient.Attachment
}

type guardianDTO struct {
	ID string `json:"id"`
	patient.Guardian
}

type profileDTO struct {
	patientDTO
	Allergies   []allergyDTO    `json:"allergies"`
	Conditions  []conditionDTO  `json:"conditions"`
	Attachments []attachmentDTO `json:"attachments"`
	Guardians   []guardianDTO   `json:"guardians"`
}

func toProfileDTO(p *patient.Profile) profileDTO {
	out := profileDTO{patientDTO: toPatientDTO(p.Patient)}
	for _, a := range p.Allergies {
		out.Allergies = append(out.Allergies, allergyDTO{ID: id.Encode(id.PrefixAllergy, a.ID), Allergy: a})
	}
	for _, c := range p.Conditions {
		out.Conditions = append(out.Conditions, conditionDTO{ID: id.Encode(id.PrefixCondition, c.ID), Condition: c})
	}
	for _, at := range p.Attachments {
		out.Attachments = append(out.Attachments, attachmentDTO{ID: id.Encode(id.PrefixAttachment, at.ID), Attachment: at})
	}
	for _, g := range p.Guardians {
		out.Guardians = append(out.Guardians, guardianDTO{ID: id.Encode(id.PrefixGuardian, g.ID), Guardian: g})
	}
	if out.Allergies == nil {
		out.Allergies = []allergyDTO{}
	}
	if out.Conditions == nil {
		out.Conditions = []conditionDTO{}
	}
	if out.Attachments == nil {
		out.Attachments = []attachmentDTO{}
	}
	if out.Guardians == nil {
		out.Guardians = []guardianDTO{}
	}
	return out
}
