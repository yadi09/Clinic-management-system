package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Register mounts the finance views. Read-only, and behind the same permission
// that has always guarded the finance dashboard.
func Register(rg *gin.RouterGroup, h *Handlers, tokens *auth.TokenService) {
	g := rg.Group("/finance", httpx.RequireAuth(tokens), httpx.RequirePermission("billing.manage"),
		httpx.RequireFlag("finance_advanced"))
	g.GET("/overview", h.Overview)
	// Aged debt is sold as its own line ("who owes you, and for how long"), so it
	// gets its own gate: a plan can include the dashboard without it.
	g.GET("/receivables", httpx.RequireFlag("debt_ageing"), h.Receivables)
	g.GET("/cash", h.Cash)
	g.GET("/services", h.Services)
	g.GET("/book", h.Book)
}
