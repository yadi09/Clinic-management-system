package http

import (
	"time"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/pharmacy"
)

// ---- suppliers ----

type supplierDTO struct {
	ID string `json:"id"`
	pharmacy.Supplier
}
type supplierRequest struct {
	Name         string `json:"name" binding:"required"`
	Contact      string `json:"contact"`
	LeadTimeDays int    `json:"lead_time_days"`
}

func (h *Handlers) ListSuppliers(c *gin.Context) {
	items, err := h.svc.ListSuppliers(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]supplierDTO, 0, len(items))
	for _, s := range items {
		out = append(out, supplierDTO{ID: id.Encode(id.PrefixSupplier, s.ID), Supplier: s})
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateSupplier(c *gin.Context) {
	var req supplierRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name is required"))
		return
	}
	s, err := h.svc.CreateSupplier(c.Request.Context(), pharmacy.SupplierInput{Name: req.Name, Contact: req.Contact, LeadTimeDays: req.LeadTimeDays})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, supplierDTO{ID: id.Encode(id.PrefixSupplier, s.ID), Supplier: *s})
}

// ---- purchase orders ----

type poDTO struct {
	ID string `json:"id"`
	pharmacy.PO
}
type poItemDTO struct {
	ID string `json:"id"`
	pharmacy.POItem
}
type poDetailDTO struct {
	ID    string      `json:"id"`
	Items []poItemDTO `json:"items"`
	pharmacy.PO
}
type poRequest struct {
	SupplierID   string `json:"supplier_id" binding:"required"`
	ExpectedDate string `json:"expected_date"`
	Notes        string `json:"notes"`
	Lines        []struct {
		DrugID   string  `json:"drug_id"`
		Qty      int     `json:"qty"`
		UnitCost float64 `json:"unit_cost"`
	} `json:"lines"`
}
type poStatusRequest struct {
	Status string `json:"status" binding:"required"`
}
type receiveRequest struct {
	Items []struct {
		POItemID string `json:"po_item_id"`
		BatchNo  string `json:"batch_no"`
		Expiry   string `json:"expiry"`
	} `json:"items"`
}

func poOut(p pharmacy.PO) poDTO { return poDTO{ID: id.Encode(id.PrefixPO, p.ID), PO: p} }

func (h *Handlers) ListPOs(c *gin.Context) {
	items, err := h.svc.ListPOs(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]poDTO, 0, len(items))
	for _, p := range items {
		out = append(out, poOut(p))
	}
	httpx.OK(c, out)
}

func (h *Handlers) GetPO(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPO, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid po id"))
		return
	}
	d, err := h.svc.GetPO(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := poDetailDTO{ID: id.Encode(id.PrefixPO, d.ID), PO: d.PO, Items: make([]poItemDTO, 0, len(d.Items))}
	for _, it := range d.Items {
		out.Items = append(out.Items, poItemDTO{ID: id.Encode(id.PrefixPOItem, it.ID), POItem: it})
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreatePO(c *gin.Context) {
	var req poRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("supplier_id and lines are required"))
		return
	}
	supplierID, err := id.Decode(id.PrefixSupplier, req.SupplierID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid supplier_id"))
		return
	}
	in := pharmacy.POInput{SupplierID: supplierID, Notes: req.Notes}
	if req.ExpectedDate != "" {
		t, err := time.Parse("2006-01-02", req.ExpectedDate)
		if err != nil {
			httpx.Fail(c, apperr.Validation("expected_date must be YYYY-MM-DD"))
			return
		}
		in.ExpectedDate = &t
	}
	for _, l := range req.Lines {
		drugID, err := id.Decode(id.PrefixDrug, l.DrugID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid drug_id"))
			return
		}
		in.Lines = append(in.Lines, pharmacy.POLineInput{DrugID: drugID, Qty: l.Qty, UnitCost: l.UnitCost})
	}
	p, err := h.svc.CreatePO(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, poOut(*p))
}

func (h *Handlers) SetPOStatus(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPO, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid po id"))
		return
	}
	var req poStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("status is required"))
		return
	}
	if err := h.svc.SetPOStatus(c.Request.Context(), pid, req.Status); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) ReceivePO(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPO, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid po id"))
		return
	}
	var req receiveRequest
	_ = c.ShouldBindJSON(&req)
	in := pharmacy.ReceiveInput{POID: pid}
	for _, r := range req.Items {
		itemID, err := id.Decode(id.PrefixPOItem, r.POItemID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid po_item_id"))
			return
		}
		ri := pharmacy.ReceiveItem{POItemID: itemID, BatchNo: r.BatchNo}
		if r.Expiry != "" {
			t, err := time.Parse("2006-01-02", r.Expiry)
			if err != nil {
				httpx.Fail(c, apperr.Validation("expiry must be YYYY-MM-DD"))
				return
			}
			ri.Expiry = &t
		}
		in.Items = append(in.Items, ri)
	}
	if err := h.svc.ReceivePO(c.Request.Context(), in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- stock counts ----

type stockCountDTO struct {
	ID string `json:"id"`
	pharmacy.StockCount
}
type countItemDTO struct {
	ID string `json:"id"`
	pharmacy.StockCountItem
}
type countDetailDTO struct {
	ID    string         `json:"id"`
	Items []countItemDTO `json:"items"`
	pharmacy.StockCount
}

func (h *Handlers) ListStockCounts(c *gin.Context) {
	items, err := h.svc.ListStockCounts(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]stockCountDTO, 0, len(items))
	for _, sc := range items {
		out = append(out, stockCountDTO{ID: id.Encode(id.PrefixStockCount, sc.ID), StockCount: sc})
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateStockCount(c *gin.Context) {
	var req struct {
		Note string `json:"note"`
	}
	_ = c.ShouldBindJSON(&req)
	cid, err := h.svc.CreateStockCount(c.Request.Context(), req.Note)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixStockCount, cid)})
}

func (h *Handlers) GetStockCount(c *gin.Context) {
	cid, err := id.Decode(id.PrefixStockCount, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid count id"))
		return
	}
	d, err := h.svc.GetStockCount(c.Request.Context(), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := countDetailDTO{ID: id.Encode(id.PrefixStockCount, d.ID), StockCount: d.StockCount, Items: make([]countItemDTO, 0, len(d.Items))}
	for _, it := range d.Items {
		out.Items = append(out.Items, countItemDTO{ID: id.Encode(id.PrefixCountItem, it.ID), StockCountItem: it})
	}
	httpx.OK(c, out)
}

func (h *Handlers) SetCounted(c *gin.Context) {
	itemID, err := id.Decode(id.PrefixCountItem, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid item id"))
		return
	}
	var req struct {
		Counted int `json:"counted"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("counted is required"))
		return
	}
	if err := h.svc.SetCounted(c.Request.Context(), itemID, req.Counted); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) AdjustCountItem(c *gin.Context) {
	itemID, err := id.Decode(id.PrefixCountItem, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid item id"))
		return
	}
	if err := h.svc.AdjustCountItem(c.Request.Context(), itemID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) ApproveStockCount(c *gin.Context) {
	cid, err := id.Decode(id.PrefixStockCount, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid count id"))
		return
	}
	if err := h.svc.ApproveStockCount(c.Request.Context(), cid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- reports ----

func (h *Handlers) Report(c *gin.Context) {
	rep, err := h.svc.Report(c.Request.Context(), c.Param("kind"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, rep)
}
