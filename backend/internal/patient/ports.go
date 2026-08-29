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
	MRN              string // optional: preserve an existing card ID on import; blank = auto-generate
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

// --- legacy spreadsheet import (bulk) ---

// ImportRow is one raw row from a legacy register, exactly as it appeared in the
// spreadsheet. Every field is an unparsed string: cleaning, date detection and
// duplicate matching are the importer's job, so one clinic's formatting quirks
// can't reach the database.
type ImportRow struct {
	RowNumber int    // 1-based line in the source file, for the failure report
	MRN       string // optional legacy card ID
	Name      string // full name, split into first/middle/last
	Phone     string
	Gender    string // Male | M | female | …
	Age       string // years at the time of the visit
	VisitDate string // dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, dd\mm\yyyy or an Excel serial
}

// OnDuplicate decides what happens when a row matches an existing patient.
const (
	DuplicateSkip   = "skip"
	DuplicateUpdate = "update"
)

// Calendars a legacy sheet's dates may be written in.
const (
	CalendarEthiopian = "ethiopian"
	CalendarGregorian = "gregorian"
)

// ImportOptions tunes a run. DryRun validates everything and reports exactly what
// would happen without writing a single row.
type ImportOptions struct {
	DryRun      bool
	OnDuplicate string // skip (default) | update
	// Calendar the source sheet's dates are written in — ethiopian (default, the
	// local norm) or gregorian. Dates are always STORED as Gregorian.
	Calendar string
}

// Row outcomes.
const (
	OutcomeImported  = "imported"
	OutcomeUpdated   = "updated"
	OutcomeDuplicate = "duplicate"
	OutcomeFailed    = "failed"
)

// ImportRowResult is the per-row verdict — the raw values are echoed back so the
// UI can build a "fix these and re-upload" CSV without re-reading the file.
type ImportRowResult struct {
	RowNumber int    `json:"row_number"`
	Name      string `json:"name"`
	Phone     string `json:"phone"`
	Gender    string `json:"gender"`
	Age       string `json:"age"`
	VisitDate string `json:"visit_date"`
	Outcome   string `json:"outcome"`
	Reason    string `json:"reason,omitempty"`  // why it failed / which patient it matched
	MRN       string `json:"mrn,omitempty"`     // card ID of the created/matched patient
	Warning   string `json:"warning,omitempty"` // imported, but something was assumed
}

// ImportReport is the summary shown after a run (and after a dry run).
type ImportReport struct {
	Total         int               `json:"total"`
	Imported      int               `json:"imported"`
	Updated       int               `json:"updated"`
	Duplicates    int               `json:"duplicates"`
	Failed        int               `json:"failed"`
	MissingPhone  int               `json:"missing_phone"`
	MissingGender int               `json:"missing_gender"`
	EstimatedDOB  int               `json:"estimated_dob"`
	DryRun        bool              `json:"dry_run"`
	Rows          []ImportRowResult `json:"rows"`
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

// SearchFilter narrows a patient search. Zero values mean "no filter", so an
// unfiltered search behaves exactly as before.
type SearchFilter struct {
	Query  string
	Gender string // male | female | other | unknown; "" = any
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
	ID         uuid.UUID `json:"-"`
	Type       string    `json:"type"`
	StorageKey string    `json:"-"`
	URL        string    `json:"url"`
	Filename   string    `json:"filename"`
	MimeType   string    `json:"mime_type"`
	SizeBytes  int64     `json:"size_bytes"`
	CreatedAt  time.Time `json:"created_at"`
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
	Overview(ctx context.Context, id uuid.UUID, scope OverviewScope) (*Overview, error)
	Search(ctx context.Context, f SearchFilter, page, pageSize int) (*SearchResult, error)
	Delete(ctx context.Context, id uuid.UUID) error

	// ImportPatients bulk-loads a legacy register. Each row is validated and written
	// in its own transaction: a bad row is reported and skipped, never rolling back
	// the rows that succeeded.
	ImportPatients(ctx context.Context, rows []ImportRow, opts ImportOptions) (*ImportReport, error)

	AddAllergy(ctx context.Context, patientID uuid.UUID, in AllergyInput) (uuid.UUID, error)
	RemoveAllergy(ctx context.Context, patientID, id uuid.UUID) error
	AddCondition(ctx context.Context, patientID uuid.UUID, in ConditionInput) (uuid.UUID, error)
	RemoveCondition(ctx context.Context, patientID, id uuid.UUID) error
	AddGuardian(ctx context.Context, patientID uuid.UUID, in GuardianInput) (uuid.UUID, error)

	SignAttachmentUpload(ctx context.Context, patientID uuid.UUID, in AttachmentSignInput) (storage.UploadTarget, error)
	RecordAttachment(ctx context.Context, patientID uuid.UUID, in AttachmentInput) (*Attachment, error)
	RemoveAttachment(ctx context.Context, patientID, id uuid.UUID) error
}

// The patient page opened on a wall of the same-sized cards — Demographics, then
// Allergies, then Conditions — and answered none of the questions any of the four
// people who open it actually arrive with. Reception wants to know whether this
// person owes money and when they are next booked. Triage wants the last vitals.
// The doctor wants what the patient carries and what they are on. The lab wants
// what is outstanding on the bench. None of that was on the page, and some of it
// had no endpoint at all.
//
// Overview is the "right now" half: the facts that are true of this patient at this
// moment, as opposed to their record. Each block is filled only for a caller
// entitled to it, so the same call serves a cashier and a physician without either
// seeing the other's screen.
type Overview struct {
	HereNow   *Presence    `json:"here_now,omitempty"`
	Money     *MoneyBrief  `json:"money,omitempty"`
	Next      *ApptBrief   `json:"next_appointment,omitempty"`
	LastVisit *VisitBrief  `json:"last_visit,omitempty"`
	Labs      *LabBrief    `json:"labs,omitempty"`
	Vitals    *VitalsBrief `json:"vitals,omitempty"`
}

// Presence is where the patient physically is, if they are in the building.
type Presence struct {
	Kind     string    `json:"kind"` // "queue" | "bed"
	State    string    `json:"state,omitempty"`
	Stage    string    `json:"stage,omitempty"`
	Where    string    `json:"where,omitempty"` // department, or ward / bed
	Provider string    `json:"provider,omitempty"`
	Since    time.Time `json:"since"`
	Nights   int       `json:"nights,omitempty"`
}

type MoneyBrief struct {
	Owed       string     `json:"owed"`
	OldestDays int        `json:"oldest_days"`
	AllAgreed  bool       `json:"all_agreed"`
	LastPaidAt *time.Time `json:"last_paid_at,omitempty"`
}

type ApptBrief struct {
	StartsAt   time.Time `json:"starts_at"`
	Provider   string    `json:"provider,omitempty"`
	Department string    `json:"department,omitempty"`
	IsFollowup bool      `json:"is_followup"`
}

// VisitBrief carries the date for anyone who may open the patient, and the reason
// only for someone allowed to read the clinical record.
type VisitBrief struct {
	At        time.Time `json:"at"`
	Diagnosis string    `json:"diagnosis,omitempty"`
	Provider  string    `json:"provider,omitempty"`
	Open      bool      `json:"open"`
}

type LabBrief struct {
	OnTheBench int        `json:"on_the_bench"` // ordered / collected / in process
	ToValidate int        `json:"to_validate"`  // resulted, not yet validated
	Critical   int        `json:"critical"`
	LastAt     *time.Time `json:"last_at,omitempty"`
}

type VitalsBrief struct {
	RecordedAt time.Time `json:"recorded_at"`
	Systolic   *int      `json:"systolic,omitempty"`
	Diastolic  *int      `json:"diastolic,omitempty"`
	Pulse      *int      `json:"pulse,omitempty"`
	TempC      *string   `json:"temp_c,omitempty"`
	RespRate   *int      `json:"resp_rate,omitempty"`
	SpO2       *int      `json:"spo2,omitempty"`
	WeightKg   *string   `json:"weight_kg,omitempty"`
	HeightCm   *string   `json:"height_cm,omitempty"`
}

// OverviewScope is what the caller is allowed to be told, decided at the HTTP edge
// from the principal's permissions and passed down rather than re-derived here.
type OverviewScope struct {
	Money    bool
	Schedule bool
	Clinical bool
	Labs     bool
	Vitals   bool
}
