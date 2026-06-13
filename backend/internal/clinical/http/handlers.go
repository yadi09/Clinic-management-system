// Package http exposes the clinical module's REST endpoints (Phase 3a: triage
// vitals on a visit).
package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/clinical"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

// Handlers wires the clinical service to HTTP.
type Handlers struct{ svc clinical.Service }

// NewHandlers constructs clinical HTTP handlers.
func NewHandlers(svc clinical.Service) *Handlers { return &Handlers{svc: svc} }

// ---- requests ----

type vitalsRequest struct {
	BranchID     string   `json:"branch_id" binding:"required"`
	DepartmentID string   `json:"department_id"`
	ProviderID   string   `json:"provider_id"`
	Systolic     *int     `json:"systolic"`
	Diastolic    *int     `json:"diastolic"`
	Pulse        *int     `json:"pulse"`
	RespRate     *int     `json:"resp_rate"`
	Spo2         *int     `json:"spo2"`
	TempC        *float64 `json:"temp_c"`
	WeightKg     *float64 `json:"weight_kg"`
	HeightCm     *float64 `json:"height_cm"`
	Notes        string   `json:"notes"`
}

// ---- responses ----

type encounterDTO struct {
	ID string `json:"id"`
	clinical.Encounter
}

type visitDTO struct {
	Encounter *encounterDTO     `json:"encounter"`
	Vitals    []clinical.Vitals `json:"vitals"`
}

func encOut(e *clinical.Encounter) *encounterDTO {
	if e == nil {
		return nil
	}
	return &encounterDTO{ID: id.Encode(id.PrefixEncounter, e.ID), Encounter: *e}
}

// RecordVitals handles POST /visits/:qid/vitals.
func (h *Handlers) RecordVitals(c *gin.Context) {
	qid, err := id.Decode(id.PrefixQueueEntry, c.Param("qid"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid visit id"))
		return
	}
	var req vitalsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("branch_id is required"))
		return
	}
	branchID, err := id.Decode(id.PrefixBranch, req.BranchID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid branch_id"))
		return
	}
	in := clinical.RecordVitalsInput{
		QueueEntryID: qid, BranchID: branchID,
		Vitals: clinical.VitalsInput{
			Systolic: req.Systolic, Diastolic: req.Diastolic, Pulse: req.Pulse, RespRate: req.RespRate,
			Spo2: req.Spo2, TempC: req.TempC, WeightKg: req.WeightKg, HeightCm: req.HeightCm, Notes: req.Notes,
		},
	}
	if req.DepartmentID != "" {
		d, err := id.Decode(id.PrefixDepartment, req.DepartmentID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid department_id"))
			return
		}
		in.DepartmentID = &d
	}
	if req.ProviderID != "" {
		p, err := id.Decode(id.PrefixUser, req.ProviderID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid provider_id"))
			return
		}
		in.ProviderID = &p
	}
	// PatientID is required to attach the encounter/vitals; the triage screen
	// passes it on the queue entry it is acting on.
	pid := c.Query("patient")
	if pid == "" {
		httpx.Fail(c, apperr.Validation("patient is required"))
		return
	}
	patientID, err := id.Decode(id.PrefixPatient, pid)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient"))
		return
	}
	in.PatientID = patientID

	enc, v, err := h.svc.RecordVitals(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, visitDTO{Encounter: encOut(enc), Vitals: []clinical.Vitals{*v}})
}

// GetVisit handles GET /visits/:qid.
func (h *Handlers) GetVisit(c *gin.Context) {
	qid, err := id.Decode(id.PrefixQueueEntry, c.Param("qid"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid visit id"))
		return
	}
	enc, vitals, err := h.svc.GetVisit(c.Request.Context(), qid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if vitals == nil {
		vitals = []clinical.Vitals{}
	}
	httpx.OK(c, visitDTO{Encounter: encOut(enc), Vitals: vitals})
}
