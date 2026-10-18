package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterPublic mounts what a patient uses. Signing in is rate limited per address.
func (h *Handlers) RegisterPublic(v1 *gin.RouterGroup) {
	g := v1.Group("/portal")
	g.POST("/:slug/login", h.Login)
	g.GET("/:slug/me", h.Me)
}

// RegisterProtected mounts the clinic's own switches (group must already have RequireAuth).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	rg.GET("/portal-settings", httpx.RequirePermission("clinic.manage"), h.GetSettings)
	rg.PUT("/portal-settings", httpx.RequirePermission("clinic.manage"), h.SaveSettings)
}
