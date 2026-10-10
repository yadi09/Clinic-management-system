// Package http exposes the organisation module's REST endpoints.
package http

import (
	"encoding/json"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/org"
)

// Handlers wires the org service to HTTP.
type Handlers struct{ svc org.Service }

// NewHandlers constructs org HTTP handlers.
func NewHandlers(svc org.Service) *Handlers { return &Handlers{svc: svc} }

// ---- requests ----

type clinicReq struct {
	Name     string `json:"name" binding:"required"`
	Timezone string `json:"timezone"`
	Locale   string `json:"locale"`
}
type branchReq struct {
	Name         string `json:"name" binding:"required"`
	Code         string `json:"code" binding:"required"`
	Address      string `json:"address"`
	Phone        string `json:"phone"`
	OpeningHours any    `json:"opening_hours"`
	IsActive     *bool  `json:"is_active"`
}
type departmentReq struct {
	BranchID  string `json:"branch_id" binding:"required"`
	Name      string `json:"name" binding:"required"`
	Specialty string `json:"specialty"`
}
type resourceReq struct {
	BranchID     string `json:"branch_id" binding:"required"`
	DepartmentID string `json:"department_id"`
	Name         string `json:"name" binding:"required"`
	Type         string `json:"type" binding:"required"`
}
type workspaceReq struct {
	Slug string `json:"slug" binding:"required"`
}

// ---- response DTOs (prefixed external IDs) ----

type branchDTO struct {
	ID string `json:"id"`
	org.Branch
}
type departmentDTO struct {
	ID       string `json:"id"`
	BranchID string `json:"branch_id"`
	org.Department
}
type resourceDTO struct {
	ID           string  `json:"id"`
	BranchID     string  `json:"branch_id"`
	DepartmentID *string `json:"department_id"`
	org.Resource
}

func branchOut(b org.Branch) branchDTO {
	return branchDTO{ID: id.Encode(id.PrefixBranch, b.ID), Branch: b}
}
func departmentOut(d org.Department) departmentDTO {
	return departmentDTO{ID: id.Encode(id.PrefixDepartment, d.ID), BranchID: id.Encode(id.PrefixBranch, d.BranchID), Department: d}
}
func resourceOut(r org.Resource) resourceDTO {
	var dep *string
	if r.DepartmentID != nil {
		s := id.Encode(id.PrefixDepartment, *r.DepartmentID)
		dep = &s
	}
	return resourceDTO{ID: id.Encode(id.PrefixResource, r.ID), BranchID: id.Encode(id.PrefixBranch, r.BranchID), DepartmentID: dep, Resource: r}
}

// ---- clinic ----

func (h *Handlers) GetClinic(c *gin.Context) {
	cl, err := h.svc.GetClinic(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, cl)
}

func (h *Handlers) SaveClinic(c *gin.Context) {
	var req clinicReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name is required"))
		return
	}
	cl, err := h.svc.SaveClinic(c.Request.Context(), org.ClinicInput{Name: req.Name, Timezone: req.Timezone, Locale: req.Locale})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, cl)
}

// GetWorkspace handles GET /org/workspace — the tenant's login handle.
func (h *Handlers) GetWorkspace(c *gin.Context) {
	ws, err := h.svc.GetWorkspace(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ws)
}

// UpdateWorkspace handles PUT /org/workspace — change the login slug.
func (h *Handlers) UpdateWorkspace(c *gin.Context) {
	var req workspaceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a workspace name is required"))
		return
	}
	ws, err := h.svc.UpdateWorkspace(c.Request.Context(), req.Slug)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, ws)
}

// ---- settings (flow configuration) ----

type settingsReq struct {
	CardFeeEnabled   bool    `json:"card_fee_enabled"`
	CardFeeAmount    float64 `json:"card_fee_amount"`
	CardCurrency     string  `json:"card_currency"`
	FreeWindowDays   int     `json:"free_window_days"`
	TriageRequired   bool    `json:"triage_required"`
	DoctorAssignment string  `json:"doctor_assignment"`
}

func (h *Handlers) GetSettings(c *gin.Context) {
	s, err := h.svc.GetSettings(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, s)
}

func (h *Handlers) SaveSettings(c *gin.Context) {
	var req settingsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid settings"))
		return
	}
	s, err := h.svc.SaveSettings(c.Request.Context(), org.SettingsInput{
		CardFeeEnabled:   req.CardFeeEnabled,
		CardFeeAmount:    strconv.FormatFloat(req.CardFeeAmount, 'f', 2, 64),
		CardCurrency:     req.CardCurrency,
		FreeWindowDays:   req.FreeWindowDays,
		TriageRequired:   req.TriageRequired,
		DoctorAssignment: req.DoctorAssignment,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, s)
}

// ---- branches ----

func (h *Handlers) ListBranches(c *gin.Context) {
	items, err := h.svc.ListBranches(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]branchDTO, 0, len(items))
	for _, b := range items {
		out = append(out, branchOut(b))
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateBranch(c *gin.Context) {
	var req branchReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name and code are required"))
		return
	}
	b, err := h.svc.CreateBranch(c.Request.Context(), branchInput(req))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, branchOut(*b))
}

func (h *Handlers) UpdateBranch(c *gin.Context) {
	bid, ok := decodeID(c, id.PrefixBranch, "id")
	if !ok {
		return
	}
	var req branchReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("name and code are required"))
		return
	}
	b, err := h.svc.UpdateBranch(c.Request.Context(), bid, branchInput(req))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, branchOut(*b))
}

func (h *Handlers) DeleteBranch(c *gin.Context) {
	bid, ok := decodeID(c, id.PrefixBranch, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteBranch(c.Request.Context(), bid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// BranchUsage handles GET /org/branch-usage — how many branches vs the plan cap.
func (h *Handlers) BranchUsage(c *gin.Context) {
	u, err := h.svc.BranchUsage(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, u)
}

// PlanUsage handles GET /org/plan-usage — the tenant's plan + usage vs caps.
func (h *Handlers) PlanUsage(c *gin.Context) {
	u, err := h.svc.PlanUsage(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, u)
}

// GetBranchModules handles GET /org/branches/:id/modules.
func (h *Handlers) GetBranchModules(c *gin.Context) {
	bid, ok := decodeID(c, id.PrefixBranch, "id")
	if !ok {
		return
	}
	mods, err := h.svc.GetBranchModules(c.Request.Context(), bid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, mods)
}

// SetBranchModules handles PUT /org/branches/:id/modules. Body is a map of
// module → enabled (true/false), or null to clear the override.
func (h *Handlers) SetBranchModules(c *gin.Context) {
	bid, ok := decodeID(c, id.PrefixBranch, "id")
	if !ok {
		return
	}
	var req map[string]*bool
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("expected a map of module to enabled"))
		return
	}
	if err := h.svc.SetBranchModules(c.Request.Context(), bid, req); err != nil {
		httpx.Fail(c, err)
		return
	}
	mods, err := h.svc.GetBranchModules(c.Request.Context(), bid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, mods)
}

// ---- departments ----

func (h *Handlers) ListDepartments(c *gin.Context) {
	items, err := h.svc.ListDepartments(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]departmentDTO, 0, len(items))
	for _, d := range items {
		out = append(out, departmentOut(d))
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateDepartment(c *gin.Context) {
	var req departmentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("branch_id and name are required"))
		return
	}
	branchID, err := id.Decode(id.PrefixBranch, req.BranchID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid branch_id"))
		return
	}
	d, err := h.svc.CreateDepartment(c.Request.Context(), org.DepartmentInput{BranchID: branchID, Name: req.Name, Specialty: req.Specialty})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, departmentOut(*d))
}

func (h *Handlers) UpdateDepartment(c *gin.Context) {
	did, ok := decodeID(c, id.PrefixDepartment, "id")
	if !ok {
		return
	}
	var req departmentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("branch_id and name are required"))
		return
	}
	branchID, _ := id.Decode(id.PrefixBranch, req.BranchID)
	d, err := h.svc.UpdateDepartment(c.Request.Context(), did, org.DepartmentInput{BranchID: branchID, Name: req.Name, Specialty: req.Specialty})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, departmentOut(*d))
}

func (h *Handlers) DeleteDepartment(c *gin.Context) {
	did, ok := decodeID(c, id.PrefixDepartment, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteDepartment(c.Request.Context(), did); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- resources ----

func (h *Handlers) ListResources(c *gin.Context) {
	items, err := h.svc.ListResources(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]resourceDTO, 0, len(items))
	for _, r := range items {
		out = append(out, resourceOut(r))
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateResource(c *gin.Context) {
	var req resourceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("branch_id, name and type are required"))
		return
	}
	branchID, err := id.Decode(id.PrefixBranch, req.BranchID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid branch_id"))
		return
	}
	var deptID *uuid.UUID
	if req.DepartmentID != "" {
		d, err := id.Decode(id.PrefixDepartment, req.DepartmentID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid department_id"))
			return
		}
		deptID = &d
	}
	r, err := h.svc.CreateResource(c.Request.Context(), org.ResourceInput{BranchID: branchID, DepartmentID: deptID, Name: req.Name, Type: req.Type})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, resourceOut(*r))
}

func (h *Handlers) DeleteResource(c *gin.Context) {
	rid, ok := decodeID(c, id.PrefixResource, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteResource(c.Request.Context(), rid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ---- helpers ----

func branchInput(req branchReq) org.BranchInput {
	return org.BranchInput{Name: req.Name, Code: req.Code, Address: req.Address, Phone: req.Phone, OpeningHours: rawFromAny(req.OpeningHours), IsActive: req.IsActive}
}

func decodeID(c *gin.Context, prefix, param string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, c.Param(param))
	if err != nil {
		httpx.Fail(c, apperr.NotFound("NOT_FOUND", "resource not found"))
		return uuid.Nil, false
	}
	return u, true
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

// GetPrintSettings handles GET /org/print-settings. Any signed-in staff may read it:
// every person who prints needs the clinic's letterhead.
func (h *Handlers) GetPrintSettings(c *gin.Context) {
	out, err := h.svc.GetPrintSettings(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SavePrintSettings handles PUT /org/print-settings (clinic.manage).
func (h *Handlers) SavePrintSettings(c *gin.Context) {
	var req struct {
		Settings json.RawMessage `json:"settings"`
		// Logo: absent keeps it, "" removes it, a data URL replaces it.
		Logo *string `json:"logo"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("the print settings are not valid"))
		return
	}
	out, err := h.svc.SavePrintSettings(c.Request.Context(), org.PrintSettingsInput{Settings: req.Settings, Logo: req.Logo})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// LogPrint handles POST /org/print-log: a paper is being printed; how many times so far?
func (h *Handlers) LogPrint(c *gin.Context) {
	var req struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a document kind and reference are required"))
		return
	}
	out, err := h.svc.LogPrint(c.Request.Context(), req.Kind, req.Ref)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// PeekPrint handles GET /org/print-log?kind=&ref= — the count so far, not counting this look.
func (h *Handlers) PeekPrint(c *gin.Context) {
	out, err := h.svc.PeekPrint(c.Request.Context(), c.Query("kind"), c.Query("ref"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}
