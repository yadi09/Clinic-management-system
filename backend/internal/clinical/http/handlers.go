// Package http exposes the clinical module's REST endpoints (Phase 3a: triage
// vitals on a visit).
package http

import (
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

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

// ============================================================================
// Phase 3b: consultation / EMR
// ============================================================================

// ---- requests ----

type openRequest struct {
	QueueEntryID string `json:"queue_entry_id" binding:"required"`
}
type noteRequest struct {
	Subjective string `json:"subjective"`
	Objective  string `json:"objective"`
	Assessment string `json:"assessment"`
	Plan       string `json:"plan"`
}
type diagnosisRequest struct {
	CatalogID   string `json:"catalog_id"`
	Code        string `json:"code"`
	Description string `json:"description"`
	IsPrimary   bool   `json:"is_primary"`
}
type medicationRequest struct {
	DrugName     string `json:"drug_name" binding:"required"`
	Dose         string `json:"dose"`
	Frequency    string `json:"frequency"`
	Duration     string `json:"duration"`
	Instructions string `json:"instructions"`
}
type categoryRequest struct {
	Name      string `json:"name" binding:"required"`
	SortOrder int    `json:"sort_order"`
	IsActive  *bool  `json:"is_active"`
}
type catalogEntryRequest struct {
	CategoryID string `json:"category_id" binding:"required"`
	Code       string `json:"code"`
	Name       string `json:"name" binding:"required"`
	IsActive   *bool  `json:"is_active"`
}

// ---- response DTOs (prefixed external IDs) ----

type bannerDTO struct {
	PatientID string `json:"patient_id"`
	clinical.PatientBanner
}
type diagnosisDTO struct {
	ID string `json:"id"`
	clinical.Diagnosis
}
type medicationDTO struct {
	ID string `json:"id"`
	clinical.Medication
}
type workspaceDTO struct {
	EncounterID  string             `json:"encounter_id"`
	Status       string             `json:"status"`
	StartedAt    time.Time          `json:"started_at"`
	BranchID     string             `json:"branch_id"`
	DepartmentID *string            `json:"department_id"`
	ProviderID   *string            `json:"provider_id"`
	Patient      bannerDTO          `json:"patient"`
	Allergies    []clinical.Allergy `json:"allergies"`
	Vitals       []clinical.Vitals  `json:"vitals"`
	Note         clinical.Note      `json:"note"`
	Diagnoses    []diagnosisDTO     `json:"diagnoses"`
	Prescription []medicationDTO    `json:"prescription"`
}
type historyDTO struct {
	ID string `json:"id"`
	clinical.HistoryItem
}

func encodePtr(prefix string, u *uuid.UUID) *string {
	if u == nil {
		return nil
	}
	s := id.Encode(prefix, *u)
	return &s
}
type categoryDTO struct {
	ID string `json:"id"`
	clinical.DiagnosisCategory
}
type catalogEntryDTO struct {
	ID         string `json:"id"`
	CategoryID string `json:"category_id"`
	clinical.CatalogEntry
}

func diagnosisOut(d clinical.Diagnosis) diagnosisDTO {
	return diagnosisDTO{ID: id.Encode(id.PrefixDiagnosis, d.ID), Diagnosis: d}
}
func medicationOut(m clinical.Medication) medicationDTO {
	return medicationDTO{ID: id.Encode(id.PrefixRxItem, m.ID), Medication: m}
}
func categoryOut(cat clinical.DiagnosisCategory) categoryDTO {
	return categoryDTO{ID: id.Encode(id.PrefixDiagCategory, cat.ID), DiagnosisCategory: cat}
}
func catalogOut(e clinical.CatalogEntry) catalogEntryDTO {
	return catalogEntryDTO{ID: id.Encode(id.PrefixDiagCatalog, e.ID), CategoryID: id.Encode(id.PrefixDiagCategory, e.CategoryID), CatalogEntry: e}
}

func workspaceOut(ws *clinical.Workspace) workspaceDTO {
	out := workspaceDTO{
		EncounterID: id.Encode(id.PrefixEncounter, ws.EncounterID),
		Status:      ws.Status,
		StartedAt:   ws.StartedAt,
		BranchID:    id.Encode(id.PrefixBranch, ws.BranchID),
		DepartmentID: encodePtr(id.PrefixDepartment, ws.DepartmentID),
		ProviderID:  encodePtr(id.PrefixUser, ws.ProviderID),
		Patient:     bannerDTO{PatientID: id.Encode(id.PrefixPatient, ws.Patient.PatientID), PatientBanner: ws.Patient},
		Allergies:   ws.Allergies,
		Vitals:      ws.Vitals,
		Note:        ws.Note,
		Diagnoses:   make([]diagnosisDTO, 0, len(ws.Diagnoses)),
		Prescription: make([]medicationDTO, 0, len(ws.Prescription)),
	}
	for _, d := range ws.Diagnoses {
		out.Diagnoses = append(out.Diagnoses, diagnosisOut(d))
	}
	for _, m := range ws.Prescription {
		out.Prescription = append(out.Prescription, medicationOut(m))
	}
	return out
}

// ---- encounter handlers ----

// OpenEncounter handles POST /encounters/open.
func (h *Handlers) OpenEncounter(c *gin.Context) {
	var req openRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("queue_entry_id is required"))
		return
	}
	qid, err := id.Decode(id.PrefixQueueEntry, req.QueueEntryID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid queue_entry_id"))
		return
	}
	ws, err := h.svc.OpenEncounter(c.Request.Context(), qid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, workspaceOut(ws))
}

// History handles GET /encounters?patient= — the patient's past encounters.
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
	out := make([]historyDTO, 0, len(items))
	for _, it := range items {
		out = append(out, historyDTO{ID: id.Encode(id.PrefixEncounter, it.ID), HistoryItem: it})
	}
	httpx.OK(c, out)
}

// GetWorkspace handles GET /encounters/:id.
func (h *Handlers) GetWorkspace(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	ws, err := h.svc.GetWorkspace(c.Request.Context(), encID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, workspaceOut(ws))
}

// SaveNote handles PUT /encounters/:id/note.
func (h *Handlers) SaveNote(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	var req noteRequest
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.SaveNote(c.Request.Context(), encID, clinical.NoteInput{
		Subjective: req.Subjective, Objective: req.Objective, Assessment: req.Assessment, Plan: req.Plan,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AddDiagnosis handles POST /encounters/:id/diagnoses.
func (h *Handlers) AddDiagnosis(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	var req diagnosisRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a diagnosis is required"))
		return
	}
	in := clinical.DiagnosisInput{Code: req.Code, Description: req.Description, IsPrimary: req.IsPrimary}
	if req.CatalogID != "" {
		cid, err := id.Decode(id.PrefixDiagCatalog, req.CatalogID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid catalog_id"))
			return
		}
		in.CatalogID = &cid
	}
	d, err := h.svc.AddDiagnosis(c.Request.Context(), encID, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, diagnosisOut(*d))
}

// RemoveDiagnosis handles DELETE /encounters/:id/diagnoses/:dxId.
func (h *Handlers) RemoveDiagnosis(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	dxID, ok := decodeParam(c, id.PrefixDiagnosis, "dxId")
	if !ok {
		return
	}
	if err := h.svc.RemoveDiagnosis(c.Request.Context(), encID, dxID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AddMedication handles POST /encounters/:id/prescriptions.
func (h *Handlers) AddMedication(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	var req medicationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a medication name is required"))
		return
	}
	m, err := h.svc.AddMedication(c.Request.Context(), encID, clinical.MedicationInput{
		DrugName: req.DrugName, Dose: req.Dose, Frequency: req.Frequency, Duration: req.Duration, Instructions: req.Instructions,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, medicationOut(*m))
}

// RemoveMedication handles DELETE /encounters/:id/prescriptions/:itemId.
func (h *Handlers) RemoveMedication(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	itemID, ok := decodeParam(c, id.PrefixRxItem, "itemId")
	if !ok {
		return
	}
	if err := h.svc.RemoveMedication(c.Request.Context(), encID, itemID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// SignAndClose handles POST /encounters/:id/sign.
func (h *Handlers) SignAndClose(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	if err := h.svc.SignAndClose(c.Request.Context(), encID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// SetAside handles POST /encounters/:id/set-aside — park an open encounter as
// awaiting_results (e.g. labs pending) without locking it.
func (h *Handlers) SetAside(c *gin.Context) {
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	if err := h.svc.SetAside(c.Request.Context(), encID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- doctor "My day" board ----

type boardActiveDTO struct {
	EncounterID  string  `json:"encounter_id"`
	QueueEntryID *string `json:"queue_entry_id"`
	clinical.BoardActive
}
type boardDoneDTO struct {
	EncounterID string `json:"encounter_id"`
	clinical.BoardDone
}
type boardDTO struct {
	Active []boardActiveDTO `json:"active"`
	Done   []boardDoneDTO   `json:"done"`
}

// MyBoard handles GET /encounters/board?provider= — the doctor's in-progress and
// done-today encounters. Defaults to the authenticated user.
func (h *Handlers) MyBoard(c *gin.Context) {
	var provider uuid.UUID
	if q := c.Query("provider"); q != "" {
		pid, err := id.Decode(id.PrefixUser, q)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid provider"))
			return
		}
		provider = pid
	} else if p, ok := httpx.PrincipalFrom(c); ok {
		provider = p.UserID
	} else {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	board, err := h.svc.MyBoard(c.Request.Context(), provider)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := boardDTO{Active: make([]boardActiveDTO, 0, len(board.Active)), Done: make([]boardDoneDTO, 0, len(board.Done))}
	for _, a := range board.Active {
		out.Active = append(out.Active, boardActiveDTO{
			EncounterID: id.Encode(id.PrefixEncounter, a.EncounterID), QueueEntryID: encodePtr(id.PrefixQueueEntry, a.QueueEntryID), BoardActive: a,
		})
	}
	for _, d := range board.Done {
		out.Done = append(out.Done, boardDoneDTO{EncounterID: id.Encode(id.PrefixEncounter, d.EncounterID), BoardDone: d})
	}
	httpx.OK(c, out)
}

// ---- diagnosis catalog handlers ----

// ListCategories handles GET /diagnosis-categories.
func (h *Handlers) ListCategories(c *gin.Context) {
	items, err := h.svc.ListCategories(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]categoryDTO, 0, len(items))
	for _, cat := range items {
		out = append(out, categoryOut(cat))
	}
	httpx.OK(c, out)
}

// SearchCatalog handles GET /diagnosis-catalog?search=&category=&all=.
func (h *Handlers) SearchCatalog(c *gin.Context) {
	var catID *uuid.UUID
	if cat := c.Query("category"); cat != "" {
		d, err := id.Decode(id.PrefixDiagCategory, cat)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid category"))
			return
		}
		catID = &d
	}
	items, err := h.svc.SearchCatalog(c.Request.Context(), c.Query("search"), catID, c.Query("all") == "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]catalogEntryDTO, 0, len(items))
	for _, e := range items {
		out = append(out, catalogOut(e))
	}
	httpx.OK(c, out)
}

// CreateCategory handles POST /diagnosis-categories.
func (h *Handlers) CreateCategory(c *gin.Context) {
	var req categoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name is required"))
		return
	}
	cat, err := h.svc.CreateCategory(c.Request.Context(), clinical.CategoryInput{Name: req.Name, SortOrder: req.SortOrder, IsActive: true})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, categoryOut(*cat))
}

// UpdateCategory handles PUT /diagnosis-categories/:id.
func (h *Handlers) UpdateCategory(c *gin.Context) {
	catID, ok := decodeParam(c, id.PrefixDiagCategory, "id")
	if !ok {
		return
	}
	var req categoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name is required"))
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	if err := h.svc.UpdateCategory(c.Request.Context(), catID, clinical.CategoryInput{Name: req.Name, SortOrder: req.SortOrder, IsActive: active}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// DeleteCategory handles DELETE /diagnosis-categories/:id.
func (h *Handlers) DeleteCategory(c *gin.Context) {
	catID, ok := decodeParam(c, id.PrefixDiagCategory, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteCategory(c.Request.Context(), catID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// CreateCatalogEntry handles POST /diagnosis-catalog.
func (h *Handlers) CreateCatalogEntry(c *gin.Context) {
	var req catalogEntryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("category_id and name are required"))
		return
	}
	catID, err := id.Decode(id.PrefixDiagCategory, req.CategoryID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid category_id"))
		return
	}
	e, err := h.svc.CreateCatalogEntry(c.Request.Context(), clinical.CatalogEntryInput{CategoryID: catID, Code: req.Code, Name: req.Name, IsActive: true})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, catalogOut(*e))
}

// UpdateCatalogEntry handles PUT /diagnosis-catalog/:id.
func (h *Handlers) UpdateCatalogEntry(c *gin.Context) {
	entryID, ok := decodeParam(c, id.PrefixDiagCatalog, "id")
	if !ok {
		return
	}
	var req catalogEntryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("category_id and name are required"))
		return
	}
	catID, err := id.Decode(id.PrefixDiagCategory, req.CategoryID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid category_id"))
		return
	}
	active := true
	if req.IsActive != nil {
		active = *req.IsActive
	}
	if err := h.svc.UpdateCatalogEntry(c.Request.Context(), entryID, clinical.CatalogEntryInput{CategoryID: catID, Code: req.Code, Name: req.Name, IsActive: active}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// DeleteCatalogEntry handles DELETE /diagnosis-catalog/:id.
func (h *Handlers) DeleteCatalogEntry(c *gin.Context) {
	entryID, ok := decodeParam(c, id.PrefixDiagCatalog, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteCatalogEntry(c.Request.Context(), entryID); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// decodeParam decodes a prefixed path param, failing the request on error.
func decodeParam(c *gin.Context, prefix, param string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, c.Param(param))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return uuid.Nil, false
	}
	return u, true
}
