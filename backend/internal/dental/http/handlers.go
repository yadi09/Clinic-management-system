// Package http exposes the dental REST endpoints. Thin handlers: decode the
// prefixed patient/plan/session ids, call the service, encode JSON.
package http

import (
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

type Handlers struct{ svc dental.Service }

func NewHandlers(svc dental.Service) *Handlers { return &Handlers{svc: svc} }

func decode(c *gin.Context, prefix, raw string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, raw)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return uuid.Nil, false
	}
	return u, true
}

func chartDTO(ch dental.Chart) gin.H {
	// The front desk's sealed chart (noChart) has no anatomy: send an empty one, so a
	// client never has to tell "none" from "missing".
	anatomy := ch.Anatomy
	if anatomy == nil {
		anatomy = map[string]dental.ToothAnatomy{}
	}
	items := make([]gin.H, 0, len(ch.Items))
	for _, it := range ch.Items {
		row := gin.H{"id": id.Encode(id.PrefixChartItem, it.ID), "tooth": it.Tooth, "kind": it.Kind, "status": it.Status,
			"created_by": it.CreatedBy, "created_at": it.CreatedAt, "updated_by": it.UpdatedBy, "updated_at": it.UpdatedAt}
		if it.Surface != "" {
			row["surface"] = it.Surface
		}
		if it.Material != "" {
			row["material"] = it.Material
		}
		if it.BridgeEnd != 0 {
			row["bridge_end"] = it.BridgeEnd
		}
		if it.Note != "" {
			row["note"] = it.Note
		}
		if it.DoneOn != nil {
			row["done_on"] = *it.DoneOn
		}
		items = append(items, row)
	}
	positions := ch.Positions
	if positions == nil {
		positions = map[string]dental.Position{}
	}
	h := gin.H{"teeth": ch.Teeth, "anatomy": anatomy, "items": items, "positions": positions}
	if ch.UpdatedAt != nil {
		h["updated_at"] = *ch.UpdatedAt
	}
	return h
}

func balanceDTO(b dental.Balance) gin.H {
	return gin.H{"owed": b.Owed, "paid": b.Paid, "balance": b.Balance, "due": b.Due, "overdue": b.Overdue,
		"at_cashier": b.AtCashier, "waived": b.Waived}
}

func imageDTO(im dental.Image) gin.H {
	return gin.H{
		"id": id.Encode(id.PrefixAttachment, im.ID), "url": im.URL, "filename": im.Filename,
		"mime_type": im.MimeType, "size_bytes": im.SizeBytes, "created_at": im.CreatedAt, "category": im.Category,
	}
}

func prescriptionDTO(rx dental.Prescription) gin.H {
	items := make([]gin.H, 0, len(rx.Items))
	for _, it := range rx.Items {
		items = append(items, gin.H{
			"drug_name": it.DrugName, "dose": it.Dose, "frequency": it.Frequency,
			"duration": it.Duration, "instructions": it.Instructions,
			// Carried back so a prescription that was written over a known allergy
			// says so wherever it is read, not only where it was written.
			"allergens": it.Allergens, "allergy_override": it.AllergyOverride,
		})
	}
	return gin.H{"id": id.Encode(id.PrefixDentalRx, rx.ID), "note": rx.Note, "created_at": rx.CreatedAt, "items": items,
		"prescribed_by": rx.PrescribedBy}
}

// clinical reports whether this caller may see the clinical record, as opposed to
// only the schedule and the money.
//
// Until now the SEAL WAS ONLY IN THE UI: /dental/patients/:id/summary is open to
// dental.read, and the DTO shipped procedure, tooth, notes, rx, prescriptions and
// image URLs to everyone. The front desk's browser was receiving the full clinical
// record and merely not drawing it — one devtools tab away from a patient's notes.
// The reception view is about to share components with the clinician's, so a
// UI-shaped seal is not something to keep relying on.
func clinical(c *gin.Context) bool {
	p, ok := tenancy.PrincipalFromContext(c.Request.Context())
	return ok && p.HasPermission("dental.manage")
}

// sealed returns v for a clinician and "" for anyone else. Used on the fields that
// leaked past the summary's seal (audit D19): a plan's tooth and note, and the
// procedure and tooth on the calendar and the unbilled report.
func sealed(clinical bool, v string) string {
	if clinical {
		return v
	}
	return ""
}

// noChart is what the front desk is given in place of the odontogram.
var noChart = dental.Chart{Teeth: map[string]string{}}

func sessionDTO(se dental.Session, clinical bool) gin.H {
	images := make([]gin.H, 0, len(se.Images))
	for _, im := range se.Images {
		images = append(images, imageDTO(im))
	}
	rxs := make([]gin.H, 0, len(se.Prescriptions))
	for _, rx := range se.Prescriptions {
		rxs = append(rxs, prescriptionDTO(rx))
	}
	// Extras go to the desk as well as the chair: they are money owed, and the
	// cashier is entitled to see what the patient is being asked to pay for.
	extras := make([]gin.H, 0, len(se.Extras))
	for _, ex := range se.Extras {
		dto := gin.H{
			"id": id.Encode(id.PrefixTreatmentSession, ex.ID), "amount_due": ex.AmountDue,
			"payment": ex.Payment, "service_name": ex.ServiceName, "status": ex.Status,
			// Treated now, owed later, and the reason: the chair shows it on the row.
			"pay_later": ex.PayLater, "pay_later_note": ex.PayLaterNote,
		}
		// The bill, once there is one, so it can be taken in place at the chair.
		if ex.ChargeID != nil {
			dto["charge_id"] = id.Encode(id.PrefixCharge, *ex.ChargeID)
		}
		extras = append(extras, dto)
	}
	out := gin.H{
		"id": id.Encode(id.PrefixTreatmentSession, se.ID), "seq": se.Seq, "scheduled_date": se.ScheduledDate,
		"amount_due": se.AmountDue, "status": se.Status, "payment": se.Payment,
		// The desk needs the promise to chase it; it is a money note, not a clinical one.
		"pay_later": se.PayLater, "pay_later_note": se.PayLaterNote,
		"extras": extras, "service_name": se.ServiceName,
	}
	if !clinical {
		// Empty rather than absent: the client's Session type keeps its shape, so a
		// desk surface renders "no note" instead of crashing on undefined.
		out["procedure"], out["tooth"], out["notes"], out["rx"] = "", "", "", ""
		out["images"], out["prescriptions"] = []gin.H{}, []gin.H{}
		return out
	}
	out["procedure"], out["tooth"], out["notes"], out["rx"] = se.Procedure, se.Tooth, se.Notes, se.Rx
	out["images"], out["prescriptions"] = images, rxs
	return out
}

func planDTO(p dental.Plan, clinical bool) gin.H {
	sessions := make([]gin.H, 0, len(p.Sessions))
	for _, se := range p.Sessions {
		sessions = append(sessions, sessionDTO(se, clinical))
	}
	out := gin.H{
		"id": id.Encode(id.PrefixTreatmentPlan, p.ID), "title": p.Title, "tooth": sealed(clinical, p.Tooth),
		"total_amount": p.TotalAmount, "start_date": p.StartDate, "interval_unit": p.IntervalUnit,
		"interval_count": p.IntervalCount, "session_count": p.SessionCount, "deadline": p.Deadline,
		"status": p.Status, "note": sealed(clinical, p.Note), "created_at": p.CreatedAt, "sessions": sessions,
		// The catalogue link and the price it quoted on the day. Absent rather than
		// empty when the course predates the catalogue, so "off-list" is legible.
		"service_name": p.ServiceName, "list_price": p.ListPrice,
		// Money from the ledger, not summed from the sessions' planned fees.
		"money": gin.H{
			"planned": p.Money.Planned, "collected": p.Money.Collected,
			"at_cashier": p.Money.AtCashier, "due": p.Money.Due, "waived": p.Money.Waived,
		},
	}
	if p.ServiceID != nil {
		out["service_id"] = id.Encode(id.PrefixServiceItem, *p.ServiceID)
	}
	// Separate from sessions on purpose: the deposit is money, not an appointment.
	// The key is absent rather than null when the plan has no down payment, so a
	// client cannot mistake "no deposit" for "a deposit of nothing". Only the
	// money-bearing fields: a deposit has no procedure, tooth, notes or images, and
	// sending empty ones would invite the UI to offer to fill them in.
	if d := p.Deposit; d != nil {
		out["deposit"] = gin.H{
			"id":             id.Encode(id.PrefixTreatmentSession, d.ID),
			"amount_due":     d.AmountDue,
			"payment":        d.Payment,
			"scheduled_date": d.ScheduledDate,
		}
	}
	return out
}

// parseDrugID decodes the library drug the prescriber picked.
//
// The API speaks PREFIXED opaque ids ("drg_…"), never raw UUIDs — this first went
// out calling uuid.Parse, which failed on every real id, silently dropped the link,
// and left the allergy check matching on spelling alone. An absent id is still fine
// (the drug was typed free-hand); a malformed one is refused rather than quietly
// downgrading the safety check.
func parseDrugID(v string) (*uuid.UUID, error) {
	if v == "" {
		return nil, nil
	}
	did, err := id.Decode(id.PrefixDrug, v)
	if err != nil {
		return nil, apperr.Validation("invalid drug_id")
	}
	return &did, nil
}

// Reprice sets one visit's fee and says where the difference lands. The client
// shows the arithmetic before it is sent; the server is what decides it.
func (h *Handlers) RepriceSession(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		Amount string `json:"amount"`
		Mode   string `json:"mode"` // respread | total
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("an amount and a mode are required"))
		return
	}
	if err := h.svc.RepriceSession(c.Request.Context(), pid, sid, req.Amount, req.Mode, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- summary ---

func (h *Handlers) Summary(c *gin.Context) {
	clin := clinical(c)
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sum, err := h.svc.Summary(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	plans := make([]gin.H, 0, len(sum.Plans))
	for _, p := range sum.Plans {
		plans = append(plans, planDTO(p, clin))
	}
	chart := sum.Chart
	if !clin {
		chart = noChart // the tooth chart is clinical, like the notes
	}
	httpx.OK(c, gin.H{"chart": chartDTO(chart), "plans": plans, "balance": balanceDTO(sum.Balance), "image_limit": sum.ImageLimit})
}

// --- chart ---

func (h *Handlers) GetChart(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	if !clinical(c) {
		// Empty, not 403: shared screens ask for it, and a desk user must not see
		// errors for a seal working as intended (audit D19).
		httpx.OK(c, chartDTO(noChart))
		return
	}
	ch, err := h.svc.GetChart(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, chartDTO(*ch))
}

func (h *Handlers) SaveChart(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	// changes: only the teeth this save touches, {tooth: condition}, "" clears.
	// teeth (the whole mouth) is still accepted from a page loaded before this
	// change, and is merged the same way — so even an old tab cannot erase a tooth
	// it did not show, except by clearing it explicitly.
	var req struct {
		Changes map[string]string `json:"changes"`
		Teeth   map[string]string `json:"teeth"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Changes == nil && req.Teeth == nil) {
		httpx.Fail(c, apperr.Validation("send the teeth that changed"))
		return
	}
	changes := req.Changes
	if changes == nil {
		changes = req.Teeth
	}
	ch, err := h.svc.SaveChart(c.Request.Context(), pid, changes)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, chartDTO(*ch))
}

// SaveAnatomy takes the anatomical chart's changes: {"changes": {"11": {...}, "21": null}}.
// A tooth is sent whole (its full record), and null clears it.
func (h *Handlers) SaveAnatomy(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Changes map[string]*dental.ToothAnatomy `json:"changes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Changes == nil {
		httpx.Fail(c, apperr.Validation("send the teeth that changed"))
		return
	}
	ch, err := h.svc.SaveAnatomy(c.Request.Context(), pid, req.Changes)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, chartDTO(*ch))
}

// SaveChartItems: {"teeth": {"16": [{"kind": "filling", "surface": "O", "material":
// "composite", "status": "planned"}, …], "21": []}} — each tooth named gets exactly
// the items listed (an empty list clears it).
func (h *Handlers) SaveChartItems(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Teeth map[string][]dental.ItemInput `json:"teeth"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Teeth == nil {
		httpx.Fail(c, apperr.Validation("send the teeth that changed"))
		return
	}
	ch, err := h.svc.SaveChartItems(c.Request.Context(), pid, req.Teeth)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, chartDTO(*ch))
}

// SavePositions: {"changes": {"12": {"rotation": 20, …}, "11": null}}.
func (h *Handlers) SavePositions(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Changes map[string]*dental.Position `json:"changes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Changes == nil {
		httpx.Fail(c, apperr.Validation("send the teeth that changed"))
		return
	}
	ch, err := h.svc.SavePositions(c.Request.Context(), pid, req.Changes)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, chartDTO(*ch))
}

// --- the clinic's dental settings ---

func (h *Handlers) GetDentalSettings(c *gin.Context) {
	st, err := h.svc.GetDentalSettings(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

func (h *Handlers) SaveDentalSettings(c *gin.Context) {
	var req dental.DentalSettings
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("send chart_style"))
		return
	}
	st, err := h.svc.SaveDentalSettings(c.Request.Context(), req)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, st)
}

// --- treatment plans ---

func (h *Handlers) ListPlans(c *gin.Context) {
	clin := clinical(c)
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	plans, err := h.svc.ListPlans(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(plans))
	for _, p := range plans {
		out = append(out, planDTO(p, clin))
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreatePlan(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Title         string `json:"title"`
		Tooth         string `json:"tooth"`
		TotalAmount   string `json:"total_amount"`
		StartDate     string `json:"start_date"`
		IntervalUnit  string `json:"interval_unit"`
		IntervalCount int    `json:"interval_count"`
		SessionCount  int    `json:"session_count"`
		Note          string `json:"note"`
		Deposit       string `json:"deposit"`
		ServiceID     string `json:"service_id"`
		Sessions      []struct {
			ScheduledDate string `json:"scheduled_date"`
			AmountDue     string `json:"amount_due"`
		} `json:"sessions"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a treatment name and start date are required"))
		return
	}
	in := dental.PlanInput{
		Title: req.Title, Tooth: req.Tooth, TotalAmount: req.TotalAmount, StartDate: req.StartDate,
		IntervalUnit: req.IntervalUnit, IntervalCount: req.IntervalCount, SessionCount: req.SessionCount, Note: req.Note,
		Deposit: req.Deposit,
	}
	// A malformed service id is refused rather than dropped: silently unlinking the
	// course from the catalogue is how a price stops being auditable.
	if v := strings.TrimSpace(req.ServiceID); v != "" {
		sid, e := id.Decode(id.PrefixServiceItem, v)
		if e != nil {
			httpx.Fail(c, apperr.Validation("unknown service"))
			return
		}
		in.ServiceID = &sid
	}
	for _, ss := range req.Sessions {
		in.Sessions = append(in.Sessions, dental.SessionSeed{ScheduledDate: ss.ScheduledDate, AmountDue: ss.AmountDue})
	}
	p, err := h.svc.CreatePlan(c.Request.Context(), pid, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, planDTO(*p, true))
}

func (h *Handlers) AddExtra(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		ServiceID string `json:"service_id"`
		Amount    string `json:"amount"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("choose the procedure from the clinic's list"))
		return
	}
	svc, e := id.Decode(id.PrefixServiceItem, strings.TrimSpace(req.ServiceID))
	if e != nil {
		httpx.Fail(c, apperr.Validation("choose the procedure from the clinic's list"))
		return
	}
	if err := h.svc.AddExtra(c.Request.Context(), pid, sid, dental.ExtraInput{ServiceID: svc, Amount: req.Amount}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// PopularExtras handles GET /dental/extras/popular — the clinic's most-added extras.
func (h *Handlers) PopularExtras(c *gin.Context) {
	items := h.svc.PopularExtras(c.Request.Context())
	out := make([]gin.H, 0, len(items))
	for _, p := range items {
		out = append(out, gin.H{"service_id": id.Encode(id.PrefixServiceItem, p.ServiceID), "name": p.Name, "price": p.Price, "uses": p.Uses})
	}
	httpx.OK(c, out)
}

func (h *Handlers) RemoveExtra(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	exid, ok := decode(c, id.PrefixTreatmentSession, c.Param("exid"))
	if !ok {
		return
	}
	if err := h.svc.RemoveExtra(c.Request.Context(), pid, exid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) UpdatePlan(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	plid, ok := decode(c, id.PrefixTreatmentPlan, c.Param("pid"))
	if !ok {
		return
	}
	var req struct {
		Title  *string `json:"title"`
		Tooth  *string `json:"tooth"`
		Note   *string `json:"note"`
		Status *string `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	if err := h.svc.UpdatePlan(c.Request.Context(), pid, plid, dental.PlanUpdate{Title: req.Title, Tooth: req.Tooth, Note: req.Note, Status: req.Status}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) DeletePlan(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	plid, ok := decode(c, id.PrefixTreatmentPlan, c.Param("pid"))
	if !ok {
		return
	}
	if err := h.svc.DeletePlan(c.Request.Context(), pid, plid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- sessions ---

func (h *Handlers) UpdateSession(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		ScheduledDate string  `json:"scheduled_date"`
		AmountDue     string  `json:"amount_due"`
		Status        string  `json:"status"`
		Procedure     *string `json:"procedure"`
		Tooth         *string `json:"tooth"`
		Notes         *string `json:"notes"`
		Rx            *string `json:"rx"`
		Reason        string  `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	if err := h.svc.UpdateSession(c.Request.Context(), pid, sid, dental.SessionUpdate{
		ScheduledDate: req.ScheduledDate, AmountDue: req.AmountDue, Status: req.Status,
		Procedure: req.Procedure, Tooth: req.Tooth, Notes: req.Notes, Rx: req.Rx, Reason: req.Reason,
	}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// RescheduleSession accepts a date and nothing else — the request struct is the
// enforcement. Reachable with appointment.manage (the front desk) as well as
// dental.manage; see routes.go.
func (h *Handlers) RescheduleSession(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		ScheduledDate string `json:"scheduled_date"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	if req.ScheduledDate == "" {
		httpx.Fail(c, apperr.Validation("scheduled_date is required"))
		return
	}
	if err := h.svc.RescheduleSession(c.Request.Context(), pid, sid, req.ScheduledDate); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) CollectSession(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	if err := h.svc.CollectSession(c.Request.Context(), pid, sid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// CollectSessions handles POST /dental/patients/:id/collect-sessions — bill several
// sessions at once so the front desk can take payment for a whole treatment plan.
// An empty session_ids list means every outstanding session.
func (h *Handlers) CollectSessions(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		SessionIDs []string `json:"session_ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("send the visits to collect as session_ids"))
		return
	}
	ids := make([]uuid.UUID, 0, len(req.SessionIDs))
	for _, raw := range req.SessionIDs {
		u, e := id.Decode(id.PrefixTreatmentSession, raw)
		if e != nil {
			httpx.Fail(c, apperr.Validation("invalid session id"))
			return
		}
		ids = append(ids, u)
	}
	billed, total, err := h.svc.CollectSessions(c.Request.Context(), pid, ids)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"billed": billed, "total": total})
}

func (h *Handlers) UncollectSession(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("say why the bill is being pulled back"))
		return
	}
	if err := h.svc.UncollectSession(c.Request.Context(), pid, sid, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) SetPayLater(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		On   *bool  `json:"on"`
		Note string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	on := true
	if req.On != nil {
		on = *req.On
	}
	if err := h.svc.SetPayLater(c.Request.Context(), pid, sid, on, req.Note); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- medical history ---

func medicalHistoryDTO(h dental.MedicalHistory) gin.H {
	return gin.H{
		"answers": h.Answers, "notes": h.Notes, "recorded": h.Recorded,
		"reviewed_at": h.ReviewedAt, "reviewed_by": h.ReviewedBy,
	}
}

// GetMedicalHistory handles GET /dental/patients/:id/medical-history.
func (h *Handlers) GetMedicalHistory(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	out, err := h.svc.GetMedicalHistory(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, medicalHistoryDTO(*out))
}

// SaveMedicalHistory handles PUT /dental/patients/:id/medical-history — record or
// re-confirm the questionnaire.
func (h *Handlers) SaveMedicalHistory(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Answers map[string]string `json:"answers"`
		Notes   string            `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	out, err := h.svc.SaveMedicalHistory(c.Request.Context(), pid, dental.MedicalHistoryInput{Answers: req.Answers, Notes: req.Notes})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, medicalHistoryDTO(*out))
}

// --- prescriptions ---

func (h *Handlers) AddPrescription(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		Note  string `json:"note"`
		Items []struct {
			DrugName     string `json:"drug_name"`
			Dose         string `json:"dose"`
			Frequency    string `json:"frequency"`
			Duration     string `json:"duration"`
			Instructions string `json:"instructions"`
			DrugID       string `json:"drug_id"`
		} `json:"items"`
		// Sent only on the retry after an ALLERGY_CONFLICT: the prescriber's reason
		// for writing the drug anyway.
		OverrideReason string `json:"override_reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	items := make([]dental.RxItemInput, 0, len(req.Items))
	for _, it := range req.Items {
		did, err := parseDrugID(it.DrugID)
		if err != nil {
			httpx.Fail(c, err)
			return
		}
		items = append(items, dental.RxItemInput{
			DrugName: it.DrugName, Dose: it.Dose, Frequency: it.Frequency, Duration: it.Duration, Instructions: it.Instructions,
			DrugID: did,
		})
	}
	rx, err := h.svc.AddPrescription(c.Request.Context(), pid, sid,
		dental.PrescriptionInput{Note: req.Note, Items: items, OverrideReason: req.OverrideReason})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, prescriptionDTO(*rx))
}

func (h *Handlers) DeletePrescription(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	rxid, ok := decode(c, id.PrefixDentalRx, c.Param("rxid"))
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&req) // an empty body falls through to the service's "say why"
	if err := h.svc.DeletePrescription(c.Request.Context(), pid, rxid, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- images ---

func (h *Handlers) SignImageUpload(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Filename string `json:"filename"`
		MimeType string `json:"mime_type"`
	}
	_ = c.ShouldBindJSON(&req)
	target, err := h.svc.SignImageUpload(c.Request.Context(), pid, req.Filename, req.MimeType)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, target)
}

func (h *Handlers) RecordImage(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		StorageKey string `json:"storage_key"`
		Filename   string `json:"filename"`
		MimeType   string `json:"mime_type"`
		SizeBytes  int64  `json:"size_bytes"`
		SessionID  string `json:"session_id"`
		Category   string `json:"category"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("storage_key is required"))
		return
	}
	var sess *uuid.UUID
	if req.SessionID != "" {
		u, e := id.Decode(id.PrefixTreatmentSession, req.SessionID)
		if e != nil {
			httpx.Fail(c, apperr.Validation("invalid session id"))
			return
		}
		sess = &u
	}
	cat := req.Category
	if cat != "" && cat != "before" && cat != "after" && cat != "xray" {
		cat = ""
	}
	im, err := h.svc.RecordImage(c.Request.Context(), pid, sess, dental.ImageRecordInput{
		StorageKey: req.StorageKey, Filename: req.Filename, MimeType: req.MimeType, SizeBytes: req.SizeBytes, Category: cat,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, imageDTO(*im))
}

func (h *Handlers) ListImages(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var sess *uuid.UUID
	if raw := c.Query("session"); raw != "" {
		u, e := id.Decode(id.PrefixTreatmentSession, raw)
		if e != nil {
			httpx.Fail(c, apperr.Validation("invalid session id"))
			return
		}
		sess = &u
	}
	// X-rays and clinical photos are part of the record; the desk's dental.read used
	// to receive signed links to every one of them (audit D19).
	if !clinical(c) {
		httpx.OK(c, []gin.H{})
		return
	}
	imgs, err := h.svc.ListImages(c.Request.Context(), pid, sess)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(imgs))
	for _, im := range imgs {
		out = append(out, imageDTO(im))
	}
	httpx.OK(c, out)
}

func (h *Handlers) DeleteImage(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	aid, ok := decode(c, id.PrefixAttachment, c.Param("aid"))
	if !ok {
		return
	}
	if err := h.svc.DeleteImage(c.Request.Context(), pid, aid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) Outstanding(c *gin.Context) {
	rows, err := h.svc.Outstanding(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, o := range rows {
		out = append(out, gin.H{
			"patient_id": id.Encode(id.PrefixPatient, o.PatientID), "patient_name": o.PatientName,
			"mrn": o.MRN, "balance": o.Balance,
		})
	}
	httpx.OK(c, out)
}

// SessionsCalendar lists all patients' treatment sessions in [from,to] for the
// clinic calendar (follow-up visits alongside appointments).
func (h *Handlers) SessionsCalendar(c *gin.Context) {
	clin := clinical(c)
	from, to := c.Query("from"), c.Query("to")
	if from == "" || to == "" {
		httpx.Fail(c, apperr.Validation("from and to (YYYY-MM-DD) are required"))
		return
	}
	items, err := h.svc.SessionsInRange(c.Request.Context(), from, to)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(items))
	for _, it := range items {
		out = append(out, gin.H{
			"session_id":   id.Encode(id.PrefixTreatmentSession, it.SessionID),
			"plan_id":      id.Encode(id.PrefixTreatmentPlan, it.PlanID),
			"patient_id":   id.Encode(id.PrefixPatient, it.PatientID),
			"patient_name": it.PatientName, "mrn": it.MRN, "scheduled_date": it.ScheduledDate,
			"seq": it.Seq, "session_count": it.SessionCount, "title": it.Title,
			"procedure": sealed(clin, it.Procedure), "tooth": sealed(clin, it.Tooth), "amount_due": it.AmountDue,
			"status": it.Status, "payment": it.Payment, "pay_later": it.PayLater,
			"kind": it.Kind, "phone": it.Phone,
		})
	}
	httpx.OK(c, out)
}

// --- Examinations -----------------------------------------------------------

func examDTO(e dental.Exam) gin.H {
	h := gin.H{
		"id": id.Encode(id.PrefixDentalVisit, e.ID), "visit_date": e.VisitDate,
		"chief_complaint": e.ChiefComplaint, "hpi": e.HPI, "past_dental_history": e.PastDentalHistory,
		"extraoral": e.Extraoral, "extraoral_notes": e.ExtraoralNotes,
		"intraoral": e.Intraoral, "intraoral_notes": e.IntraoralNotes,
		"investigations": e.Investigations, "investigation_results": e.InvestigationResults,
		"diagnosis": e.Diagnosis, "treatment_plan": e.TreatmentPlan,
		"treatment_given": e.TreatmentGiven, "anaesthesia": e.Anaesthesia,
		"complications": e.Complications, "procedures": e.Procedures, "postop": e.Postop,
		"recorded_by": e.RecordedBy, "created_at": e.CreatedAt, "updated_at": e.UpdatedAt,
	}
	if e.SessionID != nil {
		h["session_id"] = id.Encode(id.PrefixTreatmentSession, *e.SessionID)
	}
	return h
}

// examReq is the whole form; an examination is saved as one document, not patched.
type examReq struct {
	SessionID            string                 `json:"session_id"`
	VisitDate            string                 `json:"visit_date"`
	ChiefComplaint       string                 `json:"chief_complaint"`
	HPI                  string                 `json:"hpi"`
	PastDentalHistory    string                 `json:"past_dental_history"`
	Extraoral            []string               `json:"extraoral"`
	ExtraoralNotes       string                 `json:"extraoral_notes"`
	Intraoral            []string               `json:"intraoral"`
	IntraoralNotes       string                 `json:"intraoral_notes"`
	Investigations       []string               `json:"investigations"`
	InvestigationResults string                 `json:"investigation_results"`
	Diagnosis            string                 `json:"diagnosis"`
	TreatmentPlan        string                 `json:"treatment_plan"`
	TreatmentGiven       []string               `json:"treatment_given"`
	Anaesthesia          string                 `json:"anaesthesia"`
	Complications        string                 `json:"complications"`
	Procedures           []dental.ExamProcedure `json:"procedures"`
	Postop               string                 `json:"postop"`
}

func (r examReq) toInput() (dental.ExamInput, bool) {
	in := dental.ExamInput{
		VisitDate: r.VisitDate, ChiefComplaint: r.ChiefComplaint, HPI: r.HPI,
		PastDentalHistory: r.PastDentalHistory, Extraoral: r.Extraoral, ExtraoralNotes: r.ExtraoralNotes,
		Intraoral: r.Intraoral, IntraoralNotes: r.IntraoralNotes,
		Investigations: r.Investigations, InvestigationResults: r.InvestigationResults,
		Diagnosis: r.Diagnosis, TreatmentPlan: r.TreatmentPlan, TreatmentGiven: r.TreatmentGiven,
		Anaesthesia: r.Anaesthesia, Complications: r.Complications,
		Procedures: r.Procedures, Postop: r.Postop,
	}
	if r.SessionID != "" {
		sid, err := id.Decode(id.PrefixTreatmentSession, r.SessionID)
		if err != nil {
			return in, false
		}
		in.SessionID = &sid
	}
	return in, true
}

func (h *Handlers) ListExams(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	list, err := h.svc.ListExams(c.Request.Context(), pid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, e := range list {
		out = append(out, examDTO(e))
	}
	httpx.OK(c, gin.H{"items": out})
}

func (h *Handlers) CreateExam(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	var req examReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	in, ok := req.toInput()
	if !ok {
		httpx.Fail(c, apperr.Validation("invalid session id"))
		return
	}
	out, err := h.svc.CreateExam(c.Request.Context(), pid, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, examDTO(*out))
}

func (h *Handlers) UpdateExam(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	eid, ok := decode(c, id.PrefixDentalVisit, c.Param("eid"))
	if !ok {
		return
	}
	var req examReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	in, ok := req.toInput()
	if !ok {
		httpx.Fail(c, apperr.Validation("invalid session id"))
		return
	}
	out, err := h.svc.UpdateExam(c.Request.Context(), pid, eid, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, examDTO(*out))
}

func (h *Handlers) DeleteExam(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	eid, ok := decode(c, id.PrefixDentalVisit, c.Param("eid"))
	if !ok {
		return
	}
	if err := h.svc.DeleteExam(c.Request.Context(), pid, eid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- the unbilled-treatment report -------------------------------------------

func (h *Handlers) UnbilledTreatment(c *gin.Context) {
	clin := clinical(c)
	limit, _ := strconv.Atoi(c.Query("limit"))
	offset, _ := strconv.Atoi(c.Query("offset"))
	out, err := h.svc.UnbilledTreatment(c.Request.Context(), c.Query("from"), c.Query("to"), limit, offset)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out.Rows))
	for _, r := range out.Rows {
		rows = append(rows, gin.H{
			"session_id": id.Encode(id.PrefixTreatmentSession, r.SessionID),
			"patient_id": id.Encode(id.PrefixPatient, r.PatientID),
			"mrn":        r.MRN, "patient_name": r.PatientName, "phone": r.Phone,
			"plan_title": r.PlanTitle, "procedure": sealed(clin, r.Procedure), "tooth": sealed(clin, r.Tooth),
			"seq": r.Seq, "session_count": r.SessionCount,
			"kind": r.Kind, "service_name": r.Service, "treatment_date": r.TreatmentDate, "days_unbilled": r.DaysUnbilled,
			"amount": r.Amount, "lane": r.Lane,
			"pay_later": r.PayLater, "pay_later_note": r.PayLaterNote,
			"clinician": r.Clinician, "branch": r.Branch,
		})
	}
	httpx.OK(c, gin.H{
		"rows": rows, "total": out.Total, "count": out.Count, "has_more": out.HasMore,
		"promised_total": out.PromisedTotal, "promised_count": out.PromisedCount,
	})
}

func (h *Handlers) WriteOffSession(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	if err := h.svc.WriteOffSession(c.Request.Context(), pid, sid, req.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) UndoWriteOff(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	sid, ok := decode(c, id.PrefixTreatmentSession, c.Param("sid"))
	if !ok {
		return
	}
	if err := h.svc.UndoWriteOff(c.Request.Context(), pid, sid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) AddSession(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	plid, ok := decode(c, id.PrefixTreatmentPlan, c.Param("pid"))
	if !ok {
		return
	}
	var req struct {
		ScheduledDate string `json:"scheduled_date"`
		AmountDue     string `json:"amount_due"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	out, err := h.svc.AddSession(c.Request.Context(), pid, plid,
		dental.SessionSeed{ScheduledDate: req.ScheduledDate, AmountDue: req.AmountDue})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, sessionDTO(*out, true))
}

// CancelPlan ends a course that will not go ahead. A reason is required.
func (h *Handlers) CancelPlan(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	planID, ok := decode(c, id.PrefixTreatmentPlan, c.Param("pid"))
	if !ok {
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("say why the course is being cancelled"))
		return
	}
	n, err := h.svc.CancelPlan(c.Request.Context(), pid, planID, req.Reason)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"sessions_cancelled": n})
}

func (h *Handlers) FinishCourse(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
		return
	}
	plid, ok := decode(c, id.PrefixTreatmentPlan, c.Param("pid"))
	if !ok {
		return
	}
	n, err := h.svc.FinishCourse(c.Request.Context(), pid, plid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"sessions_cancelled": n})
}

/* ------------------------------------------------- this clinic's procedures */

func (h *Handlers) ListProcedures(c *gin.Context) {
	out, err := h.svc.ListProcedures(c.Request.Context(), c.Query("all") == "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, p := range out {
		rows = append(rows, gin.H{"id": id.Encode(id.PrefixProcedure, p.ID), "name": p.Name,
			"is_active": p.IsActive, "sort_order": p.SortOrder})
	}
	httpx.OK(c, rows)
}

func (h *Handlers) CreateProcedure(c *gin.Context) {
	var r struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("give the procedure a name"))
		return
	}
	out, err := h.svc.CreateProcedure(c.Request.Context(), r.Name)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixProcedure, out.ID), "name": out.Name,
		"is_active": out.IsActive, "sort_order": out.SortOrder})
}

func (h *Handlers) UpdateProcedure(c *gin.Context) {
	pid, err := id.Decode(id.PrefixProcedure, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("that id is not valid"))
		return
	}
	var r struct {
		Name     string `json:"name"`
		IsActive *bool  `json:"is_active"`
	}
	if e := c.ShouldBindJSON(&r); e != nil {
		httpx.Fail(c, apperr.Validation("give the procedure a name"))
		return
	}
	if e := h.svc.UpdateProcedure(c.Request.Context(), pid, r.Name, r.IsActive); e != nil {
		httpx.Fail(c, e)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) DeleteProcedure(c *gin.Context) {
	pid, err := id.Decode(id.PrefixProcedure, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("that id is not valid"))
		return
	}
	if e := h.svc.DeleteProcedure(c.Request.Context(), pid); e != nil {
		httpx.Fail(c, e)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) ReorderProcedures(c *gin.Context) {
	var r struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("send the order"))
		return
	}
	ids := make([]uuid.UUID, 0, len(r.IDs))
	for _, raw := range r.IDs {
		u, e := id.Decode(id.PrefixProcedure, raw)
		if e != nil {
			httpx.Fail(c, apperr.Validation("that id is not valid"))
			return
		}
		ids = append(ids, u)
	}
	if e := h.svc.ReorderProcedures(c.Request.Context(), ids); e != nil {
		httpx.Fail(c, e)
		return
	}
	httpx.NoContent(c)
}

/* ------------------------------------------- the conditions on this chart */

func toothStatusDTO(t dental.ToothStatus) gin.H {
	return gin.H{"id": id.Encode(id.PrefixToothStatus, t.ID), "code": t.Code, "label": t.Label,
		"color": t.Color, "sort_order": t.SortOrder, "is_active": t.IsActive}
}

func (h *Handlers) ListToothStatuses(c *gin.Context) {
	out, err := h.svc.ListToothStatuses(c.Request.Context(), c.Query("all") == "1")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, t := range out {
		rows = append(rows, toothStatusDTO(t))
	}
	httpx.OK(c, rows)
}

func (h *Handlers) CreateToothStatus(c *gin.Context) {
	var r struct {
		Label string `json:"label"`
		Color string `json:"color"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("give the condition a name and a colour"))
		return
	}
	out, err := h.svc.CreateToothStatus(c.Request.Context(), r.Label, r.Color)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, toothStatusDTO(*out))
}

func (h *Handlers) UpdateToothStatus(c *gin.Context) {
	sid, err := id.Decode(id.PrefixToothStatus, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("that id is not valid"))
		return
	}
	var r struct {
		Label    string `json:"label"`
		Color    string `json:"color"`
		IsActive *bool  `json:"is_active"`
	}
	if e := c.ShouldBindJSON(&r); e != nil {
		httpx.Fail(c, apperr.Validation("give the condition a name and a colour"))
		return
	}
	if e := h.svc.UpdateToothStatus(c.Request.Context(), sid, r.Label, r.Color, r.IsActive); e != nil {
		httpx.Fail(c, e)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) DeleteToothStatus(c *gin.Context) {
	sid, err := id.Decode(id.PrefixToothStatus, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("that id is not valid"))
		return
	}
	if e := h.svc.DeleteToothStatus(c.Request.Context(), sid); e != nil {
		httpx.Fail(c, e)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) ReorderToothStatuses(c *gin.Context) {
	var r struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&r); err != nil {
		httpx.Fail(c, apperr.Validation("send the order"))
		return
	}
	ids := make([]uuid.UUID, 0, len(r.IDs))
	for _, raw := range r.IDs {
		u, e := id.Decode(id.PrefixToothStatus, raw)
		if e != nil {
			httpx.Fail(c, apperr.Validation("that id is not valid"))
			return
		}
		ids = append(ids, u)
	}
	if e := h.svc.ReorderToothStatuses(c.Request.Context(), ids); e != nil {
		httpx.Fail(c, e)
		return
	}
	httpx.NoContent(c)
}

/* ------------------------------------------------------------- the chair */

// Chairside handles GET /dental/chairside?provider=&from=&to=.
//
// Returns the live chair AND today's finished visits: a dentist needs to see what
// they have done, and to undo a check-out made by mistake.
func (h *Handlers) Chairside(c *gin.Context) {
	var provider *uuid.UUID
	if raw := c.Query("provider"); raw != "" && raw != "all" {
		u, err := id.Decode(id.PrefixUser, raw)
		if err != nil {
			httpx.Fail(c, apperr.Validation("unknown provider"))
			return
		}
		provider = &u
	}
	from := time.Now().Add(-24 * time.Hour)
	if f, err := time.Parse(time.RFC3339, c.Query("from")); err == nil {
		from = f
	}
	var until *time.Time
	if t, err := time.Parse(time.RFC3339, c.Query("to")); err == nil {
		until = &t
	}
	out, err := h.svc.Chairside(c.Request.Context(), provider, from, until)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	rows := make([]gin.H, 0, len(out))
	for _, p := range out {
		row := gin.H{
			"queue_id":   id.Encode(id.PrefixQueueEntry, p.QueueID),
			"patient_id": id.Encode(id.PrefixPatient, p.PatientID),
			"state":      p.State, "stage": p.Stage, "priority": p.Priority,
			"enqueued_at":     p.EnqueuedAt,
			"department_name": p.DepartmentName, "provider_name": p.ProviderName,
			"patient_name": p.PatientName, "mrn": p.MRN, "age": p.Age, "sex": p.Sex,
			"allergies": p.Allergies, "owed": p.Owed, "unbilled": p.Unbilled,
			"recorded_this_visit": p.RecordedThisVisit,
		}
		if p.StartedAt != nil {
			row["started_at"] = *p.StartedAt
		}
		if p.EndedAt != nil {
			row["ended_at"] = *p.EndedAt
		}
		if p.ProviderID != nil {
			row["provider_id"] = id.Encode(id.PrefixUser, *p.ProviderID)
		}
		if p.PlanTitle != "" {
			row["plan_title"] = p.PlanTitle
			row["plan_done"] = p.PlanDone
			row["plan_total"] = p.PlanTotal
		}
		rows = append(rows, row)
	}
	httpx.OK(c, rows)
}
