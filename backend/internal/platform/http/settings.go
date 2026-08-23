package http

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/platform"
)

// Integrations tells the console which vendor credentials are loaded. Never the
// credentials themselves — a hint is enough to tell two keys apart.
func (h *Handlers) GetIntegration(c *gin.Context) {
	out, err := h.svc.GetIntegration(c.Request.Context(), platform.SettingVerifyETKey)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handlers) SetIntegration(c *gin.Context) {
	var req struct {
		Key string `json:"key"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("paste the key first"))
		return
	}
	var actor *uuid.UUID
	if p, ok := httpx.PrincipalFrom(c); ok {
		id := p.UserID
		actor = &id
	}
	out, err := h.svc.SetIntegrationKey(c.Request.Context(), platform.SettingVerifyETKey, req.Key, actor)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handlers) ClearIntegration(c *gin.Context) {
	if err := h.svc.ClearIntegrationKey(c.Request.Context(), platform.SettingVerifyETKey); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}
