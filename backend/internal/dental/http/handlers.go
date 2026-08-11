// Package http exposes the dental REST endpoints. Thin handlers: decode the
// prefixed patient/plan/session ids, call the service, encode JSON.
package http

import (
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
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
	h := gin.H{"teeth": ch.Teeth}
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
		})
	}
	return gin.H{"id": id.Encode(id.PrefixDentalRx, rx.ID), "note": rx.Note, "created_at": rx.CreatedAt, "items": items}
}

func sessionDTO(se dental.Session) gin.H {
	images := make([]gin.H, 0, len(se.Images))
	for _, im := range se.Images {
		images = append(images, imageDTO(im))
	}
	rxs := make([]gin.H, 0, len(se.Prescriptions))
	for _, rx := range se.Prescriptions {
		rxs = append(rxs, prescriptionDTO(rx))
	}
	return gin.H{
		"id": id.Encode(id.PrefixTreatmentSession, se.ID), "seq": se.Seq, "scheduled_date": se.ScheduledDate,
		"amount_due": se.AmountDue, "status": se.Status, "payment": se.Payment,
		"procedure": se.Procedure, "tooth": se.Tooth, "notes": se.Notes, "rx": se.Rx,
		"pay_later": se.PayLater, "pay_later_note": se.PayLaterNote,
		"images": images, "prescriptions": rxs,
	}
}

func planDTO(p dental.Plan) gin.H {
	sessions := make([]gin.H, 0, len(p.Sessions))
	for _, se := range p.Sessions {
		sessions = append(sessions, sessionDTO(se))
	}
	return gin.H{
		"id": id.Encode(id.PrefixTreatmentPlan, p.ID), "title": p.Title, "tooth": p.Tooth,
		"total_amount": p.TotalAmount, "start_date": p.StartDate, "interval_unit": p.IntervalUnit,
		"interval_count": p.IntervalCount, "session_count": p.SessionCount, "deadline": p.Deadline,
		"status": p.Status, "note": p.Note, "created_at": p.CreatedAt, "sessions": sessions,
		// Money from the ledger, not summed from the sessions' planned fees.
		"money": gin.H{
			"planned": p.Money.Planned, "collected": p.Money.Collected,
			"at_cashier": p.Money.AtCashier, "due": p.Money.Due, "waived": p.Money.Waived,
		},
	}
}

// --- summary ---

func (h *Handlers) Summary(c *gin.Context) {
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
		plans = append(plans, planDTO(p))
	}
	httpx.OK(c, gin.H{"chart": chartDTO(sum.Chart), "plans": plans, "balance": balanceDTO(sum.Balance), "image_limit": sum.ImageLimit})
}

// --- chart ---

func (h *Handlers) GetChart(c *gin.Context) {
	pid, ok := decode(c, id.PrefixPatient, c.Param("id"))
	if !ok {
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
	var req struct {
		Teeth map[string]string `json:"teeth"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("teeth map is required"))
		return
	}
	ch, err := h.svc.SaveChart(c.Request.Context(), pid, req.Teeth)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, chartDTO(*ch))
}

// --- treatment plans ---

func (h *Handlers) ListPlans(c *gin.Context) {
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
		out = append(out, planDTO(p))
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
	}
	for _, ss := range req.Sessions {
		in.Sessions = append(in.Sessions, dental.SessionSeed{ScheduledDate: ss.ScheduledDate, AmountDue: ss.AmountDue})
	}
	p, err := h.svc.CreatePlan(c.Request.Context(), pid, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, planDTO(*p))
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
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	if err := h.svc.UpdateSession(c.Request.Context(), pid, sid, dental.SessionUpdate{
		ScheduledDate: req.ScheduledDate, AmountDue: req.AmountDue, Status: req.Status,
		Procedure: req.Procedure, Tooth: req.Tooth, Notes: req.Notes, Rx: req.Rx,
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
	_ = c.ShouldBindJSON(&req) // absent body = collect everything outstanding
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
	if err := h.svc.UncollectSession(c.Request.Context(), pid, sid); err != nil {
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
		} `json:"items"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("invalid request"))
		return
	}
	items := make([]dental.RxItemInput, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, dental.RxItemInput{
			DrugName: it.DrugName, Dose: it.Dose, Frequency: it.Frequency, Duration: it.Duration, Instructions: it.Instructions,
		})
	}
	rx, err := h.svc.AddPrescription(c.Request.Context(), pid, sid, dental.PrescriptionInput{Note: req.Note, Items: items})
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
	if err := h.svc.DeletePrescription(c.Request.Context(), pid, rxid); err != nil {
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
			"procedure": it.Procedure, "tooth": it.Tooth, "amount_due": it.AmountDue,
			"status": it.Status, "payment": it.Payment, "pay_later": it.PayLater,
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
			"plan_title": r.PlanTitle, "procedure": r.Procedure, "tooth": r.Tooth,
			"seq": r.Seq, "session_count": r.SessionCount,
			"treatment_date": r.TreatmentDate, "days_unbilled": r.DaysUnbilled,
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
	httpx.Created(c, sessionDTO(*out))
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
