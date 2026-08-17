// Package http exposes the finance views.
//
// Everything here is read-only and gated on billing.manage — the permission whose
// description has always said "view the finance dashboard".
package http

import (
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/finance"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

type Handlers struct{ svc finance.Service }

func NewHandlers(svc finance.Service) *Handlers { return &Handlers{svc: svc} }

// addis is the clinic's day. A period picked as "today" must mean today in Addis,
// not today in UTC — the three-hour offset silently moved evening takings into the
// next day's figures on every report this system has ever printed.
var addis = func() *time.Location {
	loc, err := time.LoadLocation("Africa/Addis_Ababa")
	if err != nil {
		return time.FixedZone("EAT", 3*60*60)
	}
	return loc
}()

// filterFrom reads ?from=&to=&branch=. Dates are inclusive days in clinic time;
// `to` is exclusive at midnight so a single day is [00:00, next 00:00).
func filterFrom(c *gin.Context) (finance.Filter, error) {
	var f finance.Filter
	now := time.Now().In(addis)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, addis)

	f.From, f.To = today, today.AddDate(0, 0, 1)
	if v := c.Query("from"); v != "" {
		t, err := time.ParseInLocation("2006-01-02", v, addis)
		if err != nil {
			return f, apperr.Validation("from must be YYYY-MM-DD")
		}
		f.From = t
	}
	if v := c.Query("to"); v != "" {
		t, err := time.ParseInLocation("2006-01-02", v, addis)
		if err != nil {
			return f, apperr.Validation("to must be YYYY-MM-DD")
		}
		f.To = t.AddDate(0, 0, 1)
	}
	if f.To.Before(f.From) {
		return f, apperr.Validation("the end of the period cannot be before its start")
	}
	if v := c.Query("branch"); v != "" {
		bid, err := id.Decode(id.PrefixBranch, v)
		if err != nil {
			return f, apperr.Validation("invalid branch")
		}
		f.Branch = &bid
	}
	return f, nil
}

func (h *Handlers) Overview(c *gin.Context) {
	f, err := filterFrom(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Overview(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handlers) Receivables(c *gin.Context) {
	f, err := filterFrom(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Receivables(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out.Rows))
	for _, r := range out.Rows {
		rows = append(rows, gin.H{
			"id": id.Encode(id.PrefixPatient, r.PatientID), "mrn": r.MRN, "name": r.Name,
			"phone": r.Phone, "owed": r.Owed, "oldest_days": r.OldestDays,
			"bucket": r.Bucket, "last_paid": r.LastPaid, "why": r.Why,
		})
	}
	httpx.OK(c, gin.H{"total": out.Total, "count": out.Count, "buckets": out.Buckets, "rows": rows})
}

func (h *Handlers) Cash(c *gin.Context) {
	f, err := filterFrom(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Cash(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handlers) Services(c *gin.Context) {
	f, err := filterFrom(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Services(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func (h *Handlers) Book(c *gin.Context) {
	f, err := filterFrom(c)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out, err := h.svc.Book(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out.AtRisk))
	for _, r := range out.AtRisk {
		rows = append(rows, gin.H{
			"id": id.Encode(id.PrefixPatient, r.PatientID), "patient": r.Patient, "mrn": r.MRN,
			"phone": r.Phone, "plan": r.Plan, "at_risk": r.AtRisk, "reason": r.Reason, "days_idle": r.DaysIdle,
		})
	}
	httpx.OK(c, gin.H{"total": out.Total, "visits": out.Visits, "by_month": out.ByMonth, "at_risk": rows})
}

var _ = uuid.Nil
