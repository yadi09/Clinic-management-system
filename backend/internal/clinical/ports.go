// Package clinical defines the public contracts of the clinical module: the
// encounter (the visit spine, one per queue entry) and triage vitals. Phase 3b
// extends encounters with clinical notes, diagnoses, and prescriptions.
package clinical

import (
	"context"
	"encoding/json"
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
	ID              uuid.UUID `json:"-"`
	DrugName        string    `json:"drug_name"`
	Dose            string    `json:"dose,omitempty"`
	Frequency       string    `json:"frequency,omitempty"`
	Duration        string    `json:"duration,omitempty"`
	Instructions    string    `json:"instructions,omitempty"`
	Allergens       []string  `json:"allergens,omitempty"`        // the drug's allergen tags
	AllergyOverride string    `json:"allergy_override,omitempty"` // reason recorded when prescribed despite an allergy
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
	LabReferrals []LabReferral `json:"lab_referrals"`
}

// LabReferral is an external-lab request (and its returned result) for clinics
// without an in-house lab. result_values / result_files are raw JSON passthrough.
type LabReferral struct {
	ID            uuid.UUID       `json:"-"`
	Tests         string          `json:"tests"`
	Indication    string          `json:"indication,omitempty"`
	Status        string          `json:"status"`
	ResultSummary string          `json:"result_summary,omitempty"`
	ResultValues  json.RawMessage `json:"result_values,omitempty"`
	ResultFiles   json.RawMessage `json:"result_files,omitempty"`
	ExternalLab   string          `json:"external_lab,omitempty"`
	ResultedAt    *time.Time      `json:"resulted_at,omitempty"`
	CreatedAt     time.Time       `json:"created_at"`
}

// LabReferralInput requests external lab tests (free-text, one per line).
type LabReferralInput struct {
	Tests      string
	Indication string
}

// LabReferralResultInput records a returned result — any subset may be set.
type LabReferralResultInput struct {
	Summary     string
	ExternalLab string
	Values      json.RawMessage // optional structured rows (raw JSON array)
	Files       json.RawMessage // optional attachment refs (raw JSON array)
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

// HistoryImportInput carries a migrated record: the patient, the date it was
// originally recorded (YYYY-MM-DD; blank = today), and the history split into the
// standard SOAP sections (at least one must be non-empty).
type HistoryImportInput struct {
	PatientID  uuid.UUID
	Date       string
	Subjective string // History (HPI, past/family/personal)
	Objective  string // Examination findings
	Assessment string // Diagnosis / assessment
	Plan       string // Treatment / plan
}

// DiagnosisInput adds a diagnosis — from the catalog (CatalogID set) or free entry.
type DiagnosisInput struct {
	CatalogID   *uuid.UUID
	Code        string
	Description string
	IsPrimary   bool
}

// MedicationInput adds a prescription line (allergy-guarded).
type MedicationInput struct {
	DrugName, Dose, Frequency, Duration, Instructions string
	DrugID                                            *uuid.UUID // optional link to the drug library
	OverrideReason                                    string     // set to prescribe despite an allergy warning
}

// Allergen is one entry of the per-clinic allergen library.
type Allergen struct {
	ID       uuid.UUID `json:"-"`
	Name     string    `json:"name"`
	IsActive bool      `json:"is_active"`
	// What this substance usually does, so recording it against a patient does not
	// mean retyping it. A default, never a constraint — the same allergen puts one
	// patient in a rash and another in anaphylaxis.
	DefaultReaction string `json:"default_reaction,omitempty"`
	DefaultSeverity string `json:"default_severity,omitempty"`
}

// Drug is one entry of the per-clinic drug library, with its default sig and allergen tags.
type Drug struct {
	ID                  uuid.UUID `json:"-"`
	Name                string    `json:"name"`
	DefaultDose         string    `json:"default_dose,omitempty"`
	DefaultFrequency    string    `json:"default_frequency,omitempty"`
	DefaultDuration     string    `json:"default_duration,omitempty"`
	DefaultInstructions string    `json:"default_instructions,omitempty"`
	IsActive            bool      `json:"is_active"`
	Allergens           []string  `json:"allergens"`
}

// AllergenInput / DrugInput carry create/update payloads for the libraries.
type AllergenInput struct {
	Name            string
	IsActive        bool
	DefaultReaction string
	DefaultSeverity string
}
type DrugInput struct {
	Name                string
	DefaultDose         string
	DefaultFrequency    string
	DefaultDuration     string
	DefaultInstructions string
	IsActive            bool
	AllergenIDs         []uuid.UUID
}

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
	// Medical certificates. IssueCertificate computes rest_to from rest_from + days
	// and stamps a per-tenant, per-year reference.
	IssueCertificate(ctx context.Context, patientID uuid.UUID, in CertificateInput) (*Certificate, error)
	ListCertificates(ctx context.Context, patientID uuid.UUID) ([]Certificate, error)
	VoidCertificate(ctx context.Context, id uuid.UUID, reason string) error

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
	MyBoard(ctx context.Context, providerID uuid.UUID, doneSince time.Time, doneUntil *time.Time) (*Board, error)
	History(ctx context.Context, patientID uuid.UUID) ([]HistoryItem, error)
	// ImportHistory stores a migrated (paper / old-system) record as a back-dated,
	// signed historical encounter+note so it appears in the patient's timeline.
	ImportHistory(ctx context.Context, in HistoryImportInput) (uuid.UUID, error)

	// Diagnosis catalog (admin config + doctor search).
	ListCategories(ctx context.Context) ([]DiagnosisCategory, error)
	CreateCategory(ctx context.Context, in CategoryInput) (*DiagnosisCategory, error)
	UpdateCategory(ctx context.Context, id uuid.UUID, in CategoryInput) error
	DeleteCategory(ctx context.Context, id uuid.UUID) error
	SearchCatalog(ctx context.Context, search string, categoryID *uuid.UUID, includeInactive bool) ([]CatalogEntry, error)
	CreateCatalogEntry(ctx context.Context, in CatalogEntryInput) (*CatalogEntry, error)
	UpdateCatalogEntry(ctx context.Context, id uuid.UUID, in CatalogEntryInput) error
	DeleteCatalogEntry(ctx context.Context, id uuid.UUID) error

	// Vitals form configuration (VITALS-A): the per-clinic catalog of vital fields,
	// with plausibility bounds (min/max) and reference ranges (low/high).
	GetVitalFields(ctx context.Context) ([]VitalField, error)
	SaveVitalFields(ctx context.Context, fields []VitalFieldInput) error

	// Drug & allergen libraries (RX-LIB).
	ListAllergens(ctx context.Context, search string, includeInactive bool) ([]Allergen, error)
	CreateAllergen(ctx context.Context, in AllergenInput) (*Allergen, error)
	UpdateAllergen(ctx context.Context, id uuid.UUID, in AllergenInput) error
	DeleteAllergen(ctx context.Context, id uuid.UUID) error
	SearchDrugs(ctx context.Context, search string, includeInactive bool) ([]Drug, error)
	CreateDrug(ctx context.Context, in DrugInput) (*Drug, error)
	UpdateDrug(ctx context.Context, id uuid.UUID, in DrugInput) error
	DeleteDrug(ctx context.Context, id uuid.UUID) error

	// External lab referrals (RX-LAB-REFERRAL) — for clinics without an in-house lab.
	CreateLabReferral(ctx context.Context, encounterID uuid.UUID, in LabReferralInput) (*LabReferral, error)
	RecordLabReferralResult(ctx context.Context, referralID uuid.UUID, in LabReferralResultInput) error
	CancelLabReferral(ctx context.Context, referralID uuid.UUID) error
}

// VitalField is one configurable vital measurement on the triage form. Min/Max are
// plausibility bounds (values outside are rejected at entry); Low/High define the
// reference range used to flag a value Low / Normal / High. Any threshold may be nil.
type VitalField struct {
	Key      string   `json:"key"`
	Label    string   `json:"label"`
	Unit     string   `json:"unit"`
	Decimals int      `json:"decimals"`
	Enabled  bool     `json:"enabled"`
	Required bool     `json:"required"`
	Order    int      `json:"order"`
	Min      *float64 `json:"min,omitempty"`
	Low      *float64 `json:"low,omitempty"`
	High     *float64 `json:"high,omitempty"`
	Max      *float64 `json:"max,omitempty"`
}

// VitalFieldInput is one row of an admin "save vitals form" request.
type VitalFieldInput struct {
	Key      string
	Label    string
	Unit     string
	Decimals int
	Enabled  bool
	Required bool
	Order    int
	Min      *float64
	Low      *float64
	High     *float64
	Max      *float64
}

// --- medical certificates ---------------------------------------------------
//
// The note a patient takes to an employer or a school. It is a legal document: it
// carries a reference number, names the clinician who actually issued it, and is
// re-printable unchanged, so a doubtful employer who telephones can be answered.

// CertKind is what the clinic is attesting.
//
//	sick_leave  unfit for work or school for a stated period
//	fitness     fit to resume duties (the other half of the same conversation)
//	attendance  simply attended on a date — usually all a school needs
type CertKind = string

// Certificate is one issued medical certificate.
type Certificate struct {
	ID            uuid.UUID `json:"-"`
	Ref           string    `json:"ref"` // MC-2026-0041
	Kind          CertKind  `json:"kind"`
	PatientName   string    `json:"patient_name"`
	MRN           string    `json:"mrn"`
	Age           string    `json:"age,omitempty"`
	Gender        string    `json:"gender,omitempty"`
	Diagnosis     string    `json:"diagnosis,omitempty"`
	ShowDiagnosis bool      `json:"show_diagnosis"`
	RestDays      int       `json:"rest_days,omitempty"`
	RestFrom      string    `json:"rest_from,omitempty"`
	RestTo        string    `json:"rest_to,omitempty"`
	Notes         string    `json:"notes,omitempty"`
	IssuedAt      string    `json:"issued_at"`
	IssuedBy      string    `json:"issued_by,omitempty"` // display name of the clinician
	Branch        string    `json:"branch,omitempty"`
	Status        string    `json:"status"`
	VoidReason    string    `json:"void_reason,omitempty"`
}

// CertificateInput issues one. The clinician is taken from the session, never from
// the request: a typed-in doctor name is not attribution, it is a text field.
type CertificateInput struct {
	Kind          CertKind
	Diagnosis     string
	ShowDiagnosis bool
	RestDays      int
	RestFrom      string // YYYY-MM-DD
	Notes         string
}
