// Package http serves the patient portal.
package http

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/ratelimit"
	"github.com/reicb/clinicsaas/internal/portal"
)

type Handlers struct {
	svc    portal.Service
	typing ratelimit.Limiter
}

func New(svc portal.Service, typing ratelimit.Limiter) *Handlers {
	return &Handlers{svc: svc, typing: typing}
}

// noStore keeps a patient's record out of every cache and search engine.
func noStore(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("X-Robots-Tag", "noindex, nofollow")
}

// clientIP prefers the address Cloudflare saw; behind it c.ClientIP() is the proxy's.
func clientIP(c *gin.Context) string {
	if ip := strings.TrimSpace(c.GetHeader("CF-Connecting-IP")); ip != "" {
		return ip
	}
	return c.ClientIP()
}

// Login handles POST /portal/:slug/login {card}.
func (h *Handlers) Login(c *gin.Context) {
	noStore(c)
	ip := clientIP(c)
	if h.typing != nil && !h.typing.Allow("portal-login:"+ip) {
		httpx.Fail(c, apperr.RateLimited())
		return
	}
	var req struct {
		Card string `json:"card"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("type your card number"))
		return
	}
	s, err := h.svc.Login(c.Request.Context(), c.Param("slug"), req.Card, ip)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, s)
}

// Me handles GET /portal/:slug/me with the patient's token in X-Portal-Token.
func (h *Handlers) Me(c *gin.Context) {
	noStore(c)
	me, err := h.svc.Me(c.Request.Context(), c.Param("slug"), c.GetHeader("X-Portal-Token"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, me)
}

// GetSettings handles GET /portal-settings.
func (h *Handlers) GetSettings(c *gin.Context) {
	st, err := h.svc.GetSettings(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

// SaveSettings handles PUT /portal-settings.
func (h *Handlers) SaveSettings(c *gin.Context) {
	var in portal.Settings
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, apperr.Validation("invalid settings"))
		return
	}
	st, err := h.svc.SaveSettings(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}
