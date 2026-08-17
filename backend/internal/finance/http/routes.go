package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Register mounts the finance views. Read-only, and behind the same permission
// that has always guarded the finance dashboard.
func Register(rg *gin.RouterGroup, h *Handlers, tokens *auth.TokenService) {
	g := rg.Group("/finance", httpx.RequireAuth(tokens), httpx.RequirePermission("billing.manage"))
	g.GET("/overview", h.Overview)
	g.GET("/receivables", h.Receivables)
}
