package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterPublic mounts what whoever holds a paper may open without an account.
// The token in the link is unguessable (128 bits), the whole v1 group is rate limited
// per address, and typing a short code is limited harder still.
func (h *Handlers) RegisterPublic(v1 *gin.RouterGroup) {
	g := v1.Group("/verify")
	g.GET("/t/:slug/:token", h.Check)
	g.GET("/c/:slug/:code", h.ByCode)
	g.GET("/logo/:slug", h.Logo)
}

// RegisterProtected mounts the clinic's own side (group must already have
// RequireAuth). Whoever can write a prescription may print it with its check.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	rg.POST("/verify/issue", httpx.RequireAnyPermission("dental.manage", "encounter.manage"), h.Issue)
}
