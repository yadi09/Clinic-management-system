// Package http exposes the pharmacy module's REST endpoints (Phase 4a:
// dispense queue/flow, drug catalog, batches & stock adjustments).
package http

import (
	"time"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/pharmacy"
)

// Handlers wires the pharmacy service to HTTP.
type Handlers struct{ svc pharmacy.Service }

// NewHandlers constructs pharmacy HTTP handlers.
func NewHandlers(svc pharmacy.Service) *Handlers { return &Handlers{svc: svc} }

// ---- DTOs ----

type drugDTO struct {
	ID string `json:"id"`
	pharmacy.Drug
}

func drugOut(d pharmacy.Drug) drugDTO { return drugDTO{ID: id.Encode(id.PrefixDrug, d.ID), Drug: d} }

type batchDTO struct {
	ID     string `json:"id"`
	DrugID string `json:"drug_id"`
	pharmacy.Batch
}

func batchOut(b pharmacy.Batch) batchDTO {
	return batchDTO{ID: id.Encode(id.PrefixBatch, b.ID), DrugID: id.Encode(id.PrefixDrug, b.DrugID), Batch: b}
}

type queueItemDTO struct {
	ID string `json:"id"`
	pharmacy.DispenseQueueItem
}

type dispenseItemDTO struct {
	ID              string     `json:"id"`
	DrugName        string     `json:"drug_name"`
	Sig             string     `json:"sig"`
	MatchedDrugID   *string    `json:"matched_drug_id"`
	AllergyConflict string     `json:"allergy_conflict,omitempty"`
	Batches         []batchDTO `json:"batches"`
}

type dispenseDetailDTO struct {
	ID          string            `json:"id"`
	RxNo        int64             `json:"rx_no"`
	PatientName string            `json:"patient_name"`
	MRN         string            `json:"mrn"`
	Prescriber  string            `json:"prescriber,omitempty"`
	Dispensed   bool              `json:"dispensed"`
	Allergies   []string          `json:"allergies"`
	Items       []dispenseItemDTO `json:"items"`
}

type saleDTO struct {
	ID string `json:"id"`
	pharmacy.Sale
}

// ---- requests ----

type dispenseRequest struct {
	CounsellingNotes string `json:"counselling_notes"`
	Lines            []struct {
		DrugID  string `json:"drug_id"`
		BatchID string `json:"batch_id"`
		Qty     int    `json:"qty"`
	} `json:"lines"`
}

type stockAdjustRequest struct {
	DrugID  string `json:"drug_id" binding:"required"`
	BatchID string `json:"batch_id"`
	BatchNo string `json:"batch_no"`
	Expiry  string `json:"expiry"` // YYYY-MM-DD (new batch)
	Delta   int    `json:"delta"`
	Reason  string `json:"reason"`
	Note    string `json:"note"`
}

type quarantineRequest struct {
	Quarantined bool `json:"quarantined"`
}

// ---- drug catalog ----

// ListDrugs handles GET /pharmacy/drugs?class=&controlled=.
func (h *Handlers) ListDrugs(c *gin.Context) {
	var class *string
	if v := c.Query("class"); v != "" {
		class = &v
	}
	var controlled *bool
	if v := c.Query("controlled"); v == "true" || v == "false" {
		b := v == "true"
		controlled = &b
	}
	items, err := h.svc.ListDrugs(c.Request.Context(), class, controlled)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]drugDTO, 0, len(items))
	for _, d := range items {
		out = append(out, drugOut(d))
	}
	httpx.OK(c, out)
}

// SearchDrugs handles GET /pharmacy/drugs/search?q=.
func (h *Handlers) SearchDrugs(c *gin.Context) {
	items, err := h.svc.SearchDrugs(c.Request.Context(), c.Query("q"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]drugDTO, 0, len(items))
	for _, d := range items {
		out = append(out, drugOut(d))
	}
	httpx.OK(c, out)
}

// ---- batches / stock ----

// ListBatches handles GET /pharmacy/batches.
func (h *Handlers) ListBatches(c *gin.Context) {
	items, err := h.svc.ListBatches(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]batchDTO, 0, len(items))
	for _, b := range items {
		out = append(out, batchOut(b))
	}
	httpx.OK(c, out)
}

// AdjustStock handles POST /pharmacy/stock/adjust.
func (h *Handlers) AdjustStock(c *gin.Context) {
	var req stockAdjustRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("drug_id is required"))
		return
	}
	drugID, err := id.Decode(id.PrefixDrug, req.DrugID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid drug_id"))
		return
	}
	in := pharmacy.StockAdjustInput{DrugID: drugID, BatchNo: req.BatchNo, Delta: req.Delta, Reason: req.Reason, Note: req.Note}
	if req.BatchID != "" {
		bid, err := id.Decode(id.PrefixBatch, req.BatchID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid batch_id"))
			return
		}
		in.BatchID = &bid
	}
	if req.Expiry != "" {
		t, err := time.Parse("2006-01-02", req.Expiry)
		if err != nil {
			httpx.Fail(c, apperr.Validation("expiry must be YYYY-MM-DD"))
			return
		}
		in.Expiry = &t
	}
	if err := h.svc.AdjustStock(c.Request.Context(), in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// Quarantine handles POST /pharmacy/batches/:id/quarantine.
func (h *Handlers) Quarantine(c *gin.Context) {
	bid, err := id.Decode(id.PrefixBatch, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid batch id"))
		return
	}
	var req quarantineRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("quarantined (bool) is required"))
		return
	}
	if err := h.svc.SetQuarantine(c.Request.Context(), bid, req.Quarantined); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- dispensing ----

// DispenseQueue handles GET /pharmacy/dispense-queue.
func (h *Handlers) DispenseQueue(c *gin.Context) {
	dq, err := h.svc.DispenseQueue(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items := make([]queueItemDTO, 0, len(dq.Items))
	for _, it := range dq.Items {
		items = append(items, queueItemDTO{ID: id.Encode(id.PrefixPrescription, it.PrescriptionID), DispenseQueueItem: it})
	}
	httpx.OK(c, gin.H{"kpis": dq.KPIs, "items": items})
}

// DispenseDetail handles GET /pharmacy/dispense/:id.
func (h *Handlers) DispenseDetail(c *gin.Context) {
	rxID, err := id.Decode(id.PrefixPrescription, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid prescription id"))
		return
	}
	d, err := h.svc.DispenseDetail(c.Request.Context(), rxID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := dispenseDetailDTO{
		ID: id.Encode(id.PrefixPrescription, d.PrescriptionID), RxNo: d.RxNo, PatientName: d.PatientName, MRN: d.MRN,
		Prescriber: d.Prescriber, Dispensed: d.Dispensed, Allergies: d.Allergies, Items: make([]dispenseItemDTO, 0, len(d.Items)),
	}
	for _, it := range d.Items {
		di := dispenseItemDTO{
			ID: id.Encode(id.PrefixRxItem, it.PrescriptionItemID), DrugName: it.DrugName, Sig: it.Sig,
			AllergyConflict: it.AllergyConflict, Batches: make([]batchDTO, 0, len(it.Batches)),
		}
		if it.MatchedDrugID != nil {
			s := id.Encode(id.PrefixDrug, *it.MatchedDrugID)
			di.MatchedDrugID = &s
		}
		for _, b := range it.Batches {
			di.Batches = append(di.Batches, batchOut(b))
		}
		out.Items = append(out.Items, di)
	}
	httpx.OK(c, out)
}

// Dispense handles POST /pharmacy/dispense/:id.
func (h *Handlers) Dispense(c *gin.Context) {
	rxID, err := id.Decode(id.PrefixPrescription, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid prescription id"))
		return
	}
	var req dispenseRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("lines are required"))
		return
	}
	in := pharmacy.DispenseInput{PrescriptionID: rxID, CounsellingNotes: req.CounsellingNotes}
	for _, l := range req.Lines {
		drugID, err := id.Decode(id.PrefixDrug, l.DrugID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid drug_id"))
			return
		}
		batchID, err := id.Decode(id.PrefixBatch, l.BatchID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid batch_id"))
			return
		}
		in.Lines = append(in.Lines, pharmacy.DispenseLine{DrugID: drugID, BatchID: batchID, Qty: l.Qty})
	}
	sale, err := h.svc.Dispense(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, saleDTO{ID: id.Encode(id.PrefixSale, sale.ID), Sale: *sale})
}
