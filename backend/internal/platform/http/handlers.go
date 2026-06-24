// Package http exposes the platform (super-admin) endpoints.
package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/platform"
)

type Handlers struct {
	svc platform.Service
}

func NewHandlers(svc platform.Service) *Handlers { return &Handlers{svc: svc} }

func (h *Handlers) Login(c *gin.Context) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("email and password are required"))
		return
	}
	out, err := h.svc.Authenticate(c.Request.Context(), req.Email, req.Password)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handlers) ListClinics(c *gin.Context) {
	out, err := h.svc.ListClinics(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, cl := range out {
		rows = append(rows, clinicDTO(cl))
	}
	httpx.OK(c, rows)
}

func (h *Handlers) ProvisionClinic(c *gin.Context) {
	var req struct {
		ClinicName    string          `json:"clinic_name"`
		Slug          string          `json:"slug"`
		OwnerEmail    string          `json:"owner_email"`
		OwnerName     string          `json:"owner_name"`
		OwnerPassword string          `json:"owner_password"`
		Modules       map[string]bool `json:"modules"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	out, err := h.svc.ProvisionClinic(c.Request.Context(), platform.ProvisionInput{
		ClinicName: req.ClinicName, Slug: req.Slug, OwnerEmail: req.OwnerEmail, OwnerName: req.OwnerName, OwnerPassword: req.OwnerPassword, Modules: req.Modules,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{
		"clinic":         clinicDTO(out.Clinic),
		"owner_email":    out.OwnerEmail,
		"temp_password":  out.TempPassword,
		"workspace_slug": out.WorkspaceSlug,
	})
}

func (h *Handlers) SetClinicStatus(c *gin.Context, status string) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	if err := h.svc.SetClinicStatus(c.Request.Context(), tid, status); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) Suspend(c *gin.Context)    { h.SetClinicStatus(c, "suspended") }
func (h *Handlers) Reactivate(c *gin.Context) { h.SetClinicStatus(c, "active") }

// Modules describes which module entitlements exist + a clinic's current state.
func (h *Handlers) GetModules(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	flags, err := h.svc.GetClinicModules(c.Request.Context(), tid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	mods := make([]gin.H, 0, len(platform.ModuleFlags))
	for _, m := range platform.ModuleFlags {
		mods = append(mods, gin.H{"key": m.Key, "label": m.Label, "enabled": flags[m.Key]})
	}
	httpx.OK(c, mods)
}

func (h *Handlers) SetModules(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	var req struct {
		Modules map[string]bool `json:"modules"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("modules are required"))
		return
	}
	if err := h.svc.SetClinicModules(c.Request.Context(), tid, req.Modules); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func clinicDTO(cl platform.ClinicSummary) gin.H {
	return gin.H{
		"id":          id.Encode(id.PrefixTenant, cl.TenantID),
		"name":        cl.Name,
		"slug":        cl.Slug,
		"status":      cl.Status,
		"owner_email": cl.OwnerEmail,
		"users":       cl.Users,
		"patients":    cl.Patients,
		"created_at":  cl.CreatedAt,
	}
}
