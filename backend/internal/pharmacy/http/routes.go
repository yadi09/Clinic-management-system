package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the pharmacy routes (group must already have
// RequireAuth). The whole module is gated by the `pharmacy` feature flag.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/pharmacy", httpx.RequireFlag("pharmacy"))

	read := httpx.RequirePermission("pharmacy.read")
	g.GET("/drugs", read, h.ListDrugs)
	g.GET("/drugs/search", read, h.SearchDrugs)
	g.GET("/batches", read, h.ListBatches)
	g.GET("/dispense-queue", read, h.DispenseQueue)
	g.GET("/dispense/:id", read, h.DispenseDetail)
	g.GET("/dashboard", read, h.Dashboard)

	g.POST("/dispense/:id", httpx.RequirePermission("pharmacy.dispense"), h.Dispense)
	g.POST("/otc", httpx.RequirePermission("pharmacy.sell"), h.SellOTC)

	stock := httpx.RequirePermission("pharmacy.stock")
	g.POST("/stock/adjust", stock, h.AdjustStock)
	g.POST("/batches/:id/quarantine", stock, h.Quarantine)

	manage := httpx.RequirePermission("pharmacy.manage")
	g.POST("/drugs", manage, h.CreateDrug)
	g.PUT("/drugs/:id", manage, h.UpdateDrug)
}
