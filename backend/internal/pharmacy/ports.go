// Package pharmacy defines the public contracts of the pharmacy module
// (Phase 4a: dispensing core — drug catalog, batch stock with FEFO, dispense
// queue/flow with a class-aware allergy guard, and stock adjustments).
package pharmacy

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Drug is a catalog entry (with computed on-hand stock).
type Drug struct {
	ID           uuid.UUID `json:"-"`
	Name         string    `json:"name"`
	Form         string    `json:"form,omitempty"`
	Class        string    `json:"drug_class,omitempty"`
	IsControlled bool      `json:"is_controlled"`
	UnitPrice    string    `json:"unit_price"`
	ReorderLevel int       `json:"reorder_level"`
	IsActive     bool      `json:"is_active"`
	OnHand       int       `json:"on_hand"`
}

// Batch is a stock lot of a drug.
type Batch struct {
	ID          uuid.UUID  `json:"-"`
	DrugID      uuid.UUID  `json:"-"`
	DrugName    string     `json:"drug_name,omitempty"`
	BatchNo     string     `json:"batch_no"`
	Expiry      *time.Time `json:"expiry_date,omitempty"`
	QtyOnHand   int        `json:"qty_on_hand"`
	Quarantined bool       `json:"quarantined"`
	Status      string     `json:"status"` // ok | near_expiry | expired | quarantine
}

// KPIs are the dispense-queue header counters.
type KPIs struct {
	ToDispense     int `json:"to_dispense"`
	DispensedToday int `json:"dispensed_today"`
	LowStock       int `json:"low_stock"`
	NearExpiry     int `json:"near_expiry"`
}

// DispenseQueueItem is a signed prescription waiting to be dispensed.
type DispenseQueueItem struct {
	PrescriptionID  uuid.UUID `json:"-"`
	RxNo            int64     `json:"rx_no"`
	PatientName     string    `json:"patient_name"`
	MRN             string    `json:"mrn"`
	Prescriber      string    `json:"prescriber,omitempty"`
	ItemCount       int       `json:"item_count"`
	Dispensed       bool      `json:"dispensed"`
	AwaitingPayment bool      `json:"awaiting_payment"` // priced & sent to cashier, not yet paid/handed over
	Flags           []string  `json:"flags"`
}

// DispenseQueue is the queue header (KPIs) + rows.
type DispenseQueue struct {
	KPIs  KPIs                `json:"kpis"`
	Items []DispenseQueueItem `json:"items"`
}

// DispenseItem is one prescribed line on the dispense screen, matched to a
// catalog drug with its FEFO-ordered batches and an allergy verdict.
type DispenseItem struct {
	PrescriptionItemID uuid.UUID  `json:"-"`
	DrugName           string     `json:"drug_name"` // as prescribed
	Sig                string     `json:"sig"`       // dose · frequency · duration
	MatchedDrugID      *uuid.UUID `json:"-"`
	Batches            []Batch    `json:"batches"`
	AllergyConflict    string     `json:"allergy_conflict,omitempty"`
}

// DispenseDetail is the dispense workspace for one prescription.
type DispenseDetail struct {
	PrescriptionID uuid.UUID      `json:"-"`
	RxNo           int64          `json:"rx_no"`
	PatientName    string         `json:"patient_name"`
	MRN            string         `json:"mrn"`
	Prescriber     string         `json:"prescriber,omitempty"`
	Dispensed      bool           `json:"dispensed"`
	Allergies      []string       `json:"allergies"`
	Items          []DispenseItem `json:"items"`
	// Pre-pay state: once priced & billed, the meds wait for the cashier.
	Prepared      bool   `json:"prepared"`
	PreparedTotal string `json:"prepared_total,omitempty"`
	ChargeSettled bool   `json:"charge_settled"` // cashier has collected → ready to hand over
}

// DispenseLine is a confirmed line to dispense (drug + batch + qty).
type DispenseLine struct {
	DrugID  uuid.UUID
	BatchID uuid.UUID
	Qty     int
}

// DispenseInput is the dispense action.
type DispenseInput struct {
	PrescriptionID   uuid.UUID
	Lines            []DispenseLine
	CounsellingNotes string
}

// Sale is the charge raised by a dispense (or an OTC sale, later).
type Sale struct {
	ID     uuid.UUID `json:"-"`
	Total  string    `json:"total"`
	Status string    `json:"status"`
}

// PreparedDispense is the result of pricing a prescription and sending it to the
// cashier (pre-pay): the meds are reserved but no stock has moved yet.
type PreparedDispense struct {
	SaleID   uuid.UUID `json:"-"`
	ChargeID uuid.UUID `json:"-"`
	Total    string    `json:"total"`
}

// StockAdjustInput adjusts a batch (BatchID set) or creates a new batch (nil).
type StockAdjustInput struct {
	DrugID  uuid.UUID
	BatchID *uuid.UUID
	BatchNo string
	Expiry  *time.Time
	Delta   int
	Reason  string
	Note    string
}

// DrugInput is a catalog create/update payload (Phase 4b-1).
type DrugInput struct {
	Name         string
	Form         string
	Class        string
	IsControlled bool
	UnitPrice    string
	ReorderLevel int
	IsActive     bool
}

// OtcLine / OtcInput is a counter sale.
type OtcLine struct {
	DrugID uuid.UUID
	Qty    int
}
type OtcInput struct {
	PatientID     *uuid.UUID
	Lines         []OtcLine
	Discount      float64
	Tax           float64
	PaymentMethod string
	// The clinic's configured payment method and the transaction reference, so an
	// OTC sale paid by transfer is as traceable as one taken at the cashier.
	RailID    *uuid.UUID
	Reference string
}

// VolumePoint is one day on the dispensing chart.
type VolumePoint struct {
	Day   string `json:"day"`
	Count int    `json:"count"`
}

// Dashboard is the pharmacy-manager overview.
type Dashboard struct {
	DispensedToday int           `json:"dispensed_today"`
	ValueOnHand    string        `json:"value_on_hand"`
	LowStock       int           `json:"low_stock"`
	NearExpiry     int           `json:"near_expiry"`
	Expired        int           `json:"expired"`
	OpenPOs        int           `json:"open_pos"`
	Volume         []VolumePoint `json:"volume"`
	Alerts         []string      `json:"alerts"`
}

// Service is the pharmacy module API.
type Service interface {
	ListDrugs(ctx context.Context, class *string, controlled *bool) ([]Drug, error)
	SearchDrugs(ctx context.Context, q string) ([]Drug, error)
	ListBatches(ctx context.Context) ([]Batch, error)
	DispenseQueue(ctx context.Context) (*DispenseQueue, error)
	DispenseDetail(ctx context.Context, prescriptionID uuid.UUID) (*DispenseDetail, error)
	// Pre-pay dispense is two-phase: PrepareDispense prices & bills (no stock moves);
	// after the cashier collects, CompleteDispense decrements stock and hands over.
	PrepareDispense(ctx context.Context, in DispenseInput) (*PreparedDispense, error)
	CompleteDispense(ctx context.Context, prescriptionID uuid.UUID) (*Sale, error)
	AdjustStock(ctx context.Context, in StockAdjustInput) error
	SetQuarantine(ctx context.Context, batchID uuid.UUID, quarantined bool) error

	// Phase 4b-1: catalog admin, OTC sale, manager dashboard.
	CreateDrug(ctx context.Context, in DrugInput) (*Drug, error)
	UpdateDrug(ctx context.Context, id uuid.UUID, in DrugInput) error
	SellOTC(ctx context.Context, in OtcInput) (*Sale, error)
	Dashboard(ctx context.Context) (*Dashboard, error)

	// Phase 4b-2: purchasing, stock control, reports.
	ListSuppliers(ctx context.Context) ([]Supplier, error)
	CreateSupplier(ctx context.Context, in SupplierInput) (*Supplier, error)
	ListPOs(ctx context.Context) ([]PO, error)
	GetPO(ctx context.Context, id uuid.UUID) (*PODetail, error)
	CreatePO(ctx context.Context, in POInput) (*PO, error)
	SetPOStatus(ctx context.Context, id uuid.UUID, status string) error
	ReceivePO(ctx context.Context, in ReceiveInput) error

	CreateStockCount(ctx context.Context, note string) (uuid.UUID, error)
	ListStockCounts(ctx context.Context) ([]StockCount, error)
	GetStockCount(ctx context.Context, id uuid.UUID) (*StockCountDetail, error)
	SetCounted(ctx context.Context, itemID uuid.UUID, counted int) error
	AdjustCountItem(ctx context.Context, itemID uuid.UUID) error
	ApproveStockCount(ctx context.Context, id uuid.UUID) error

	Report(ctx context.Context, kind string) (*Report, error)
}

// --- Phase 4b-2 types ---

type Supplier struct {
	ID           uuid.UUID `json:"-"`
	Name         string    `json:"name"`
	Contact      string    `json:"contact,omitempty"`
	LeadTimeDays int       `json:"lead_time_days"`
	IsActive     bool      `json:"is_active"`
}
type SupplierInput struct {
	Name         string
	Contact      string
	LeadTimeDays int
}

type POLineInput struct {
	DrugID   uuid.UUID
	Qty      int
	UnitCost float64
}
type POInput struct {
	SupplierID   uuid.UUID
	ExpectedDate *time.Time
	Notes        string
	Lines        []POLineInput
}
type PO struct {
	ID           uuid.UUID  `json:"-"`
	PONo         int64      `json:"po_no"`
	Supplier     string     `json:"supplier"`
	Status       string     `json:"status"`
	ExpectedDate *time.Time `json:"expected_date,omitempty"`
	Total        string     `json:"total"`
	ItemCount    int        `json:"item_count"`
}
type POItem struct {
	ID        uuid.UUID `json:"-"`
	DrugID    uuid.UUID `json:"-"`
	DrugName  string    `json:"drug_name"`
	Qty       int       `json:"qty"`
	UnitCost  string    `json:"unit_cost"`
	LineTotal string    `json:"line_total"`
	Received  bool      `json:"received"`
}
type PODetail struct {
	PO
	Items []POItem `json:"items"`
}
type ReceiveItem struct {
	POItemID uuid.UUID
	BatchNo  string
	Expiry   *time.Time
}
type ReceiveInput struct {
	POID  uuid.UUID
	Items []ReceiveItem
}

type StockCount struct {
	ID         uuid.UUID  `json:"-"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"created_at"`
	ApprovedAt *time.Time `json:"approved_at,omitempty"`
}
type StockCountItem struct {
	ID       uuid.UUID `json:"-"`
	DrugName string    `json:"drug_name"`
	OnHand   int       `json:"on_hand"`
	Counted  int       `json:"counted"`
	Variance int       `json:"variance"`
	Adjusted bool      `json:"adjusted"`
}
type StockCountDetail struct {
	StockCount
	Items []StockCountItem `json:"items"`
}

// Report is a generic tabular report (columns + string rows).
type Report struct {
	Columns []string   `json:"columns"`
	Rows    [][]string `json:"rows"`
}
