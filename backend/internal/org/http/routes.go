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

	g.GET("/workspace", h.GetWorkspace)
	g.PUT("/workspace", manage, h.UpdateWorkspace)

	g.GET("/settings", h.GetSettings)
	g.PUT("/settings", manage, h.SaveSettings)

	g.GET("/branch-usage", h.BranchUsage)
	g.GET("/plan-usage", h.PlanUsage)
	g.GET("/branches", h.ListBranches)
	g.POST("/branches", manage, h.CreateBranch)
	g.PUT("/branches/:id", manage, h.UpdateBranch)
	g.DELETE("/branches/:id", manage, h.DeleteBranch)
	g.GET("/branches/:id/modules", manage, h.GetBranchModules)
	g.PUT("/branches/:id/modules", manage, h.SetBranchModules)

	g.GET("/departments", h.ListDepartments)
	g.POST("/departments", manage, h.CreateDepartment)
	g.PUT("/departments/:id", manage, h.UpdateDepartment)
	g.DELETE("/departments/:id", manage, h.DeleteDepartment)

	g.GET("/resources", h.ListResources)
	g.POST("/resources", manage, h.CreateResource)
	g.DELETE("/resources/:id", manage, h.DeleteResource)
}
