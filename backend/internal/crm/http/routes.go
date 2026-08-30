package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Register mounts the CRM under the platform group.
//
// Reps hold crm.work and see only this. Designing campaigns and creating accounts
// take platform.admin, so a marketing account can never reach the tenant controls
// sitting next door in the same console.
func (h *Handlers) Register(v1 *gin.RouterGroup, tokens *auth.TokenService) {
	g := v1.Group("/platform/crm", httpx.RequireAuth(tokens))

	work := httpx.RequirePermission("crm.work")
	boss := httpx.RequirePermission("platform.admin")

	g.GET("/campaigns", work, h.ListCampaigns)
	g.POST("/campaigns", boss, h.CreateCampaign)
	g.PUT("/campaigns/:id", boss, h.UpdateCampaign)
	g.POST("/campaigns/:id/active", boss, h.SetCampaignActive)
	g.GET("/campaigns/:id/board", work, h.GetBoard)

	g.GET("/prospects", work, h.ListProspects)
	g.GET("/prospects/duplicates", work, h.CheckDuplicates)
	g.POST("/prospects", work, h.CreateProspect)
	g.GET("/prospects/:id", work, h.GetProspect)
	g.PUT("/prospects/:id", work, h.UpdateProspect)
	g.POST("/prospects/:id/assign", work, h.Assign)
	g.POST("/prospects/:id/enrol", work, h.Enrol)
	g.POST("/prospects/:id/complete-phase", work, h.CompletePhase)
	g.POST("/prospects/:id/outcome", work, h.SetOutcome)
	g.POST("/prospects/:id/reopen", work, h.Reopen)
	g.POST("/prospects/:id/touches", work, h.LogTouch)

	g.GET("/reps", work, h.ListReps)
	g.POST("/reps", boss, h.CreateRep)
	g.POST("/reps/:id/status", boss, h.SetRepStatus)

	g.POST("/inbound/import", boss, h.ImportInbound)
}
