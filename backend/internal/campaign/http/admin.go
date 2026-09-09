package http

import (
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/campaign"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

func campaignID(c *gin.Context) (uuid.UUID, bool) {
	cid, err := id.Decode(id.PrefixPromo, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid campaign id"))
		return uuid.Nil, false
	}
	return cid, true
}

func adminDTO(a campaign.Admin) gin.H {
	return gin.H{
		"id": id.Encode(id.PrefixPromo, a.ID), "code": a.Code, "title": a.Title, "subtitle": a.Subtitle,
		"status": a.Status, "opens_at": a.OpensAt, "closes_at": a.ClosesAt,
		"chances": a.Chances, "gifts": a.Gifts, "gift_label": a.GiftLabel, "gift_detail": a.GiftDetail,
		"telegram": a.Telegram, "phone": a.Phone, "seed_hash": a.SeedHash, "seed": a.Seed,
		"entries": a.Entries, "played": a.Played, "winners": a.Winners,
		"gifts_left": a.GiftsLeft, "chances_left": a.ChancesLeft, "waiting": a.Waiting,
		"auto_extend": a.AutoExtend, "extend_block": a.ExtendBlock,
	}
}

// AdminList handles GET /platform/campaigns.
func (h *Handlers) AdminList(c *gin.Context) {
	out, err := h.svc.List(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	res := make([]gin.H, 0, len(out))
	for _, a := range out {
		res = append(res, adminDTO(a))
	}
	httpx.OK(c, res)
}

// AdminGet handles GET /platform/campaigns/:id.
func (h *Handlers) AdminGet(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	a, err := h.svc.Get(c.Request.Context(), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, adminDTO(*a))
}

// AdminSave handles PUT /platform/campaigns/:id.
func (h *Handlers) AdminSave(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	var req struct {
		Title      string     `json:"title"`
		Subtitle   string     `json:"subtitle"`
		Chances    int        `json:"chances"`
		Gifts      int        `json:"gifts"`
		GiftLabel  string     `json:"gift_label"`
		GiftDetail string     `json:"gift_detail"`
		Telegram   string     `json:"telegram"`
		Phone      string     `json:"phone"`
		ClosesAt    *time.Time `json:"closes_at"`
		AutoExtend  bool       `json:"auto_extend"`
		ExtendBlock int        `json:"extend_block"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("check the campaign settings"))
		return
	}
	if err := h.svc.Save(c.Request.Context(), cid, campaign.AdminInput{
		Title: req.Title, Subtitle: req.Subtitle, Chances: req.Chances, Gifts: req.Gifts,
		GiftLabel: req.GiftLabel, GiftDetail: req.GiftDetail,
		Telegram: req.Telegram, Phone: req.Phone, ClosesAt: req.ClosesAt,
		AutoExtend: req.AutoExtend, ExtendBlock: req.ExtendBlock,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminOpen handles POST /platform/campaigns/:id/open — seals the draw.
func (h *Handlers) AdminOpen(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	if err := h.svc.Open(c.Request.Context(), cid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminClose handles POST /platform/campaigns/:id/close — publishes the seed and
// draws any gift nobody reached.
func (h *Handlers) AdminClose(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	if err := h.svc.Close(c.Request.Context(), cid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminReset handles POST /platform/campaigns/:id/reset.
func (h *Handlers) AdminReset(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	if err := h.svc.Reset(c.Request.Context(), cid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminQuestions handles GET /platform/campaigns/:id/questions.
func (h *Handlers) AdminQuestions(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	qs, err := h.svc.ListQuestions(c.Request.Context(), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(qs))
	for _, q := range qs {
		out = append(out, gin.H{
			"id": id.Encode(id.PrefixPromoQuestion, q.ID), "prompt": q.Prompt, "teaches": q.Teaches,
			"choices": q.Choices, "sort": q.Sort, "active": q.Active,
		})
	}
	httpx.OK(c, out)
}

type questionReq struct {
	Prompt  string            `json:"prompt"`
	Teaches string            `json:"teaches"`
	Choices []campaign.Choice `json:"choices"`
	Sort    int               `json:"sort"`
	Active  bool              `json:"active"`
}

// AdminSaveQuestion handles POST (create) and PUT (update) of one question.
func (h *Handlers) AdminSaveQuestion(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	var req questionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("check the question"))
		return
	}
	var qid *uuid.UUID
	if raw := c.Param("qid"); raw != "" {
		v, err := id.Decode(id.PrefixPromoQuestion, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid question id"))
			return
		}
		qid = &v
	}
	if err := h.svc.SaveQuestion(c.Request.Context(), cid, qid, campaign.AdminQuestion{
		Prompt: req.Prompt, Teaches: req.Teaches, Choices: req.Choices, Sort: req.Sort, Active: req.Active,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminDeleteQuestion handles DELETE /platform/campaigns/:id/questions/:qid.
func (h *Handlers) AdminDeleteQuestion(c *gin.Context) {
	qid, err := id.Decode(id.PrefixPromoQuestion, c.Param("qid"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid question id"))
		return
	}
	if err := h.svc.DeleteQuestion(c.Request.Context(), qid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminPrizes handles GET /platform/campaigns/:id/prizes.
func (h *Handlers) AdminPrizes(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	ps, err := h.svc.ListPrizes(c.Request.Context(), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(ps))
	for _, p := range ps {
		out = append(out, gin.H{
			"id": id.Encode(id.PrefixPromoPrize, p.ID), "label": p.Label,
			"detail": p.Detail, "weight": p.Weight, "sort": p.Sort,
		})
	}
	httpx.OK(c, out)
}

// AdminSavePrize handles POST/PUT of one wheel segment.
func (h *Handlers) AdminSavePrize(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	var req struct {
		Label  string `json:"label"`
		Detail string `json:"detail"`
		Weight int    `json:"weight"`
		Sort   int    `json:"sort"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("check the offer"))
		return
	}
	var pid *uuid.UUID
	if raw := c.Param("pid"); raw != "" {
		v, err := id.Decode(id.PrefixPromoPrize, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid offer id"))
			return
		}
		pid = &v
	}
	if err := h.svc.SavePrize(c.Request.Context(), cid, pid, campaign.AdminPrize{
		Label: req.Label, Detail: req.Detail, Weight: req.Weight, Sort: req.Sort,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminDeletePrize handles DELETE /platform/campaigns/:id/prizes/:pid.
func (h *Handlers) AdminDeletePrize(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPromoPrize, c.Param("pid"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid offer id"))
		return
	}
	if err := h.svc.DeletePrize(c.Request.Context(), pid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminEntries handles GET /platform/campaigns/:id/entries — the list.
func (h *Handlers) AdminEntries(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	es, err := h.svc.Entries(c.Request.Context(), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(es))
	for _, e := range es {
		out = append(out, gin.H{
			"id": id.Encode(id.PrefixPromoEntry, e.ID), "full_name": e.FullName, "phone": e.Phone,
			"clinic_name": e.ClinicName, "quiz_done": e.QuizDone, "spun": e.Spun, "won": e.Won,
			"prize_label": e.PrizeLabel, "wrong": e.Wrong, "created_at": e.CreatedAt, "spun_at": e.SpunAt,
		})
	}
	httpx.OK(c, out)
}

// AdminMissed handles GET /platform/campaigns/:id/missed.
func (h *Handlers) AdminMissed(c *gin.Context) {
	cid, ok := campaignID(c)
	if !ok {
		return
	}
	out, err := h.svc.MostMissed(c.Request.Context(), cid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}
