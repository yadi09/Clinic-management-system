package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Register mounts the platform routes on the versioned group. Login is public;
// every other route requires a platform access token (platform.admin permission).
func (h *Handlers) Register(v1 *gin.RouterGroup, tokens *auth.TokenService) {
	// Public: partner-page lead capture (unauthenticated, rate-limited by v1).
	v1.POST("/partner/leads", h.CaptureLead)

	p := v1.Group("/platform")
	p.POST("/auth/login", h.Login)

	admin := p.Group("", httpx.RequireAuth(tokens), httpx.RequirePermission("platform.admin"))
	admin.GET("/clinics", h.ListClinics)
	admin.POST("/clinics", h.ProvisionClinic)
	admin.POST("/clinics/:id/suspend", h.Suspend)
	admin.POST("/clinics/:id/reactivate", h.Reactivate)
	admin.GET("/clinics/:id/modules", h.GetModules)
	admin.PUT("/clinics/:id/modules", h.SetModules)
	admin.GET("/clinics/:id/policies", h.GetPolicies)
	admin.PUT("/clinics/:id/policies", h.SetPolicies)
	admin.GET("/clinics/:id/usage", h.GetClinicUsage)
	admin.POST("/clinics/:id/plan", h.SetClinicPlan)
	admin.POST("/clinics/:id/impersonate", h.ImpersonateOwner)
	// A clinic's branches: each one a workspace of its own.
	admin.GET("/clinics/:id/branches", h.ListBranches)
	admin.POST("/clinics/:id/branches", h.CreateBranch)
	admin.GET("/plans", h.ListPlans)
	admin.POST("/plans", h.CreatePlan)
	admin.PUT("/plans/:id", h.UpdatePlan)
	// What a plan includes, and one clinic's exception to it.
	admin.GET("/features", h.Features)
	admin.GET("/plans/:id/features", h.PlanFeatures)
	admin.PUT("/plans/:id/features", h.SetPlanFeatures)
	admin.GET("/clinics/:id/entitlements", h.ClinicEntitlements)
	admin.PUT("/clinics/:id/entitlements", h.SetClinicEntitlement)
	// The vendor's own third-party credentials (currently the Verify.ET key).
	admin.GET("/integrations/verifyet", h.GetIntegration)
	admin.PUT("/integrations/verifyet", h.SetIntegration)
	admin.DELETE("/integrations/verifyet", h.ClearIntegration)

	admin.GET("/partner-leads", h.ListLeads)
	admin.POST("/partner-leads/:id/status", h.SetLeadStatus)
}
