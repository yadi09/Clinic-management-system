// Package http exposes the billing module's REST endpoints (Phase 3a: the card
// / consultation fee).
package http

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

// Handlers wires the billing service to HTTP.
type Handlers struct{ svc billing.Service }

// NewHandlers constructs billing HTTP handlers.
func NewHandlers(svc billing.Service) *Handlers { return &Handlers{svc: svc} }

// ---- requests ----

type collectRequest struct {
	PatientID     string `json:"patient_id" binding:"required"`
	BranchID      string `json:"branch_id" binding:"required"`
	AppointmentID string `json:"appointment_id"`
	Waived        bool   `json:"waived"`
	WaiveReason   string `json:"waive_reason"`
}

// ---- responses ----

type paymentDTO struct {
	ID string `json:"id"`
	billing.Payment
}

func paymentOut(p billing.Payment) paymentDTO {
	return paymentDTO{ID: id.Encode(id.PrefixCardPayment, p.ID), Payment: p}
}

// Assess handles GET /billing/card/assess?patient=&appointment=.
func (h *Handlers) Assess(c *gin.Context) {
	patientID, err := id.Decode(id.PrefixPatient, c.Query("patient"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("patient is required"))
		return
	}
	in := billing.AssessInput{PatientID: patientID}
	if a := c.Query("appointment"); a != "" {
		aid, err := id.Decode(id.PrefixAppointment, a)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid appointment"))
			return
		}
		in.AppointmentID = &aid
	}
	res, err := h.svc.Assess(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, res)
}

// Collect handles POST /billing/card/collect.
func (h *Handlers) Collect(c *gin.Context) {
	var req collectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id and branch_id are required"))
		return
	}
	patientID, err := id.Decode(id.PrefixPatient, req.PatientID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient_id"))
		return
	}
	branchID, err := id.Decode(id.PrefixBranch, req.BranchID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid branch_id"))
		return
	}
	in := billing.CollectInput{PatientID: patientID, BranchID: branchID, Waived: req.Waived, WaiveReason: req.WaiveReason}
	if req.AppointmentID != "" {
		aid, err := id.Decode(id.PrefixAppointment, req.AppointmentID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid appointment_id"))
			return
		}
		in.AppointmentID = &aid
	}
	p, err := h.svc.Collect(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, paymentOut(*p))
}

// History handles GET /billing/card/history?patient=.
func (h *Handlers) History(c *gin.Context) {
	patientID, err := id.Decode(id.PrefixPatient, c.Query("patient"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("patient is required"))
		return
	}
	items, err := h.svc.History(c.Request.Context(), patientID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]paymentDTO, 0, len(items))
	for _, p := range items {
		out = append(out, paymentOut(p))
	}
	httpx.OK(c, out)
}

// ============================================================================
// Billing-1: service catalog + charges + cashier + cash summary
// ============================================================================

type serviceReq struct {
	Code     string  `json:"code"`
	Name     string  `json:"name"`
	Category string  `json:"category"`
	Price    float64 `json:"price"`
}
type serviceDTO struct {
	ID string `json:"id"`
	billing.ServiceItem
}
type pendingDTO struct {
	ID string `json:"id"`
	billing.PendingCharge
}
type chargeRowDTO struct {
	ID string `json:"id"`
	billing.ChargeRow
}

func (h *Handlers) ListServices(c *gin.Context) {
	items, err := h.svc.ListServices(c.Request.Context(), c.Query("active") == "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]serviceDTO, 0, len(items))
	for _, s := range items {
		out = append(out, serviceDTO{ID: id.Encode(id.PrefixServiceItem, s.ID), ServiceItem: s})
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateService(c *gin.Context) {
	var req serviceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("code and name are required"))
		return
	}
	s, err := h.svc.CreateService(c.Request.Context(), billing.ServiceItemInput{
		Code: req.Code, Name: req.Name, Category: req.Category, Price: strconv.FormatFloat(req.Price, 'f', 2, 64),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, serviceDTO{ID: id.Encode(id.PrefixServiceItem, s.ID), ServiceItem: *s})
}

func (h *Handlers) UpdateService(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	var req serviceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("code and name are required"))
		return
	}
	if err := h.svc.UpdateService(c.Request.Context(), sid, billing.ServiceItemInput{
		Code: req.Code, Name: req.Name, Category: req.Category, Price: strconv.FormatFloat(req.Price, 'f', 2, 64),
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SetServiceActive(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	var req struct {
		IsActive bool `json:"is_active"`
	}
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.SetServiceActive(c.Request.Context(), sid, req.IsActive); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) DeleteService(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteService(c.Request.Context(), sid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type raiseReq struct {
	PatientID     string  `json:"patient_id" binding:"required"`
	EncounterID   string  `json:"encounter_id"`
	ServiceItemID string  `json:"service_item_id"`
	Source        string  `json:"source"`
	Description   string  `json:"description"`
	Amount        float64 `json:"amount"`
	BranchID      string  `json:"branch_id"`
	DepartmentID  string  `json:"department_id"`
	ToTriage      bool    `json:"to_triage"`
	ProviderID    string  `json:"provider_id"`
}

func (h *Handlers) RaiseCharge(c *gin.Context) {
	var req raiseReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id is required"))
		return
	}
	pid, err := id.Decode(id.PrefixPatient, req.PatientID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient_id"))
		return
	}
	in := billing.ChargeInput{
		PatientID: pid, Source: req.Source, Description: req.Description, Amount: strconv.FormatFloat(req.Amount, 'f', 2, 64), ToTriage: req.ToTriage,
	}
	if !decodeOpt(c, id.PrefixEncounter, req.EncounterID, &in.EncounterID) ||
		!decodeOpt(c, id.PrefixServiceItem, req.ServiceItemID, &in.ServiceItemID) ||
		!decodeOpt(c, id.PrefixBranch, req.BranchID, &in.BranchID) ||
		!decodeOpt(c, id.PrefixDepartment, req.DepartmentID, &in.DepartmentID) ||
		!decodeOpt(c, id.PrefixUser, req.ProviderID, &in.ProviderID) {
		return
	}
	cid, err := h.svc.RaiseCharge(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixCharge, cid)})
}

func (h *Handlers) PendingCharges(c *gin.Context) {
	items, err := h.svc.PendingCharges(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]pendingDTO, 0, len(items))
	for _, p := range items {
		out = append(out, pendingDTO{ID: id.Encode(id.PrefixCharge, p.ID), PendingCharge: p})
	}
	httpx.OK(c, out)
}

func (h *Handlers) PatientCharges(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPatient, c.Query("patient"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("patient is required"))
		return
	}
	items, err := h.svc.PatientCharges(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]chargeRowDTO, 0, len(items))
	for _, ch := range items {
		out = append(out, chargeRowDTO{ID: id.Encode(id.PrefixCharge, ch.ID), ChargeRow: ch})
	}
	httpx.OK(c, out)
}

func (h *Handlers) SettleCharge(c *gin.Context) {
	cid, ok := decodeBilling(c, id.PrefixCharge, "id")
	if !ok {
		return
	}
	var req struct {
		Method string `json:"method"`
	}
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.SettleCharge(c.Request.Context(), cid, req.Method); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) WaiveCharge(c *gin.Context) {
	cid, ok := decodeBilling(c, id.PrefixCharge, "id")
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a reason is required"))
		return
	}
	if err := h.svc.WaiveCharge(c.Request.Context(), cid, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) WaiverReasons(c *gin.Context) {
	httpx.OK(c, h.svc.WaiverReasons())
}

func (h *Handlers) Cash(c *gin.Context) {
	since := time.Now().Add(-24 * time.Hour)
	if q := c.Query("since"); q != "" {
		if t, err := time.Parse(time.RFC3339, q); err == nil {
			since = t
		}
	}
	out, err := h.svc.CashSince(c.Request.Context(), since)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func decodeBilling(c *gin.Context, prefix, param string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, c.Param(param))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return uuid.Nil, false
	}
	return u, true
}

// decodeOpt decodes an optional prefixed id into *dst; fails the request on a
// malformed (non-empty) value. Empty input leaves dst nil.
func decodeOpt(c *gin.Context, prefix, raw string, dst **uuid.UUID) bool {
	if raw == "" {
		return true
	}
	u, err := id.Decode(prefix, raw)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid "+prefix+" id"))
		return false
	}
	*dst = &u
	return true
}
