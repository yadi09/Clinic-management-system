// Package http exposes the campaign: a handful of public endpoints for the page
// itself, and the vendor console's editing behind platform.admin.
package http

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/campaign"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Handlers serves the campaign endpoints.
type Handlers struct{ svc campaign.Service }

// New constructs the handlers.
func New(svc campaign.Service) *Handlers { return &Handlers{svc: svc} }

// token comes from a header rather than the URL so it stays out of server logs,
// browser history and anything the clinic might paste into a group chat.
func token(c *gin.Context) string {
	if t := strings.TrimSpace(c.GetHeader("X-Campaign-Token")); t != "" {
		return t
	}
	return strings.TrimSpace(c.Query("t"))
}

// Public handles GET /campaigns/:code — everything the page may know up front.
func (h *Handlers) Public(c *gin.Context) {
	out, err := h.svc.Public(c.Request.Context(), c.Param("code"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Enter handles POST /campaigns/:code/enter.
func (h *Handlers) Enter(c *gin.Context) {
	var req struct {
		FullName   string `json:"full_name"`
		Phone      string `json:"phone"`
		ClinicName string `json:"clinic_name"`
		Website    string `json:"website"` // honeypot: bots fill it, people never see it
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("please fill in all three fields"))
		return
	}
	out, err := h.svc.Enter(c.Request.Context(), c.Param("code"), campaign.EnterInput{
		FullName: req.FullName, Phone: req.Phone, ClinicName: req.ClinicName, Honeypot: req.Website,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

// Resume handles GET /campaigns/:code/me — where this clinic got to.
func (h *Handlers) Resume(c *gin.Context) {
	out, err := h.svc.Resume(c.Request.Context(), c.Param("code"), token(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Questions handles GET /campaigns/:code/questions.
func (h *Handlers) Questions(c *gin.Context) {
	out, err := h.svc.Questions(c.Request.Context(), c.Param("code"), token(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Answer handles POST /campaigns/:code/answer.
func (h *Handlers) Answer(c *gin.Context) {
	var req struct {
		Question string `json:"question"`
		Choice   int    `json:"choice"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("choose an answer"))
		return
	}
	out, err := h.svc.Answer(c.Request.Context(), c.Param("code"), token(c), req.Question, req.Choice)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Spin handles POST /campaigns/:code/spin.
func (h *Handlers) Spin(c *gin.Context) {
	out, err := h.svc.Spin(c.Request.Context(), c.Param("code"), token(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}
