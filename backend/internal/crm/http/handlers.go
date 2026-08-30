// Package http exposes the CRM inside the platform console's authenticated group.
//
// Two permissions run through here. crm.work is the marketing rep's: see the
// pipeline, add clinics, log calls, move a clinic forward. platform.admin is the
// super-admin's and additionally covers designing campaigns and creating accounts —
// a rep who can walk into a clinic must not be able to provision or suspend one.
package http

import (
	"context"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/crm"
	crmservice "github.com/reicb/clinicsaas/internal/crm/service"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

type Handlers struct{ svc crm.Service }

func NewHandlers(s crm.Service) *Handlers { return &Handlers{svc: s} }

// ctxOf carries the acting platform account down to the service, which stamps it on
// every touch, completed phase and new clinic. "Who did this" is most of the value
// of a shared pipeline.
func ctxOf(c *gin.Context) context.Context {
	if p, ok := httpx.PrincipalFrom(c); ok {
		return crmservice.WithActor(c.Request.Context(), p.UserID)
	}
	return c.Request.Context()
}

func decode(c *gin.Context, prefix, raw string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, raw)
	if err != nil {
		httpx.Fail(c, apperr.Validation("that id is not valid"))
		return uuid.Nil, false
	}
	return u, true
}

/* ------------------------------------------------------------------ DTOs */

func phaseDTO(p crm.Phase) gin.H {
	return gin.H{"id": id.Encode(id.PrefixCrmPhase, p.ID), "seq": p.Seq, "name": p.Name,
		"intent": p.Intent, "waiting": p.Waiting}
}

func campaignDTO(c crm.Campaign) gin.H {
	ph := make([]gin.H, 0, len(c.Phases))
	for _, p := range c.Phases {
		ph = append(ph, phaseDTO(p))
	}
	return gin.H{"id": id.Encode(id.PrefixCrmCampaign, c.ID), "name": c.Name, "goal": c.Goal,
		"is_active": c.IsActive, "phases": ph, "active": c.Active, "signed_up": c.SignedUp,
		"created_at": c.Created}
}

func prospectDTO(p crm.Prospect) gin.H {
	h := gin.H{
		"id": id.Encode(id.PrefixProspect, p.ID), "clinic_name": p.ClinicName,
		"contact_name": p.ContactName, "contact_role": p.ContactRole,
		"phone": p.Phone, "phone_alt": p.PhoneAlt, "email": p.Email,
		"address": p.Address, "map_url": p.MapURL, "note": p.Note,
		"source": p.Source, "status": p.Status, "outcome_note": p.OutcomeNote,
		"owner_name": p.OwnerName, "touches": p.Touches, "created_at": p.CreatedAt,
	}
	if p.ReadyOn != nil {
		h["ready_on"] = *p.ReadyOn
	}
	if p.OwnerID != nil {
		h["owner_id"] = id.Encode(id.PrefixUser, *p.OwnerID)
	}
	if p.CampaignID != nil {
		h["campaign_id"] = id.Encode(id.PrefixCrmCampaign, *p.CampaignID)
		h["campaign_name"] = p.CampaignName
		h["phase_seq"] = p.PhaseSeq
		h["phase_count"] = p.PhaseCount
		h["phase_name"] = p.PhaseName
	}
	if p.PhaseID != nil {
		h["phase_id"] = id.Encode(id.PrefixCrmPhase, *p.PhaseID)
	}
	if p.LastTouchAt != nil {
		h["last_touch_at"] = *p.LastTouchAt
		h["last_touch_kind"] = p.LastTouchKind
		h["last_touch_by"] = p.LastTouchBy
	}
	return h
}

/* ------------------------------------------------------------- campaigns */

func (h *Handlers) ListCampaigns(c *gin.Context) {
	out, err := h.svc.ListCampaigns(ctxOf(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, x := range out {
		rows = append(rows, campaignDTO(x))
	}
	httpx.OK(c, rows)
}

type campaignReq struct {
	Name   string `json:"name"`
	Goal   string `json:"goal"`
	Phases []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Intent string `json:"intent"`
	} `json:"phases"`
}

func (r campaignReq) toInput() crm.CampaignInput {
	in := crm.CampaignInput{Name: r.Name, Goal: r.Goal}
	for _, p := range r.Phases {
		in.Phases = append(in.Phases, crm.PhaseInput{ID: p.ID, Name: p.Name, Intent: p.Intent})
	}
	return in
}

func (h *Handlers) CreateCampaign(c *gin.Context) {
	var r campaignReq
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("a name and at least one phase are required"))
		return
	}
	out, err := h.svc.CreateCampaign(ctxOf(c), r.toInput())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, campaignDTO(*out))
}

func (h *Handlers) UpdateCampaign(c *gin.Context) {
	cid, ok := decode(c, id.PrefixCrmCampaign, c.Param("id"))
	if !ok {
		return
	}
	var r campaignReq
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("a name and at least one phase are required"))
		return
	}
	if err := h.svc.UpdateCampaign(ctxOf(c), cid, r.toInput()); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SetCampaignActive(c *gin.Context) {
	cid, ok := decode(c, id.PrefixCrmCampaign, c.Param("id"))
	if !ok {
		return
	}
	var r struct {
		Active bool `json:"active"`
	}
	_ = c.ShouldBindJSON(&r)
	if err := h.svc.SetCampaignActive(ctxOf(c), cid, r.Active); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) GetBoard(c *gin.Context) {
	cid, ok := decode(c, id.PrefixCrmCampaign, c.Param("id"))
	if !ok {
		return
	}
	b, err := h.svc.GetBoard(ctxOf(c), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	cols := make([]gin.H, 0, len(b.Columns))
	for _, col := range b.Columns {
		ps := make([]gin.H, 0, len(col.Prospects))
		for _, p := range col.Prospects {
			ps = append(ps, prospectDTO(p))
		}
		cols = append(cols, gin.H{"phase": phaseDTO(col.Phase), "prospects": ps})
	}
	httpx.OK(c, gin.H{"campaign": campaignDTO(b.Campaign), "columns": cols})
}

/* ------------------------------------------------------------- prospects */

func (h *Handlers) ListProspects(c *gin.Context) {
	out, err := h.svc.ListProspects(ctxOf(c), c.Query("q"), c.Query("status"), c.Query("owner"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, p := range out {
		rows = append(rows, prospectDTO(p))
	}
	httpx.OK(c, rows)
}

func (h *Handlers) GetProspect(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	p, touches, steps, err := h.svc.GetProspect(ctxOf(c), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	ts := make([]gin.H, 0, len(touches))
	for _, t := range touches {
		ts = append(ts, gin.H{"id": id.Encode(id.PrefixTouch, t.ID), "kind": t.Kind, "note": t.Note,
			"happened_at": t.HappenedAt, "by_name": t.ByName})
	}
	st := make([]gin.H, 0, len(steps))
	for _, x := range steps {
		st = append(st, gin.H{"phase_name": x.PhaseName, "seq": x.Seq, "note": x.Note,
			"done_by": x.DoneBy, "done_at": x.DoneAt})
	}
	httpx.OK(c, gin.H{"prospect": prospectDTO(*p), "touches": ts, "steps": st})
}

func (h *Handlers) CheckDuplicates(c *gin.Context) {
	out, err := h.svc.CheckDuplicates(ctxOf(c), c.Query("name"), c.Query("phone"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, d := range out {
		rows = append(rows, gin.H{"id": id.Encode(id.PrefixProspect, d.ID), "clinic_name": d.ClinicName,
			"phone": d.Phone, "owner_name": d.OwnerName, "status": d.Status, "why": d.Why})
	}
	httpx.OK(c, rows)
}

type prospectReq struct {
	ClinicName  string `json:"clinic_name"`
	ContactName string `json:"contact_name"`
	ContactRole string `json:"contact_role"`
	Phone       string `json:"phone"`
	PhoneAlt    string `json:"phone_alt"`
	Email       string `json:"email"`
	Address     string `json:"address"`
	MapURL      string `json:"map_url"`
	Note        string `json:"note"`
	Source      string `json:"source"`
	OwnerID     string `json:"owner_id"`
	CampaignID  string `json:"campaign_id"`
}

func (r prospectReq) toInput(c *gin.Context) (crm.ProspectInput, bool) {
	in := crm.ProspectInput{
		ClinicName: r.ClinicName, ContactName: r.ContactName, ContactRole: r.ContactRole,
		Phone: r.Phone, PhoneAlt: r.PhoneAlt, Email: r.Email, Address: r.Address,
		MapURL: r.MapURL, Note: r.Note, Source: r.Source,
	}
	if r.OwnerID != "" {
		u, ok := decode(c, id.PrefixUser, r.OwnerID)
		if !ok {
			return in, false
		}
		in.OwnerID = &u
	}
	if r.CampaignID != "" {
		u, ok := decode(c, id.PrefixCrmCampaign, r.CampaignID)
		if !ok {
			return in, false
		}
		in.CampaignID = &u
	}
	return in, true
}

func (h *Handlers) CreateProspect(c *gin.Context) {
	var r prospectReq
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("the clinic needs a name"))
		return
	}
	in, ok := r.toInput(c)
	if !ok {
		return
	}
	out, err := h.svc.CreateProspect(ctxOf(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, prospectDTO(*out))
}

func (h *Handlers) UpdateProspect(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	var r prospectReq
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("the clinic needs a name"))
		return
	}
	in, ok := r.toInput(c)
	if !ok {
		return
	}
	if err := h.svc.UpdateProspect(ctxOf(c), pid, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) Assign(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	var r struct {
		OwnerID string `json:"owner_id"`
	}
	_ = c.ShouldBindJSON(&r)
	var owner *uuid.UUID
	if r.OwnerID != "" {
		u, ok := decode(c, id.PrefixUser, r.OwnerID)
		if !ok {
			return
		}
		owner = &u
	}
	if err := h.svc.Assign(ctxOf(c), pid, owner); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

/* -------------------------------------------------------------- pipeline */

func (h *Handlers) Enrol(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	var r struct {
		CampaignID string `json:"campaign_id"`
	}
	if err := c.ShouldBindJSON(&r); err != nil || r.CampaignID == "" {
		httpx.Fail(c, apperr.Validation("choose a campaign"))
		return
	}
	cid, ok := decode(c, id.PrefixCrmCampaign, r.CampaignID)
	if !ok {
		return
	}
	if err := h.svc.Enrol(ctxOf(c), pid, cid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) CompletePhase(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	var r struct {
		Note string `json:"note"`
	}
	_ = c.ShouldBindJSON(&r)
	out, err := h.svc.CompletePhase(ctxOf(c), pid, r.Note)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, prospectDTO(*out))
}

func (h *Handlers) SetOutcome(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	var r struct {
		Status  string `json:"status"`
		ReadyOn string `json:"ready_on"`
		Note    string `json:"note"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("choose an outcome"))
		return
	}
	if err := h.svc.SetOutcome(ctxOf(c), pid, crm.Outcome{Status: r.Status, ReadyOn: r.ReadyOn, Note: r.Note}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) Reopen(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	if err := h.svc.Reopen(ctxOf(c), pid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) LogTouch(c *gin.Context) {
	pid, ok := decode(c, id.PrefixProspect, c.Param("id"))
	if !ok {
		return
	}
	var r struct {
		Kind       string `json:"kind"`
		Note       string `json:"note"`
		HappenedAt string `json:"happened_at"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("say what kind of contact this was"))
		return
	}
	if err := h.svc.LogTouch(ctxOf(c), pid, r.Kind, r.Note, r.HappenedAt); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

/* ------------------------------------------------------------------ reps */

func (h *Handlers) ListReps(c *gin.Context) {
	out, err := h.svc.ListReps(ctxOf(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, r := range out {
		rows = append(rows, gin.H{"id": id.Encode(id.PrefixUser, r.ID), "email": r.Email,
			"full_name": r.FullName, "role": r.Role, "status": r.Status,
			"open": r.Open, "signed_up": r.SignedUp})
	}
	httpx.OK(c, rows)
}

func (h *Handlers) CreateRep(c *gin.Context) {
	var r struct {
		Email    string `json:"email"`
		FullName string `json:"full_name"`
		Role     string `json:"role"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("name, email and a password are required"))
		return
	}
	out, err := h.svc.CreateRep(ctxOf(c), r.Email, r.FullName, r.Role, r.Password)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixUser, out.ID), "email": out.Email,
		"full_name": out.FullName, "role": out.Role, "status": out.Status})
}

func (h *Handlers) SetRepStatus(c *gin.Context) {
	rid, ok := decode(c, id.PrefixUser, c.Param("id"))
	if !ok {
		return
	}
	var r struct {
		Status string `json:"status"`
	}
	_ = c.ShouldBindJSON(&r)
	if err := h.svc.SetRepStatus(ctxOf(c), rid, r.Status); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) ImportInbound(c *gin.Context) {
	var r struct {
		CampaignID string `json:"campaign_id"`
	}
	_ = c.ShouldBindJSON(&r)
	var cid *uuid.UUID
	if r.CampaignID != "" {
		u, ok := decode(c, id.PrefixCrmCampaign, r.CampaignID)
		if !ok {
			return
		}
		cid = &u
	}
	n, err := h.svc.ImportInbound(ctxOf(c), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"imported": n})
}
