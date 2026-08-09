package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the inpatient routes (bearer-authenticated group), all
// gated by the per-clinic "inpatient" module flag. Config + reports need
// bed.manage; the board + admit/discharge/transfer need bed.assign.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/inpatient", httpx.RequireFlag("inpatient"))

	g.GET("/wards", httpx.RequirePermission("bed.assign"), h.ListWards)
	g.POST("/wards", httpx.RequirePermission("bed.manage"), h.CreateWard)
	g.PUT("/wards/:id", httpx.RequirePermission("bed.manage"), h.UpdateWard)

	g.GET("/beds", httpx.RequirePermission("bed.assign"), h.ListBeds)
	g.POST("/beds", httpx.RequirePermission("bed.manage"), h.CreateBed)
	g.PUT("/beds/:id", httpx.RequirePermission("bed.manage"), h.UpdateBed)

	g.GET("/board", httpx.RequirePermission("bed.assign"), h.Board)
	g.POST("/admissions", httpx.RequirePermission("bed.assign"), h.Admit)
	g.POST("/admissions/:id/discharge", httpx.RequirePermission("bed.assign"), h.Discharge)
	g.POST("/admissions/:id/transfer", httpx.RequirePermission("bed.assign"), h.Transfer)

	g.GET("/report", httpx.RequirePermission("bed.manage"), h.Report)
}
