// Package dental is the per-clinic-gated dental surface: a per-patient tooth chart
// (odontogram), scheduled treatment PLANS made of dated SESSIONS (each with its own
// payment, notes/Rx and images), and an installment balance. Session fees bill
// through the billing.Charger spine (source='dental') so the cashier collects them
// and Finance/Z-report see them as their own revenue line.
package dental

import (
	"context"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/storage"
)

// Chart is a patient's odontogram: a map of tooth code (Palmer, e.g. "UR1") to a
// status string. The frontend owns the status vocabulary; we store the map verbatim.
type Chart struct {
	Teeth     map[string]string `json:"teeth"`
	UpdatedAt *string           `json:"updated_at,omitempty"`
}

// Image is a stored dental image (X-ray, before/after), backed by the shared
// attachments table (type='image'); optionally filed under a treatment session
// and categorised (before | after | xray).
type Image struct {
	ID         uuid.UUID `json:"-"`
	SessionID  *string   `json:"session_id,omitempty"`
	Category   string    `json:"category,omitempty"` // before | after | xray | "" (uncategorised)
	StorageKey string    `json:"-"`
	URL        string    `json:"url"`
	Filename   string    `json:"filename"`
	MimeType   string    `json:"mime_type"`
	SizeBytes  int64     `json:"size_bytes"`
	CreatedAt  string    `json:"created_at"`
}

// ImageRecordInput persists image metadata after a direct upload.
type ImageRecordInput struct {
	StorageKey string
	Filename   string
	MimeType   string
	SizeBytes  int64  // client-declared; the server prefers the real stored size when available
	Category   string // before | after | xray | "" (uncategorised)
}

// RxItem is one medication line of a dental prescription.
type RxItem struct {
	DrugName     string `json:"drug_name"`
	Dose         string `json:"dose,omitempty"`
	Frequency    string `json:"frequency,omitempty"`
	Duration     string `json:"duration,omitempty"`
	Instructions string `json:"instructions,omitempty"`
}

// Prescription is a printable medication document attached to a session.
type Prescription struct {
	ID        uuid.UUID `json:"-"`
	Note      string    `json:"note,omitempty"`
	CreatedAt string    `json:"created_at"`
	Items     []RxItem  `json:"items"`
}

// RxItemInput / PrescriptionInput create a prescription with its lines.
type RxItemInput struct {
	DrugName     string
	Dose         string
	Frequency    string
	Duration     string
	Instructions string
}
type PrescriptionInput struct {
	Note  string
	Items []RxItemInput
}

// Session is one dated milestone of a treatment plan.
type Session struct {
	ID            uuid.UUID      `json:"-"`
	Seq           int            `json:"seq"`
	ScheduledDate string         `json:"scheduled_date"` // YYYY-MM-DD
	AmountDue     string         `json:"amount_due"`
	Status        string         `json:"status"`  // planned | done | cancelled
	Payment       string         `json:"payment"` // unpaid | billed | paid (derived from the linked charge)
	Procedure     string         `json:"procedure,omitempty"`
	Tooth         string         `json:"tooth,omitempty"`
	Notes         string         `json:"notes,omitempty"`
	Rx            string         `json:"rx,omitempty"`
	PayLater      bool           `json:"pay_later"`                // doctor rendered service on a promise to pay later
	PayLaterNote  string         `json:"pay_later_note,omitempty"` // the recorded promise/reason
	Images        []Image        `json:"images"`
	Prescriptions []Prescription `json:"prescriptions"`
}

// Plan is a scheduled dental treatment (parent of sessions).
type Plan struct {
	ID            uuid.UUID `json:"-"`
	Title         string    `json:"title"`
	Tooth         string    `json:"tooth,omitempty"`
	TotalAmount   string    `json:"total_amount"`
	StartDate     string    `json:"start_date"`
	IntervalUnit  string    `json:"interval_unit"` // day | week | month
	IntervalCount int       `json:"interval_count"`
	SessionCount  int       `json:"session_count"`
	Deadline      string    `json:"deadline,omitempty"`
	Status        string    `json:"status"` // active | completed | cancelled
	Note          string    `json:"note,omitempty"`
	CreatedAt     string    `json:"created_at"`
	Sessions      []Session `json:"sessions"`
}

// SessionSeed is one concrete session from the create preview (date + amount).
type SessionSeed struct {
	ScheduledDate string
	AmountDue     string
}

// PlanInput creates a plan. When Sessions is empty the schedule is generated from
// start_date + interval + session_count with the total split across them.
type PlanInput struct {
	Title         string
	Tooth         string
	TotalAmount   string
	StartDate     string // YYYY-MM-DD
	IntervalUnit  string // day | week | month
	IntervalCount int
	SessionCount  int
	Note          string
	Sessions      []SessionSeed // optional per-session overrides from the preview
}

// PlanUpdate edits plan-level fields (pointers = leave unchanged).
type PlanUpdate struct {
	Title  *string
	Tooth  *string
	Note   *string
	Status *string
}

// SessionUpdate edits one session (pointers/empty = leave unchanged).
type SessionUpdate struct {
	ScheduledDate string
	AmountDue     string
	Status        string
	Procedure     *string
	Tooth         *string
	Notes         *string
	Rx            *string
}

// Balance is the money picture: owed across sessions vs settled dental payments.
// Due is the actionable debt — service already given (session done or pay-later)
// but not yet paid; Overdue = Due > 0.
type Balance struct {
	Owed    string `json:"owed"`
	Paid    string `json:"paid"` // settled MINUS refunded — money actually retained
	Balance string `json:"balance"`
	// Raised and sitting with the cashier. Reported separately and excluded from Due:
	// counting queued money as owed is what made the desk chase patients twice.
	AtCashier string `json:"at_cashier"`
	// Formally forgiven. Neither owed nor collected; shown so it is not mistaken for
	// either, and so a waived fee can never be billed a second time.
	Waived  string `json:"waived"`
	Due     string `json:"due"`
	Overdue bool   `json:"overdue"`
}

// Summary is the whole workspace in one call.
type Summary struct {
	Chart      Chart   `json:"chart"`
	Plans      []Plan  `json:"plans"`
	Balance    Balance `json:"balance"`
	ImageLimit int     `json:"image_limit"` // plan's images-per-patient cap; -1 = unlimited
}

// MedicalHistory is the patient's pre-treatment health questionnaire. Answers are
// stored verbatim as a key→value map; the question catalogue lives in the frontend
// (same contract as the tooth chart) so a clinic's form can change without a
// migration. ReviewedAt is what makes it trustworthy — an old history is not one.
type MedicalHistory struct {
	Answers    map[string]string `json:"answers"`
	Notes      string            `json:"notes,omitempty"`
	ReviewedAt string            `json:"reviewed_at,omitempty"`
	ReviewedBy string            `json:"reviewed_by,omitempty"` // display name of the clinician
	Recorded   bool              `json:"recorded"`              // false = never taken
}

// MedicalHistoryInput saves (or re-confirms) the questionnaire.
type MedicalHistoryInput struct {
	Answers map[string]string
	Notes   string
}

// ExamProcedure is one line of the per-tooth work table on an examination.
type ExamProcedure struct {
	Tooth     string `json:"tooth,omitempty"`
	Procedure string `json:"procedure,omitempty"`
	Notes     string `json:"notes,omitempty"`
}

// Exam is a dated clinical examination: why the patient came, what was found on
// examining them, what was investigated, and what the clinician concluded. It is
// the record that justifies a treatment plan.
//
// Not a per-session form — see 00046. A session records what was DONE; an
// examination records the assessment, taken at a first visit, a new complaint or a
// recall. SessionID links the two when the examination happened at a session.
//
// The multi-select fields hold option keys whose catalogue lives in the frontend
// (same contract as the tooth chart), so a clinic's form can grow without a migration.
type Exam struct {
	ID                   uuid.UUID       `json:"-"`
	SessionID            *uuid.UUID      `json:"-"`          // encoded by the DTO layer
	VisitDate            string          `json:"visit_date"` // YYYY-MM-DD
	ChiefComplaint       string          `json:"chief_complaint,omitempty"`
	HPI                  string          `json:"hpi,omitempty"`
	PastDentalHistory    string          `json:"past_dental_history,omitempty"`
	Extraoral            []string        `json:"extraoral"`
	ExtraoralNotes       string          `json:"extraoral_notes,omitempty"`
	Intraoral            []string        `json:"intraoral"`
	IntraoralNotes       string          `json:"intraoral_notes,omitempty"`
	Investigations       []string        `json:"investigations"`
	InvestigationResults string          `json:"investigation_results,omitempty"`
	Diagnosis            string          `json:"diagnosis,omitempty"`
	TreatmentPlan        string          `json:"treatment_plan,omitempty"`
	TreatmentGiven       []string        `json:"treatment_given"`
	Anaesthesia          string          `json:"anaesthesia,omitempty"`
	Complications        string          `json:"complications,omitempty"`
	Procedures           []ExamProcedure `json:"procedures"`
	Postop               string          `json:"postop,omitempty"`
	RecordedBy           string          `json:"recorded_by,omitempty"` // display name of the clinician
	CreatedAt            string          `json:"created_at"`
	UpdatedAt            string          `json:"updated_at"`
}

// ExamInput creates or replaces an examination. Every field is written on save —
// this is one form submitted whole, not a patch.
type ExamInput struct {
	SessionID            *uuid.UUID
	VisitDate            string
	ChiefComplaint       string
	HPI                  string
	PastDentalHistory    string
	Extraoral            []string
	ExtraoralNotes       string
	Intraoral            []string
	IntraoralNotes       string
	Investigations       []string
	InvestigationResults string
	Diagnosis            string
	TreatmentPlan        string
	TreatmentGiven       []string
	Anaesthesia          string
	Complications        string
	Procedures           []ExamProcedure
	Postop               string
}

// Outstanding is one patient on the "who owes for treatment" overview.
type Outstanding struct {
	PatientID   uuid.UUID `json:"-"`
	PatientName string    `json:"patient_name"`
	MRN         string    `json:"mrn"`
	Balance     string    `json:"balance"`
}

// SessionCalItem is one treatment session placed on the clinic calendar (all
// patients, a date range) so follow-up visits show alongside appointments.
type SessionCalItem struct {
	SessionID     uuid.UUID `json:"-"`
	PlanID        uuid.UUID `json:"-"`
	PatientID     uuid.UUID `json:"-"`
	PatientName   string    `json:"patient_name"`
	MRN           string    `json:"mrn"`
	ScheduledDate string    `json:"scheduled_date"`
	Seq           int       `json:"seq"`
	SessionCount  int       `json:"session_count"`
	Title         string    `json:"title"` // plan title
	Procedure     string    `json:"procedure,omitempty"`
	Tooth         string    `json:"tooth,omitempty"`
	AmountDue     string    `json:"amount_due"`
	Status        string    `json:"status"`  // planned | done
	Payment       string    `json:"payment"` // unpaid | billed | paid
	PayLater      bool      `json:"pay_later"`
}

// Service is the dental module API.
type Service interface {
	Summary(ctx context.Context, patientID uuid.UUID) (*Summary, error)

	GetChart(ctx context.Context, patientID uuid.UUID) (*Chart, error)
	SaveChart(ctx context.Context, patientID uuid.UUID, teeth map[string]string) (*Chart, error)

	// Medical history (pre-treatment health questionnaire). Deliberately NOT part of
	// Summary: Summary is readable by the front desk, and this is clinical.
	GetMedicalHistory(ctx context.Context, patientID uuid.UUID) (*MedicalHistory, error)
	SaveMedicalHistory(ctx context.Context, patientID uuid.UUID, in MedicalHistoryInput) (*MedicalHistory, error)

	// Treatment plans + sessions.
	ListPlans(ctx context.Context, patientID uuid.UUID) ([]Plan, error)
	CreatePlan(ctx context.Context, patientID uuid.UUID, in PlanInput) (*Plan, error)
	UpdatePlan(ctx context.Context, patientID, planID uuid.UUID, in PlanUpdate) error
	DeletePlan(ctx context.Context, patientID, planID uuid.UUID) error
	UpdateSession(ctx context.Context, patientID, sessionID uuid.UUID, in SessionUpdate) error
	// RescheduleSession moves a still-planned session to another date and nothing
	// else. Split out from UpdateSession so the front desk can answer "can I come
	// on Thursday instead?" without being handed the clinical record — see the
	// permission notes in dental/http/routes.go.
	RescheduleSession(ctx context.Context, patientID, sessionID uuid.UUID, date string) error
	// CollectSession raises this session's amount as a dental charge (→ cashier).
	CollectSession(ctx context.Context, patientID, sessionID uuid.UUID) error
	// UncollectSession reverses a mistaken collect by voiding the still-pending
	// charge so the cashier can no longer settle it; the session returns to unpaid.
	UncollectSession(ctx context.Context, patientID, sessionID uuid.UUID) error
	// CollectSessions bills several sessions in one go — the front desk settling a
	// whole treatment plan. Sessions already billed or paid are skipped, not failed.
	// Passing no ids bills every outstanding session the patient has.
	CollectSessions(ctx context.Context, patientID uuid.UUID, sessionIDs []uuid.UUID) (billed int, total string, err error)
	// SetPayLater flags (or clears) a session as service-given-on-a-promise-to-pay.
	SetPayLater(ctx context.Context, patientID, sessionID uuid.UUID, on bool, note string) error

	// Examinations — the clinical assessment behind the treatment. Clinician only:
	// like medical history, these are deliberately absent from Summary so the front
	// desk's read access can never surface them.
	ListExams(ctx context.Context, patientID uuid.UUID) ([]Exam, error)
	CreateExam(ctx context.Context, patientID uuid.UUID, in ExamInput) (*Exam, error)
	UpdateExam(ctx context.Context, patientID, examID uuid.UUID, in ExamInput) (*Exam, error)
	DeleteExam(ctx context.Context, patientID, examID uuid.UUID) error

	// Prescriptions (printable) attached to a session.
	AddPrescription(ctx context.Context, patientID, sessionID uuid.UUID, in PrescriptionInput) (*Prescription, error)
	DeletePrescription(ctx context.Context, patientID, prescriptionID uuid.UUID) error

	Outstanding(ctx context.Context) ([]Outstanding, error)
	// UnbilledTreatment lists delivered treatment that nobody has billed — the
	// clinic-wide safety net for the removed billing gate.
	UnbilledTreatment(ctx context.Context, from, to string, limit, offset int) (*Unbilled, error)
	// SessionsInRange lists all patients' sessions scheduled within [from,to] for the
	// clinic calendar (follow-up visits shown next to appointments).
	SessionsInRange(ctx context.Context, from, to string) ([]SessionCalItem, error)

	// Images (X-rays, before/after) — optionally scoped to a session (nil = general).
	SignImageUpload(ctx context.Context, patientID uuid.UUID, filename, mime string) (storage.UploadTarget, error)
	RecordImage(ctx context.Context, patientID uuid.UUID, sessionID *uuid.UUID, in ImageRecordInput) (*Image, error)
	ListImages(ctx context.Context, patientID uuid.UUID, sessionID *uuid.UUID) ([]Image, error)
	DeleteImage(ctx context.Context, patientID, imageID uuid.UUID) error
}

// UnbilledRow is one delivered-but-unpaid treatment on the clinic-wide report.
//
// This is the control that replaced the billing gate. Recording a visit no longer
// requires money to move first — the clinic's rule is that a patient may be treated
// on a promise to pay — so something has to make sure the promise is not simply
// forgotten. Nothing did: Cure Dental was carrying 11,500 ETB of delivered treatment
// that no screen in the product would ever have raised its hand about.
type UnbilledRow struct {
	SessionID     uuid.UUID `json:"-"`
	PatientID     uuid.UUID `json:"-"`
	MRN           string    `json:"mrn"`
	PatientName   string    `json:"patient_name"`
	Phone         string    `json:"phone,omitempty"` // so the desk can actually chase it
	PlanTitle     string    `json:"plan_title"`
	Procedure     string    `json:"procedure,omitempty"`
	Tooth         string    `json:"tooth,omitempty"`
	Seq           int       `json:"seq"`
	SessionCount  int       `json:"session_count"`
	TreatmentDate string    `json:"treatment_date"` // delivered-on, falling back to scheduled
	DaysUnbilled  int       `json:"days_unbilled"`
	Amount        string    `json:"amount"`
	// never_billed | bill_withdrawn | refunded — three different actions, never summed
	// into one headline.
	Lane         string `json:"lane"`
	PayLater     bool   `json:"pay_later"`
	PayLaterNote string `json:"pay_later_note,omitempty"`
	Clinician    string `json:"clinician,omitempty"`
	Branch       string `json:"branch,omitempty"`
}

// Unbilled is the report plus its true totals. The totals are computed over the
// WHOLE result, not the returned page — a header reading "142,000 ETB" that only
// counts the first fifty rows is the same silent understatement as the truncated
// statement, in the place it matters most.
type Unbilled struct {
	Rows    []UnbilledRow `json:"rows"`
	Total   string        `json:"total"`
	Count   int           `json:"count"`
	HasMore bool          `json:"has_more"`
	// Promised but NOT yet delivered — shown apart because billing it would charge
	// for a visit that has not happened. These exist because "pay later" used to be
	// how the record form was unlocked.
	PromisedTotal string `json:"promised_total"`
	PromisedCount int    `json:"promised_count"`
}
