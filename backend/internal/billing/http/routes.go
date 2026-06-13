package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the billing routes (group must already have
// RequireAuth). The card fee is collected at reception (payment.collect).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/billing/card", httpx.RequirePermission("payment.collect"))
	g.GET("/assess", h.Assess)
	g.POST("/collect", h.Collect)
	g.GET("/history", h.History)
}
