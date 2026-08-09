package http

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/clinical"
	"github.com/reicb/clinicsaas/internal/kernel/ai"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

// Assist handles POST /encounters/:id/assist — the clinical decision-support
// co-pilot. It assembles the encounter's current context (demographics, allergies,
// latest vitals, the doctor's note, working diagnoses/prescriptions) plus a curated
// summary of the patient's relevant past history, then asks the model for
// provisional differentials, red flags, workup, management, and questions. The
// endpoint is disabled when no AI key is configured; nothing is written to the
// record — the doctor decides what to accept.
func (h *Handlers) Assist(c *gin.Context) {
	if h.assist == nil || !h.assist.Configured() {
		httpx.Fail(c, apperr.New(http.StatusServiceUnavailable, "ASSIST_DISABLED", "AI Assist is not enabled on this clinic"))
		return
	}
	encID, ok := decodeParam(c, id.PrefixEncounter, "id")
	if !ok {
		return
	}
	ws, err := h.svc.GetWorkspace(c.Request.Context(), encID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}

	in := buildAssistInput(ws)
	// Relevant past history — best effort; a failure here shouldn't block the analysis.
	if hist, herr := h.svc.History(c.Request.Context(), ws.Patient.PatientID); herr == nil {
		in.PastHistory = summarizeHistory(hist, encID)
	}

	res, err := h.assist.Suggest(c.Request.Context(), in)
	if errors.Is(err, ai.ErrUnauthorized) {
		httpx.Fail(c, apperr.New(http.StatusBadGateway, "ASSIST_AUTH", "AI Assist key is invalid or revoked — update NVIDIA_API_KEY"))
		return
	}
	if err != nil {
		httpx.Fail(c, apperr.New(http.StatusBadGateway, "ASSIST_FAILED", "AI Assist could not analyze this encounter — try again"))
		return
	}
	httpx.OK(c, res)
}

// buildAssistInput flattens the encounter workspace into the model's input shape.
func buildAssistInput(ws *clinical.Workspace) ai.AssistInput {
	in := ai.AssistInput{
		Age:        ws.Patient.Age,
		Gender:     ws.Patient.Gender,
		BloodGroup: ws.Patient.BloodGroup,
	}
	for _, a := range ws.Allergies {
		s := a.Substance
		if a.Severity != "" {
			s += " (" + a.Severity + ")"
		}
		if a.Reaction != "" {
			s += ": " + a.Reaction
		}
		in.Allergies = append(in.Allergies, s)
	}
	if v, ok := latestVitals(ws.Vitals); ok {
		in.Vitals = formatVitals(v)
	}
	in.Note = combineNote(ws.Note)
	for _, d := range ws.Diagnoses {
		s := d.Description
		if d.Code != "" {
			s = d.Code + " — " + s
		}
		in.Diagnoses = append(in.Diagnoses, s)
	}
	for _, m := range ws.Prescription {
		s := m.DrugName
		if m.Dose != "" {
			s += " " + m.Dose
		}
		if m.Frequency != "" {
			s += " " + m.Frequency
		}
		in.Medications = append(in.Medications, s)
	}
	return in
}

func latestVitals(vs []clinical.Vitals) (clinical.Vitals, bool) {
	if len(vs) == 0 {
		return clinical.Vitals{}, false
	}
	latest := vs[0]
	for _, v := range vs[1:] {
		if v.RecordedAt.After(latest.RecordedAt) {
			latest = v
		}
	}
	return latest, true
}

func formatVitals(v clinical.Vitals) []string {
	var out []string
	if v.Systolic != nil && v.Diastolic != nil {
		out = append(out, fmt.Sprintf("BP %d/%d mmHg", *v.Systolic, *v.Diastolic))
	}
	if v.Pulse != nil {
		out = append(out, fmt.Sprintf("Pulse %d bpm", *v.Pulse))
	}
	if v.RespRate != nil {
		out = append(out, fmt.Sprintf("RR %d /min", *v.RespRate))
	}
	if v.Spo2 != nil {
		out = append(out, fmt.Sprintf("SpO2 %d%%", *v.Spo2))
	}
	if v.TempC != nil && *v.TempC != "" {
		out = append(out, fmt.Sprintf("Temp %s°C", *v.TempC))
	}
	if v.WeightKg != nil && *v.WeightKg != "" {
		out = append(out, fmt.Sprintf("Weight %s kg", *v.WeightKg))
	}
	if v.HeightCm != nil && *v.HeightCm != "" {
		out = append(out, fmt.Sprintf("Height %s cm", *v.HeightCm))
	}
	if strings.TrimSpace(v.Notes) != "" {
		out = append(out, "Triage note: "+strings.TrimSpace(v.Notes))
	}
	return out
}

func combineNote(n clinical.Note) string {
	var parts []string
	add := func(label, val string) {
		if strings.TrimSpace(val) != "" {
			parts = append(parts, label+": "+strings.TrimSpace(val))
		}
	}
	add("Subjective", n.Subjective)
	add("Objective", n.Objective)
	add("Assessment", n.Assessment)
	add("Plan", n.Plan)
	return strings.Join(parts, "\n")
}

// summarizeHistory turns the patient timeline into a compact list of the most
// recent past encounters (excluding the current one), newest first, capped so the
// prompt stays small — one line each: "2026-03-14: <primary diagnosis>".
func summarizeHistory(items []clinical.HistoryItem, current uuid.UUID) []string {
	filtered := make([]clinical.HistoryItem, 0, len(items))
	for _, it := range items {
		if it.ID == current {
			continue
		}
		filtered = append(filtered, it)
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].StartedAt.After(filtered[j].StartedAt) })

	const maxItems = 10
	if len(filtered) > maxItems {
		filtered = filtered[:maxItems]
	}
	out := make([]string, 0, len(filtered))
	for _, it := range filtered {
		date := it.StartedAt.Format("2006-01-02")
		dx := strings.TrimSpace(it.PrimaryDx)
		if dx == "" {
			label := it.Type
			if label == "" {
				label = "visit"
			}
			dx = label + " (no recorded diagnosis)"
		}
		out = append(out, date+": "+dx)
	}
	return out
}
