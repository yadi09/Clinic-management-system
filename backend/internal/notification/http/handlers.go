package http

import (
	"encoding/json"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/notification"
)

type Handlers struct{ svc notification.Service }

func NewHandlers(svc notification.Service) *Handlers { return &Handlers{svc: svc} }

// RegisterProtected mounts the signed-in user's inbox. No permission of its own:
// everyone has an inbox, and every query is limited to the caller's own rows.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	rg.GET("/notifications", h.List)
	rg.GET("/notifications/count", h.Count)
	rg.POST("/notifications/read-all", h.MarkAllRead)
	rg.POST("/notifications/:id/read", h.MarkRead)
}

// href is where opening a notification takes the user. Decided here, per kind, so
// the screen just follows it and a new kind needs no change on the frontend.
func href(n notification.Notification) string {
	switch n.Kind {
	case notification.KindMissedVisit:
		if n.PatientID != nil {
			return "/patients/" + id.Encode(id.PrefixPatient, *n.PatientID)
		}
	case notification.KindPatientWaiting:
		// The screen a doctor starts the visit from, chosen by the producer from
		// the clinic's type: a dentist's Chairside, a doctor's My day.
		var d struct {
			Screen string `json:"screen"`
		}
		_ = json.Unmarshal(n.Data, &d) // a missing or odd value falls to My day
		if d.Screen == "chairside" {
			return "/chairside"
		}
		return "/worklist"
	}
	return ""
}

func dto(n notification.Notification) gin.H {
	return gin.H{
		"id":         id.Encode(id.PrefixNotification, n.ID),
		"kind":       n.Kind,
		"title":      n.Title,
		"body":       n.Body,
		"data":       n.Data,
		"href":       href(n),
		"created_at": n.CreatedAt,
		"read_at":    n.ReadAt,
	}
}

func (h *Handlers) List(c *gin.Context) {
	f := notification.ListFilter{}
	switch c.Query("unread") {
	case "1", "true":
		f.UnreadOnly = true
	}
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			httpx.Fail(c, apperr.Validation("limit must be a positive number"))
			return
		}
		f.Limit = n
	}
	page, err := h.svc.List(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items := make([]gin.H, 0, len(page.Items))
	for _, n := range page.Items {
		items = append(items, dto(n))
	}
	httpx.OK(c, gin.H{"items": items, "unread": page.Unread})
}

func (h *Handlers) Count(c *gin.Context) {
	n, err := h.svc.UnreadCount(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"unread": n})
}

func (h *Handlers) MarkRead(c *gin.Context) {
	u, err := id.Decode(id.PrefixNotification, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return
	}
	if err := h.svc.MarkRead(c.Request.Context(), u); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) MarkAllRead(c *gin.Context) {
	n, err := h.svc.MarkAllRead(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"marked": n})
}
