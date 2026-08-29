package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the maternity routes (bearer-authenticated group).
// Everything is gated behind the per-clinic "maternity" module flag; writes need
// triage.manage OR encounter.manage, reads need patient.read.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("", httpx.RequireFlag("maternity"))
	g.POST("/dating/preview", httpx.RequireAnyPermission("triage.manage", "encounter.manage"), h.Preview)
	g.POST("/patients/:id/dating", httpx.RequireAnyPermission("triage.manage", "encounter.manage"), h.Save)
	g.GET("/dating/summary", httpx.RequirePermission("patient.read"), h.Summary)
	g.GET("/patients/:id/dating", httpx.RequirePermission("patient.read"), h.Get)
	g.GET("/patients/:id/dating/history", httpx.RequirePermission("patient.read"), h.History)
}
