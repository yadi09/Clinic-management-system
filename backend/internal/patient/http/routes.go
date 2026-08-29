package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts patient routes (group must already have RequireAuth).
// Each route is gated by an atomic permission (NFR-13).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	p := rg.Group("/patients")
	p.POST("", httpx.RequirePermission("patient.create"), h.Create)
	p.POST("/import", httpx.RequirePermission("patient.create"), h.Import) // legacy register (bulk CSV)
	p.GET("", httpx.RequirePermission("patient.search"), h.Search)
	p.GET("/:id", httpx.RequirePermission("patient.read"), h.Get)
	// One call, filled differently for each person who makes it — see Overview.
	p.GET("/:id/overview", httpx.RequirePermission("patient.read"), h.Overview)
	p.PUT("/:id", httpx.RequirePermission("patient.update"), h.Update)
	p.DELETE("/:id", httpx.RequirePermission("patient.update"), h.Delete)

	p.POST("/:id/allergies", httpx.RequirePermission("patient.update"), h.AddAllergy)
	p.DELETE("/:id/allergies/:sid", httpx.RequirePermission("patient.update"), h.RemoveAllergy)
	p.POST("/:id/conditions", httpx.RequirePermission("patient.update"), h.AddCondition)
	p.DELETE("/:id/conditions/:sid", httpx.RequirePermission("patient.update"), h.RemoveCondition)
	p.POST("/:id/guardians", httpx.RequirePermission("patient.update"), h.AddGuardian)

	p.POST("/:id/attachments/sign", httpx.RequirePermission("patient.update"), h.SignUpload)
	p.POST("/:id/attachments", httpx.RequirePermission("patient.update"), h.RecordAttachment)
	p.DELETE("/:id/attachments/:sid", httpx.RequirePermission("patient.update"), h.RemoveAttachment)
}
