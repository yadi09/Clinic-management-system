package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/org"
)

type railReq struct {
	Key            string `json:"key"`
	Label          string `json:"label"`
	Kind           string `json:"kind"`
	BankKey        string `json:"bank_key"`
	AccountName    string `json:"account_name"`
	AccountNumber  string `json:"account_number"`
	NeedsReference bool   `json:"needs_reference"`
	Active         *bool  `json:"active"`
	SortOrder      int    `json:"sort_order"`
}

func railInput(r railReq) org.PaymentRailInput {
	active := true
	if r.Active != nil {
		active = *r.Active
	}
	return org.PaymentRailInput{
		Key: r.Key, Label: r.Label, Kind: r.Kind, BankKey: r.BankKey,
		AccountName: r.AccountName, AccountNumber: r.AccountNumber,
		NeedsReference: r.NeedsReference, Active: active, SortOrder: r.SortOrder,
	}
}

func railOut(r org.PaymentRail) gin.H {
	return gin.H{
		"id": id.Encode(id.PrefixPaymentRail, r.ID), "key": r.Key, "label": r.Label,
		"kind": r.Kind, "bank_key": r.BankKey, "account_name": r.AccountName,
		"account_number": r.AccountNumber, "needs_reference": r.NeedsReference,
		"active": r.Active, "sort_order": r.SortOrder,
	}
}

// ListPaymentRails serves both the desk and the settings screen. The desk asks for
// active rails only; settings asks for everything, or a switched-off method could
// never be switched back on.
func (h *Handlers) ListPaymentRails(c *gin.Context) {
	rails, err := h.svc.ListPaymentRails(c.Request.Context(), c.Query("all") != "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(rails))
	for _, r := range rails {
		out = append(out, railOut(r))
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreatePaymentRail(c *gin.Context) {
	var req railReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a name and a kind are required"))
		return
	}
	r, err := h.svc.CreatePaymentRail(c.Request.Context(), railInput(req))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, railOut(*r))
}

func (h *Handlers) UpdatePaymentRail(c *gin.Context) {
	rid, ok := decodeID(c, id.PrefixPaymentRail, "id")
	if !ok {
		return
	}
	var req railReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a name and a kind are required"))
		return
	}
	r, err := h.svc.UpdatePaymentRail(c.Request.Context(), rid, railInput(req))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, railOut(*r))
}

func (h *Handlers) DeletePaymentRail(c *gin.Context) {
	rid, ok := decodeID(c, id.PrefixPaymentRail, "id")
	if !ok {
		return
	}
	if err := h.svc.DeletePaymentRail(c.Request.Context(), rid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}
