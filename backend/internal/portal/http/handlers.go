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

func token(c *gin.Context) string { return c.GetHeader("X-Portal-Token") }

// PayOptions handles GET /portal/:slug/pay/options.
func (h *Handlers) PayOptions(c *gin.Context) {
	noStore(c)
	out, err := h.svc.PayOptions(c.Request.Context(), c.Param("slug"), token(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Pay handles POST /portal/:slug/pay. Limited per address: every try can cost the clinic a
// paid bank check.
func (h *Handlers) Pay(c *gin.Context) {
	noStore(c)
	if h.typing != nil && !h.typing.Allow("portal-pay:"+clientIP(c)) {
		httpx.Fail(c, apperr.RateLimited())
		return
	}
	var in portal.PayInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, apperr.Validation("choose what you are paying and type the transaction number"))
		return
	}
	out, err := h.svc.Pay(c.Request.Context(), c.Param("slug"), token(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// PayStatus handles GET /portal/:slug/pay/:id.
func (h *Handlers) PayStatus(c *gin.Context) {
	noStore(c)
	out, err := h.svc.PayStatus(c.Request.Context(), c.Param("slug"), token(c), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// ListPayments handles GET /portal-payments — attempts nobody has confirmed yet.
func (h *Handlers) ListPayments(c *gin.Context) {
	out, err := h.svc.ListPayments(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// ConfirmPayment handles POST /portal-payments/:id/confirm.
func (h *Handlers) ConfirmPayment(c *gin.Context) {
	out, err := h.svc.ConfirmPayment(c.Request.Context(), c.Param("id"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// RejectPayment handles POST /portal-payments/:id/reject {reason}.
func (h *Handlers) RejectPayment(c *gin.Context) {
	var in struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&in)
	if err := h.svc.RejectPayment(c.Request.Context(), c.Param("id"), in.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"ok": true})
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
