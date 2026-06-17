// Package lab defines the public contracts of the laboratory module (Phase 5a):
// the test catalog, orders (from an encounter), the technician worklist
// (accession → result entry → validation), and results back to the doctor.
package lab

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// LabTest is a catalog test/panel.
type LabTest struct {
	ID           uuid.UUID `json:"-"`
	Code         string    `json:"code"`
	Name         string    `json:"name"`
	Specimen     string    `json:"specimen,omitempty"`
	IsActive     bool      `json:"is_active"`
	AnalyteCount int       `json:"analyte_count"`
}

// Analyte is a measurable component of a test, with reference/critical ranges.
type Analyte struct {
	ID           uuid.UUID `json:"-"`
	Name         string    `json:"name"`
	Unit         string    `json:"unit,omitempty"`
	RefLow       string    `json:"ref_low,omitempty"`
	RefHigh      string    `json:"ref_high,omitempty"`
	CriticalLow  string    `json:"critical_low,omitempty"`
	CriticalHigh string    `json:"critical_high,omitempty"`
}

// OrderInput is a doctor's lab order (provider = the acting user).
type OrderInput struct {
	EncounterID  *uuid.UUID
	PatientID    uuid.UUID
	Priority     string
	ClinicalNote string
	TestIDs      []uuid.UUID
}

// OrderItemBrief is one test (sample) on an order.
type OrderItemBrief struct {
	ID       uuid.UUID `json:"-"`
	SampleNo int64     `json:"sample_no"`
	Status   string    `json:"status"`
	TestName string    `json:"test_name"`
}

// Order is a created lab order.
type Order struct {
	ID           uuid.UUID        `json:"-"`
	OrderNo      int64            `json:"order_no"`
	Priority     string           `json:"priority"`
	ClinicalNote string           `json:"clinical_note,omitempty"`
	CreatedAt    time.Time        `json:"created_at"`
	Items        []OrderItemBrief `json:"items"`
}

// WorklistItem is a row on the lab technician's worklist.
type WorklistItem struct {
	ID          uuid.UUID `json:"-"`
	SampleNo    int64     `json:"sample_no"`
	Status      string    `json:"status"`
	OrderedAt   time.Time `json:"ordered_at"`
	Priority    string    `json:"priority"`
	PatientName string    `json:"patient_name"`
	MRN         string    `json:"mrn"`
	TestName    string    `json:"test_name"`
}

// AnalyteResult is an analyte row with its current value/flag (result entry + display).
type AnalyteResult struct {
	AnalyteID uuid.UUID `json:"-"`
	Name      string    `json:"name"`
	Unit      string    `json:"unit,omitempty"`
	RefLow    string    `json:"ref_low,omitempty"`
	RefHigh   string    `json:"ref_high,omitempty"`
	Value     string    `json:"value,omitempty"`
	Flag      string    `json:"flag"`
}

// OrderItemDetail is the accession / result-entry view for one sample.
type OrderItemDetail struct {
	ID             uuid.UUID       `json:"-"`
	SampleNo       int64           `json:"sample_no"`
	Status         string          `json:"status"`
	Specimen       string          `json:"specimen,omitempty"`
	TestName       string          `json:"test_name"`
	PatientName    string          `json:"patient_name"`
	MRN            string          `json:"mrn"`
	Priority       string          `json:"priority"`
	ClinicalNote   string          `json:"clinical_note,omitempty"`
	OrderedBy      string          `json:"ordered_by,omitempty"`
	Critical       bool            `json:"critical"`
	NotifiedAt     *time.Time      `json:"notified_at,omitempty"`
	NotifiedByName string          `json:"notified_by,omitempty"`
	Analytes       []AnalyteResult `json:"analytes"`
}

// InboxItem is one returned result on the ordering doctor's results inbox.
type InboxItem struct {
	ID            uuid.UUID  `json:"-"`
	EncounterID   *uuid.UUID `json:"-"`
	SampleNo      int64      `json:"sample_no"`
	TestName      string     `json:"test_name"`
	PatientName   string     `json:"patient_name"`
	MRN           string     `json:"mrn"`
	Priority      string     `json:"priority"`
	ValidatedAt   *time.Time `json:"validated_at,omitempty"`
	Critical      bool       `json:"critical"`
	NotifiedAt    *time.Time `json:"notified_at,omitempty"`
	CriticalCount int        `json:"critical_count"`
	AbnormalCount int        `json:"abnormal_count"`
}

// ResultInput is one analyte value entered by the technician.
type ResultInput struct {
	AnalyteID uuid.UUID
	Value     string
}

// CatalogImportRow is one CSV line: a test (by code) and one of its analytes.
type CatalogImportRow struct {
	TestCode     string
	TestName     string
	Specimen     string
	AnalyteName  string
	Unit         string
	RefLow       string
	RefHigh      string
	CriticalLow  string
	CriticalHigh string
}

// CatalogImportResult summarises a bulk import.
type CatalogImportResult struct {
	TestsCreated   int `json:"tests_created"`
	AnalytesAdded  int `json:"analytes_added"`
	RowsSkippedDup int `json:"rows_skipped_dup"`
}

// SampleRef resolves a scanned sample number to an item id + status.
type SampleRef struct {
	ID     uuid.UUID `json:"-"`
	Status string    `json:"status"`
}

// EncounterOrderItem / EncounterOrder show a doctor their ordered labs + results.
type EncounterOrderItem struct {
	SampleNo int64           `json:"sample_no"`
	TestName string          `json:"test_name"`
	Status   string          `json:"status"`
	Results  []AnalyteResult `json:"results"`
}
type EncounterOrder struct {
	OrderNo   int64                `json:"order_no"`
	Priority  string               `json:"priority"`
	CreatedAt time.Time            `json:"created_at"`
	Items     []EncounterOrderItem `json:"items"`
}

// PendingSummary powers the doctor board's "awaiting lab" reason.
type PendingSummary struct {
	Count int      `json:"count"`
	Tests []string `json:"tests"`
}

// Service is the lab module API.
type Service interface {
	ListTests(ctx context.Context, activeOnly bool) ([]LabTest, error)
	ListAnalytes(ctx context.Context, testID uuid.UUID) ([]Analyte, error)
	CreateTest(ctx context.Context, code, name, specimen string) (*LabTest, error)
	UpdateTest(ctx context.Context, testID uuid.UUID, code, name, specimen string) error
	SetTestActive(ctx context.Context, testID uuid.UUID, active bool) error
	DeleteTest(ctx context.Context, testID uuid.UUID) error
	AddAnalyte(ctx context.Context, testID uuid.UUID, in Analyte) error
	UpdateAnalyte(ctx context.Context, analyteID uuid.UUID, in Analyte) error
	DeleteAnalyte(ctx context.Context, analyteID uuid.UUID) error
	ImportCatalog(ctx context.Context, rows []CatalogImportRow) (*CatalogImportResult, error)
	FindSample(ctx context.Context, sampleNo int64) (*SampleRef, error)

	CreateOrder(ctx context.Context, in OrderInput) (*Order, error)
	EncounterLabs(ctx context.Context, encounterID uuid.UUID) ([]EncounterOrder, error)
	PendingLabs(ctx context.Context, encounterID uuid.UUID) (*PendingSummary, error)

	Worklist(ctx context.Context, status string) ([]WorklistItem, error)
	OrderItem(ctx context.Context, itemID uuid.UUID) (*OrderItemDetail, error)
	Accession(ctx context.Context, itemID uuid.UUID, collectedBy string) error
	SaveResults(ctx context.Context, itemID uuid.UUID, results []ResultInput) error
	SubmitResults(ctx context.Context, itemID uuid.UUID) error
	ValidateItem(ctx context.Context, itemID uuid.UUID) error

	// Phase 5b-1: critical escalation + acknowledgement + doctor inbox.
	MarkNotified(ctx context.Context, itemID uuid.UUID) error
	ResultsInbox(ctx context.Context, providerID uuid.UUID) ([]InboxItem, error)
	InboxCount(ctx context.Context, providerID uuid.UUID) (int, error)
}
