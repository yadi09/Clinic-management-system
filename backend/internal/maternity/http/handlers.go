// Package http exposes the maternity (pregnancy dating) endpoints. Handlers are
// thin: parse YYYY-MM-DD dates, call the service, return JSON with date-only
// strings (the timezone-clean contract).
package http

import (
	"strings"

	"github.com/google/uuid"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/maternity"
	"github.com/reicb/clinicsaas/internal/pregnancy"
)

type Handlers struct {
	svc maternity.Service
}

func NewHandlers(svc maternity.Service) *Handlers { return &Handlers{svc: svc} }

type inputsReq struct {
	FirstDayOfLmp  string `json:"firstDayOfLmp"`
	CycleLength    *int   `json:"cycleLength"`
	UltrasoundDate string `json:"ultrasoundDate"`
	GaWeeks        *int   `json:"gaWeeks"`
	GaDays         *int   `json:"gaDays"`
	Edd            string `json:"edd"`
	TransferDate   string `json:"transferDate"`
	EmbryoType     string `json:"embryoType"`
	ConceptionDate string `json:"conceptionDate"`
}

type datingReq struct {
	Method string    `json:"method"`
	Inputs inputsReq `json:"inputs"`
	GaDate string    `json:"gaDate"`
	Note   string    `json:"note"`
}

func parseDate(s string) (*time.Time, bool) {
	if s == "" {
		return nil, true
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil, false
	}
	return &t, true
}

func (r inputsReq) toInputs() (pregnancy.Inputs, bool) {
	var in pregnancy.Inputs
	ok := true
	get := func(s string) *time.Time { d, valid := parseDate(s); ok = ok && valid; return d }
	in.FirstDayOfLMP = get(r.FirstDayOfLmp)
	in.UltrasoundDate = get(r.UltrasoundDate)
	in.EDD = get(r.Edd)
	in.TransferDate = get(r.TransferDate)
	in.ConceptionDate = get(r.ConceptionDate)
	in.CycleLength = r.CycleLength
	in.GAWeeks = r.GaWeeks
	in.GADays = r.GaDays
	if r.EmbryoType != "" {
		et := r.EmbryoType
		in.EmbryoType = &et
	}
	return in, ok
}

func gaDateOrToday(s string) time.Time {
	if d, ok := parseDate(s); ok && d != nil {
		return *d
	}
	n := time.Now().UTC()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}

func dstr(t time.Time) string { return t.Format("2006-01-02") }
func dptr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.Format("2006-01-02")
	return &s
}

func resultDTO(r pregnancy.Result) gin.H {
	win := gin.H{}
	for k, w := range r.Windows {
		win[k] = gin.H{"start": dptr(w.Start), "end": dptr(w.End), "point": dptr(w.Point)}
	}
	return gin.H{
		"calculatedLmp":       dstr(r.CalculatedLMP),
		"estimatedConception": dstr(r.EstimatedConception),
		"edd":                 dstr(r.EDD),
		"gestationalAge": gin.H{
			"days": r.GestationalAge.Days, "weeks": r.GestationalAge.Weeks,
			"remDays": r.GestationalAge.RemDays, "label": r.GestationalAge.Label, "valid": r.GestationalAge.Valid,
		},
		"windows": win,
	}
}

func redateDTO(r *maternity.RedateRec) gin.H {
	if r == nil {
		return nil
	}
	return gin.H{"recommended": r.Recommended, "discrepancyDays": r.DiscrepancyDays, "previousEdd": dstr(r.PreviousEDD), "newEdd": dstr(r.NewEDD)}
}

// Preview handles POST /dating/preview (compute only, no persistence).
func (h *Handlers) Preview(c *gin.Context) {
	var req datingReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("method and inputs are required"))
		return
	}
	in, ok := req.Inputs.toInputs()
	if !ok {
		httpx.Fail(c, apperr.Validation("dates must be YYYY-MM-DD"))
		return
	}
	res, err := h.svc.Preview(c.Request.Context(), pregnancy.Method(req.Method), in, gaDateOrToday(req.GaDate))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, resultDTO(res))
}

// Save handles POST /patients/:id/dating (persist + history).
func (h *Handlers) Save(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPatient, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient id"))
		return
	}
	var req datingReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("method and inputs are required"))
		return
	}
	in, ok := req.Inputs.toInputs()
	if !ok {
		httpx.Fail(c, apperr.Validation("dates must be YYYY-MM-DD"))
		return
	}
	out, err := h.svc.SaveDating(c.Request.Context(), pid, pregnancy.Method(req.Method), in, gaDateOrToday(req.GaDate), req.Note)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	dating := resultDTO(out.Dating.Result)
	dating["method"] = string(out.Dating.Method)
	httpx.OK(c, gin.H{"dating": dating, "redate": redateDTO(out.Redate)})
}

// Get handles GET /patients/:id/dating (current dating, GA recomputed for gaDate/today).
func (h *Handlers) Get(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPatient, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient id"))
		return
	}
	d, err := h.svc.GetDating(c.Request.Context(), pid, gaDateOrToday(c.Query("gaDate")))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if d == nil {
		httpx.OK(c, gin.H{"dating": nil})
		return
	}
	dating := resultDTO(d.Result)
	dating["method"] = string(d.Method)
	if d.UpdatedAt != nil {
		dating["updatedAt"] = d.UpdatedAt.Format(time.RFC3339)
	}
	httpx.OK(c, gin.H{"dating": dating})
}

// Summary handles GET /dating/summary?patients=pat_a,pat_b — which of these patients
// already has a dating, so a worklist can say so on the row instead of making the
// nurse open the calculator to find out.
func (h *Handlers) Summary(c *gin.Context) {
	raw := strings.Split(c.Query("patients"), ",")
	ids := make([]uuid.UUID, 0, len(raw))
	for _, r := range raw {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		pid, err := id.Decode(id.PrefixPatient, r)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid patient id"))
			return
		}
		ids = append(ids, pid)
	}
	found, err := h.svc.SummaryFor(c.Request.Context(), ids, gaDateOrToday(c.Query("gaDate")))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	items := make([]gin.H, 0, len(found))
	for pid, d := range found {
		row := resultDTO(d.Result)
		row["patientId"] = id.Encode(id.PrefixPatient, pid)
		row["method"] = string(d.Method)
		if d.UpdatedAt != nil {
			row["updatedAt"] = d.UpdatedAt.Format(time.RFC3339)
		}
		items = append(items, row)
	}
	httpx.OK(c, gin.H{"items": items})
}

// History handles GET /patients/:id/dating/history.
func (h *Handlers) History(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPatient, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient id"))
		return
	}
	entries, err := h.svc.History(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(entries))
	for _, e := range entries {
		out = append(out, gin.H{
			"method": string(e.Method), "calculatedLmp": dstr(e.CalculatedLMP), "edd": dstr(e.EDD),
			"recordedByName": e.RecordedByName, "recordedAt": e.RecordedAt.Format(time.RFC3339), "note": e.Note,
		})
	}
	httpx.OK(c, gin.H{"entries": out})
}
