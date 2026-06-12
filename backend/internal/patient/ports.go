// Package patient defines the public contracts of the patient bounded module:
// registration, search, profile, clinical lists (allergies/conditions),
// attachments, and guardian links. Other modules depend on these, never on the
// internal service/repo (Part 2 §5.3).
package patient

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/storage"
)

// PatientInput is the create/update payload (DOB as YYYY-MM-DD).
type PatientInput struct {
	FirstName        string
	MiddleName       string
	LastName         string
	Gender           string // male|female|other|unknown
	DOB              string // YYYY-MM-DD
	NationalID       string
	PassportNo       string
	Phone            string
	Email            string
	BloodGroup       string
	Address          json.RawMessage
	EmergencyContact json.RawMessage
	Force            bool // proceed despite duplicate warnings
}

// Patient is the full patient record.
type Patient struct {
	ID               uuid.UUID       `json:"-"`
	MRN              string          `json:"mrn"`
	FirstName        string          `json:"first_name"`
	MiddleName       string          `json:"middle_name,omitempty"`
	LastName         string          `json:"last_name"`
	Gender           string          `json:"gender"`
	DOB              string          `json:"dob"`
	NationalID       string          `json:"national_id,omitempty"`
	PassportNo       string          `json:"passport_no,omitempty"`
	Phone            string          `json:"phone,omitempty"`
	Email            string          `json:"email,omitempty"`
	BloodGroup       string          `json:"blood_group,omitempty"`
	Address          json.RawMessage `json:"address,omitempty"`
	EmergencyContact json.RawMessage `json:"emergency_contact,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
}

// Summary is a search-result row.
type Summary struct {
	ID         uuid.UUID `json:"-"`
	MRN        string    `json:"mrn"`
	FirstName  string    `json:"first_name"`
	MiddleName string    `json:"middle_name,omitempty"`
	LastName   string    `json:"last_name"`
	Gender     string    `json:"gender"`
	DOB        string    `json:"dob"`
	Phone      string    `json:"phone,omitempty"`
	Email      string    `json:"email,omitempty"`
}

// Duplicate is a likely-duplicate match surfaced on create (FR-PAT-03).
type Duplicate struct {
	ID         uuid.UUID `json:"-"`
	MRN        string    `json:"mrn"`
	FullName   string    `json:"full_name"`
	DOB        string    `json:"dob"`
	Phone      string    `json:"phone,omitempty"`
	NationalID string    `json:"national_id,omitempty"`
}

// SearchResult is a paginated patient list.
type SearchResult struct {
	Items    []Summary
	Total    int
	Page     int
	PageSize int
}

// Allergy / Condition / Attachment / Guardian — patient sub-records.
type Allergy struct {
	ID        uuid.UUID `json:"-"`
	Substance string    `json:"substance"`
	Reaction  string    `json:"reaction,omitempty"`
	Severity  string    `json:"severity"`
	CreatedAt time.Time `json:"created_at"`
}

type Condition struct {
	ID          uuid.UUID `json:"-"`
	ICDCode     string    `json:"icd_code,omitempty"`
	Description string    `json:"description"`
	Status      string    `json:"status"`
	OnsetDate   string    `json:"onset_date,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type Attachment struct {
	ID        uuid.UUID `json:"-"`
	Type      string    `json:"type"`
	StorageKey string   `json:"-"`
	URL       string    `json:"url"`
	Filename  string    `json:"filename"`
	MimeType  string    `json:"mime_type"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

type Guardian struct {
	ID                uuid.UUID  `json:"-"`
	GuardianPatientID *uuid.UUID `json:"-"`
	Relationship      string     `json:"relationship"`
	CreatedAt         time.Time  `json:"created_at"`
}

// Profile is a patient plus their clinical lists and attachments.
type Profile struct {
	Patient
	Allergies   []Allergy    `json:"allergies"`
	Conditions  []Condition  `json:"conditions"`
	Attachments []Attachment `json:"attachments"`
	Guardians   []Guardian   `json:"guardians"`
}

// Inputs for sub-records.
type AllergyInput struct{ Substance, Reaction, Severity string }
type ConditionInput struct {
	ICDCode, Description, Status, OnsetDate string
}
type GuardianInput struct {
	GuardianPatientID *uuid.UUID
	Relationship      string
}
type AttachmentSignInput struct {
	Filename string
	Type     string // pdf|image|report|scan
}
type AttachmentInput struct {
	Type, StorageKey, Filename, MimeType string
	SizeBytes                            int64
}

// Service is the patient module API.
type Service interface {
	Create(ctx context.Context, in PatientInput) (*Patient, []Duplicate, error)
	Update(ctx context.Context, id uuid.UUID, in PatientInput) (*Patient, error)
	Get(ctx context.Context, id uuid.UUID) (*Profile, error)
	Search(ctx context.Context, q string, page, pageSize int) (*SearchResult, error)
	Delete(ctx context.Context, id uuid.UUID) error

	AddAllergy(ctx context.Context, patientID uuid.UUID, in AllergyInput) (uuid.UUID, error)
	RemoveAllergy(ctx context.Context, patientID, id uuid.UUID) error
	AddCondition(ctx context.Context, patientID uuid.UUID, in ConditionInput) (uuid.UUID, error)
	RemoveCondition(ctx context.Context, patientID, id uuid.UUID) error
	AddGuardian(ctx context.Context, patientID uuid.UUID, in GuardianInput) (uuid.UUID, error)

	SignAttachmentUpload(ctx context.Context, patientID uuid.UUID, in AttachmentSignInput) (storage.UploadTarget, error)
	RecordAttachment(ctx context.Context, patientID uuid.UUID, in AttachmentInput) (*Attachment, error)
	RemoveAttachment(ctx context.Context, patientID, id uuid.UUID) error
}
