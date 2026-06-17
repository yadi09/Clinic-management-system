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
	g.PUT("/tests/:id", mgr, h.UpdateTest)
	g.PUT("/tests/:id/active", mgr, h.SetTestActive)
	g.DELETE("/tests/:id", mgr, h.DeleteTest)
	g.POST("/tests/:id/analytes", mgr, h.AddAnalyte)
	g.PUT("/analytes/:id", mgr, h.UpdateAnalyte)
	g.DELETE("/analytes/:id", mgr, h.DeleteAnalyte)
	g.POST("/catalog/import", mgr, h.ImportCatalog)

	// Orders + doctor views.
	order := httpx.RequirePermission("lab.order")
	g.POST("/orders", order, h.CreateOrder)
	g.GET("/encounters/:id/labs", order, h.EncounterLabs)
	g.GET("/encounters/:id/pending", order, h.PendingLabs)
	// Doctor results inbox (returned results; unacknowledged criticals pinned).
	g.GET("/inbox", order, h.Inbox)
	g.GET("/inbox/count", order, h.InboxCount)

	// Technician processing.
	proc := httpx.RequirePermission("lab.process")
	g.GET("/worklist", proc, h.Worklist)
	g.GET("/find-sample", proc, h.FindSample) // barcode/sample lookup
	// Sample detail is readable by the tech, the ordering doctor and the validator.
	g.GET("/items/:id", httpx.RequireAnyPermission("lab.process", "lab.order", "lab.validate"), h.GetItem)
	g.POST("/items/:id/accession", proc, h.Accession)
	g.PUT("/items/:id/results", proc, h.SaveResults)
	g.POST("/items/:id/submit", proc, h.SubmitResults)
	// Critical-callback acknowledgement — the ordering doctor or the lab.
	g.POST("/items/:id/notify", httpx.RequireAnyPermission("lab.order", "lab.process"), h.MarkNotified)

	// Validation.
	g.POST("/items/:id/validate", httpx.RequirePermission("lab.validate"), h.ValidateItem)
}
