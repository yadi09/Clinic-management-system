package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the clinical routes (group must already have
// RequireAuth).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	// Triage vitals (3a) — nurses.
	v := rg.Group("/visits", httpx.RequirePermission("triage.manage"))
	v.GET("/:qid", h.GetVisit)
	v.POST("/:qid/vitals", h.RecordVitals)

	// Encounter workspace (3b) — doctors.
	enc := rg.Group("/encounters", httpx.RequirePermission("encounter.manage"))
	enc.POST("", h.OpenEncounter)   // open-or-get the encounter for a queue entry
	enc.GET("", h.History)          // ?patient= → patient history timeline
	enc.GET("/:id", h.GetWorkspace)
	enc.PUT("/:id/note", h.SaveNote)
	enc.POST("/:id/diagnoses", h.AddDiagnosis)
	enc.DELETE("/:id/diagnoses/:dxId", h.RemoveDiagnosis)
	enc.POST("/:id/prescriptions", h.AddMedication)
	enc.DELETE("/:id/prescriptions/:itemId", h.RemoveMedication)
	enc.POST("/:id/sign", h.SignAndClose)

	// Diagnosis catalog — reads open to any authenticated staff (non-PHI
	// reference data); writes are admin-only (clinic.manage).
	rg.GET("/diagnosis-categories", h.ListCategories)
	rg.GET("/diagnosis-catalog", h.SearchCatalog)
	admin := rg.Group("", httpx.RequirePermission("clinic.manage"))
	admin.POST("/diagnosis-categories", h.CreateCategory)
	admin.PUT("/diagnosis-categories/:id", h.UpdateCategory)
	admin.DELETE("/diagnosis-categories/:id", h.DeleteCategory)
	admin.POST("/diagnosis-catalog", h.CreateCatalogEntry)
	admin.PUT("/diagnosis-catalog/:id", h.UpdateCatalogEntry)
	admin.DELETE("/diagnosis-catalog/:id", h.DeleteCatalogEntry)
}
