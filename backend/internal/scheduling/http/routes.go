package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the bearer-authenticated scheduling routes (the group
// must already have RequireAuth). The SSE stream route is mounted separately in
// cmd/api with query-token auth (EventSource can't set headers).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	appt := rg.Group("/appointments")
	appt.GET("", httpx.RequirePermission("appointment.manage"), h.List)
	appt.POST("", httpx.RequirePermission("appointment.manage"), h.Book)
	appt.PUT("/:id", httpx.RequirePermission("appointment.manage"), h.Reschedule)
	appt.POST("/:id/status", httpx.RequirePermission("appointment.manage"), h.SetStatus)
	appt.POST("/:id/followup", httpx.RequirePermission("appointment.manage"), h.MarkFollowup)
	appt.POST("/:id/check-in", httpx.RequirePermission("queue.manage"), h.CheckIn)

	q := rg.Group("/queue")
	q.GET("", httpx.RequirePermission("queue.manage"), h.ListQueue)
	q.POST("/walk-in", httpx.RequirePermission("queue.manage"), h.WalkIn)
	q.POST("/:id/transition", httpx.RequirePermission("queue.manage"), h.Transition)
	q.POST("/:id/priority", httpx.RequirePermission("queue.manage"), h.SetPriority)
	q.POST("/:id/assign", httpx.RequirePermission("queue.manage"), h.Assign)

	// A doctor's personal worklist ("patients waiting for me") + the unassigned
	// pick-up pool (patients past triage not yet claimed by any doctor).
	rg.GET("/worklist", httpx.RequirePermission("encounter.manage"), h.Worklist)
	rg.GET("/worklist/unassigned", httpx.RequirePermission("encounter.manage"), h.Unassigned)
}
