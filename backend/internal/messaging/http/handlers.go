// Package http exposes the messaging module over HTTP.
package http

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/messaging"
)

// Handlers wires the messaging service to HTTP.
type Handlers struct{ svc messaging.Service }

// NewHandlers constructs messaging HTTP handlers.
func NewHandlers(svc messaging.Service) *Handlers { return &Handlers{svc: svc} }

// GetSettings returns how this clinic sends.
func (h *Handlers) GetSettings(c *gin.Context) {
	out, err := h.svc.GetSettings(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SaveSettings updates how this clinic sends.
func (h *Handlers) SaveSettings(c *gin.Context) {
	var req struct {
		Enabled      bool   `json:"enabled"`
		Lang         string `json:"lang"`
		QuietFrom    string `json:"quiet_from"`
		QuietTo      string `json:"quiet_to"`
		SenderName   string `json:"sender_name"`
		SenderID     string `json:"sender_id"`
		SenderStatus string `json:"sender_status"`
		// Empty leaves the stored key alone; the form never echoes it back, and a
		// blank field must not be read as "delete my credential".
		APIKey      string `json:"api_key"`
		ClearAPIKey bool   `json:"clear_api_key"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("could not read those settings"))
		return
	}
	out, err := h.svc.SaveSettings(c.Request.Context(), messaging.SettingsInput{
		Enabled: req.Enabled, Lang: req.Lang, QuietFrom: req.QuietFrom,
		QuietTo: req.QuietTo, SenderName: req.SenderName,
		SenderID: req.SenderID, SenderStatus: req.SenderStatus,
		APIKey: req.APIKey, ClearAPIKey: req.ClearAPIKey,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Usage returns this month's spend against the allowance.
func (h *Handlers) Usage(c *gin.Context) {
	out, err := h.svc.Usage(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Preview prices a draft without sending it.
func (h *Handlers) Preview(c *gin.Context) {
	var req struct {
		Body string `json:"body"`
	}
	_ = c.ShouldBindJSON(&req)
	out, err := h.svc.Preview(c.Request.Context(), req.Body)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

type logDTO struct {
	ID string `json:"id"`
	messaging.LogRow
	PatientID string `json:"patient_id,omitempty"`
}

// Log returns what was sent, newest first.
func (h *Handlers) Log(c *gin.Context) {
	f := messaging.LogFilter{
		Kind:   strings.TrimSpace(c.Query("kind")),
		Status: strings.TrimSpace(c.Query("status")),
	}
	if v := strings.TrimSpace(c.Query("patient")); v != "" {
		pid, e := id.Decode(id.PrefixPatient, v)
		if e != nil {
			httpx.Fail(c, apperr.Validation("unknown patient"))
			return
		}
		f.PatientID = &pid
	}
	rows, err := h.svc.Log(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]logDTO, 0, len(rows))
	for _, r := range rows {
		d := logDTO{ID: id.Encode(id.PrefixMessage, r.ID), LogRow: r}
		if r.PatientID != nil {
			d.PatientID = id.Encode(id.PrefixPatient, *r.PatientID)
		}
		out = append(out, d)
	}
	httpx.OK(c, out)
}

// SendTest queues one message to a number the sender types in.
func (h *Handlers) SendTest(c *gin.Context) {
	var req struct {
		Phone string `json:"phone"`
		Body  string `json:"body"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a phone number and a message are required"))
		return
	}
	if err := h.svc.SendTest(c.Request.Context(), req.Phone, req.Body); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}
