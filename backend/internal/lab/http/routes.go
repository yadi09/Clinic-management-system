package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the lab routes (group must already have RequireAuth).
// The whole module is gated by the `laboratory` feature flag.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/lab", httpx.RequireFlag("laboratory"))

	// Catalog reads — any authenticated staff (non-PHI reference data).
	g.GET("/tests", h.ListTests)
	g.GET("/tests/:id/analytes", h.ListAnalytes)
	// Catalog management.
	mgr := httpx.RequirePermission("lab.manage")
	g.POST("/tests", mgr, h.CreateTest)
	g.POST("/tests/:id/analytes", mgr, h.AddAnalyte)

	// Orders + doctor views.
	order := httpx.RequirePermission("lab.order")
	g.POST("/orders", order, h.CreateOrder)
	g.GET("/encounters/:id/labs", order, h.EncounterLabs)
	g.GET("/encounters/:id/pending", order, h.PendingLabs)

	// Technician processing.
	proc := httpx.RequirePermission("lab.process")
	g.GET("/worklist", proc, h.Worklist)
	g.GET("/items/:id", proc, h.GetItem)
	g.POST("/items/:id/accession", proc, h.Accession)
	g.PUT("/items/:id/results", proc, h.SaveResults)
	g.POST("/items/:id/submit", proc, h.SubmitResults)

	// Validation.
	g.POST("/items/:id/validate", httpx.RequirePermission("lab.validate"), h.ValidateItem)
}
