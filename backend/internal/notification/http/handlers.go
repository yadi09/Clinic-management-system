package http

import (
	"encoding/json"
	"regexp"
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

// kindParam reads an optional kind filter. Kinds are short snake_case names; any
// other text is refused rather than passed on to a query.
func kindParam(c *gin.Context) (string, bool) {
	k := c.Query("kind")
	if k == "" {
		return "", true
	}
	if !kindPattern.MatchString(k) {
		httpx.Fail(c, apperr.Validation("unknown notification kind"))
		return "", false
	}
	return k, true
}

var kindPattern = regexp.MustCompile(`^[a-z][a-z_]{0,39}$`)

func (h *Handlers) List(c *gin.Context) {
	f := notification.ListFilter{}
	switch c.Query("status") {
	case "", "all":
	case "unread":
		f.Status = notification.StatusUnread
	case "read":
		f.Status = notification.StatusRead
	default:
		httpx.Fail(c, apperr.Validation("status must be unread, read or all"))
		return
	}
	// The original form, still sent by older screens.
	switch c.Query("unread") {
	case "1", "true":
		f.Status = notification.StatusUnread
	}
	kind, ok := kindParam(c)
	if !ok {
		return
	}
	f.Kind = kind
	if raw := c.Query("before"); raw != "" {
		u, err := id.Decode(id.PrefixNotification, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid before id"))
			return
		}
		f.Before = &u
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
	var next any
	if page.Next != nil {
		next = id.Encode(id.PrefixNotification, *page.Next)
	}
	httpx.OK(c, gin.H{"items": items, "unread": page.Unread, "next": next})
}

func (h *Handlers) Count(c *gin.Context) {
	n, err := h.svc.Counts(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"unread": n.Unread, "by_kind": n.ByKind})
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
	kind, ok := kindParam(c)
	if !ok {
		return
	}
	n, err := h.svc.MarkAllRead(c.Request.Context(), kind)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"marked": n})
}
