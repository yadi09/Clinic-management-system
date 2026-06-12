// Package http exposes the patient module's REST endpoints. Handlers bind/
// validate, decode external prefixed IDs, call the service, and shape responses.
package http

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/patient"
)

// Handlers wires the patient service to HTTP.
type Handlers struct {
	svc patient.Service
}

// NewHandlers constructs patient HTTP handlers.
func NewHandlers(svc patient.Service) *Handlers { return &Handlers{svc: svc} }

// Create handles POST /patients (FR-PAT-01/03).
func (h *Handlers) Create(c *gin.Context) {
	var req patientRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("first_name, last_name and dob are required"))
		return
	}
	p, dups, err := h.svc.Create(c.Request.Context(), toInput(req))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if p == nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error": gin.H{
				"code":       "PATIENT_DUPLICATE",
				"message":    "one or more possible duplicate patients were found; resubmit with force=true to proceed",
				"request_id": httpx.RequestID(c),
			},
			"duplicates": toDuplicateDTOs(dups),
		})
		return
	}
	httpx.Created(c, toPatientDTO(*p))
}

// Search handles GET /patients?q=&page=&page_size= (FR-PAT-04).
func (h *Handlers) Search(c *gin.Context) {
	page := httpx.ParsePage(c)
	res, err := h.svc.Search(c.Request.Context(), c.Query("q"), page.Page, page.PageSize)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items := make([]summaryDTO, 0, len(res.Items))
	for _, s := range res.Items {
		items = append(items, summaryDTO{ID: id.Encode(id.PrefixPatient, s.ID), Summary: s})
	}
	httpx.RespondMeta(c, http.StatusOK, items, httpx.Meta{Page: res.Page, PageSize: res.PageSize, Total: res.Total})
}

// Get handles GET /patients/:id.
func (h *Handlers) Get(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	prof, err := h.svc.Get(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, toProfileDTO(prof))
}

// Update handles PUT /patients/:id.
func (h *Handlers) Update(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	var req patientRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("first_name, last_name and dob are required"))
		return
	}
	p, err := h.svc.Update(c.Request.Context(), pid, toInput(req))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, toPatientDTO(*p))
}

// Delete handles DELETE /patients/:id.
func (h *Handlers) Delete(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	if err := h.svc.Delete(c.Request.Context(), pid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AddAllergy handles POST /patients/:id/allergies.
func (h *Handlers) AddAllergy(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	var req allergyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("substance is required"))
		return
	}
	newID, err := h.svc.AddAllergy(c.Request.Context(), pid, patient.AllergyInput{Substance: req.Substance, Reaction: req.Reaction, Severity: req.Severity})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixAllergy, newID)})
}

// RemoveAllergy handles DELETE /patients/:id/allergies/:sid.
func (h *Handlers) RemoveAllergy(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	aid, ok := decodeID(c, id.PrefixAllergy, "sid")
	if !ok {
		return
	}
	if err := h.svc.RemoveAllergy(c.Request.Context(), pid, aid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AddCondition handles POST /patients/:id/conditions.
func (h *Handlers) AddCondition(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	var req conditionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("description is required"))
		return
	}
	newID, err := h.svc.AddCondition(c.Request.Context(), pid, patient.ConditionInput{ICDCode: req.ICDCode, Description: req.Description, Status: req.Status, OnsetDate: req.OnsetDate})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixCondition, newID)})
}

// RemoveCondition handles DELETE /patients/:id/conditions/:sid.
func (h *Handlers) RemoveCondition(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	cid, ok := decodeID(c, id.PrefixCondition, "sid")
	if !ok {
		return
	}
	if err := h.svc.RemoveCondition(c.Request.Context(), pid, cid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AddGuardian handles POST /patients/:id/guardians.
func (h *Handlers) AddGuardian(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	var req guardianRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("relationship is required"))
		return
	}
	var guardianPatientID *uuid.UUID
	if req.GuardianPatientID != "" {
		gid, err := id.Decode(id.PrefixPatient, req.GuardianPatientID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid guardian_patient_id"))
			return
		}
		guardianPatientID = &gid
	}
	newID, err := h.svc.AddGuardian(c.Request.Context(), pid, patient.GuardianInput{GuardianPatientID: guardianPatientID, Relationship: req.Relationship})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixGuardian, newID)})
}

// SignUpload handles POST /patients/:id/attachments/sign.
func (h *Handlers) SignUpload(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	var req signUploadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("filename and type are required"))
		return
	}
	target, err := h.svc.SignAttachmentUpload(c.Request.Context(), pid, patient.AttachmentSignInput{Filename: req.Filename, Type: req.Type})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, target)
}

// RecordAttachment handles POST /patients/:id/attachments.
func (h *Handlers) RecordAttachment(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	var req recordAttachmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("type, storage_key, filename and mime_type are required"))
		return
	}
	att, err := h.svc.RecordAttachment(c.Request.Context(), pid, patient.AttachmentInput{
		Type: req.Type, StorageKey: req.StorageKey, Filename: req.Filename, MimeType: req.MimeType, SizeBytes: req.SizeBytes,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, attachmentDTO{ID: id.Encode(id.PrefixAttachment, att.ID), Attachment: *att})
}

// RemoveAttachment handles DELETE /patients/:id/attachments/:sid.
func (h *Handlers) RemoveAttachment(c *gin.Context) {
	pid, ok := h.patientID(c)
	if !ok {
		return
	}
	aid, ok := decodeID(c, id.PrefixAttachment, "sid")
	if !ok {
		return
	}
	if err := h.svc.RemoveAttachment(c.Request.Context(), pid, aid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- helpers ---

func (h *Handlers) patientID(c *gin.Context) (uuid.UUID, bool) {
	return decodeID(c, id.PrefixPatient, "id")
}

func decodeID(c *gin.Context, prefix, param string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, c.Param(param))
	if err != nil {
		httpx.Fail(c, apperr.NotFound("NOT_FOUND", "resource not found"))
		return uuid.Nil, false
	}
	return u, true
}

func toInput(req patientRequest) patient.PatientInput {
	return patient.PatientInput{
		FirstName: req.FirstName, MiddleName: req.MiddleName, LastName: req.LastName,
		Gender: req.Gender, DOB: req.DOB, NationalID: req.NationalID, PassportNo: req.PassportNo,
		Phone: req.Phone, Email: req.Email, BloodGroup: req.BloodGroup,
		Address: rawFromAny(req.Address), EmergencyContact: rawFromAny(req.EmergencyContact), Force: req.Force,
	}
}

func rawFromAny(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func toDuplicateDTOs(dups []patient.Duplicate) []duplicateDTO {
	out := make([]duplicateDTO, 0, len(dups))
	for _, d := range dups {
		out = append(out, duplicateDTO{ID: id.Encode(id.PrefixPatient, d.ID), Duplicate: d})
	}
	return out
}
