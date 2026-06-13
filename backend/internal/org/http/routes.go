package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts org routes (group must already have RequireAuth).
// Reads are open to any authenticated staff; mutations require clinic.manage.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/org")
	manage := httpx.RequirePermission("clinic.manage")

	g.GET("/clinic", h.GetClinic)
	g.PUT("/clinic", manage, h.SaveClinic)

	g.GET("/settings", h.GetSettings)
	g.PUT("/settings", manage, h.SaveSettings)

	g.GET("/branches", h.ListBranches)
	g.POST("/branches", manage, h.CreateBranch)
	g.PUT("/branches/:id", manage, h.UpdateBranch)
	g.DELETE("/branches/:id", manage, h.DeleteBranch)

	g.GET("/departments", h.ListDepartments)
	g.POST("/departments", manage, h.CreateDepartment)
	g.PUT("/departments/:id", manage, h.UpdateDepartment)
	g.DELETE("/departments/:id", manage, h.DeleteDepartment)

	g.GET("/resources", h.ListResources)
	g.POST("/resources", manage, h.CreateResource)
	g.DELETE("/resources/:id", manage, h.DeleteResource)
}
