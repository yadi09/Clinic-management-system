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
	g.GET("/:slug/pay/options", h.PayOptions)
	g.POST("/:slug/pay", h.Pay)
	g.GET("/:slug/pay/:id", h.PayStatus)
}

// RegisterProtected mounts the clinic's own switches (group must already have RequireAuth).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	rg.GET("/portal-settings", httpx.RequirePermission("clinic.manage"), h.GetSettings)
	rg.PUT("/portal-settings", httpx.RequirePermission("clinic.manage"), h.SaveSettings)
	// The cashier decides what the bank check could not.
	rg.GET("/portal-payments", httpx.RequirePermission("payment.collect"), h.ListPayments)
	rg.POST("/portal-payments/:id/confirm", httpx.RequirePermission("payment.collect"), h.ConfirmPayment)
	rg.POST("/portal-payments/:id/reject", httpx.RequirePermission("payment.collect"), h.RejectPayment)
}
