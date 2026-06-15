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

// --- Phase 3b: consultation / EMR ---

// PatientBanner is the header strip of the encounter workspace.
type PatientBanner struct {
	PatientID  uuid.UUID `json:"-"`
	Name       string    `json:"name"`
	MRN        string    `json:"mrn"`
	Age        int       `json:"age"`
	Gender     string    `json:"gender"`
	BloodGroup string    `json:"blood_group,omitempty"`
}

// Allergy is a patient allergy shown as a clinical-safety alert.
type Allergy struct {
	Substance string `json:"substance"`
	Severity  string `json:"severity"`
	Reaction  string `json:"reaction,omitempty"`
}

// Note is the SOAP note.
type Note struct {
	Subjective string     `json:"subjective"`
	Objective  string     `json:"objective"`
	Assessment string     `json:"assessment"`
	Plan       string     `json:"plan"`
	Status     string     `json:"status"` // draft | signed
	SignedAt   *time.Time `json:"signed_at,omitempty"`
}

// Diagnosis is an encounter diagnosis (a snapshot of a catalog entry).
type Diagnosis struct {
	ID           uuid.UUID `json:"-"`
	Code         string    `json:"code,omitempty"`
	Description  string    `json:"description"`
	IsPrimary    bool      `json:"is_primary"`
	CategoryName string    `json:"category_name,omitempty"`
}

// Medication is a prescription line.
type Medication struct {
	ID           uuid.UUID `json:"-"`
	DrugName     string    `json:"drug_name"`
	Dose         string    `json:"dose,omitempty"`
	Frequency    string    `json:"frequency,omitempty"`
	Duration     string    `json:"duration,omitempty"`
	Instructions string    `json:"instructions,omitempty"`
}

// Workspace is the full encounter view the doctor opens from the worklist.
type Workspace struct {
	EncounterID  uuid.UUID     `json:"-"`
	Status       string        `json:"status"`
	StartedAt    time.Time     `json:"started_at"`
	BranchID     uuid.UUID     `json:"-"` // for booking a follow-up
	DepartmentID *uuid.UUID    `json:"-"`
	ProviderID   *uuid.UUID    `json:"-"`
	Patient      PatientBanner `json:"patient"`
	Allergies    []Allergy     `json:"allergies"`
	Vitals       []Vitals      `json:"vitals"`
	Note         Note          `json:"note"`
	Diagnoses    []Diagnosis   `json:"diagnoses"`
	Prescription []Medication  `json:"prescription"`
}

// BoardActive is one in-progress encounter on the doctor's "My day" board.
// PendingLabs > 0 (or status == awaiting_results) is the reason it's parked.
type BoardActive struct {
	EncounterID  uuid.UUID  `json:"-"`
	QueueEntryID *uuid.UUID `json:"-"`
	Status       string     `json:"status"`
	StartedAt    time.Time  `json:"started_at"`
	PatientName  string     `json:"patient_name"`
	MRN          string     `json:"mrn"`
	PendingLabs  int        `json:"pending_labs"`
}

// BoardDone is one encounter the doctor closed today.
type BoardDone struct {
	EncounterID uuid.UUID  `json:"-"`
	ClosedAt    *time.Time `json:"closed_at,omitempty"`
	StartedAt   time.Time  `json:"started_at"`
	PatientName string     `json:"patient_name"`
	MRN         string     `json:"mrn"`
}

// Board is the doctor's own active + done-today encounters.
type Board struct {
	Active []BoardActive `json:"active"`
	Done   []BoardDone   `json:"done"`
}

// HistoryItem is one past encounter on the patient timeline.
type HistoryItem struct {
	ID           uuid.UUID `json:"-"`
	StartedAt    time.Time `json:"started_at"`
	Status       string    `json:"status"`
	Type         string    `json:"type"`
	ProviderName string    `json:"provider_name,omitempty"`
	PrimaryDx    string    `json:"primary_dx,omitempty"`
}

// NoteInput saves SOAP fields.
type NoteInput struct{ Subjective, Objective, Assessment, Plan string }

// DiagnosisInput adds a diagnosis — from the catalog (CatalogID set) or free entry.
type DiagnosisInput struct {
	CatalogID   *uuid.UUID
	Code        string
	Description string
	IsPrimary   bool
}

// MedicationInput adds a prescription line (allergy-guarded).
type MedicationInput struct{ DrugName, Dose, Frequency, Duration, Instructions string }

// DiagnosisCategory is an admin-managed disease category.
type DiagnosisCategory struct {
	ID        uuid.UUID `json:"-"`
	Name      string    `json:"name"`
	SortOrder int       `json:"sort_order"`
	IsActive  bool      `json:"is_active"`
}

// CatalogEntry is an admin-managed diagnosis the doctor picks from.
type CatalogEntry struct {
	ID           uuid.UUID `json:"-"`
	CategoryID   uuid.UUID `json:"-"`
	CategoryName string    `json:"category_name"`
	Code         string    `json:"code,omitempty"`
	Name         string    `json:"name"`
	IsActive     bool      `json:"is_active"`
}

// CategoryInput / CatalogEntryInput are admin write payloads.
type CategoryInput struct {
	Name      string
	SortOrder int
	IsActive  bool
}
type CatalogEntryInput struct {
	CategoryID uuid.UUID
	Code       string
	Name       string
	IsActive   bool
}

// Service is the clinical module API.
type Service interface {
	// RecordVitals opens (or reuses) the encounter for a queue entry and appends
	// a vitals set.
	RecordVitals(ctx context.Context, in RecordVitalsInput) (*Encounter, *Vitals, error)
	// GetVisit returns the encounter for a queue entry (nil if not opened yet)
	// and its recorded vitals, newest first.
	GetVisit(ctx context.Context, queueEntryID uuid.UUID) (*Encounter, []Vitals, error)

	// Encounter workspace (Phase 3b).
	OpenEncounter(ctx context.Context, queueEntryID uuid.UUID) (*Workspace, error)
	GetWorkspace(ctx context.Context, encounterID uuid.UUID) (*Workspace, error)
	SaveNote(ctx context.Context, encounterID uuid.UUID, in NoteInput) error
	AddDiagnosis(ctx context.Context, encounterID uuid.UUID, in DiagnosisInput) (*Diagnosis, error)
	RemoveDiagnosis(ctx context.Context, encounterID, diagnosisID uuid.UUID) error
	AddMedication(ctx context.Context, encounterID uuid.UUID, in MedicationInput) (*Medication, error)
	RemoveMedication(ctx context.Context, encounterID, itemID uuid.UUID) error
	SignAndClose(ctx context.Context, encounterID uuid.UUID) error
	// SetAside parks an open encounter as awaiting_results (e.g. labs pending);
	// it stays editable — only SignAndClose locks it.
	SetAside(ctx context.Context, encounterID uuid.UUID) error
	// MyBoard returns the calling doctor's in-progress and done-today encounters.
	MyBoard(ctx context.Context, providerID uuid.UUID) (*Board, error)
	History(ctx context.Context, patientID uuid.UUID) ([]HistoryItem, error)

	// Diagnosis catalog (admin config + doctor search).
	ListCategories(ctx context.Context) ([]DiagnosisCategory, error)
	CreateCategory(ctx context.Context, in CategoryInput) (*DiagnosisCategory, error)
	UpdateCategory(ctx context.Context, id uuid.UUID, in CategoryInput) error
	DeleteCategory(ctx context.Context, id uuid.UUID) error
	SearchCatalog(ctx context.Context, search string, categoryID *uuid.UUID, includeInactive bool) ([]CatalogEntry, error)
	CreateCatalogEntry(ctx context.Context, in CatalogEntryInput) (*CatalogEntry, error)
	UpdateCatalogEntry(ctx context.Context, id uuid.UUID, in CatalogEntryInput) error
	DeleteCatalogEntry(ctx context.Context, id uuid.UUID) error
}
