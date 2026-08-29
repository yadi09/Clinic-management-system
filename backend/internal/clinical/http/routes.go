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

	// Voice dictation (speech-to-text) for clinical documentation — doctors (SOAP
	// notes) and triage nurses (triage notes).
	rg.POST("/transcribe", httpx.RequireAnyPermission("encounter.manage", "triage.manage"), h.Transcribe)

	// Import a migrated (paper / old-system) patient record as a back-dated visit —
	// done by whoever onboards old data (patient.create) or a clinician.
	// Medical certificates. A clinician signs these; reception does not — a
	// certificate is a clinical attestation, and the name on it must be the person
	// who actually saw the patient. Reading them is wider: the desk has to be able
	// to reprint one for a patient who lost it.
	rg.POST("/patients/:id/certificates", httpx.RequireAnyPermission("encounter.manage", "dental.manage"), h.IssueCertificate)
	rg.GET("/patients/:id/certificates", httpx.RequireAnyPermission("encounter.manage", "dental.manage", "dental.read", "patient.read"), h.ListCertificates)
	rg.POST("/certificates/:cid/void", httpx.RequireAnyPermission("encounter.manage", "dental.manage"), h.VoidCertificate)

	rg.POST("/history-import", httpx.RequireAnyPermission("patient.create", "encounter.manage"), h.ImportHistory)

	// Encounter workspace (3b) — doctors.
	enc := rg.Group("/encounters", httpx.RequirePermission("encounter.manage"))
	enc.POST("", h.OpenEncounter) // open-or-get the encounter for a queue entry
	enc.GET("", h.History)        // ?patient= → patient history timeline
	// The same record, asked the way a doctor asks it.
	rg.GET("/patients/:id/story", httpx.RequirePermission("encounter.manage"), h.Story)
	enc.GET("/board", h.MyBoard)  // doctor's "My day": in-progress + done today
	enc.GET("/:id", h.GetWorkspace)
	enc.POST("/:id/assist", h.Assist) // AI clinical decision-support co-pilot
	enc.PUT("/:id/note", h.SaveNote)
	enc.POST("/:id/diagnoses", h.AddDiagnosis)
	enc.DELETE("/:id/diagnoses/:dxId", h.RemoveDiagnosis)
	enc.POST("/:id/prescriptions", h.AddMedication)
	enc.DELETE("/:id/prescriptions/:itemId", h.RemoveMedication)
	enc.POST("/:id/set-aside", h.SetAside)
	enc.POST("/:id/sign", h.SignAndClose)
	// External lab referrals (clinics without an in-house lab): request tests to
	// print for the patient, then record the result they bring back.
	enc.POST("/:id/lab-referrals", h.CreateLabReferral)
	rg.POST("/lab-referrals/:id/result", httpx.RequirePermission("encounter.manage"), h.RecordLabReferralResult)
	rg.POST("/lab-referrals/:id/result/sign", httpx.RequirePermission("encounter.manage"), h.SignReferralUpload)
	rg.POST("/lab-referrals/:id/cancel", httpx.RequirePermission("encounter.manage"), h.CancelLabReferral)

	// Diagnosis catalog — reads open to any authenticated staff (non-PHI
	// reference data); writes are admin-only (clinic.manage).
	rg.GET("/diagnosis-categories", h.ListCategories)
	rg.GET("/diagnosis-catalog", h.SearchCatalog)
	// Vitals form config (VITALS-A): the recorder reads it (any staff who take
	// vitals); only an admin edits it.
	rg.GET("/vital-fields", h.GetVitalFields)
	admin := rg.Group("", httpx.RequirePermission("clinic.manage"))
	admin.PUT("/vital-fields", h.SaveVitalFields)
	admin.POST("/diagnosis-categories", h.CreateCategory)
	admin.PUT("/diagnosis-categories/:id", h.UpdateCategory)
	admin.DELETE("/diagnosis-categories/:id", h.DeleteCategory)
	admin.POST("/diagnosis-catalog", h.CreateCatalogEntry)
	admin.PUT("/diagnosis-catalog/:id", h.UpdateCatalogEntry)
	admin.DELETE("/diagnosis-catalog/:id", h.DeleteCatalogEntry)

	// Drug & allergen libraries (RX-LIB) — reads open to clinicians (used while
	// prescribing); writes by a doctor (encounter.manage) or a clinic admin.
	rg.GET("/drugs", h.SearchDrugs)
	rg.GET("/allergens", h.ListAllergens)
	rxlib := rg.Group("", httpx.RequireAnyPermission("encounter.manage", "clinic.manage"))
	rxlib.POST("/drugs", h.CreateDrug)
	rxlib.PUT("/drugs/:id", h.UpdateDrug)
	rxlib.DELETE("/drugs/:id", h.DeleteDrug)
	rxlib.PUT("/allergens/:id", h.UpdateAllergen)
	rxlib.DELETE("/allergens/:id", h.DeleteAllergen)
	// Creating an allergen is also allowed for whoever records patient allergies
	// (patient.update), so the allergen library stays the single source of truth.
	rg.POST("/allergens", httpx.RequireAnyPermission("encounter.manage", "clinic.manage", "patient.update"), h.CreateAllergen)
}
