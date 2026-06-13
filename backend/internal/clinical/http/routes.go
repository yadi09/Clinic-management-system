package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the clinical routes (group must already have
// RequireAuth). Triage vitals are gated by triage.manage.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	v := rg.Group("/visits", httpx.RequirePermission("triage.manage"))
	v.GET("/:qid", h.GetVisit)
	v.POST("/:qid/vitals", h.RecordVitals)
}
