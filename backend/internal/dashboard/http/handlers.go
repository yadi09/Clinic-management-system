package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/dashboard"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

type Handlers struct{ svc dashboard.Service }

func NewHandlers(svc dashboard.Service) *Handlers { return &Handlers{svc: svc} }

// RegisterProtected mounts the home screen's single request. No permission of its
// own: every section inside is already gated by what the caller may see, and a home
// screen that 403s is a home screen nobody can open.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	rg.GET("/dashboard/today", h.Today)
}

func (h *Handlers) Today(c *gin.Context) {
	out, err := h.svc.Today(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}
