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

	// Billing-1: service catalog (admin), charges + cashier, finance view.
	b := rg.Group("/billing")
	mgr := httpx.RequirePermission("billing.manage")
	b.GET("/services", h.ListServices) // readable by any authenticated staff (to price a charge)
	b.POST("/services", mgr, h.CreateService)
	b.PUT("/services/:id", mgr, h.UpdateService)
	b.PUT("/services/:id/active", mgr, h.SetServiceActive)
	b.PUT("/services/:id/default", mgr, h.SetServiceDefault)
	b.GET("/services/:id/providers", mgr, h.GetServiceProviders)
	b.PUT("/services/:id/providers", mgr, h.SetServiceProviders)
	b.DELETE("/services/:id", mgr, h.DeleteService)
	b.GET("/providers", httpx.RequirePermission("payment.collect"), h.ProvidersForServices) // reception's filtered list

	collect := httpx.RequirePermission("payment.collect")
	b.POST("/charges", collect, h.RaiseCharge)
	b.GET("/charges/pending", collect, h.PendingCharges)
	b.GET("/charges", collect, h.PatientCharges) // ?patient=
	b.POST("/charges/:id/settle", collect, h.SettleCharge)
	b.POST("/charges/:id/waive", httpx.RequirePermission("payment.waive"), h.WaiveCharge)
	b.GET("/waiver-reasons", collect, h.WaiverReasons)

	b.GET("/cash", mgr, h.Cash) // owner/manager finance view
}
