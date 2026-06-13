// Package http exposes the billing module's REST endpoints (Phase 3a: the card
// / consultation fee).
package http

import (
	"github.com/gin-gonic/gin"

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
