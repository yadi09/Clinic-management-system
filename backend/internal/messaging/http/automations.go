package http

import (
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/messaging"
)

// Variables lists the placeholders a template may use, so the editor can offer
// them as buttons rather than expecting anyone to remember the spelling.
func (h *Handlers) Variables(c *gin.Context) {
	out := make([]gin.H, 0, len(messaging.Vars))
	for _, name := range messaging.VarNames() {
		out = append(out, gin.H{"name": name, "describes": messaging.Vars[name]})
	}
	httpx.OK(c, out)
}

// ListTemplates returns the clinic's wording for every occasion.
func (h *Handlers) ListTemplates(c *gin.Context) {
	out, err := h.svc.ListTemplates(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SaveTemplate replaces one occasion's wording in one language.
func (h *Handlers) SaveTemplate(c *gin.Context) {
	var req struct {
		Kind string `json:"kind"`
		Lang string `json:"lang"`
		Body string `json:"body"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("could not read that message"))
		return
	}
	if err := h.svc.SaveTemplate(c.Request.Context(), req.Kind, req.Lang, req.Body); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ListRules returns each automation's timing and whether it is on.
func (h *Handlers) ListRules(c *gin.Context) {
	out, err := h.svc.ListRules(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SaveRule changes one automation.
func (h *Handlers) SaveRule(c *gin.Context) {
	var req struct {
		Kind        string `json:"kind"`
		Enabled     bool   `json:"enabled"`
		OffsetHours int    `json:"offset_hours"`
		SendAt      string `json:"send_at"`
		RepeatDays  int    `json:"repeat_days"`
		MaxRepeats  int    `json:"max_repeats"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("could not read that setting"))
		return
	}
	if err := h.svc.SaveRule(c.Request.Context(), messaging.RuleInput{
		Kind: req.Kind, Enabled: req.Enabled, OffsetHours: req.OffsetHours,
		SendAt: req.SendAt, RepeatDays: req.RepeatDays, MaxRepeats: req.MaxRepeats,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type audienceDTO struct {
	ID string `json:"id"`
	messaging.Audience
}

// Audience lists patients a hand-picked send could go to.
func (h *Handlers) Audience(c *gin.Context) {
	f := messaging.AudienceFilter{
		Search:    strings.TrimSpace(c.Query("q")),
		OwingOnly: c.Query("owing") == "1",
	}
	if v := strings.TrimSpace(c.Query("seen_days")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			httpx.Fail(c, apperr.Validation("that is not a number of days"))
			return
		}
		f.SeenWithinDays = n
	}
	rows, err := h.svc.Audience(c.Request.Context(), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]audienceDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, audienceDTO{ID: id.Encode(id.PrefixPatient, r.PatientID), Audience: r})
	}
	httpx.OK(c, out)
}

// SendCampaign queues one message to the patients somebody chose.
func (h *Handlers) SendCampaign(c *gin.Context) {
	var req struct {
		Title      string   `json:"title"`
		Body       string   `json:"body"`
		PatientIDs []string `json:"patient_ids"`
		// ISO-8601. Absent or empty means send now.
		ScheduledFor string `json:"scheduled_for"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("could not read that message"))
		return
	}
	in := messaging.CampaignInput{Title: req.Title, Body: req.Body}
	for _, raw := range req.PatientIDs {
		pid, err := id.Decode(id.PrefixPatient, strings.TrimSpace(raw))
		if err != nil {
			// One bad id fails the whole send rather than quietly dropping a patient
			// somebody deliberately chose.
			httpx.Fail(c, apperr.Validation("one of those patients is not recognised"))
			return
		}
		in.PatientIDs = append(in.PatientIDs, pid)
	}
	if v := strings.TrimSpace(req.ScheduledFor); v != "" {
		when, err := time.Parse(time.RFC3339, v)
		if err != nil {
			httpx.Fail(c, apperr.Validation("that send time is not a valid date and time"))
			return
		}
		in.ScheduledFor = &when
	}
	res, err := h.svc.SendCampaign(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{
		"id": id.Encode(id.PrefixCampaign, res.ID), "queued": res.Queued,
		"skipped": res.Skipped, "segments": res.Segments, "cost": res.Cost,
	})
}

// Resend has another go at a message that did not reach the patient.
func (h *Handlers) Resend(c *gin.Context) {
	mid, err := id.Decode(id.PrefixMessage, strings.TrimSpace(c.Param("id")))
	if err != nil {
		httpx.Fail(c, apperr.Validation("unknown message"))
		return
	}
	if err := h.svc.Resend(c.Request.Context(), mid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// SendNow releases a message waiting out the clinic's quiet hours.
func (h *Handlers) SendNow(c *gin.Context) {
	mid, err := id.Decode(id.PrefixMessage, strings.TrimSpace(c.Param("id")))
	if err != nil {
		httpx.Fail(c, apperr.Validation("unknown message"))
		return
	}
	if err := h.svc.SendNow(c.Request.Context(), mid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// UnbilledReminders previews or sends reminders for selected unbilled-treatment
// rows. One endpoint for both: the preview and the send must run the identical
// derivation, or the desk approves one thing and the patient receives another.
func (h *Handlers) UnbilledReminders(c *gin.Context) {
	var req struct {
		SessionIDs []string `json:"session_ids"`
		Body       string   `json:"body"`
		Preview    bool     `json:"preview"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("could not read that request"))
		return
	}
	in := messaging.UnbilledRemindInput{Body: req.Body, Preview: req.Preview}
	for _, raw := range req.SessionIDs {
		sid, err := id.Decode(id.PrefixTreatmentSession, strings.TrimSpace(raw))
		if err != nil {
			// One bad id fails the whole batch rather than silently dropping a row
			// somebody deliberately ticked.
			httpx.Fail(c, apperr.Validation("one of those rows is not recognised — refresh the page"))
			return
		}
		in.SessionIDs = append(in.SessionIDs, sid)
	}
	res, err := h.svc.UnbilledReminders(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(res.Rows))
	for _, r := range res.Rows {
		rows = append(rows, gin.H{
			"patient_id":   id.Encode(id.PrefixPatient, r.PatientID),
			"patient_name": r.PatientName, "mrn": r.MRN, "body": r.Body,
			"segments": r.Segments, "cost": r.Cost, "skip_reason": r.SkipReason,
			"last_reminded_at": r.LastRemindedAt,
		})
	}
	httpx.OK(c, gin.H{"rows": rows, "segments": res.Segments, "cost": res.Cost,
		"queued": res.Queued, "skipped": res.Skipped})
}
