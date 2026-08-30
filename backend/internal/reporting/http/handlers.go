// Package http exposes the DHIS2 reporting endpoints: render the top-10 grid,
// push it to DHIS2 (dry-run then write, server-side), read it back, and clear it.
package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/dhis2"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/reporting"
)

// Handlers wires the reporting service to HTTP.
type Handlers struct {
	svc reporting.Service
}

func NewHandlers(svc reporting.Service) *Handlers { return &Handlers{svc: svc} }

// RegisterProtected mounts /reporting/dhis2 under clinic.manage (owner/manager).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/reporting/dhis2", httpx.RequirePermission("clinic.manage"))
	g.GET("", h.GetReport)
	g.POST("/push", h.Push)
	g.GET("/submitted", h.Submitted)
	g.POST("/clear", h.Clear)
	g.GET("/config", h.GetConfig)
	g.PUT("/config", h.SaveConfig)
	g.POST("/test", h.TestConnection)
	g.GET("/elements", h.ListElements)
	g.GET("/mapping", h.GetMapping)
	g.PUT("/mapping", h.SaveMapping)
}

func configDTO(c *reporting.Config) gin.H {
	return gin.H{
		"connected": c.Connected, "base_url": c.BaseURL, "org_unit": c.OrgUnit,
		"org_unit_name": c.OrgUnitName, "data_set": c.DataSet, "period_calendar": c.PeriodCalendar,
	}
}

func (h *Handlers) GetConfig(c *gin.Context) {
	cfg, err := h.svc.GetConfig(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, configDTO(cfg))
}

func (h *Handlers) SaveConfig(c *gin.Context) {
	var req struct {
		Token          string `json:"token"`
		BaseURL        string `json:"base_url"`
		OrgUnit        string `json:"org_unit"`
		OrgUnitName    string `json:"org_unit_name"`
		PeriodCalendar string `json:"period_calendar"`
	}
	_ = c.ShouldBindJSON(&req)
	cfg, err := h.svc.SaveConfig(c.Request.Context(), reporting.ConfigInput{
		Token: req.Token, BaseURL: req.BaseURL, OrgUnit: req.OrgUnit,
		OrgUnitName: req.OrgUnitName, PeriodCalendar: req.PeriodCalendar,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, configDTO(cfg))
}

func (h *Handlers) TestConnection(c *gin.Context) {
	var req struct {
		Token   string `json:"token"`
		BaseURL string `json:"base_url"`
	}
	_ = c.ShouldBindJSON(&req)
	res, err := h.svc.TestConnection(c.Request.Context(), req.Token, req.BaseURL)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	facs := make([]gin.H, 0, len(res.Facilities))
	for _, f := range res.Facilities {
		facs = append(facs, gin.H{"id": f.ID, "name": f.Name})
	}
	httpx.OK(c, gin.H{"facilities": facs, "calendar": res.Calendar})
}

func (h *Handlers) ListElements(c *gin.Context) {
	els, err := h.svc.ListElements(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(els))
	for _, e := range els {
		out = append(out, gin.H{"id": e.ID, "name": e.Name})
	}
	httpx.OK(c, gin.H{"elements": out})
}

func (h *Handlers) GetMapping(c *gin.Context) {
	entries, err := h.svc.GetMapping(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(entries))
	for _, m := range entries {
		out = append(out, gin.H{"disease_key": m.DiseaseKey, "disease_name": m.DiseaseName, "data_element": m.DataElement, "data_element_name": m.DataElementName})
	}
	httpx.OK(c, gin.H{"entries": out})
}

func (h *Handlers) SaveMapping(c *gin.Context) {
	var req struct {
		Entries []struct {
			DiseaseKey      string `json:"disease_key"`
			DiseaseName     string `json:"disease_name"`
			DataElement     string `json:"data_element"`
			DataElementName string `json:"data_element_name"`
		} `json:"entries"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("entries are required"))
		return
	}
	entries := make([]reporting.MapEntry, 0, len(req.Entries))
	for _, e := range req.Entries {
		entries = append(entries, reporting.MapEntry{DiseaseKey: e.DiseaseKey, DiseaseName: e.DiseaseName, DataElement: e.DataElement, DataElementName: e.DataElementName})
	}
	if err := h.svc.SaveMapping(c.Request.Context(), entries); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ageLabels is the display label per column key (fixed order in dhis2.ColumnKeys).
var ageLabels = map[string]string{
	"1": "<1", "1_4": "1–4", "5_14": "5–14", "15_29": "15–29", "30_64": "30–64", "65": "≥65",
}

func columns() []gin.H {
	cols := make([]gin.H, 0, len(dhis2.ColumnKeys))
	for _, k := range dhis2.ColumnKeys {
		sex := "M"
		band := k[2:]
		if k[0] == 'F' {
			sex = "F"
		}
		cols = append(cols, gin.H{"key": k, "sex": sex, "label": ageLabels[band]})
	}
	return cols
}

func (h *Handlers) GetReport(c *gin.Context) {
	rep, err := h.svc.GetReport(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	colTotals := map[string]int{}
	grand := 0
	diseases := make([]gin.H, 0, len(rep.Diseases))
	for _, d := range rep.Diseases {
		total := 0
		for _, k := range dhis2.ColumnKeys {
			if v, ok := d.Counts[k]; ok {
				total += v
				colTotals[k] += v
				grand += v
			}
		}
		diseases = append(diseases, gin.H{
			"rank": d.Rank, "name": d.Name, "data_element": d.DataElement,
			"counts": d.Counts, "total": total,
		})
	}
	httpx.OK(c, gin.H{
		"configured": rep.Configured,
		"context": gin.H{
			"org_unit": rep.Context.OrgUnit, "org_unit_linked": rep.Context.OrgUnitLinked,
			"data_set": rep.Context.DataSet,
			"period":   rep.Context.Period, "period_label": rep.Context.PeriodLabel,
			"period_start": rep.Context.PeriodStart, "period_end": rep.Context.PeriodEnd,
			"department": rep.Context.Department, "outcome": rep.Context.Outcome,
		},
		"columns":       columns(),
		"diseases":      diseases,
		"column_totals": colTotals,
		"grand_total":   grand,
	})
}

func (h *Handlers) Push(c *gin.Context) {
	sum, err := h.svc.Push(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, summaryDTO(sum))
}

func (h *Handlers) Clear(c *gin.Context) {
	sum, err := h.svc.Clear(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, summaryDTO(sum))
}

func (h *Handlers) Submitted(c *gin.Context) {
	vals, err := h.svc.Submitted(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(vals))
	for _, v := range vals {
		out = append(out, gin.H{"data_element": v.DataElement, "category_option_combo": v.CategoryOptionCombo, "value": v.Value})
	}
	httpx.OK(c, gin.H{"count": len(out), "values": out})
}

func summaryDTO(s *dhis2.ImportSummary) gin.H {
	conflicts := make([]string, 0, len(s.Conflicts))
	for _, c := range s.Conflicts {
		conflicts = append(conflicts, c.Value)
	}
	return gin.H{
		"status": s.Status, "description": s.Description,
		"imported": s.Imported, "updated": s.Updated, "ignored": s.Ignored, "deleted": s.Deleted,
		"conflicts": conflicts,
	}
}
