// Package http exposes the billing module's REST endpoints (Phase 3a: the card
// / consultation fee).
package http

import (
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// Handlers wires the billing service to HTTP.
type Handlers struct{ svc billing.Service }

// NewHandlers constructs billing HTTP handlers.
func NewHandlers(svc billing.Service) *Handlers { return &Handlers{svc: svc} }

// ---- requests ----

type collectRequest struct {
	PatientID     string `json:"patient_id" binding:"required"`
	BranchID      string `json:"branch_id" binding:"required"`
	AppointmentID string `json:"appointment_id"`
	Waived        bool   `json:"waived"`
	WaiveReason   string `json:"waive_reason"`
}

// ---- responses ----

type paymentDTO struct {
	ID string `json:"id"`
	billing.Payment
}

func paymentOut(p billing.Payment) paymentDTO {
	return paymentDTO{ID: id.Encode(id.PrefixCardPayment, p.ID), Payment: p}
}

// Assess handles GET /billing/card/assess?patient=&appointment=.
func (h *Handlers) Assess(c *gin.Context) {
	patientID, err := id.Decode(id.PrefixPatient, c.Query("patient"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("patient is required"))
		return
	}
	in := billing.AssessInput{PatientID: patientID}
	if a := c.Query("appointment"); a != "" {
		aid, err := id.Decode(id.PrefixAppointment, a)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid appointment"))
			return
		}
		in.AppointmentID = &aid
	}
	res, err := h.svc.Assess(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, res)
}

// Collect handles POST /billing/card/collect.
func (h *Handlers) Collect(c *gin.Context) {
	var req collectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id and branch_id are required"))
		return
	}
	patientID, err := id.Decode(id.PrefixPatient, req.PatientID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient_id"))
		return
	}
	branchID, err := id.Decode(id.PrefixBranch, req.BranchID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid branch_id"))
		return
	}
	in := billing.CollectInput{PatientID: patientID, BranchID: branchID, Waived: req.Waived, WaiveReason: req.WaiveReason}
	if req.AppointmentID != "" {
		aid, err := id.Decode(id.PrefixAppointment, req.AppointmentID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid appointment_id"))
			return
		}
		in.AppointmentID = &aid
	}
	p, err := h.svc.Collect(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, paymentOut(*p))
}

// History handles GET /billing/card/history?patient=.
func (h *Handlers) History(c *gin.Context) {
	patientID, err := id.Decode(id.PrefixPatient, c.Query("patient"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("patient is required"))
		return
	}
	items, err := h.svc.History(c.Request.Context(), patientID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]paymentDTO, 0, len(items))
	for _, p := range items {
		out = append(out, paymentOut(p))
	}
	httpx.OK(c, out)
}

// ============================================================================
// Billing-1: service catalog + charges + cashier + cash summary
// ============================================================================

type serviceReq struct {
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	Category     string  `json:"category"`
	Price        float64 `json:"price"`
	AssignableBy string  `json:"assignable_by"`
}
type serviceDTO struct {
	ID string `json:"id"`
	billing.ServiceItem
}
type pendingDTO struct {
	ID        string `json:"id"`
	PatientID string `json:"patient_id"`
	billing.PendingCharge
}
type chargeRowDTO struct {
	ID string `json:"id"`
	billing.ChargeRow
}

// mayEditCategory decides who owns a part of the catalog.
//
// The dentist owns the dental list: they are the one who knows a molar root canal
// is not the same job as an incisor's, and making them wait for an administrator
// to add it is how the clinic ends up with six spellings of "Root Canal" typed
// free-hand instead. Everything else stays with billing.manage, because a general
// service's price is a business decision, not a clinical one.
func mayEditCategory(c *gin.Context, category string) error {
	p, ok := tenancy.PrincipalFromContext(c.Request.Context())
	if !ok {
		return apperr.Forbidden("NOT_ALLOWED", "not allowed")
	}
	if p.HasPermission("billing.manage") {
		return nil
	}
	if strings.TrimSpace(strings.ToLower(category)) == "dental" && p.HasPermission("dental.manage") {
		return nil
	}
	return apperr.Forbidden("NOT_ALLOWED", "only the dental list can be edited from the chair — ask an administrator for other services")
}

func (h *Handlers) ListServices(c *gin.Context) {
	items, err := h.svc.ListServices(c.Request.Context(), c.Query("active") == "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]serviceDTO, 0, len(items))
	for _, s := range items {
		out = append(out, serviceDTO{ID: id.Encode(id.PrefixServiceItem, s.ID), ServiceItem: s})
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateService(c *gin.Context) {
	var req serviceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("code and name are required"))
		return
	}
	if req.Price < 0 {
		httpx.Fail(c, apperr.Validation("price cannot be negative"))
		return
	}
	if err := mayEditCategory(c, req.Category); err != nil {
		httpx.Fail(c, err)
		return
	}
	s, err := h.svc.CreateService(c.Request.Context(), billing.ServiceItemInput{
		Code: req.Code, Name: req.Name, Category: req.Category, Price: strconv.FormatFloat(req.Price, 'f', 2, 64),
		AssignableBy: req.AssignableBy,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, serviceDTO{ID: id.Encode(id.PrefixServiceItem, s.ID), ServiceItem: *s})
}

func (h *Handlers) UpdateService(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	var req serviceReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("code and name are required"))
		return
	}
	if req.Price < 0 {
		httpx.Fail(c, apperr.Validation("price cannot be negative"))
		return
	}
	if err := mayEditCategory(c, req.Category); err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.svc.UpdateService(c.Request.Context(), sid, billing.ServiceItemInput{
		Code: req.Code, Name: req.Name, Category: req.Category, Price: strconv.FormatFloat(req.Price, 'f', 2, 64),
		AssignableBy: req.AssignableBy,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SetServiceActive(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	var req struct {
		IsActive bool `json:"is_active"`
	}
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.SetServiceActive(c.Request.Context(), sid, req.IsActive); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SetServiceDefault(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	var req struct {
		IsDefault bool `json:"is_default"`
	}
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.SetServiceDefault(c.Request.Context(), sid, req.IsDefault); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// GET /billing/services/:id/providers — the staff assigned to a service (catalog editor).
func (h *Handlers) GetServiceProviders(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	ids, err := h.svc.ServiceProviderIDs(c.Request.Context(), sid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]string, 0, len(ids))
	for _, u := range ids {
		out = append(out, id.Encode(id.PrefixUser, u))
	}
	httpx.OK(c, gin.H{"user_ids": out})
}

// PUT /billing/services/:id/providers — replace the staff assigned to a service.
func (h *Handlers) SetServiceProviders(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	var req struct {
		UserIDs []string `json:"user_ids"`
	}
	_ = c.ShouldBindJSON(&req)
	users := make([]uuid.UUID, 0, len(req.UserIDs))
	for _, raw := range req.UserIDs {
		u, err := id.Decode(id.PrefixUser, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid user id"))
			return
		}
		users = append(users, u)
	}
	if err := h.svc.SetServiceProviders(c.Request.Context(), sid, users); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// GET /billing/providers?services=svc_a,svc_b — staff who provide the given services
// (reception's filtered assign dropdown).
func (h *Handlers) ProvidersForServices(c *gin.Context) {
	var ids []uuid.UUID
	for _, raw := range strings.Split(c.Query("services"), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		sid, err := id.Decode(id.PrefixServiceItem, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid service id"))
			return
		}
		ids = append(ids, sid)
	}
	provs, err := h.svc.ProvidersForServices(c.Request.Context(), ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	type provDTO struct {
		ID string `json:"id"`
		billing.Provider
	}
	out := make([]provDTO, 0, len(provs))
	for _, p := range provs {
		out = append(out, provDTO{ID: id.Encode(id.PrefixUser, p.ID), Provider: p})
	}
	httpx.OK(c, out)
}

func (h *Handlers) DeleteService(c *gin.Context) {
	sid, ok := decodeBilling(c, id.PrefixServiceItem, "id")
	if !ok {
		return
	}
	if err := h.svc.DeleteService(c.Request.Context(), sid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

type raiseReq struct {
	PatientID     string  `json:"patient_id" binding:"required"`
	EncounterID   string  `json:"encounter_id"`
	ServiceItemID string  `json:"service_item_id"`
	Source        string  `json:"source"`
	Description   string  `json:"description"`
	Amount        float64 `json:"amount"`
	BranchID      string  `json:"branch_id"`
	DepartmentID  string  `json:"department_id"`
	ToTriage      bool    `json:"to_triage"`
	ProviderID    string  `json:"provider_id"`
}

func (h *Handlers) RaiseCharge(c *gin.Context) {
	var req raiseReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id is required"))
		return
	}
	pid, err := id.Decode(id.PrefixPatient, req.PatientID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient_id"))
		return
	}
	if req.Amount < 0 {
		httpx.Fail(c, apperr.Validation("amount cannot be negative"))
		return
	}
	in := billing.ChargeInput{
		PatientID: pid, Source: req.Source, Description: req.Description, Amount: strconv.FormatFloat(req.Amount, 'f', 2, 64), ToTriage: req.ToTriage,
	}
	if !decodeOpt(c, id.PrefixEncounter, req.EncounterID, &in.EncounterID) ||
		!decodeOpt(c, id.PrefixServiceItem, req.ServiceItemID, &in.ServiceItemID) ||
		!decodeOpt(c, id.PrefixBranch, req.BranchID, &in.BranchID) ||
		!decodeOpt(c, id.PrefixDepartment, req.DepartmentID, &in.DepartmentID) ||
		!decodeOpt(c, id.PrefixUser, req.ProviderID, &in.ProviderID) {
		return
	}
	cid, err := h.svc.RaiseCharge(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixCharge, cid)})
}

type batchItemReq struct {
	ServiceItemID string  `json:"service_item_id"`
	Source        string  `json:"source"`
	Description   string  `json:"description"`
	Amount        float64 `json:"amount"`
}
type raiseBatchReq struct {
	PatientID    string         `json:"patient_id" binding:"required"`
	BranchID     string         `json:"branch_id" binding:"required"`
	DepartmentID string         `json:"department_id" binding:"required"`
	ToTriage     bool           `json:"to_triage"`
	ProviderID   string         `json:"provider_id"`
	Items        []batchItemReq `json:"items" binding:"required"`
}

// RaiseChargeBatch handles POST /billing/charges/batch — register a whole visit's
// charges at once, rejecting a duplicate registration before any line is written.
func (h *Handlers) RaiseChargeBatch(c *gin.Context) {
	var req raiseBatchReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id, branch_id, department_id and items are required"))
		return
	}
	pid, err := id.Decode(id.PrefixPatient, req.PatientID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient_id"))
		return
	}
	in := billing.ChargeBatchInput{PatientID: pid, ToTriage: req.ToTriage}
	if in.BranchID, err = id.Decode(id.PrefixBranch, req.BranchID); err != nil {
		httpx.Fail(c, apperr.Validation("invalid branch_id"))
		return
	}
	if in.DepartmentID, err = id.Decode(id.PrefixDepartment, req.DepartmentID); err != nil {
		httpx.Fail(c, apperr.Validation("invalid department_id"))
		return
	}
	if !decodeOpt(c, id.PrefixUser, req.ProviderID, &in.ProviderID) {
		return
	}
	for _, it := range req.Items {
		if it.Amount < 0 {
			httpx.Fail(c, apperr.Validation("amount cannot be negative"))
			return
		}
		item := billing.ChargeBatchItem{Source: it.Source, Description: it.Description, Amount: strconv.FormatFloat(it.Amount, 'f', 2, 64)}
		if !decodeOpt(c, id.PrefixServiceItem, it.ServiceItemID, &item.ServiceItemID) {
			return
		}
		in.Items = append(in.Items, item)
	}
	ids, err := h.svc.RaiseChargeBatch(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]string, 0, len(ids))
	for _, cid := range ids {
		out = append(out, id.Encode(id.PrefixCharge, cid))
	}
	httpx.Created(c, gin.H{"ids": out})
}

func (h *Handlers) PendingCharges(c *gin.Context) {
	items, err := h.svc.PendingCharges(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]pendingDTO, 0, len(items))
	for _, p := range items {
		out = append(out, pendingDTO{ID: id.Encode(id.PrefixCharge, p.ID), PatientID: id.Encode(id.PrefixPatient, p.PatientID), PendingCharge: p})
	}
	httpx.OK(c, out)
}

func (h *Handlers) PatientCharges(c *gin.Context) {
	pid, err := id.Decode(id.PrefixPatient, c.Query("patient"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("patient is required"))
		return
	}
	items, err := h.svc.PatientCharges(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]chargeRowDTO, 0, len(items.Rows))
	for _, ch := range items.Rows {
		out = append(out, chargeRowDTO{ID: id.Encode(id.PrefixCharge, ch.ID), ChargeRow: ch})
	}
	// Rows are a page; the totals cover the whole account. The printed statement uses
	// the totals, so it can no longer understate a long-standing patient.
	httpx.OK(c, gin.H{
		"rows": out, "charged": items.Charged, "paid": items.Paid, "refunded": items.Refunded,
		"awaiting": items.Awaiting, "waived": items.Waived,
		"total_count": items.TotalCount, "truncated": items.Truncated,
	})
}

// settleReq is how the desk says the money arrived: the clinic's configured payment
// method, plus the transaction reference for a transfer or wallet payment. `method`
// is the older free-text field, still accepted so a client that has not been updated
// keeps working.
type settleReq struct {
	RailID    string `json:"rail_id"`
	Method    string `json:"method"`
	Reference string `json:"reference"`
	// Take a payment the bank contradicted. Gated on payment.waive at the route.
	Force       bool   `json:"force"`
	ForceReason string `json:"force_reason"`
	// Settle only these charges. Reception sends the ones this visit raised, so a
	// button that says 300 cannot take 1,500 of older debt with it.
	ChargeIDs []string `json:"charge_ids"`
}

func settleInput(c *gin.Context, r settleReq) (billing.SettleInput, bool) {
	in := billing.SettleInput{Method: r.Method, Reference: r.Reference,
		Force: r.Force, ForceReason: r.ForceReason}
	for _, raw := range r.ChargeIDs {
		cid, err := id.Decode(id.PrefixCharge, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid charge"))
			return in, false
		}
		in.ChargeIDs = append(in.ChargeIDs, cid)
	}
	// Overriding a bank contradiction is a manager's call, not the desk's.
	if in.Force {
		p, ok := httpx.PrincipalFrom(c)
		if !ok || !p.HasPermission("payment.waive") {
			httpx.Fail(c, apperr.Forbidden("FORBIDDEN_PERMISSION",
				"only a manager can accept a payment the bank could not confirm"))
			return in, false
		}
	}
	if r.RailID != "" {
		rid, err := id.Decode(id.PrefixPaymentRail, r.RailID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid payment method"))
			return in, false
		}
		in.RailID = &rid
	}
	return in, true
}

// VerifyPayment handles POST /billing/verify-payment — ask the bank about a claimed
// transfer before taking it. Nothing is settled here.
func (h *Handlers) VerifyPayment(c *gin.Context) {
	var req struct {
		RailID    string `json:"rail_id"`
		Reference string `json:"reference"`
		Expected  string `json:"expected"`
		PatientID string `json:"patient_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a payment method and a reference are required"))
		return
	}
	in := billing.VerifyInput{Reference: req.Reference, Expected: req.Expected}
	if req.RailID != "" {
		rid, err := id.Decode(id.PrefixPaymentRail, req.RailID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid payment method"))
			return
		}
		in.RailID = &rid
	}
	if req.PatientID != "" {
		pid, err := id.Decode(id.PrefixPatient, req.PatientID)
		if err == nil {
			in.PatientID = pid
		}
	}
	out, err := h.svc.VerifyPayment(c.Request.Context(), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// PaymentVerificationStatus tells the client whether to offer a bank check at all.
func (h *Handlers) PaymentVerificationStatus(c *gin.Context) {
	httpx.OK(c, gin.H{"available": h.svc.VerificationAvailable()})
}

func (h *Handlers) SettleCharge(c *gin.Context) {
	cid, ok := decodeBilling(c, id.PrefixCharge, "id")
	if !ok {
		return
	}
	var req settleReq
	_ = c.ShouldBindJSON(&req)
	in, ok := settleInput(c, req)
	if !ok {
		return
	}
	if err := h.svc.SettleCharge(c.Request.Context(), cid, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// SettleVisit handles POST /billing/checkout — settle all of a patient's pending charges at once.
func (h *Handlers) SettleVisit(c *gin.Context) {
	var req struct {
		PatientID string `json:"patient_id"`
		settleReq
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id is required"))
		return
	}
	pid, err := id.Decode(id.PrefixPatient, req.PatientID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid patient_id"))
		return
	}
	in, ok := settleInput(c, req.settleReq)
	if !ok {
		return
	}
	out, err := h.svc.SettleVisit(c.Request.Context(), pid, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// DeferVisit handles POST /billing/patients/:id/defer — treat now, bill later.
func (h *Handlers) DeferVisit(c *gin.Context) {
	pid, ok := decodeBilling(c, id.PrefixPatient, "id")
	if !ok {
		return
	}
	var req struct {
		Reason    string   `json:"reason"`
		ChargeIDs []string `json:"charge_ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a reason is required"))
		return
	}
	ids := make([]uuid.UUID, 0, len(req.ChargeIDs))
	for _, raw := range req.ChargeIDs {
		cid, err := id.Decode(id.PrefixCharge, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid charge id"))
			return
		}
		ids = append(ids, cid)
	}
	n, err := h.svc.DeferVisit(c.Request.Context(), pid, req.Reason, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"deferred": n})
}

func (h *Handlers) WaiveCharge(c *gin.Context) {
	cid, ok := decodeBilling(c, id.PrefixCharge, "id")
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a reason is required"))
		return
	}
	if err := h.svc.WaiveCharge(c.Request.Context(), cid, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) VoidCharge(c *gin.Context) {
	cid, ok := decodeBilling(c, id.PrefixCharge, "id")
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a reason is required"))
		return
	}
	if err := h.svc.VoidCharge(c.Request.Context(), cid, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) RefundCharge(c *gin.Context) {
	cid, ok := decodeBilling(c, id.PrefixCharge, "id")
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a reason is required"))
		return
	}
	if err := h.svc.RefundCharge(c.Request.Context(), cid, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) WaiverReasons(c *gin.Context) {
	httpx.OK(c, h.svc.WaiverReasons())
}

// financeUntil parses an optional upper bound for the finance window (accepts
// either ?until= or ?to=, RFC3339). Nil means "up to now".
func financeUntil(c *gin.Context) *time.Time {
	for _, k := range []string{"until", "to"} {
		if q := c.Query(k); q != "" {
			if t, err := time.Parse(time.RFC3339, q); err == nil {
				return &t
			}
		}
	}
	return nil
}

func (h *Handlers) Cash(c *gin.Context) {
	since := time.Now().Add(-24 * time.Hour)
	if q := c.Query("since"); q != "" {
		if t, err := time.Parse(time.RFC3339, q); err == nil {
			since = t
		}
	}
	until := financeUntil(c)
	out, err := h.svc.CashSince(c.Request.Context(), since, until)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Payments handles GET /billing/payments?since= — the cashier's "Paid today" list (by receipt).
func (h *Handlers) Payments(c *gin.Context) {
	now := time.Now().UTC()
	since := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if q := c.Query("since"); q != "" {
		if t, err := time.Parse(time.RFC3339, q); err == nil {
			since = t
		}
	}
	out, err := h.svc.PaymentsSince(c.Request.Context(), since, financeUntil(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// RefundVisit handles POST /billing/refund-visit — refund an entire receipt (manager-gated).
func (h *Handlers) RefundVisit(c *gin.Context) {
	var req struct {
		ReceiptNo int64  `json:"receipt_no"`
		Reason    string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.ReceiptNo <= 0 {
		httpx.Fail(c, apperr.Validation("a receipt and reason are required"))
		return
	}
	if err := h.svc.RefundVisit(c.Request.Context(), req.ReceiptNo, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// DayClose handles GET /billing/day-close?date= — the cashier's expected drawer + any closeout.
func (h *Handlers) DayClose(c *gin.Context) {
	out, err := h.svc.ExpectedForDay(c.Request.Context(), c.Query("date"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// DayCloses handles GET /billing/day-closes?from=&to= — each business day's takings
// and close status, so an unclosed earlier day can be caught up. Defaults to the
// last 30 days.
func (h *Handlers) DayCloses(c *gin.Context) {
	from, to := c.Query("from"), c.Query("to")
	if to == "" {
		to = time.Now().UTC().Format("2006-01-02")
	}
	if from == "" {
		from = time.Now().UTC().AddDate(0, 0, -30).Format("2006-01-02")
	}
	out, err := h.svc.DayCloses(c.Request.Context(), from, to)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// CloseDay handles POST /billing/day-close — record the counted drawer (Z-report).
func (h *Handlers) CloseDay(c *gin.Context) {
	var req struct {
		BusinessDate string  `json:"business_date"`
		Counted      float64 `json:"counted"`
		Note         string  `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a counted amount is required"))
		return
	}
	out, err := h.svc.CloseDay(c.Request.Context(), billing.CloseDayInput{
		BusinessDate: req.BusinessDate, Counted: strconv.FormatFloat(req.Counted, 'f', 2, 64), Note: req.Note,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Reconciliations handles GET /billing/reconciliations?all=1 — closeouts (own, or all for finance).
func (h *Handlers) Reconciliations(c *gin.Context) {
	out, err := h.svc.Reconciliations(c.Request.Context(), c.Query("all") == "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

func decodeBilling(c *gin.Context, prefix, param string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, c.Param(param))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return uuid.Nil, false
	}
	return u, true
}

// decodeOpt decodes an optional prefixed id into *dst; fails the request on a
// malformed (non-empty) value. Empty input leaves dst nil.
func decodeOpt(c *gin.Context, prefix, raw string, dst **uuid.UUID) bool {
	if raw == "" {
		return true
	}
	u, err := id.Decode(prefix, raw)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid "+prefix+" id"))
		return false
	}
	*dst = &u
	return true
}
