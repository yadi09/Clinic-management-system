package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Register mounts the platform routes on the versioned group. Login is public;
// every other route requires a platform access token (platform.admin permission).
func (h *Handlers) Register(v1 *gin.RouterGroup, tokens *auth.TokenService) {
	p := v1.Group("/platform")
	p.POST("/auth/login", h.Login)

	admin := p.Group("", httpx.RequireAuth(tokens), httpx.RequirePermission("platform.admin"))
	admin.GET("/clinics", h.ListClinics)
	admin.POST("/clinics", h.ProvisionClinic)
	admin.POST("/clinics/:id/suspend", h.Suspend)
	admin.POST("/clinics/:id/reactivate", h.Reactivate)
	admin.GET("/clinics/:id/modules", h.GetModules)
	admin.PUT("/clinics/:id/modules", h.SetModules)
}
