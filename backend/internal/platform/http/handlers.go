// Package http exposes the platform (super-admin) endpoints.
package http

import (
	"log/slog"
	"strings"

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
		OwnerPhone    string          `json:"owner_phone"`
		OwnerPassword string          `json:"owner_password"`
		ClinicType    string          `json:"clinic_type"`
		PlanCode      string          `json:"plan_code"`
		Modules       map[string]bool `json:"modules"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	out, err := h.svc.ProvisionClinic(c.Request.Context(), platform.ProvisionInput{
		ClinicName: req.ClinicName, Slug: req.Slug, OwnerEmail: req.OwnerEmail, OwnerName: req.OwnerName, OwnerPhone: req.OwnerPhone, OwnerPassword: req.OwnerPassword, ClinicType: req.ClinicType, PlanCode: req.PlanCode, Modules: req.Modules,
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

// GetPolicies lists the per-clinic role policies and this clinic's answers.
func (h *Handlers) GetPolicies(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	set, err := h.svc.GetClinicPolicies(c.Request.Context(), tid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(platform.RolePolicies))
	for _, p := range platform.RolePolicies {
		out = append(out, gin.H{"key": p.Key, "label": p.Label, "help": p.Help, "enabled": set[p.Key]})
	}
	httpx.OK(c, out)
}

func (h *Handlers) SetPolicies(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	var req struct {
		Policies map[string]bool `json:"policies"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("policies are required"))
		return
	}
	if err := h.svc.SetClinicPolicies(c.Request.Context(), tid, req.Policies); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ImpersonateOwner mints a tenant access token for the clinic's owner so the
// platform admin can sign in as them. Audited.
func (h *Handlers) ImpersonateOwner(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	out, err := h.svc.ImpersonateOwner(c.Request.Context(), tid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if p, ok := httpx.PrincipalFrom(c); ok {
		slog.Warn("platform impersonation", "admin", p.Email, "clinic", c.Param("id"), "as_user", out.User.Email)
	}
	httpx.OK(c, gin.H{
		"access_token":   out.AccessToken,
		"expires_in":     out.ExpiresIn,
		"workspace_slug": out.WorkspaceSlug,
		"user": gin.H{
			"id":        id.Encode(id.PrefixUser, out.User.ID),
			"tenant_id": id.Encode(id.PrefixTenant, out.User.TenantID),
			"email":     out.User.Email,
			"full_name": out.User.FullName,
			"roles":     out.User.Roles,
		},
	})
}

// CaptureLead handles POST /partner/leads (public) — a partner-page sign-up.
func (h *Handlers) CaptureLead(c *gin.Context) {
	var req struct {
		Name            string `json:"name"`
		Phone           string `json:"phone"`
		Email           string `json:"email"`
		Region          string `json:"region"`
		Audience        string `json:"audience"`
		ClinicsEstimate string `json:"clinics_estimate"`
		Goal            string `json:"goal"`
		Source          string `json:"source"`
		Website         string `json:"website"` // honeypot: bots fill it, humans leave it empty
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("please fill in your details"))
		return
	}
	// Silently accept and drop obvious bot submissions (honeypot tripped).
	if strings.TrimSpace(req.Website) != "" {
		httpx.OK(c, gin.H{"ok": true})
		return
	}
	if err := h.svc.CaptureLead(c.Request.Context(), platform.PartnerLeadInput{
		Name: req.Name, Phone: req.Phone, Email: req.Email, Region: req.Region,
		Audience: req.Audience, ClinicsEstimate: req.ClinicsEstimate, Goal: req.Goal,
		Source: req.Source, IP: c.ClientIP(), UserAgent: c.Request.UserAgent(),
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
}

// ListLeads handles GET /platform/partner-leads (admin).
func (h *Handlers) ListLeads(c *gin.Context) {
	out, err := h.svc.ListPartnerLeads(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, l := range out {
		rows = append(rows, gin.H{
			"id": id.Encode(id.PrefixPartnerLead, l.ID), "name": l.Name, "phone": l.Phone, "email": l.Email,
			"region": l.Region, "audience": l.Audience, "clinics_estimate": l.ClinicsEstimate,
			"goal": l.Goal, "source": l.Source, "status": l.Status, "created_at": l.CreatedAt,
		})
	}
	httpx.OK(c, rows)
}

// SetLeadStatus handles POST /platform/partner-leads/:id/status (admin).
func (h *Handlers) SetLeadStatus(c *gin.Context) {
	lid, err := id.Decode(id.PrefixPartnerLead, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid lead id"))
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("status is required"))
		return
	}
	if err := h.svc.SetLeadStatus(c.Request.Context(), lid, req.Status); err != nil {
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
		"owner_phone": cl.OwnerPhone,
		"users":       cl.Users,
		"patients":    cl.Patients,
		"clinic_type": cl.ClinicType,
		"plan_code":   cl.PlanCode,
		"plan_name":   cl.PlanName,
		"created_at":  cl.CreatedAt,
	}
}

// --- subscription plans ---

func planDTO(p platform.Plan) gin.H {
	return gin.H{
		"id": id.Encode(id.PrefixPlan, p.ID), "code": p.Code, "name": p.Name, "clinic_type": p.ClinicType,
		"branch_limit": p.BranchLimit, "user_limit": p.UserLimit, "storage_gb": p.StorageGB,
		"patient_limit": p.PatientLimit, "images_per_patient": p.ImagesPerPatient, "sms_monthly": p.SMSMonthly,
		"price_monthly": p.PriceMonthly, "status": p.Status, "in_use": p.InUse,
	}
}

type planReq struct {
	Code             string `json:"code"`
	Name             string `json:"name"`
	ClinicType       string `json:"clinic_type"`
	BranchLimit      *int   `json:"branch_limit"`
	UserLimit        *int   `json:"user_limit"`
	StorageGB        *int   `json:"storage_gb"`
	PatientLimit     *int   `json:"patient_limit"`
	ImagesPerPatient *int   `json:"images_per_patient"`
	SMSMonthly       *int   `json:"sms_monthly"`
	PriceMonthly     string `json:"price_monthly"`
}

func (r planReq) toInput() platform.PlanInput {
	return platform.PlanInput{
		Code: r.Code, Name: r.Name, ClinicType: r.ClinicType, BranchLimit: r.BranchLimit, UserLimit: r.UserLimit,
		StorageGB: r.StorageGB, PatientLimit: r.PatientLimit, ImagesPerPatient: r.ImagesPerPatient,
		SMSMonthly: r.SMSMonthly, PriceMonthly: r.PriceMonthly,
	}
}

func (h *Handlers) ListPlans(c *gin.Context) {
	plans, err := h.svc.ListPlans(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(plans))
	for _, p := range plans {
		out = append(out, planDTO(p))
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreatePlan(c *gin.Context) {
	var req planReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("plan code and name are required"))
		return
	}
	p, err := h.svc.CreatePlan(c.Request.Context(), req.toInput())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, planDTO(*p))
}

func (h *Handlers) UpdatePlan(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPlan, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid plan id"))
		return
	}
	var req planReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	if err := h.svc.UpdatePlan(c.Request.Context(), pid, req.toInput()); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SetClinicPlan(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	var req struct {
		PlanID               string `json:"plan_id"`
		StorageGBOverride    *int   `json:"storage_gb_override"`
		PatientLimitOverride *int   `json:"patient_limit_override"`
		UserLimitOverride    *int   `json:"user_limit_override"`
		BranchLimitOverride  *int   `json:"branch_limit_override"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("plan_id is required"))
		return
	}
	planID, err := id.Decode(id.PrefixPlan, req.PlanID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid plan_id"))
		return
	}
	if err := h.svc.SetClinicPlan(c.Request.Context(), tid, platform.ClinicPlanInput{
		PlanID: planID, StorageGBOverride: req.StorageGBOverride, PatientLimitOverride: req.PatientLimitOverride,
		UserLimitOverride: req.UserLimitOverride, BranchLimitOverride: req.BranchLimitOverride,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) GetClinicUsage(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	u, err := h.svc.ClinicUsage(c.Request.Context(), tid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, u)
}

// --- plan features & per-clinic entitlements ----------------------------------

// Features handles GET /platform/features — the catalogue of what can be gated.
func (h *Handlers) Features(c *gin.Context) {
	out, err := h.svc.Features(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// PlanFeatures handles GET /platform/plans/:id/features.
func (h *Handlers) PlanFeatures(c *gin.Context) {
	pid, derr := id.Decode(id.PrefixPlan, c.Param("id"))
	if derr != nil {
		httpx.Fail(c, apperr.Validation("invalid plan id"))
		return
	}
	out, err := h.svc.PlanFeatures(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SetPlanFeatures handles PUT /platform/plans/:id/features.
func (h *Handlers) SetPlanFeatures(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPlan, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid plan id"))
		return
	}
	var req struct {
		Features map[string]bool `json:"features"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("features are required"))
		return
	}
	if err := h.svc.SetPlanFeatures(c.Request.Context(), pid, req.Features); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ClinicEntitlements handles GET /platform/clinics/:id/entitlements.
func (h *Handlers) ClinicEntitlements(c *gin.Context) {
	tid, derr := id.Decode(id.PrefixTenant, c.Param("id"))
	if derr != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	out, err := h.svc.ClinicEntitlements(c.Request.Context(), tid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SetClinicEntitlement handles PUT /platform/clinics/:id/entitlements — one
// feature at a time, because each is a commercial decision with a reason.
func (h *Handlers) SetClinicEntitlement(c *gin.Context) {
	tid, err := id.Decode(id.PrefixTenant, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid clinic id"))
		return
	}
	var req struct {
		Feature string `json:"feature"`
		// nil clears the exception and lets the plan decide again.
		State *bool  `json:"state"`
		Note  string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Feature) == "" {
		httpx.Fail(c, apperr.Validation("a feature is required"))
		return
	}
	if err := h.svc.SetClinicEntitlement(c.Request.Context(), tid, strings.TrimSpace(req.Feature), req.State, req.Note); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}
