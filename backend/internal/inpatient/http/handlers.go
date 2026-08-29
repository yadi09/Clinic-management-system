// Package http exposes the inpatient (bed management) REST endpoints. Thin
// handlers: decode prefixed ids + dates, call the service, encode JSON.
package http

import (
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/inpatient"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

type Handlers struct{ svc inpatient.Service }

func NewHandlers(svc inpatient.Service) *Handlers { return &Handlers{svc: svc} }

func parseTime(s string) *time.Time {
	if s == "" {
		return nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return &t
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return &t
	}
	return nil
}

// --- wards ---

func (h *Handlers) ListWards(c *gin.Context) {
	wards, err := h.svc.ListWards(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(wards))
	for _, w := range wards {
		out = append(out, gin.H{"id": id.Encode(id.PrefixWard, w.ID), "name": w.Name, "is_active": w.IsActive, "bed_count": w.BedCount})
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateWard(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	_ = c.ShouldBindJSON(&req)
	w, err := h.svc.CreateWard(c.Request.Context(), inpatient.WardInput{Name: req.Name})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, gin.H{"id": id.Encode(id.PrefixWard, w.ID), "name": w.Name, "is_active": w.IsActive})
}

func (h *Handlers) UpdateWard(c *gin.Context) {
	wid, ok := decode(c, id.PrefixWard, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Name     string `json:"name"`
		IsActive *bool  `json:"is_active"`
	}
	_ = c.ShouldBindJSON(&req)
	if err := h.svc.UpdateWard(c.Request.Context(), wid, inpatient.WardInput{Name: req.Name, IsActive: req.IsActive}); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- beds ---

func bedDTO(b inpatient.Bed) gin.H {
	return gin.H{
		"id": id.Encode(id.PrefixBed, b.ID), "ward_id": id.Encode(id.PrefixWard, b.WardID), "ward_name": b.WardName,
		"label": b.Label, "bed_type": b.BedType, "daily_rate": b.DailyRate, "out_of_service": b.OutOfService,
		"is_active": b.IsActive, "note": b.Note,
	}
}

func (h *Handlers) ListBeds(c *gin.Context) {
	beds, err := h.svc.ListBeds(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(beds))
	for _, b := range beds {
		out = append(out, bedDTO(b))
	}
	httpx.OK(c, out)
}

func (h *Handlers) CreateBed(c *gin.Context) {
	var req struct {
		WardID    string `json:"ward_id"`
		Label     string `json:"label"`
		BedType   string `json:"bed_type"`
		DailyRate string `json:"daily_rate"`
		Note      string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("ward and label are required"))
		return
	}
	wid, ok := decode(c, id.PrefixWard, req.WardID)
	if !ok {
		return
	}
	b, err := h.svc.CreateBed(c.Request.Context(), inpatient.BedInput{WardID: wid, Label: req.Label, BedType: req.BedType, DailyRate: req.DailyRate, Note: req.Note})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, bedDTO(*b))
}

func (h *Handlers) UpdateBed(c *gin.Context) {
	bid, ok := decode(c, id.PrefixBed, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		WardID       string `json:"ward_id"`
		Label        string `json:"label"`
		BedType      string `json:"bed_type"`
		DailyRate    string `json:"daily_rate"`
		OutOfService *bool  `json:"out_of_service"`
		IsActive     *bool  `json:"is_active"`
		Note         string `json:"note"`
	}
	_ = c.ShouldBindJSON(&req)
	in := inpatient.BedInput{Label: req.Label, BedType: req.BedType, DailyRate: req.DailyRate, OutOfService: req.OutOfService, IsActive: req.IsActive, Note: req.Note}
	if req.WardID != "" {
		if in.WardID, ok = decode(c, id.PrefixWard, req.WardID); !ok {
			return
		}
	}
	if err := h.svc.UpdateBed(c.Request.Context(), bid, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// --- board / admissions ---

func boardBedDTO(b inpatient.BoardBed) gin.H {
	h := gin.H{
		"id": id.Encode(id.PrefixBed, b.ID), "ward_id": id.Encode(id.PrefixWard, b.WardID), "ward_name": b.WardName,
		"label": b.Label, "bed_type": b.BedType, "daily_rate": b.DailyRate, "out_of_service": b.OutOfService,
		"occupied": b.Occupied, "days": b.Days, "overdue": b.Overdue,
	}
	if b.Occupied {
		h["admission_id"] = id.Encode(id.PrefixAdmission, *b.AdmissionID)
		h["patient_id"] = id.Encode(id.PrefixPatient, *b.PatientID)
		h["patient_name"] = b.PatientName
		h["mrn"] = b.MRN
		h["est_cost"] = b.EstCost
		// The money the card is built around. Sent whenever the bed is occupied,
		// including the zeroes: "nothing paid" is an answer the ward needs, and an
		// omitted field would read as "unknown".
		h["paid"] = b.Paid
		h["unbilled"] = b.Unbilled
		h["outstanding"] = b.Outstanding
		h["covered_nights"] = b.CoveredNights
		if b.PlannedNights > 0 {
			h["planned_nights"] = b.PlannedNights
		}
		if b.CoveredThru != nil {
			h["covered_thru"] = b.CoveredThru.Format(time.RFC3339)
		}
		if b.AdmittedAt != nil {
			h["admitted_at"] = b.AdmittedAt.Format(time.RFC3339)
		}
		if b.PaymentDueAt != nil {
			h["payment_due_at"] = b.PaymentDueAt.Format(time.RFC3339)
		}
	}
	return h
}

func (h *Handlers) Board(c *gin.Context) {
	beds, err := h.svc.Board(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(beds))
	for _, b := range beds {
		out = append(out, boardBedDTO(b))
	}
	httpx.OK(c, out)
}

func admissionDTO(a inpatient.Admission) gin.H {
	h := gin.H{
		"patient_name": a.PatientName, "mrn": a.MRN, "ward_name": a.WardName, "bed_label": a.BedLabel,
		"admitted_at": a.AdmittedAt.Format(time.RFC3339), "status": a.Status, "daily_rate": a.DailyRate,
		"days": a.Days, "est_cost": a.EstCost, "overdue": a.Overdue,
	}
	if a.ID != uuid.Nil {
		h["id"] = id.Encode(id.PrefixAdmission, a.ID)
	}
	if a.PaymentDueAt != nil {
		h["payment_due_at"] = a.PaymentDueAt.Format(time.RFC3339)
	}
	if a.DischargedAt != nil {
		h["discharged_at"] = a.DischargedAt.Format(time.RFC3339)
	}
	return h
}

func (h *Handlers) Admit(c *gin.Context) {
	var req struct {
		PatientID         string `json:"patient_id"`
		BedID             string `json:"bed_id"`
		DepositAmount     string `json:"deposit_amount"`
		PaymentDueAt      string `json:"payment_due_at"`
		ExpectedDischarge string `json:"expected_discharge"`
		Note              string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("patient_id and bed_id are required"))
		return
	}
	pid, ok := decode(c, id.PrefixPatient, req.PatientID)
	if !ok {
		return
	}
	bid, ok := decode(c, id.PrefixBed, req.BedID)
	if !ok {
		return
	}
	a, err := h.svc.Admit(c.Request.Context(), inpatient.AdmitInput{
		PatientID: pid, BedID: bid, DepositAmount: req.DepositAmount,
		PaymentDueAt: parseTime(req.PaymentDueAt), ExpectedDischarge: parseTime(req.ExpectedDischarge), Note: req.Note,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, admissionDTO(*a))
}

func (h *Handlers) Discharge(c *gin.Context) {
	aid, ok := decode(c, id.PrefixAdmission, c.Param("id"))
	if !ok {
		return
	}
	a, err := h.svc.Discharge(c.Request.Context(), aid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, admissionDTO(*a))
}

func (h *Handlers) Transfer(c *gin.Context) {
	aid, ok := decode(c, id.PrefixAdmission, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		BedID string `json:"bed_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("bed_id is required"))
		return
	}
	bid, ok := decode(c, id.PrefixBed, req.BedID)
	if !ok {
		return
	}
	if err := h.svc.Transfer(c.Request.Context(), aid, bid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) Report(c *gin.Context) {
	rep, err := h.svc.Report(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	byWard := make([]gin.H, 0, len(rep.ByWard))
	for _, w := range rep.ByWard {
		byWard = append(byWard, gin.H{"ward": w.Ward, "total": w.Total, "occupied": w.Occupied})
	}
	overdue := make([]gin.H, 0, len(rep.Overdue))
	for _, a := range rep.Overdue {
		overdue = append(overdue, admissionDTO(a))
	}
	httpx.OK(c, gin.H{
		"total_beds": rep.TotalBeds, "occupied": rep.Occupied, "available": rep.Available,
		"by_ward": byWard, "current_patients": rep.CurrentPatients, "avg_los_days": rep.AvgLOSDays,
		"bed_revenue": rep.BedRevenue, "overdue": overdue,
	})
}

func decode(c *gin.Context, prefix, raw string) (uuid.UUID, bool) {
	u, err := id.Decode(prefix, raw)
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid id"))
		return uuid.Nil, false
	}
	return u, true
}

// TopUp raises a charge for part of a running bed bill so the cashier can collect it.
//
// Requires payment.charge, not bed.assign: asking a patient for money is a billing act
// wherever it happens, and the board is not a way around that.
func (h *Handlers) TopUp(c *gin.Context) {
	aid, ok := decode(c, id.PrefixAdmission, c.Param("id"))
	if !ok {
		return
	}
	var req struct {
		Nights int    `json:"nights"`
		Amount string `json:"amount"`
	}
	// A body is optional: with neither figure, bill everything accrued so far.
	_ = c.ShouldBindJSON(&req)
	if req.Nights < 0 {
		httpx.Fail(c, apperr.Validation("nights cannot be negative"))
		return
	}
	out, err := h.svc.TopUp(c.Request.Context(), aid, inpatient.TopUpInput{Nights: req.Nights, Amount: req.Amount})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}
