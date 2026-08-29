// Package http exposes the laboratory module's REST endpoints (Phase 5a).
package http

import (
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/lab"
)

// Handlers wires the lab service to HTTP.
type Handlers struct{ svc lab.Service }

// NewHandlers constructs lab HTTP handlers.
func NewHandlers(svc lab.Service) *Handlers { return &Handlers{svc: svc} }

// ---- DTOs ----

type testDTO struct {
	ID string `json:"id"`
	lab.LabTest
}
type analyteDTO struct {
	ID string `json:"id"`
	lab.Analyte
}
type worklistDTO struct {
	ID string `json:"id"`
	lab.WorklistItem
}
type analyteResultDTO struct {
	AnalyteID string `json:"analyte_id"`
	lab.AnalyteResult
}
type itemDetailDTO struct {
	ID       string             `json:"id"`
	Analytes []analyteResultDTO `json:"analytes"`
	lab.OrderItemDetail
}

// ---- requests ----

type createOrderRequest struct {
	EncounterID  string   `json:"encounter_id"`
	PatientID    string   `json:"patient_id" binding:"required"`
	Priority     string   `json:"priority"`
	ClinicalNote string   `json:"clinical_note"`
	TestIDs      []string `json:"test_ids"`
}
type accessionRequest struct {
	CollectedBy string `json:"collected_by"`
}
type saveResultsRequest struct {
	Results []struct {
		AnalyteID string `json:"analyte_id"`
		Value     string `json:"value"`
	} `json:"results"`
}
type createTestRequest struct {
	Code     string `json:"code" binding:"required"`
	Name     string `json:"name" binding:"required"`
	Specimen string `json:"specimen"`
	Price    string `json:"price"`
}
type addAnalyteRequest struct {
	Name         string `json:"name" binding:"required"`
	Unit         string `json:"unit"`
	RefLow       string `json:"ref_low"`
	RefHigh      string `json:"ref_high"`
	CriticalLow  string `json:"critical_low"`
	CriticalHigh string `json:"critical_high"`
}

// ---- catalog ----

func (h *Handlers) ListTests(c *gin.Context) {
	items, err := h.svc.ListTests(c.Request.Context(), c.Query("active") == "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]testDTO, 0, len(items))
	for _, t := range items {
		out = append(out, testDTO{ID: id.Encode(id.PrefixLabTest, t.ID), LabTest: t})
	}
	httpx.OK(c, out)
}

func (h *Handlers) ListAnalytes(c *gin.Context) {
	testID, ok := decode(c, id.PrefixLabTest, "id")
	if !ok {
		return
	}
	items, err := h.svc.ListAnalytes(c.Request.Context(), testID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]analyteDTO, 0, len(items))
	for _, a := range items {
		out = append(out, analyteDTO{ID: id.Encode(id.PrefixAnalyte, a.ID), Analyte: a})
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateTest(c *gin.Context) {
	var req createTestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("code and name are required"))
		return
	}
	t, err := h.svc.CreateTest(c.Request.Context(), req.Code, req.Name, req.Specimen, req.Price)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, testDTO{ID: id.Encode(id.PrefixLabTest, t.ID), LabTest: *t})
}

func (h *Handlers) AddAnalyte(c *gin.Context) {
	testID, ok := decode(c, id.PrefixLabTest, "id")
	if !ok {
		return
	}
	var req addAnalyteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name is required"))
		return
	}
	if err := h.svc.AddAnalyte(c.Request.Context(), testID, lab.Analyte{
		Name: req.Name, Unit: req.Unit, RefLow: req.RefLow, RefHigh: req.RefHigh, CriticalLow: req.CriticalLow, CriticalHigh: req.CriticalHigh,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type importRequest struct {
	Rows []struct {
		TestCode     string `json:"test_code"`
		TestName     string `json:"test_name"`
		Specimen     string `json:"specimen"`
		AnalyteName  string `json:"analyte_name"`
		Unit         string `json:"unit"`
		RefLow       string `json:"ref_low"`
		RefHigh      string `json:"ref_high"`
		CriticalLow  string `json:"critical_low"`
		CriticalHigh string `json:"critical_high"`
	} `json:"rows"`
}

// ImportCatalog handles POST /lab/catalog/import — bulk tests + analytes.
func (h *Handlers) ImportCatalog(c *gin.Context) {
	var req importRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Rows) == 0 {
		httpx.Fail(c, apperr.Validation("at least one row is required"))
		return
	}
	rows := make([]lab.CatalogImportRow, 0, len(req.Rows))
	for _, r := range req.Rows {
		rows = append(rows, lab.CatalogImportRow{
			TestCode: r.TestCode, TestName: r.TestName, Specimen: r.Specimen, AnalyteName: r.AnalyteName,
			Unit: r.Unit, RefLow: r.RefLow, RefHigh: r.RefHigh, CriticalLow: r.CriticalLow, CriticalHigh: r.CriticalHigh,
		})
	}
	res, err := h.svc.ImportCatalog(c.Request.Context(), rows)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, res)
}

// FindSample handles GET /lab/items/find?sample_no= — barcode/sample lookup.
func (h *Handlers) FindSample(c *gin.Context) {
	n, err := strconv.ParseInt(c.Query("sample_no"), 10, 64)
	if err != nil || n <= 0 {
		httpx.Fail(c, apperr.Validation("a numeric sample_no is required"))
		return
	}
	ref, err := h.svc.FindSample(c.Request.Context(), n)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"id": id.Encode(id.PrefixLabItem, ref.ID), "status": ref.Status})
}

func (h *Handlers) UpdateTest(c *gin.Context) {
	testID, ok := decode(c, id.PrefixLabTest, "id")
	if !ok {
		return
	}
	var req createTestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("code and name are required"))
		return
	}
	if err := h.svc.UpdateTest(c.Request.Context(), testID, req.Code, req.Name, req.Specimen, req.Price); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SetTestActive(c *gin.Context) {
	testID, ok := decode(c, id.PrefixLabTest, "id")
	if !ok {
		return
	}
	var req struct {
		IsActive bool `json:"is_active"`
	}
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.SetTestActive(c.Request.Context(), testID, req.IsActive); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) DeleteTest(c *gin.Context) {
	testID, ok := decode(c, id.PrefixLabTest, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteTest(c.Request.Context(), testID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) UpdateAnalyte(c *gin.Context) {
	analyteID, ok := decode(c, id.PrefixAnalyte, "id")
	if !ok {
		return
	}
	var req addAnalyteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name is required"))
		return
	}
	if err := h.svc.UpdateAnalyte(c.Request.Context(), analyteID, lab.Analyte{
		Name: req.Name, Unit: req.Unit, RefLow: req.RefLow, RefHigh: req.RefHigh, CriticalLow: req.CriticalLow, CriticalHigh: req.CriticalHigh,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) DeleteAnalyte(c *gin.Context) {
	analyteID, ok := decode(c, id.PrefixAnalyte, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteAnalyte(c.Request.Context(), analyteID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- orders + doctor views ----

func (h *Handlers) CreateOrder(c *gin.Context) {
	var req createOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id and test_ids are required"))
		return
	}
	patientID, err := id.Decode(id.PrefixPatient, req.PatientID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient_id"))
		return
	}
	in := lab.OrderInput{PatientID: patientID, Priority: req.Priority, ClinicalNote: req.ClinicalNote}
	if req.EncounterID != "" {
		eid, err := id.Decode(id.PrefixEncounter, req.EncounterID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid encounter_id"))
			return
		}
		in.EncounterID = &eid
	}
	for _, t := range req.TestIDs {
		tid, err := id.Decode(id.PrefixLabTest, t)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid test id"))
			return
		}
		in.TestIDs = append(in.TestIDs, tid)
	}
	o, err := h.svc.CreateOrder(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixLabOrder, o.ID), "order_no": o.OrderNo, "items": o.Items})
}

func (h *Handlers) EncounterLabs(c *gin.Context) {
	encID, ok := decode(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	out, err := h.svc.EncounterLabs(c.Request.Context(), encID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handlers) PendingLabs(c *gin.Context) {
	encID, ok := decode(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	out, err := h.svc.PendingLabs(c.Request.Context(), encID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// ---- worklist + processing ----

func (h *Handlers) Worklist(c *gin.Context) {
	items, err := h.svc.Worklist(c.Request.Context(), c.Query("status"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]worklistDTO, 0, len(items))
	for _, it := range items {
		out = append(out, worklistDTO{ID: id.Encode(id.PrefixLabItem, it.ID), WorklistItem: it})
	}
	httpx.OK(c, out)
}

func (h *Handlers) GetItem(c *gin.Context) {
	itemID, ok := decode(c, id.PrefixLabItem, "id")
	if !ok {
		return
	}
	d, err := h.svc.OrderItem(c.Request.Context(), itemID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := itemDetailDTO{ID: id.Encode(id.PrefixLabItem, d.ID), OrderItemDetail: *d, Analytes: make([]analyteResultDTO, 0, len(d.Analytes))}
	for _, a := range d.Analytes {
		out.Analytes = append(out.Analytes, analyteResultDTO{AnalyteID: id.Encode(id.PrefixAnalyte, a.AnalyteID), AnalyteResult: a})
	}
	httpx.OK(c, out)
}

func (h *Handlers) Accession(c *gin.Context) {
	itemID, ok := decode(c, id.PrefixLabItem, "id")
	if !ok {
		return
	}
	var req accessionRequest
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.Accession(c.Request.Context(), itemID, req.CollectedBy); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SaveResults(c *gin.Context) {
	itemID, ok := decode(c, id.PrefixLabItem, "id")
	if !ok {
		return
	}
	var req saveResultsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("results are required"))
		return
	}
	in := make([]lab.ResultInput, 0, len(req.Results))
	for _, r := range req.Results {
		aid, err := id.Decode(id.PrefixAnalyte, r.AnalyteID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid analyte_id"))
			return
		}
		in = append(in, lab.ResultInput{AnalyteID: aid, Value: r.Value})
	}
	if err := h.svc.SaveResults(c.Request.Context(), itemID, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SubmitResults(c *gin.Context) {
	itemID, ok := decode(c, id.PrefixLabItem, "id")
	if !ok {
		return
	}
	if err := h.svc.SubmitResults(c.Request.Context(), itemID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) ValidateItem(c *gin.Context) {
	itemID, ok := decode(c, id.PrefixLabItem, "id")
	if !ok {
		return
	}
	if err := h.svc.ValidateItem(c.Request.Context(), itemID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- Phase 5b-1: critical acknowledgement + doctor inbox ----

func (h *Handlers) MarkNotified(c *gin.Context) {
	itemID, ok := decode(c, id.PrefixLabItem, "id")
	if !ok {
		return
	}
	if err := h.svc.MarkNotified(c.Request.Context(), itemID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type inboxDTO struct {
	ID          string  `json:"id"`
	EncounterID *string `json:"encounter_id"`
	lab.InboxItem
}

func (h *Handlers) Inbox(c *gin.Context) {
	provider, ok := h.resolveProvider(c)
	if !ok {
		return
	}
	items, err := h.svc.ResultsInbox(c.Request.Context(), provider)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]inboxDTO, 0, len(items))
	for _, it := range items {
		row := inboxDTO{ID: id.Encode(id.PrefixLabItem, it.ID), InboxItem: it}
		if it.EncounterID != nil {
			s := id.Encode(id.PrefixEncounter, *it.EncounterID)
			row.EncounterID = &s
		}
		out = append(out, row)
	}
	httpx.OK(c, out)
}

func (h *Handlers) InboxCount(c *gin.Context) {
	provider, ok := h.resolveProvider(c)
	if !ok {
		return
	}
	n, err := h.svc.InboxCount(c.Request.Context(), provider)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"count": n})
}

// resolveProvider picks ?provider= (managers viewing a doctor) or the caller.
func (h *Handlers) resolveProvider(c *gin.Context) (uuid.UUID, bool) {
	if q := c.Query("provider"); q != "" {
		pid, err := id.Decode(id.PrefixUser, q)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid provider"))
			return uuid.Nil, false
		}
		return pid, true
	}
	if p, ok := httpx.PrincipalFrom(c); ok {
		return p.UserID, true
	}
	httpx.Fail(c, apperr.Unauthenticated("authentication required"))
	return uuid.Nil, false
}

func decode(c *gin.Context, prefix, param string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, c.Param(param))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return uuid.Nil, false
	}
	return u, true
}

// PatientLabs handles GET /lab/patients/:id/labs.
func (h *Handlers) PatientLabs(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, "id")
	if !ok {
		return
	}
	out, err := h.svc.PatientLabs(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}
