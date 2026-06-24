// Package http exposes the scheduling REST + SSE endpoints.
package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/scheduling"
)

// Handlers wires the scheduling service (and the DB pool for SSE) to HTTP.
type Handlers struct {
	svc scheduling.Service
	db  *kerneldb.DB
}

// NewHandlers constructs scheduling HTTP handlers.
func NewHandlers(svc scheduling.Service, db *kerneldb.DB) *Handlers {
	return &Handlers{svc: svc, db: db}
}

// Book handles POST /appointments.
func (h *Handlers) Book(c *gin.Context) {
	var req bookRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("branch_id, patient_id, provider_id and starts_at are required"))
		return
	}
	in := scheduling.BookInput{DurationMin: req.DurationMin, Reason: req.Reason}
	var ok bool
	if in.BranchID, ok = decodeID(c, id.PrefixBranch, req.BranchID); !ok {
		return
	}
	if in.PatientID, ok = decodeID(c, id.PrefixPatient, req.PatientID); !ok {
		return
	}
	if in.ProviderID, ok = decodeID(c, id.PrefixUser, req.ProviderID); !ok {
		return
	}
	if in.DepartmentID, ok = decodeOpt(c, id.PrefixDepartment, req.DepartmentID); !ok {
		return
	}
	if in.ResourceID, ok = decodeOpt(c, id.PrefixResource, req.ResourceID); !ok {
		return
	}
	ts, err := time.Parse(time.RFC3339, req.StartsAt)
	if err != nil {
		httpx.Fail(c, apperr.Validation("starts_at must be RFC3339"))
		return
	}
	in.StartsAt = ts
	appt, err := h.svc.Book(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, toAppointmentDTO(*appt))
}

// List handles GET /appointments?branch=&from=&to=&provider=.
func (h *Handlers) List(c *gin.Context) {
	branchID, ok := decodeID(c, id.PrefixBranch, c.Query("branch"))
	if !ok {
		return
	}
	from, to := dayRange(c.Query("from"), c.Query("to"))
	var provider *uuid.UUID
	if c.Query("provider") != "" {
		p, ok := decodeOpt(c, id.PrefixUser, c.Query("provider"))
		if !ok {
			return
		}
		provider = p
	}
	appts, err := h.svc.List(c.Request.Context(), branchID, from, to, provider)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]appointmentDTO, 0, len(appts))
	for _, a := range appts {
		out = append(out, toAppointmentDTO(a))
	}
	httpx.OK(c, out)
}

// Reschedule handles PUT /appointments/:id.
func (h *Handlers) Reschedule(c *gin.Context) {
	aid, ok := decodeID(c, id.PrefixAppointment, c.Param("id"))
	if !ok {
		return
	}
	var req rescheduleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("starts_at and provider_id are required"))
		return
	}
	in := scheduling.RescheduleInput{DurationMin: req.DurationMin, Reason: req.Reason}
	if in.ProviderID, ok = decodeID(c, id.PrefixUser, req.ProviderID); !ok {
		return
	}
	if in.DepartmentID, ok = decodeOpt(c, id.PrefixDepartment, req.DepartmentID); !ok {
		return
	}
	if in.ResourceID, ok = decodeOpt(c, id.PrefixResource, req.ResourceID); !ok {
		return
	}
	ts, err := time.Parse(time.RFC3339, req.StartsAt)
	if err != nil {
		httpx.Fail(c, apperr.Validation("starts_at must be RFC3339"))
		return
	}
	in.StartsAt = ts
	appt, err := h.svc.Reschedule(c.Request.Context(), aid, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, toAppointmentDTO(*appt))
}

// SetStatus handles POST /appointments/:id/status.
func (h *Handlers) SetStatus(c *gin.Context) {
	aid, ok := decodeID(c, id.PrefixAppointment, c.Param("id"))
	if !ok {
		return
	}
	var req statusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("status is required"))
		return
	}
	if err := h.svc.SetStatus(c.Request.Context(), aid, req.Status, req.CancelReason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// CheckIn handles POST /appointments/:id/check-in.
func (h *Handlers) CheckIn(c *gin.Context) {
	aid, ok := decodeID(c, id.PrefixAppointment, c.Param("id"))
	if !ok {
		return
	}
	var req checkInRequest
	_ = c.ShouldBindJSON(&req)
	in := scheduling.CheckInInput{Priority: req.Priority, ToTriage: req.ToTriage}
	if req.ProviderID != "" {
		p, ok := decodeOpt(c, id.PrefixUser, req.ProviderID)
		if !ok {
			return
		}
		in.ProviderID = p
	}
	gated, err := h.svc.CheckIn(c.Request.Context(), aid, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"gated": gated})
}

// MarkFollowup handles POST /appointments/:id/followup — flags the appointment
// as a covered follow-up that is free of the card fee until free_until (RFC3339;
// defaults to 30 days from now if omitted).
func (h *Handlers) MarkFollowup(c *gin.Context) {
	aid, ok := decodeID(c, id.PrefixAppointment, c.Param("id"))
	if !ok {
		return
	}
	var req followupRequest
	_ = c.ShouldBindJSON(&req)
	freeUntil := time.Now().AddDate(0, 0, 30)
	if req.FreeUntil != "" {
		t, err := time.Parse(time.RFC3339, req.FreeUntil)
		if err != nil {
			httpx.Fail(c, apperr.Validation("free_until must be RFC3339"))
			return
		}
		freeUntil = t
	}
	if err := h.svc.MarkFollowup(c.Request.Context(), aid, freeUntil); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// WalkIn handles POST /queue/walk-in.
func (h *Handlers) WalkIn(c *gin.Context) {
	var req walkInRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("branch_id, department_id and patient_id are required"))
		return
	}
	in := scheduling.WalkInInput{Priority: req.Priority, ToTriage: req.ToTriage}
	var ok bool
	if in.BranchID, ok = decodeID(c, id.PrefixBranch, req.BranchID); !ok {
		return
	}
	if in.DepartmentID, ok = decodeID(c, id.PrefixDepartment, req.DepartmentID); !ok {
		return
	}
	if in.PatientID, ok = decodeID(c, id.PrefixPatient, req.PatientID); !ok {
		return
	}
	if req.ProviderID != "" {
		if in.ProviderID, ok = decodeOpt(c, id.PrefixUser, req.ProviderID); !ok {
			return
		}
	}
	gated, err := h.svc.EnqueueWalkIn(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"status": "queued", "gated": gated})
}

// ListQueue handles GET /queue?department=&stage=&from=&to=. The optional
// from/to window (RFC3339) drives the board's date filter (today / yesterday /
// last 3 days); absent from defaults to the start of today.
func (h *Handlers) ListQueue(c *gin.Context) {
	dept, ok := decodeID(c, id.PrefixDepartment, c.Query("department"))
	if !ok {
		return
	}
	var from time.Time
	if f, err := time.Parse(time.RFC3339, c.Query("from")); err == nil {
		from = f
	}
	var until *time.Time
	if t, err := time.Parse(time.RFC3339, c.Query("to")); err == nil {
		until = &t
	}
	entries, err := h.svc.ListQueue(c.Request.Context(), dept, c.Query("stage"), from, until)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]queueEntryDTO, 0, len(entries))
	for _, e := range entries {
		out = append(out, toQueueDTO(e))
	}
	httpx.OK(c, out)
}

// Worklist handles GET /worklist?provider= — a doctor's "patients waiting for
// me". Defaults to the authenticated user when no provider is given.
func (h *Handlers) Worklist(c *gin.Context) {
	var provider uuid.UUID
	if q := c.Query("provider"); q != "" {
		p, ok := decodeID(c, id.PrefixUser, q)
		if !ok {
			return
		}
		provider = p
	} else if p, ok := httpx.PrincipalFrom(c); ok {
		provider = p.UserID
	} else {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	var from time.Time
	if f, err := time.Parse(time.RFC3339, c.Query("from")); err == nil {
		from = f
	}
	entries, err := h.svc.ListWorklist(c.Request.Context(), provider, from)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]worklistDTO, 0, len(entries))
	for _, e := range entries {
		out = append(out, toWorklistDTO(e))
	}
	httpx.OK(c, out)
}

// Unassigned handles GET /worklist/unassigned — the pick-up pool of patients past
// triage but not yet claimed by any doctor.
func (h *Handlers) Unassigned(c *gin.Context) {
	var from time.Time
	if f, err := time.Parse(time.RFC3339, c.Query("from")); err == nil {
		from = f
	}
	entries, err := h.svc.ListUnassigned(c.Request.Context(), from)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]worklistDTO, 0, len(entries))
	for _, e := range entries {
		out = append(out, toWorklistDTO(e))
	}
	httpx.OK(c, out)
}

// Assign handles POST /queue/:id/assign — route a queue entry to a doctor.
func (h *Handlers) Assign(c *gin.Context) {
	qid, ok := decodeID(c, id.PrefixQueueEntry, c.Param("id"))
	if !ok {
		return
	}
	var req assignRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("provider_id is required"))
		return
	}
	provider, ok := decodeID(c, id.PrefixUser, req.ProviderID)
	if !ok {
		return
	}
	if err := h.svc.AssignProvider(c.Request.Context(), qid, provider); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// Transition handles POST /queue/:id/transition.
func (h *Handlers) Transition(c *gin.Context) {
	qid, ok := decodeID(c, id.PrefixQueueEntry, c.Param("id"))
	if !ok {
		return
	}
	var req transitionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("state is required"))
		return
	}
	if err := h.svc.TransitionQueue(c.Request.Context(), qid, req.State); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// SetPriority handles POST /queue/:id/priority.
func (h *Handlers) SetPriority(c *gin.Context) {
	qid, ok := decodeID(c, id.PrefixQueueEntry, c.Param("id"))
	if !ok {
		return
	}
	var req priorityRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("priority is required"))
		return
	}
	if err := h.svc.SetQueuePriority(c.Request.Context(), qid, req.Priority); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// QueueStream handles GET /queue/stream?department=&token= — Server-Sent Events
// backed by Postgres LISTEN/NOTIFY. Emits a "data" event whenever a queue entry
// in the caller's tenant (and the requested department) changes (NFR-04).
func (h *Handlers) QueueStream(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	deptFilter := ""
	if d := c.Query("department"); d != "" {
		dept, err := id.Decode(id.PrefixDepartment, d)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid department"))
			return
		}
		deptFilter = dept.String()
	}
	ctx := c.Request.Context()

	poolConn, err := h.db.Pool.Acquire(ctx)
	if err != nil {
		httpx.Fail(c, apperr.Internal(err))
		return
	}
	conn := poolConn.Hijack() // take the connection out of the pool; we own/close it
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "LISTEN queue_events"); err != nil {
		httpx.Fail(c, apperr.Internal(err))
		return
	}

	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	fmt.Fprint(c.Writer, ": connected\n\n")
	c.Writer.Flush()

	payloads := make(chan string, 16)
	go func() {
		defer close(payloads)
		for {
			n, err := conn.WaitForNotification(ctx)
			if err != nil {
				return // ctx cancelled (client gone) or conn error
			}
			select {
			case payloads <- n.Payload:
			case <-ctx.Done():
				return
			}
		}
	}()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	tenantID := p.TenantID.String()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fmt.Fprint(c.Writer, ": ping\n\n")
			c.Writer.Flush()
		case payload, open := <-payloads:
			if !open {
				return
			}
			var ev struct {
				TenantID     string `json:"tenant_id"`
				DepartmentID string `json:"department_id"`
			}
			if json.Unmarshal([]byte(payload), &ev) != nil || ev.TenantID != tenantID {
				continue
			}
			if deptFilter != "" && ev.DepartmentID != deptFilter {
				continue
			}
			fmt.Fprintf(c.Writer, "event: queue\ndata: %s\n\n", payload)
			c.Writer.Flush()
		}
	}
}

// --- helpers ---

func decodeID(c *gin.Context, prefix, raw string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, raw)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return uuid.Nil, false
	}
	return u, true
}

func decodeOpt(c *gin.Context, prefix, raw string) (*uuid.UUID, bool) {
	if raw == "" {
		return nil, true
	}
	u, err := id.Decode(prefix, raw)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return nil, false
	}
	return &u, true
}

func dayRange(fromStr, toStr string) (time.Time, time.Time) {
	from, err := time.Parse(time.RFC3339, fromStr)
	if err != nil {
		now := time.Now().UTC()
		from = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	}
	to, err := time.Parse(time.RFC3339, toStr)
	if err != nil {
		to = from.Add(24 * time.Hour)
	}
	return from, to
}
