// Package service implements the dental use-cases: the per-patient odontogram,
// scheduled treatment PLANS made of dated SESSIONS (each with its own payment,
// notes/Rx and images), and an installment balance. Session fees bill through the
// billing.Charger spine (source='dental') so the existing cashier settles them.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/storage"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
	billing   billing.Charger
	store     storage.Provider
}

var _ dental.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, publisher events.Publisher, charger billing.Charger, store storage.Provider) *Service {
	return &Service{db: db, publisher: publisher, billing: charger, store: store}
}

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

func activeBranchOf(ctx context.Context) *uuid.UUID {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		return p.ActiveBranchID
	}
	return nil
}

func money(s string) float64    { f, _ := strconv.ParseFloat(s, 64); return f }
func fmtMoney(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) }
func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var validSessionStatus = map[string]bool{"planned": true, "done": true, "cancelled": true}

// splitAmount divides a total into payable whole-birr amounts: each session rounds
// down to a comfortable unit (100 when the share is ≥100, else 10, else 1) and the
// last session carries the remainder — so patients pay round numbers, not 5833.33.
func splitAmount(total float64, n int) []float64 {
	if n <= 0 {
		return nil
	}
	out := make([]float64, n)
	if total <= 0 {
		return out
	}
	share := total / float64(n)
	unit := 100.0
	if share < 100 {
		unit = 10
	}
	if share < 10 {
		unit = 1
	}
	per := math.Floor(share/unit) * unit
	for i := 0; i < n-1; i++ {
		out[i] = per
	}
	out[n-1] = math.Round(total - per*float64(n-1))
	return out
}

// genDates produces n session dates from start, spaced by intervalCount units.
func genDates(start time.Time, unit string, intervalCount, n int) []time.Time {
	if intervalCount < 1 {
		intervalCount = 1
	}
	out := make([]time.Time, n)
	for i := 0; i < n; i++ {
		switch unit {
		case "day":
			out[i] = start.AddDate(0, 0, intervalCount*i)
		case "week":
			out[i] = start.AddDate(0, 0, 7*intervalCount*i)
		default: // month
			out[i] = start.AddDate(0, intervalCount*i, 0)
		}
	}
	return out
}

// --- chart (odontogram) ---

func (s *Service) GetChart(ctx context.Context, patientID uuid.UUID) (*dental.Chart, error) {
	tid, _ := actorOf(ctx)
	chart := &dental.Chart{Teeth: map[string]string{}}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return s.loadChartTx(ctx, tx, tid, patientID, chart)
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return chart, nil
}

func (s *Service) loadChartTx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID, chart *dental.Chart) error {
	var raw []byte
	var updated time.Time
	e := tx.QueryRow(ctx, `SELECT teeth, updated_at FROM dental_charts WHERE tenant_id = $1 AND patient_id = $2`, tid, patientID).Scan(&raw, &updated)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	if len(raw) > 0 {
		if e := json.Unmarshal(raw, &chart.Teeth); e != nil {
			return e
		}
	}
	u := updated.Format(time.RFC3339)
	chart.UpdatedAt = &u
	return nil
}

func (s *Service) SaveChart(ctx context.Context, patientID uuid.UUID, teeth map[string]string) (*dental.Chart, error) {
	tid, actor := actorOf(ctx)
	if teeth == nil {
		teeth = map[string]string{}
	}
	raw, err := json.Marshal(teeth)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO dental_charts (tenant_id, patient_id, teeth, updated_by, updated_at)
			 VALUES ($1,$2,$3,$4, now())
			 ON CONFLICT (tenant_id, patient_id) DO UPDATE SET
			   teeth = EXCLUDED.teeth, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			tid, patientID, raw, actor)
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	u := time.Now().Format(time.RFC3339)
	return &dental.Chart{Teeth: teeth, UpdatedAt: &u}, nil
}

// --- medical history (pre-treatment health questionnaire) ---

func (s *Service) GetMedicalHistory(ctx context.Context, patientID uuid.UUID) (*dental.MedicalHistory, error) {
	tid, _ := actorOf(ctx)
	out := &dental.MedicalHistory{Answers: map[string]string{}}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var raw []byte
		var notes *string
		var reviewedAt time.Time
		var reviewer *string
		e := tx.QueryRow(ctx,
			`SELECT h.answers, h.notes, h.reviewed_at, u.full_name
			 FROM medical_histories h
			 LEFT JOIN users u ON u.id = h.reviewed_by AND u.tenant_id = h.tenant_id
			 WHERE h.tenant_id = $1 AND h.patient_id = $2`, tid, patientID).Scan(&raw, &notes, &reviewedAt, &reviewer)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil // never taken — Recorded stays false
		}
		if e != nil {
			return e
		}
		if len(raw) > 0 {
			if e := json.Unmarshal(raw, &out.Answers); e != nil {
				return e
			}
		}
		out.Recorded = true
		if notes != nil {
			out.Notes = *notes
		}
		if reviewer != nil {
			out.ReviewedBy = *reviewer
		}
		out.ReviewedAt = reviewedAt.Format(time.RFC3339)
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SaveMedicalHistory upserts the questionnaire and stamps who confirmed it, when.
// Re-saving an unchanged form is a legitimate act — it is how a clinician records
// "I asked again today and nothing has changed".
func (s *Service) SaveMedicalHistory(ctx context.Context, patientID uuid.UUID, in dental.MedicalHistoryInput) (*dental.MedicalHistory, error) {
	tid, actor := actorOf(ctx)
	if in.Answers == nil {
		in.Answers = map[string]string{}
	}
	raw, err := json.Marshal(in.Answers)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx,
			`INSERT INTO medical_histories (tenant_id, patient_id, answers, notes, reviewed_at, reviewed_by)
			 VALUES ($1,$2,$3,$4, now(), $5)
			 ON CONFLICT (tenant_id, patient_id) DO UPDATE SET
			   answers = EXCLUDED.answers, notes = EXCLUDED.notes,
			   reviewed_at = now(), reviewed_by = EXCLUDED.reviewed_by, updated_at = now()`,
			tid, patientID, raw, nullStr(in.Notes), actor); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.medical_history.recorded",
			map[string]any{"patient_id": patientID})
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.GetMedicalHistory(ctx, patientID)
}

// --- treatment plans + sessions ---

// loadPlansTx builds a patient's plans with their sessions (+ payment state) and
// each session's images, in the caller's tx.
func (s *Service) loadPlansTx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID) ([]dental.Plan, error) {
	plans := []dental.Plan{}
	idx := map[uuid.UUID]int{} // plan id → index in plans

	prows, e := tx.Query(ctx,
		`SELECT id, title, coalesce(tooth,''), total_amount::text, start_date, interval_unit, interval_count,
		        session_count, deadline, status, coalesce(note,''), created_at
		 FROM treatment_plans WHERE tenant_id = $1 AND patient_id = $2 ORDER BY created_at DESC`, tid, patientID)
	if e != nil {
		return nil, e
	}
	defer prows.Close()
	for prows.Next() {
		var p dental.Plan
		var id uuid.UUID
		var start, created time.Time
		var deadline *time.Time
		if e := prows.Scan(&id, &p.Title, &p.Tooth, &p.TotalAmount, &start, &p.IntervalUnit, &p.IntervalCount,
			&p.SessionCount, &deadline, &p.Status, &p.Note, &created); e != nil {
			return nil, e
		}
		p.ID = id
		p.StartDate = start.Format("2006-01-02")
		if deadline != nil {
			p.Deadline = deadline.Format("2006-01-02")
		}
		p.CreatedAt = created.Format(time.RFC3339)
		p.Sessions = []dental.Session{}
		idx[id] = len(plans)
		plans = append(plans, p)
	}
	if e := prows.Err(); e != nil {
		return nil, e
	}
	if len(plans) == 0 {
		return plans, nil
	}

	// sessions (+ payment state from the linked charge)
	sidx := map[uuid.UUID][2]int{} // session id → (plan index, session index)
	srows, e := tx.Query(ctx, sessionMoneyCTE+`
		SELECT sm.session_id, sm.plan_id, sm.seq, sm.scheduled_date, sm.amount_due::text,
		       sm.session_status, sm.procedure, sm.tooth,
		       coalesce(se.notes,''), coalesce(se.rx,''),
		       sm.pay_later, sm.pay_later_note, sm.pay_state
		FROM session_money sm
		JOIN treatment_sessions se ON se.id = sm.session_id
		WHERE sm.patient_id = $2 ORDER BY sm.plan_id, sm.seq`, tid, patientID)
	if e != nil {
		return nil, e
	}
	defer srows.Close()
	for srows.Next() {
		var se dental.Session
		var id, planID uuid.UUID
		var sd time.Time
		if e := srows.Scan(&id, &planID, &se.Seq, &sd, &se.AmountDue, &se.Status, &se.Procedure, &se.Tooth, &se.Notes, &se.Rx, &se.PayLater, &se.PayLaterNote, &se.Payment); e != nil {
			return nil, e
		}
		se.ID = id
		se.ScheduledDate = sd.Format("2006-01-02")
		se.Images = []dental.Image{}
		pi, ok := idx[planID]
		if !ok {
			continue
		}
		plans[pi].Sessions = append(plans[pi].Sessions, se)
		sidx[id] = [2]int{pi, len(plans[pi].Sessions) - 1}
	}
	if e := srows.Err(); e != nil {
		return nil, e
	}

	// per-session images
	irows, e := tx.Query(ctx,
		`SELECT id, treatment_session_id, coalesce(image_category,''), storage_key, filename, mime_type, size_bytes, created_at
		 FROM attachments
		 WHERE tenant_id = $1 AND patient_id = $2 AND type = 'image' AND deleted_at IS NULL AND treatment_session_id IS NOT NULL
		 ORDER BY created_at DESC`, tid, patientID)
	if e != nil {
		return nil, e
	}
	defer irows.Close()
	for irows.Next() {
		var im dental.Image
		var sess *uuid.UUID
		var created time.Time
		if e := irows.Scan(&im.ID, &sess, &im.Category, &im.StorageKey, &im.Filename, &im.MimeType, &im.SizeBytes, &created); e != nil {
			return nil, e
		}
		if sess == nil {
			continue
		}
		loc, ok := sidx[*sess]
		if !ok {
			continue
		}
		im.URL = s.store.URL(im.StorageKey)
		im.CreatedAt = created.Format(time.RFC3339)
		plans[loc[0]].Sessions[loc[1]].Images = append(plans[loc[0]].Sessions[loc[1]].Images, im)
	}
	if e := irows.Err(); e != nil {
		return nil, e
	}

	// per-session prescriptions (+ their medication lines)
	pidx := map[uuid.UUID][3]int{} // prescription id → (plan idx, session idx, prescription idx)
	rxrows, e := tx.Query(ctx,
		`SELECT id, session_id, coalesce(note,''), created_at
		 FROM dental_prescriptions WHERE tenant_id = $1 AND patient_id = $2 ORDER BY created_at`, tid, patientID)
	if e != nil {
		return nil, e
	}
	defer rxrows.Close()
	for rxrows.Next() {
		var rx dental.Prescription
		var id, sess uuid.UUID
		var created time.Time
		if e := rxrows.Scan(&id, &sess, &rx.Note, &created); e != nil {
			return nil, e
		}
		loc, ok := sidx[sess]
		if !ok {
			continue
		}
		rx.ID = id
		rx.CreatedAt = created.Format(time.RFC3339)
		rx.Items = []dental.RxItem{}
		se := &plans[loc[0]].Sessions[loc[1]]
		se.Prescriptions = append(se.Prescriptions, rx)
		pidx[id] = [3]int{loc[0], loc[1], len(se.Prescriptions) - 1}
	}
	if e := rxrows.Err(); e != nil {
		return nil, e
	}
	if len(pidx) > 0 {
		irows2, e := tx.Query(ctx,
			`SELECT i.prescription_id, i.drug_name, coalesce(i.dose,''), coalesce(i.frequency,''), coalesce(i.duration,''), coalesce(i.instructions,'')
			 FROM dental_prescription_items i JOIN dental_prescriptions p ON p.id = i.prescription_id AND p.tenant_id = i.tenant_id
			 WHERE i.tenant_id = $1 AND p.patient_id = $2 ORDER BY i.prescription_id, i.seq`, tid, patientID)
		if e != nil {
			return nil, e
		}
		defer irows2.Close()
		for irows2.Next() {
			var rxID uuid.UUID
			var it dental.RxItem
			if e := irows2.Scan(&rxID, &it.DrugName, &it.Dose, &it.Frequency, &it.Duration, &it.Instructions); e != nil {
				return nil, e
			}
			loc, ok := pidx[rxID]
			if !ok {
				continue
			}
			p := &plans[loc[0]].Sessions[loc[1]].Prescriptions[loc[2]]
			p.Items = append(p.Items, it)
		}
		if e := irows2.Err(); e != nil {
			return nil, e
		}
	}
	return plans, nil
}

func (s *Service) ListPlans(ctx context.Context, patientID uuid.UUID) ([]dental.Plan, error) {
	tid, _ := actorOf(ctx)
	var out []dental.Plan
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		p, e := s.loadPlansTx(ctx, tx, tid, patientID)
		out = p
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreatePlan(ctx context.Context, patientID uuid.UUID, in dental.PlanInput) (*dental.Plan, error) {
	tid, actor := actorOf(ctx)
	title := in.Title
	if title == "" {
		return nil, apperr.Validation("a treatment name is required")
	}
	start, e := time.Parse("2006-01-02", in.StartDate)
	if e != nil {
		return nil, apperr.Validation("start date must be YYYY-MM-DD")
	}
	unit := in.IntervalUnit
	if unit != "day" && unit != "week" && unit != "month" {
		unit = "month"
	}
	interval := in.IntervalCount
	if interval < 1 {
		interval = 1
	}

	// Resolve the concrete sessions: the create preview sends them, otherwise
	// generate from the schedule and split the total.
	type seed struct {
		date time.Time
		amt  float64
	}
	var seeds []seed
	if len(in.Sessions) > 0 {
		for _, ss := range in.Sessions {
			d, e := time.Parse("2006-01-02", ss.ScheduledDate)
			if e != nil {
				return nil, apperr.Validation("session date must be YYYY-MM-DD")
			}
			seeds = append(seeds, seed{date: d, amt: money(ss.AmountDue)})
		}
	} else {
		n := in.SessionCount
		if n < 1 {
			n = 1
		}
		dates := genDates(start, unit, interval, n)
		amts := splitAmount(money(in.TotalAmount), n)
		for i := 0; i < n; i++ {
			seeds = append(seeds, seed{date: dates[i], amt: amts[i]})
		}
	}
	count := len(seeds)
	deadline := seeds[count-1].date
	// The stored total reflects the sessions (which the operator may have edited).
	total := 0.0
	for _, sd := range seeds {
		total += sd.amt
	}
	if money(in.TotalAmount) > 0 && len(in.Sessions) == 0 {
		total = money(in.TotalAmount)
	}

	var planID uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO treatment_plans (tenant_id, patient_id, title, tooth, total_amount, start_date, interval_unit, interval_count, session_count, deadline, note, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
			tid, patientID, title, nullStr(in.Tooth), fmtMoney(total), start.Format("2006-01-02"), unit, interval, count,
			deadline.Format("2006-01-02"), nullStr(in.Note), actor).Scan(&planID); e != nil {
			return e
		}
		for i, sd := range seeds {
			if _, e := tx.Exec(ctx,
				`INSERT INTO treatment_sessions (tenant_id, plan_id, patient_id, seq, scheduled_date, amount_due, created_by)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				tid, planID, patientID, i+1, sd.date.Format("2006-01-02"), fmtMoney(sd.amt), actor); e != nil {
				return e
			}
		}
		return s.publisher.Publish(ctx, tx, &tid, "treatment_plan", planID, "dental.plan.created",
			map[string]any{"patient_id": patientID, "title": title, "total": fmtMoney(total), "sessions": count})
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	// Return the freshly-built plan.
	var out *dental.Plan
	if e := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		plans, e := s.loadPlansTx(ctx, tx, tid, patientID)
		if e != nil {
			return e
		}
		for i := range plans {
			if plans[i].ID == planID {
				out = &plans[i]
			}
		}
		return nil
	}); e != nil {
		return nil, apperr.Internal(e)
	}
	return out, nil
}

func (s *Service) UpdatePlan(ctx context.Context, patientID, planID uuid.UUID, in dental.PlanUpdate) error {
	tid, _ := actorOf(ctx)
	if in.Status != nil && *in.Status != "active" && *in.Status != "completed" && *in.Status != "cancelled" {
		return apperr.Validation("invalid plan status")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE treatment_plans SET
			   title = COALESCE($3, title),
			   tooth = COALESCE($4, tooth),
			   note = COALESCE($5, note),
			   status = COALESCE($6, status),
			   updated_at = now()
			 WHERE tenant_id = $1 AND patient_id = $2 AND id = $7`,
			tid, patientID, in.Title, in.Tooth, in.Note, in.Status, planID)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("PLAN_NOT_FOUND", "treatment plan not found")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) DeletePlan(ctx context.Context, patientID, planID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Deleting a plan cascades its sessions out of existence. Every other path
		// guards money carefully; this one bypassed all of them, so a plan carrying a
		// paid, queued or refunded charge could be erased and the debt — or the record
		// of what the payment was FOR — would simply stop existing, with no event.
		var live int
		if e := tx.QueryRow(ctx,
			`SELECT count(*) FROM treatment_sessions se
			 JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
			 WHERE se.tenant_id = $1 AND se.plan_id = $2 AND c.status IN ('pending','paid','waived')`,
			tid, planID).Scan(&live); e != nil {
			return e
		}
		if live > 0 {
			return apperr.Conflict("PLAN_HAS_CHARGES",
				"this plan has sessions that were billed, paid or written off — cancel the plan instead of deleting it, so the money stays accounted for")
		}
		ct, e := tx.Exec(ctx, `DELETE FROM treatment_plans WHERE tenant_id = $1 AND patient_id = $2 AND id = $3`, tid, patientID, planID)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("PLAN_NOT_FOUND", "treatment plan not found")
		}
		return s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.plan.deleted",
			map[string]any{"patient_id": patientID, "plan_id": planID})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) UpdateSession(ctx context.Context, patientID, sessionID uuid.UUID, in dental.SessionUpdate) error {
	tid, _ := actorOf(ctx)
	if in.Status != "" && !validSessionStatus[in.Status] {
		return apperr.Validation("invalid session status")
	}
	var datePtr *string
	if in.ScheduledDate != "" {
		if _, e := time.Parse("2006-01-02", in.ScheduledDate); e != nil {
			return apperr.Validation("date must be YYYY-MM-DD")
		}
		datePtr = &in.ScheduledDate
	}
	var amtPtr *string
	if in.AmountDue != "" {
		a := fmtMoney(money(in.AmountDue))
		amtPtr = &a
	}
	_, actor := actorOf(ctx)
	branch := activeBranchOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// The fee is frozen once a charge is live. Without this a session billed and
		// paid at 2,000 could afterwards be edited to 5,000 while the receipt still
		// says 2,000, and the two never reconcile. Deliberately narrow: only the
		// AMOUNT is refused, because blocking the whole update would stop the dentist
		// writing clinical notes on a visit the desk has already billed — which is
		// the exact ordering phase 3 removed.
		if amtPtr != nil {
			var live bool
			if e := tx.QueryRow(ctx,
				`SELECT EXISTS (SELECT 1 FROM treatment_sessions se
				                JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id
				                WHERE se.tenant_id = $1 AND se.id = $2 AND c.deleted_at IS NULL
				                  AND c.status IN ('pending','paid','waived'))`,
				tid, sessionID).Scan(&live); e != nil {
				return e
			}
			if live {
				return apperr.Conflict("SESSION_ALREADY_BILLED",
					"this session's fee has already been billed — undo the charge first, or adjust it from the cashier")
			}
		}
		ct, e := tx.Exec(ctx,
			`UPDATE treatment_sessions SET
			   scheduled_date = COALESCE($3::date, scheduled_date),
			   amount_due = COALESCE($4::numeric, amount_due),
			   status = COALESCE(NULLIF($5,''), status),
			   procedure = COALESCE($6, procedure),
			   tooth = COALESCE($7, tooth),
			   notes = COALESCE($8, notes),
			   rx = COALESCE($9, rx),
			   -- Stamped on the TRANSITION into done, never on a re-save. The record form
			   -- re-sends status='done' every time a note is edited, and a session that
			   -- predates this column has completed_at NULL — so a COALESCE here stamped
			   -- today on the whole existing backlog and reset the report's ageing to zero
			   -- the moment anyone fixed a typo.
			   completed_at = CASE WHEN $5 = 'done' AND status <> 'done' THEN now() ELSE completed_at END,
			   completed_by = CASE WHEN $5 = 'done' AND status <> 'done' THEN $11    ELSE completed_by END,
			   branch_id    = CASE WHEN $5 = 'done' AND status <> 'done' THEN $12    ELSE branch_id END,
			   updated_at = now()
			 WHERE tenant_id = $1 AND patient_id = $2 AND id = $10`,
			tid, patientID, datePtr, amtPtr, in.Status, in.Procedure, in.Tooth, in.Notes, in.Rx, sessionID, actor, branch)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// CollectSession raises the session's amount as a pending dental charge (→ cashier).
// RescheduleSession moves a still-planned session to another date.
//
// Deliberately much narrower than UpdateSession: the front desk may change WHEN a
// session happens, never WHAT it is. Procedure, tooth, notes, Rx and the amount
// stay with the dentist. Keeping this a separate method (rather than a field-level
// check inside UpdateSession) is what makes that boundary enforceable instead of a
// convention someone can forget to re-apply.
func (s *Service) RescheduleSession(ctx context.Context, patientID, sessionID uuid.UUID, date string) error {
	tid, actor := actorOf(ctx)
	if _, e := time.Parse("2006-01-02", date); e != nil {
		return apperr.Validation("date must be YYYY-MM-DD")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var was, status string
		if e := tx.QueryRow(ctx,
			`SELECT scheduled_date::text, status FROM treatment_sessions
			  WHERE tenant_id = $1 AND patient_id = $2 AND id = $3 FOR UPDATE`,
			tid, patientID, sessionID).Scan(&was, &status); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
			}
			return e
		}
		// Only a session that hasn't happened yet may move. Redating a completed
		// session would rewrite the clinical record, which is exactly what this
		// narrower permission is meant to prevent.
		if status != "planned" {
			return apperr.Validation("only a planned session can be rescheduled")
		}
		if was == date {
			return nil // no-op — don't write a misleading audit event
		}
		if _, e := tx.Exec(ctx,
			`UPDATE treatment_sessions SET scheduled_date = $4::date, updated_at = now()
			  WHERE tenant_id = $1 AND patient_id = $2 AND id = $3`,
			tid, patientID, sessionID, date); e != nil {
			return e
		}
		// event_outbox has no actor column, so the actor goes in the payload. Other
		// dental events omit it; here it matters, because a dentist finding their
		// session moved needs to see who moved it.
		return s.publisher.Publish(ctx, tx, &tid, "treatment_session", sessionID, "dental.session.rescheduled",
			map[string]any{"patient_id": patientID, "session_id": sessionID, "from": was, "to": date, "by": actor})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) CollectSession(ctx context.Context, patientID, sessionID uuid.UUID) error {
	_, err := s.collectOne(ctx, patientID, sessionID)
	return err
}

// collectOne bills a single session and returns the amount charged. Shared by the
// single and bulk paths so the money logic exists exactly once.
func (s *Service) collectOne(ctx context.Context, patientID, sessionID uuid.UUID) (float64, error) {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	var charged float64
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var amount, planTitle string
		var seq, count int
		var chargeStatus *string
		var refunded *string
		// FOR UPDATE on the session row. Without it two clicks on Collect both read
		// "no charge", both call RaiseChargeTx, and the patient is billed twice for one
		// visit — the guard below is a check-then-act and cannot serialise itself.
		// deleted_at is honoured here too, so this agrees with sessionMoneyCTE instead
		// of treating a soft-deleted charge as live.
		var treatedAt *uuid.UUID
		e := tx.QueryRow(ctx,
			`SELECT se.amount_due::text, se.seq, p.title, p.session_count, c.status,
			        (SELECT sum(-r.amount)::text FROM charges r
			          WHERE r.tenant_id = c.tenant_id AND r.reverses_charge_id = c.id AND r.deleted_at IS NULL),
			        se.branch_id
			 FROM treatment_sessions se
			 JOIN treatment_plans p ON p.id = se.plan_id AND p.tenant_id = se.tenant_id
			 LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
			 WHERE se.tenant_id = $1 AND se.patient_id = $2 AND se.id = $3
			 FOR UPDATE OF se`,
			tid, patientID, sessionID).Scan(&amount, &seq, &planTitle, &count, &chargeStatus, &refunded, &treatedAt)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
		}
		if e != nil {
			return e
		}
		// A refunded charge stays 'paid' forever — that is the audit trail. Judging by
		// status alone made a refunded session permanently un-billable while every
		// other surface declared it owed, so the report's "Bill again" button could
		// not work and the only workaround double-charged the patient.
		wasRefunded := chargeStatus != nil && *chargeStatus == "paid" && refunded != nil
		if chargeStatus != nil && !wasRefunded {
			switch *chargeStatus {
			case "pending", "paid":
				return apperr.Conflict("SESSION_ALREADY_BILLED", "this session is already sent to the cashier or paid")
			case "waived":
				// 'waived' used to fall through this guard, so bulk collect raised a SECOND
				// charge for a fee the clinic had formally forgiven — and the waived row
				// became unreachable from the session, losing the record of who forgave it.
				return apperr.Conflict("SESSION_WAIVED", "this session was written off — reverse the write-off before billing it again")
			}
		}
		amt := money(amount)
		// Re-bill what was actually given back, not the planned fee: a partial refund
		// owes the refunded part, and amount_due may have drifted before it was frozen.
		if wasRefunded {
			amt = money(*refunded)
		}
		if amt <= 0 {
			return apperr.Validation("set an amount for this session before collecting")
		}
		// The revenue belongs to the branch that DID the treatment. Billing from the
		// clinic-wide report otherwise books it wherever the person clicking happens to
		// be signed in, quietly moving money between branches' books.
		bookTo := br
		if treatedAt != nil {
			bookTo = treatedAt
		}
		cid, e := s.billing.RaiseChargeTx(ctx, tx, billing.ChargeInput{
			PatientID: patientID, BranchID: bookTo, Source: "dental",
			Description: fmt.Sprintf("%s — session %d/%d", planTitle, seq, count), Amount: fmtMoney(amt),
		})
		if e != nil {
			return e
		}
		// Re-points the session at the new charge. The refunded original keeps its own
		// row and its reversal, so the history stays intact and readable.
		if _, e := tx.Exec(ctx, `UPDATE treatment_sessions SET charge_id = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3`, cid, tid, sessionID); e != nil {
			return e
		}
		charged = amt
		return s.publisher.Publish(ctx, tx, &tid, "charge", cid, "dental.charge.raised",
			map[string]any{"patient_id": patientID, "session_id": sessionID, "amount": fmtMoney(amt)})
	})
	if ae, ok := apperr.As(err); ok {
		return 0, ae
	}
	if err != nil {
		return 0, apperr.Internal(err)
	}
	return charged, nil
}

// CollectSessions bills several of a patient's sessions at once — the front desk
// taking payment for a whole treatment plan without involving the dentist. Each
// session is billed in its own transaction, so one failure doesn't undo the rest;
// sessions already at the cashier or paid are skipped silently. An empty id list
// means "everything still outstanding".
func (s *Service) CollectSessions(ctx context.Context, patientID uuid.UUID, sessionIDs []uuid.UUID) (int, string, error) {
	tid, _ := actorOf(ctx)
	var targets []uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Only sessions that are live, unbilled and actually worth money.
		q := `SELECT se.id
		      FROM treatment_sessions se
		      JOIN treatment_plans p ON p.id = se.plan_id AND p.tenant_id = se.tenant_id
		      LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id
		      WHERE se.tenant_id = $1 AND se.patient_id = $2
		        AND se.status <> 'cancelled' AND p.status <> 'cancelled'
		        AND se.amount_due > 0
		        AND (c.status IS NULL OR c.status NOT IN ('pending','paid','waived')
		             OR (c.status = 'paid' AND EXISTS (SELECT 1 FROM charges r
		                   WHERE r.tenant_id = c.tenant_id AND r.reverses_charge_id = c.id
		                     AND r.deleted_at IS NULL)))`
		args := []any{tid, patientID}
		if len(sessionIDs) > 0 {
			q += ` AND se.id = ANY($3)`
			args = append(args, sessionIDs)
		}
		q += ` ORDER BY se.scheduled_date, se.seq`
		rows, e := tx.Query(ctx, q, args...)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			if e := rows.Scan(&id); e != nil {
				return e
			}
			targets = append(targets, id)
		}
		return rows.Err()
	})
	if err != nil {
		return 0, "0.00", apperr.Internal(err)
	}
	if len(targets) == 0 {
		return 0, "0.00", apperr.Conflict("NOTHING_TO_COLLECT", "there are no unbilled sessions to collect for this patient")
	}
	billed, total := 0, 0.0
	for _, id := range targets {
		amt, e := s.collectOne(ctx, patientID, id)
		if e != nil {
			continue // already billed by someone else mid-run, or a bad row — keep going
		}
		billed++
		total += amt
	}
	if billed == 0 {
		return 0, "0.00", apperr.Conflict("NOTHING_TO_COLLECT", "those sessions could not be billed")
	}
	return billed, fmtMoney(total), nil
}

// WriteOffSession records that this treatment will deliberately not be charged for.
//
// Implemented as raise-then-waive in one transaction rather than by simply never
// billing, because the two look identical in the data and mean opposite things: one
// is a decision, the other is an oversight. Waiving leaves a real charge row with a
// reason, a person and a timestamp, so the report stops chasing it and the clinic can
// still answer "why did we not charge for this?" a year later.
func (s *Service) WriteOffSession(ctx context.Context, patientID, sessionID uuid.UUID, reason string) error {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return apperr.Validation("say why this is not being charged for — it is recorded on the write-off")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var amount, planTitle string
		var seq, count int
		var chargeStatus *string
		var treatedAt *uuid.UUID
		e := tx.QueryRow(ctx,
			`SELECT se.amount_due::text, se.seq, p.title, p.session_count, c.status, se.branch_id
			 FROM treatment_sessions se
			 JOIN treatment_plans p ON p.id = se.plan_id AND p.tenant_id = se.tenant_id
			 LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
			 WHERE se.tenant_id = $1 AND se.patient_id = $2 AND se.id = $3
			 FOR UPDATE OF se`,
			tid, patientID, sessionID).Scan(&amount, &seq, &planTitle, &count, &chargeStatus, &treatedAt)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
		}
		if e != nil {
			return e
		}
		if chargeStatus != nil {
			switch *chargeStatus {
			case "paid":
				return apperr.Conflict("SESSION_PAID", "this session has been paid — refund it from the cashier instead of writing it off")
			case "waived":
				return apperr.Conflict("ALREADY_WAIVED", "this session is already written off")
			case "pending":
				// Already with the cashier: waive that charge rather than raising a second.
				if e := s.billing.WaiveChargeTx(ctx, tx, *chargeIDOf(ctx, tx, tid, sessionID), reason); e != nil {
					return e
				}
				return s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.session.written_off",
					map[string]any{"patient_id": patientID, "session_id": sessionID, "reason": reason})
			}
		}
		bookTo := br
		if treatedAt != nil {
			bookTo = treatedAt
		}
		cid, e := s.billing.RaiseChargeTx(ctx, tx, billing.ChargeInput{
			PatientID: patientID, BranchID: bookTo, Source: "dental",
			Description: fmt.Sprintf("%s — session %d/%d (written off)", planTitle, seq, count),
			Amount:      fmtMoney(money(amount)),
		})
		if e != nil {
			return e
		}
		if e := s.billing.WaiveChargeTx(ctx, tx, cid, reason); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx,
			`UPDATE treatment_sessions SET charge_id = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3`,
			cid, tid, sessionID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tid, "charge", cid, "dental.session.written_off",
			map[string]any{"patient_id": patientID, "session_id": sessionID, "reason": reason, "amount": amount})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// chargeIDOf reads the session's currently linked charge inside an open tx.
func chargeIDOf(ctx context.Context, tx pgx.Tx, tid, sessionID uuid.UUID) *uuid.UUID {
	var id *uuid.UUID
	_ = tx.QueryRow(ctx, `SELECT charge_id FROM treatment_sessions WHERE tenant_id = $1 AND id = $2`, tid, sessionID).Scan(&id)
	return id
}

// UndoWriteOff detaches a written-off charge so the session can be billed again.
//
// A write-off used to be a dead end: 'waived' blocked every billing path and nothing
// could reverse it, so a mistaken write-off was permanent. The waived charge is kept
// — it is the record of the decision — and the session is simply unlinked from it.
func (s *Service) UndoWriteOff(ctx context.Context, patientID, sessionID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var chargeID *uuid.UUID
		var chargeStatus *string
		e := tx.QueryRow(ctx,
			`SELECT se.charge_id, c.status
			 FROM treatment_sessions se
			 LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
			 WHERE se.tenant_id = $1 AND se.patient_id = $2 AND se.id = $3
			 FOR UPDATE OF se`, tid, patientID, sessionID).Scan(&chargeID, &chargeStatus)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
		}
		if e != nil {
			return e
		}
		if chargeID == nil || chargeStatus == nil || *chargeStatus != "waived" {
			return apperr.Conflict("NOT_WAIVED", "this session is not written off")
		}
		if _, e := tx.Exec(ctx,
			`UPDATE treatment_sessions SET charge_id = NULL, updated_at = now()
			 WHERE tenant_id = $1 AND id = $2 AND charge_id = $3`, tid, sessionID, chargeID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tid, "charge", *chargeID, "dental.session.write_off_undone",
			map[string]any{"patient_id": patientID, "session_id": sessionID})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// UncollectSession reverses a mistaken collect: voids the still-pending charge (so
// the cashier can no longer settle it) and detaches it, returning the session to unpaid.
func (s *Service) UncollectSession(ctx context.Context, patientID, sessionID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var chargeID *uuid.UUID
		var chargeStatus *string
		e := tx.QueryRow(ctx,
			`SELECT se.charge_id, c.status
			 FROM treatment_sessions se
			 LEFT JOIN charges c ON c.id = se.charge_id AND c.tenant_id = se.tenant_id
			 WHERE se.tenant_id = $1 AND se.patient_id = $2 AND se.id = $3`,
			tid, patientID, sessionID).Scan(&chargeID, &chargeStatus)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
		}
		if e != nil {
			return e
		}
		if chargeID == nil || chargeStatus == nil {
			return apperr.Conflict("NOTHING_TO_REVERSE", "this session has nothing at the cashier to reverse")
		}
		if *chargeStatus != "pending" {
			return apperr.Conflict("NOT_PENDING", "only a charge still waiting at the cashier can be reversed")
		}
		if e := s.billing.VoidChargeTx(ctx, tx, *chargeID, "reversed by clinician (mistaken collect)"); e != nil {
			return e
		}
		// Scoped to the charge we just voided. A blanket NULL could clear a link that a
		// concurrent collect had already replaced, orphaning a live pending charge that
		// no session points at — money on the cashier's queue belonging to nobody.
		if _, e := tx.Exec(ctx, `UPDATE treatment_sessions SET charge_id = NULL, updated_at = now()
			 WHERE tenant_id = $1 AND id = $2 AND charge_id = $3`, tid, sessionID, chargeID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tid, "charge", *chargeID, "dental.charge.reversed",
			map[string]any{"patient_id": patientID, "session_id": sessionID})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// SetPayLater flags (on) or clears (off) a session as service-rendered on a promise
// to pay later — the doctor's deliberate bypass of up-front collection.
func (s *Service) SetPayLater(ctx context.Context, patientID, sessionID uuid.UUID, on bool, note string) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE treatment_sessions
			 SET pay_later = $3, pay_later_note = CASE WHEN $3 THEN $4 ELSE NULL END, updated_at = now()
			 WHERE tenant_id = $1 AND patient_id = $2 AND id = $5`,
			tid, patientID, on, nullStr(note), sessionID)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- prescriptions (printable, per session) ---

func (s *Service) AddPrescription(ctx context.Context, patientID, sessionID uuid.UUID, in dental.PrescriptionInput) (*dental.Prescription, error) {
	tid, actor := actorOf(ctx)
	items := make([]dental.RxItem, 0, len(in.Items))
	for _, it := range in.Items {
		if it.DrugName == "" {
			continue
		}
		items = append(items, dental.RxItem{DrugName: it.DrugName, Dose: it.Dose, Frequency: it.Frequency, Duration: it.Duration, Instructions: it.Instructions})
	}
	if len(items) == 0 {
		return nil, apperr.Validation("add at least one medication")
	}
	out := &dental.Prescription{Note: in.Note, Items: items}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Confirm the session belongs to this patient/tenant (RLS enforces tenant).
		var exists bool
		if e := tx.QueryRow(ctx, `SELECT true FROM treatment_sessions WHERE tenant_id = $1 AND patient_id = $2 AND id = $3`, tid, patientID, sessionID).Scan(&exists); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.NotFound("SESSION_NOT_FOUND", "session not found")
			}
			return e
		}
		var id uuid.UUID
		var created time.Time
		if e := tx.QueryRow(ctx,
			`INSERT INTO dental_prescriptions (tenant_id, session_id, patient_id, note, created_by)
			 VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
			tid, sessionID, patientID, nullStr(in.Note), actor).Scan(&id, &created); e != nil {
			return e
		}
		for i, it := range items {
			if _, e := tx.Exec(ctx,
				`INSERT INTO dental_prescription_items (tenant_id, prescription_id, seq, drug_name, dose, frequency, duration, instructions)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				tid, id, i+1, it.DrugName, nullStr(it.Dose), nullStr(it.Frequency), nullStr(it.Duration), nullStr(it.Instructions)); e != nil {
				return e
			}
		}
		out.ID = id
		out.CreatedAt = created.Format(time.RFC3339)
		return s.publisher.Publish(ctx, tx, &tid, "dental_prescription", id, "dental.prescription.created",
			map[string]any{"patient_id": patientID, "session_id": sessionID, "items": len(items)})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) DeletePrescription(ctx context.Context, patientID, prescriptionID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx, `DELETE FROM dental_prescriptions WHERE tenant_id = $1 AND patient_id = $2 AND id = $3`, tid, patientID, prescriptionID)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("PRESCRIPTION_NOT_FOUND", "prescription not found")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// sessionMoneyCTE is the ONE place dental decides what a session's charge means.
//
// Five surfaces used to each reduce treatment_sessions.amount_due — the plan's
// INTENT — and call the result money, while charges.amount, the actual money, was
// read in a single query. They drifted, and after a refund they contradicted each
// other on one screen. The balance, the per-plan strip, the outstanding list and
// the unbilled report all now select from this, so they cannot disagree again.
//
// Two things it gets right that the old joins did not:
//
//	deleted_at — every billing query filters it and none of the seven dental joins
//	did, so one soft-deleted charge kept a session reading "paid" forever.
//
//	refunds — a refund is a SEPARATE negative row carrying reverses_charge_id, and
//	the original is deliberately left 'paid' for the audit trail. Judging by the
//	original's status alone therefore reports a refunded session as fully collected,
//	which is how a clinic hands back 6,000 ETB and never re-bills it.
//
// $1 is always tenant_id.
const sessionMoneyCTE = `
WITH session_charge AS (
  SELECT se.id AS session_id,
         se.tenant_id, se.plan_id, se.patient_id, se.seq,
         se.scheduled_date,
         se.status AS session_status,
         se.pay_later,
         coalesce(se.pay_later_note,'') AS pay_later_note,
         coalesce(se.procedure,'')      AS procedure,
         coalesce(se.tooth,'')          AS tooth,
         se.amount_due,
         se.completed_at, se.completed_by, se.branch_id,
         c.id AS charge_id, c.status AS charge_status, c.amount AS charge_amount,
         rev.refunded_amount
  FROM treatment_sessions se
  LEFT JOIN charges c
         ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
  LEFT JOIN LATERAL (
        SELECT sum(-r.amount) AS refunded_amount
        FROM charges r
        WHERE r.tenant_id = c.tenant_id AND r.reverses_charge_id = c.id AND r.deleted_at IS NULL
  ) rev ON true
  WHERE se.tenant_id = $1
),
session_money AS (
  SELECT sc.*,
         -- Treatment actually happened. pay_later alone does NOT count: before the
         -- billing gate was removed it was the mechanism for unlocking the record
         -- form, so promises exist on sessions that were never delivered.
         (sc.session_status = 'done') AS delivered,
         (sc.pay_later AND sc.session_status <> 'done') AS promised_undelivered,
         CASE
           WHEN sc.charge_id IS NULL           THEN 'unpaid'
           WHEN sc.charge_status = 'void'      THEN 'unpaid'
           WHEN sc.charge_status = 'pending'   THEN 'billed'
           WHEN sc.charge_status = 'waived'    THEN 'waived'
           WHEN sc.refunded_amount IS NOT NULL THEN 'refunded'
           ELSE 'paid'
         END AS pay_state,
         CASE WHEN sc.charge_status = 'paid'
              THEN sc.charge_amount - coalesce(sc.refunded_amount, 0)
              ELSE 0 END AS net_paid,
         CASE WHEN sc.charge_status = 'paid' AND sc.refunded_amount IS NOT NULL
              THEN sc.refunded_amount
              ELSE sc.amount_due END AS owed_amount
  FROM session_charge sc
)`

// --- summary + balance ---

// balanceTx answers the money questions from the shared projection, in one query.
//
//	owed        every non-cancelled session's planned fee (the course's total cost)
//	paid        money actually retained — settled minus refunded
//	at_cashier  raised and queued; deliberately NOT part of `due`, because counting
//	            it there is what made the desk ask patients for money they had just
//	            been sent to pay
//	due         the actionable debt: treatment DELIVERED, nothing live at the
//	            cashier. Includes refunded (the clinic gave the money back, so the
//	            treatment is owed again) and excludes waived (formally forgiven).
func (s *Service) balanceTx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID) (dental.Balance, error) {
	var owed, paid, atCashier, due, waived string
	err := tx.QueryRow(ctx, sessionMoneyCTE+`,
scoped AS (
  SELECT sm.*, (sm.session_status <> 'cancelled' AND pl.status <> 'cancelled') AS alive
  FROM session_money sm
  JOIN treatment_plans pl ON pl.id = sm.plan_id AND pl.tenant_id = sm.tenant_id
  WHERE sm.patient_id = $2
)
SELECT coalesce(sum(amount_due)    FILTER (WHERE alive AND pay_state <> 'waived'), 0)::text,
       -- Deliberately NOT gated on alive: money the patient actually handed over does
       -- not stop having been paid because the session or plan was later cancelled.
       -- Gating it made settled cash vanish from the card and pushed Remaining negative.
       coalesce(sum(net_paid), 0)::text,
       coalesce(sum(charge_amount) FILTER (WHERE alive AND pay_state = 'billed'), 0)::text,
       coalesce(sum(owed_amount)   FILTER (WHERE alive AND delivered
                                             AND pay_state IN ('unpaid','refunded')), 0)::text,
       coalesce(sum(amount_due)    FILTER (WHERE alive AND pay_state = 'waived'), 0)::text
FROM scoped`, tid, patientID).Scan(&owed, &paid, &atCashier, &due, &waived)
	if err != nil {
		return dental.Balance{}, err
	}
	return dental.Balance{
		Owed: fmtMoney(money(owed)), Paid: fmtMoney(money(paid)),
		Balance:   fmtMoney(money(owed) - money(paid)),
		AtCashier: fmtMoney(money(atCashier)), Waived: fmtMoney(money(waived)),
		Due: fmtMoney(money(due)), Overdue: money(due) > 0.005,
	}, nil
}

func (s *Service) Summary(ctx context.Context, patientID uuid.UUID) (*dental.Summary, error) {
	tid, _ := actorOf(ctx)
	sum := &dental.Summary{Chart: dental.Chart{Teeth: map[string]string{}}, Plans: []dental.Plan{}}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := s.loadChartTx(ctx, tx, tid, patientID, &sum.Chart); e != nil {
			return e
		}
		plans, e := s.loadPlansTx(ctx, tx, tid, patientID)
		if e != nil {
			return e
		}
		sum.Plans = plans
		bal, e := s.balanceTx(ctx, tx, tid, patientID)
		if e != nil {
			return e
		}
		sum.Balance = bal
		l, e := limits.Effective(ctx, tx, tid)
		if e != nil {
			return e
		}
		sum.ImageLimit = -1
		if l.ImagesPerPatient != nil {
			sum.ImageLimit = int(*l.ImagesPerPatient)
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return sum, nil
}

// --- Examinations -----------------------------------------------------------
//
// The clinical assessment behind the treatment: chief complaint, examination
// findings, investigations, diagnosis. Stored per visit rather than per session —
// see 00046 for why. The multi-select findings are JSONB arrays of frontend-owned
// option keys, so the questionnaire can grow without a migration.

const examCols = `e.id, e.session_id, e.visit_date, coalesce(e.chief_complaint,''), coalesce(e.hpi,''),
	coalesce(e.past_dental_history,''), e.extraoral, coalesce(e.extraoral_notes,''), e.intraoral,
	coalesce(e.intraoral_notes,''), e.investigations, coalesce(e.investigation_results,''),
	coalesce(e.diagnosis,''), coalesce(e.treatment_plan,''), e.treatment_given,
	coalesce(e.anaesthesia,''), coalesce(e.complications,''), e.procedures, coalesce(e.postop,''),
	coalesce(u.full_name,''), e.created_at, e.updated_at`

func scanExam(row pgx.Row) (dental.Exam, error) {
	var ex dental.Exam
	var visitDate, created, updated time.Time
	var extraoral, intraoral, investigations, treatmentGiven, procedures []byte
	err := row.Scan(&ex.ID, &ex.SessionID, &visitDate, &ex.ChiefComplaint, &ex.HPI,
		&ex.PastDentalHistory, &extraoral, &ex.ExtraoralNotes, &intraoral,
		&ex.IntraoralNotes, &investigations, &ex.InvestigationResults,
		&ex.Diagnosis, &ex.TreatmentPlan, &treatmentGiven,
		&ex.Anaesthesia, &ex.Complications, &procedures, &ex.Postop,
		&ex.RecordedBy, &created, &updated)
	if err != nil {
		return ex, err
	}
	ex.VisitDate = visitDate.Format("2006-01-02")
	ex.CreatedAt = created.Format(time.RFC3339)
	ex.UpdatedAt = updated.Format(time.RFC3339)
	ex.Extraoral = decodeKeys(extraoral)
	ex.Intraoral = decodeKeys(intraoral)
	ex.Investigations = decodeKeys(investigations)
	ex.TreatmentGiven = decodeKeys(treatmentGiven)
	ex.Procedures = []dental.ExamProcedure{}
	if len(procedures) > 0 {
		_ = json.Unmarshal(procedures, &ex.Procedures)
		if ex.Procedures == nil {
			ex.Procedures = []dental.ExamProcedure{}
		}
	}
	return ex, nil
}

// decodeKeys reads a JSONB array of option keys, always returning a non-nil slice
// so the JSON response carries [] rather than null.
func decodeKeys(raw []byte) []string {
	out := []string{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
		if out == nil {
			out = []string{}
		}
	}
	return out
}

// encodeKeys marshals a selection list, dropping blanks so an empty checkbox group
// stores [] rather than [""].
func encodeKeys(in []string) []byte {
	out := []string{}
	for _, v := range in {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	b, _ := json.Marshal(out)
	return b
}

// validateExam normalises and checks the one field that must be right: the date.
// Everything else is clinical free text the server has no business rejecting.
func validateExam(in *dental.ExamInput) error {
	in.VisitDate = strings.TrimSpace(in.VisitDate)
	if in.VisitDate == "" {
		return apperr.Validation("visit date is required")
	}
	if _, err := time.Parse("2006-01-02", in.VisitDate); err != nil {
		return apperr.Validation("invalid visit date")
	}
	rows := []dental.ExamProcedure{}
	for _, p := range in.Procedures {
		p.Tooth = strings.TrimSpace(p.Tooth)
		p.Procedure = strings.TrimSpace(p.Procedure)
		p.Notes = strings.TrimSpace(p.Notes)
		if p.Tooth == "" && p.Procedure == "" && p.Notes == "" {
			continue // an untouched blank row from the form
		}
		rows = append(rows, p)
	}
	in.Procedures = rows
	return nil
}

// assertSessionOwned refuses to link an examination to a session belonging to some
// other patient — the id arrives from the client, so ownership is checked, not assumed.
func assertSessionOwned(ctx context.Context, tx pgx.Tx, tid, patientID, sessionID uuid.UUID) error {
	var ok bool
	e := tx.QueryRow(ctx,
		`SELECT true FROM treatment_sessions WHERE tenant_id = $1 AND patient_id = $2 AND id = $3`,
		tid, patientID, sessionID).Scan(&ok)
	if errors.Is(e, pgx.ErrNoRows) {
		return apperr.Validation("session does not belong to this patient")
	}
	return e
}

func (s *Service) ListExams(ctx context.Context, patientID uuid.UUID) ([]dental.Exam, error) {
	tid, _ := actorOf(ctx)
	out := []dental.Exam{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT `+examCols+`
			 FROM dental_visits e
			 LEFT JOIN users u ON u.id = e.created_by AND u.tenant_id = e.tenant_id
			 WHERE e.tenant_id = $1 AND e.patient_id = $2
			 ORDER BY e.visit_date DESC, e.created_at DESC`, tid, patientID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			ex, e := scanExam(rows)
			if e != nil {
				return e
			}
			out = append(out, ex)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// getExam re-reads one examination for the response (picks up the joined author name).
func (s *Service) getExam(ctx context.Context, patientID, examID uuid.UUID) (*dental.Exam, error) {
	tid, _ := actorOf(ctx)
	var ex dental.Exam
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx,
			`SELECT `+examCols+`
			 FROM dental_visits e
			 LEFT JOIN users u ON u.id = e.created_by AND u.tenant_id = e.tenant_id
			 WHERE e.tenant_id = $1 AND e.patient_id = $2 AND e.id = $3`, tid, patientID, examID)
		got, e := scanExam(row)
		if e != nil {
			return e
		}
		ex = got
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("EXAM_NOT_FOUND", "examination not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &ex, nil
}

func (s *Service) CreateExam(ctx context.Context, patientID uuid.UUID, in dental.ExamInput) (*dental.Exam, error) {
	tid, actor := actorOf(ctx)
	if err := validateExam(&in); err != nil {
		return nil, err
	}
	procs, _ := json.Marshal(in.Procedures)
	var examID uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if in.SessionID != nil {
			if e := assertSessionOwned(ctx, tx, tid, patientID, *in.SessionID); e != nil {
				return e
			}
		}
		if e := tx.QueryRow(ctx,
			`INSERT INTO dental_visits (tenant_id, patient_id, session_id, visit_date, chief_complaint, hpi,
			   past_dental_history, extraoral, extraoral_notes, intraoral, intraoral_notes,
			   investigations, investigation_results, diagnosis, treatment_plan, treatment_given,
			   anaesthesia, complications, procedures, postop, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
			 RETURNING id`,
			tid, patientID, in.SessionID, in.VisitDate, nullStr(in.ChiefComplaint), nullStr(in.HPI),
			nullStr(in.PastDentalHistory), encodeKeys(in.Extraoral), nullStr(in.ExtraoralNotes),
			encodeKeys(in.Intraoral), nullStr(in.IntraoralNotes),
			encodeKeys(in.Investigations), nullStr(in.InvestigationResults),
			nullStr(in.Diagnosis), nullStr(in.TreatmentPlan), encodeKeys(in.TreatmentGiven),
			nullStr(in.Anaesthesia), nullStr(in.Complications), procs, nullStr(in.Postop), actor,
		).Scan(&examID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.examination.recorded",
			map[string]any{"patient_id": patientID, "visit_date": in.VisitDate})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.getExam(ctx, patientID, examID)
}

func (s *Service) UpdateExam(ctx context.Context, patientID, examID uuid.UUID, in dental.ExamInput) (*dental.Exam, error) {
	tid, _ := actorOf(ctx)
	if err := validateExam(&in); err != nil {
		return nil, err
	}
	procs, _ := json.Marshal(in.Procedures)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if in.SessionID != nil {
			if e := assertSessionOwned(ctx, tx, tid, patientID, *in.SessionID); e != nil {
				return e
			}
		}
		tag, e := tx.Exec(ctx,
			`UPDATE dental_visits SET session_id = $4, visit_date = $5, chief_complaint = $6, hpi = $7,
			   past_dental_history = $8, extraoral = $9, extraoral_notes = $10, intraoral = $11,
			   intraoral_notes = $12, investigations = $13, investigation_results = $14, diagnosis = $15,
			   treatment_plan = $16, treatment_given = $17, anaesthesia = $18, complications = $19,
			   procedures = $20, postop = $21, updated_at = now()
			 WHERE tenant_id = $1 AND patient_id = $2 AND id = $3`,
			tid, patientID, examID, in.SessionID, in.VisitDate, nullStr(in.ChiefComplaint), nullStr(in.HPI),
			nullStr(in.PastDentalHistory), encodeKeys(in.Extraoral), nullStr(in.ExtraoralNotes),
			encodeKeys(in.Intraoral), nullStr(in.IntraoralNotes),
			encodeKeys(in.Investigations), nullStr(in.InvestigationResults),
			nullStr(in.Diagnosis), nullStr(in.TreatmentPlan), encodeKeys(in.TreatmentGiven),
			nullStr(in.Anaesthesia), nullStr(in.Complications), procs, nullStr(in.Postop))
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return apperr.NotFound("EXAM_NOT_FOUND", "examination not found")
		}
		return s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.examination.updated",
			map[string]any{"patient_id": patientID, "visit_date": in.VisitDate})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.getExam(ctx, patientID, examID)
}

func (s *Service) DeleteExam(ctx context.Context, patientID, examID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx,
			`DELETE FROM dental_visits WHERE tenant_id = $1 AND patient_id = $2 AND id = $3`,
			tid, patientID, examID)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return apperr.NotFound("EXAM_NOT_FOUND", "examination not found")
		}
		return s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.examination.deleted",
			map[string]any{"patient_id": patientID})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// UnbilledTreatment: delivered treatment with no live charge against it.
//
// Three lanes, because they need three different actions and must never be summed
// into one number:
//
//	never_billed    nobody raised a charge — Collect
//	bill_withdrawn  a charge existed and the cashier voided it — Collect again
//	refunded        paid, then given back — Bill again, or write it off deliberately
//
// Deliberately NOT included: sessions flagged pay-later that were never delivered.
// Before the billing gate was removed, "pay later" was how the record form got
// unlocked, so promises exist against visits that never happened; billing those
// would charge a patient for treatment they have not had. They are counted
// separately so the clinic can see them without being told to bill them.
func (s *Service) UnbilledTreatment(ctx context.Context, from, to string, limit, offset int) (*dental.Unbilled, error) {
	tid, _ := actorOf(ctx)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	out := &dental.Unbilled{Rows: []dental.UnbilledRow{}}
	var fromPtr, toPtr *string
	if from != "" {
		fromPtr = &from
	}
	if to != "" {
		toPtr = &to
	}

	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Totals over the WHOLE set, before paging.
		if e := tx.QueryRow(ctx, sessionMoneyCTE+`
			SELECT coalesce(sum(sm.owed_amount) FILTER (WHERE sm.delivered), 0)::text,
			       count(*) FILTER (WHERE sm.delivered),
			       coalesce(sum(sm.amount_due) FILTER (WHERE sm.promised_undelivered), 0)::text,
			       count(*) FILTER (WHERE sm.promised_undelivered)
			FROM session_money sm
			JOIN treatment_plans pl ON pl.id = sm.plan_id    AND pl.tenant_id = sm.tenant_id
			JOIN patients        pt ON pt.id = sm.patient_id AND pt.tenant_id = sm.tenant_id
			WHERE pt.deleted_at IS NULL AND pl.status <> 'cancelled'
			  AND sm.session_status <> 'cancelled'
			  AND sm.pay_state IN ('unpaid','refunded')
			  AND sm.owed_amount > 0.005
			  AND ($2::date IS NULL OR coalesce(sm.completed_at::date, sm.scheduled_date) >= $2::date)
			  AND ($3::date IS NULL OR coalesce(sm.completed_at::date, sm.scheduled_date) <= $3::date)`,
			tid, fromPtr, toPtr).Scan(&out.Total, &out.Count, &out.PromisedTotal, &out.PromisedCount); e != nil {
			return e
		}
		out.Total = fmtMoney(money(out.Total))
		out.PromisedTotal = fmtMoney(money(out.PromisedTotal))

		rows, e := tx.Query(ctx, sessionMoneyCTE+`,
today AS (SELECT (now() AT TIME ZONE 'Africa/Addis_Ababa')::date AS d)
SELECT sm.session_id, sm.patient_id, pt.mrn,
       trim(pt.first_name || ' ' || coalesce(pt.last_name,'')),
       coalesce(pt.phone,''), pl.title, sm.procedure, sm.tooth, sm.seq, pl.session_count,
       coalesce(sm.completed_at::date, sm.scheduled_date),
       ((SELECT d FROM today) - coalesce(sm.completed_at::date, sm.scheduled_date))::int,
       sm.owed_amount::text,
       CASE WHEN sm.pay_state = 'refunded' THEN 'refunded'
            WHEN sm.charge_id IS NOT NULL  THEN 'bill_withdrawn'
            ELSE 'never_billed' END,
       sm.pay_later, sm.pay_later_note,
       coalesce(u.full_name,''), coalesce(b.name,'')
FROM session_money sm
JOIN treatment_plans pl ON pl.id = sm.plan_id    AND pl.tenant_id = sm.tenant_id
JOIN patients        pt ON pt.id = sm.patient_id AND pt.tenant_id = sm.tenant_id
LEFT JOIN users      u  ON u.id  = sm.completed_by AND u.tenant_id = sm.tenant_id
LEFT JOIN branches   b  ON b.id  = sm.branch_id    AND b.tenant_id = sm.tenant_id
WHERE pt.deleted_at IS NULL AND pl.status <> 'cancelled'
  AND sm.session_status <> 'cancelled'
  AND sm.delivered
  AND sm.pay_state IN ('unpaid','refunded')
  AND sm.owed_amount > 0.005
  AND ($2::date IS NULL OR coalesce(sm.completed_at::date, sm.scheduled_date) >= $2::date)
  AND ($3::date IS NULL OR coalesce(sm.completed_at::date, sm.scheduled_date) <= $3::date)
ORDER BY coalesce(sm.completed_at::date, sm.scheduled_date) ASC
LIMIT $4 OFFSET $5`, tid, fromPtr, toPtr, limit+1, offset)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var r dental.UnbilledRow
			var td time.Time
			if e := rows.Scan(&r.SessionID, &r.PatientID, &r.MRN, &r.PatientName, &r.Phone,
				&r.PlanTitle, &r.Procedure, &r.Tooth, &r.Seq, &r.SessionCount,
				&td, &r.DaysUnbilled, &r.Amount, &r.Lane, &r.PayLater, &r.PayLaterNote,
				&r.Clinician, &r.Branch); e != nil {
				return e
			}
			r.TreatmentDate = td.Format("2006-01-02")
			r.Amount = fmtMoney(money(r.Amount))
			out.Rows = append(out.Rows, r)
		}
		if e := rows.Err(); e != nil {
			return e
		}
		// One extra row was fetched purely to answer "is there another page?".
		if len(out.Rows) > limit {
			out.Rows = out.Rows[:limit]
			out.HasMore = true
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) Outstanding(ctx context.Context) ([]dental.Outstanding, error) {
	tid, _ := actorOf(ctx)
	out := []dental.Outstanding{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Deliberately the SAME predicate as balanceTx's `due`, from the same
		// projection: the "Owes" badge on the worklist and the Balance card on the
		// patient page must be arithmetically incapable of disagreeing.
		rows, e := tx.Query(ctx, sessionMoneyCTE+`
			SELECT p.id, p.first_name, coalesce(p.last_name,''), p.mrn,
			       sum(sm.owed_amount)::text AS balance
			FROM session_money sm
			JOIN treatment_plans pl ON pl.id = sm.plan_id    AND pl.tenant_id = sm.tenant_id
			JOIN patients        p  ON p.id  = sm.patient_id AND p.tenant_id  = sm.tenant_id
			WHERE p.deleted_at IS NULL
			  AND pl.status <> 'cancelled' AND sm.session_status <> 'cancelled'
			  AND sm.delivered AND sm.pay_state IN ('unpaid','refunded')
			GROUP BY p.id, p.first_name, p.last_name, p.mrn
			HAVING sum(sm.owed_amount) > 0.005
			ORDER BY sum(sm.owed_amount) DESC`, tid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var o dental.Outstanding
			var first, last string
			if e := rows.Scan(&o.PatientID, &first, &last, &o.MRN, &o.Balance); e != nil {
				return e
			}
			o.PatientName = first + " " + last
			o.Balance = fmtMoney(money(o.Balance))
			out = append(out, o)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SessionsInRange lists all patients' non-cancelled sessions scheduled within
// [from,to] for the clinic calendar, with payment/status so follow-up visits can
// be shown (and colour-coded) alongside appointments.
func (s *Service) SessionsInRange(ctx context.Context, from, to string) ([]dental.SessionCalItem, error) {
	tid, _ := actorOf(ctx)
	out := []dental.SessionCalItem{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Same projection as everywhere else, so a session's colour on the calendar
		// matches its badge on the patient page.
		rows, e := tx.Query(ctx, sessionMoneyCTE+`
			SELECT sm.session_id, sm.plan_id, sm.patient_id, pt.first_name, coalesce(pt.last_name,''), pt.mrn,
			       sm.scheduled_date, sm.seq, p.session_count, p.title,
			       sm.procedure, sm.tooth, sm.amount_due::text, sm.session_status, sm.pay_later, sm.pay_state
			FROM session_money sm
			JOIN treatment_plans p ON p.id = sm.plan_id AND p.tenant_id = sm.tenant_id
			JOIN patients pt ON pt.id = sm.patient_id
			WHERE sm.scheduled_date >= $2::date AND sm.scheduled_date <= $3::date
			  AND sm.session_status <> 'cancelled' AND p.status <> 'cancelled' AND pt.deleted_at IS NULL
			ORDER BY sm.scheduled_date, pt.first_name`, tid, from, to)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var it dental.SessionCalItem
			var first, last string
			var sd time.Time
			if e := rows.Scan(&it.SessionID, &it.PlanID, &it.PatientID, &first, &last, &it.MRN,
				&sd, &it.Seq, &it.SessionCount, &it.Title, &it.Procedure, &it.Tooth, &it.AmountDue, &it.Status, &it.PayLater, &it.Payment); e != nil {
				return e
			}
			it.PatientName = strings.TrimSpace(first + " " + last)
			it.ScheduledDate = sd.Format("2006-01-02")
			out = append(out, it)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// --- images (X-rays, before/after) — optionally scoped to a session ---

func (s *Service) SignImageUpload(ctx context.Context, patientID uuid.UUID, filename, mime string) (storage.UploadTarget, error) {
	tid, _ := actorOf(ctx)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := limits.EnsureImageRoom(ctx, tx, tid, patientID); e != nil {
			return e
		}
		return limits.EnsureStorageRoom(ctx, tx, tid)
	}); err != nil {
		if ae, ok := apperr.As(err); ok {
			return storage.UploadTarget{}, ae
		}
		return storage.UploadTarget{}, apperr.Internal(err)
	}
	target, err := s.store.SignUpload(ctx, storage.UploadOptions{
		Folder: fmt.Sprintf("%s/dental/%s", tid, patientID), ResourceType: "image", Tags: []string{"dental"},
	})
	if err != nil {
		return storage.UploadTarget{}, apperr.Internal(err)
	}
	return target, nil
}

func (s *Service) RecordImage(ctx context.Context, patientID uuid.UUID, sessionID *uuid.UUID, in dental.ImageRecordInput) (*dental.Image, error) {
	tid, actor := actorOf(ctx)
	if in.StorageKey == "" {
		return nil, apperr.Validation("a storage key is required")
	}
	size := in.SizeBytes
	if sizer, ok := s.store.(storage.Sizer); ok {
		if real, e := sizer.Size(ctx, in.StorageKey); e == nil && real > 0 {
			size = real
		}
	}
	filename := in.Filename
	if filename == "" {
		filename = "image"
	}
	mime := in.MimeType
	if mime == "" {
		mime = "image/jpeg"
	}
	var id uuid.UUID
	var created time.Time
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO attachments (tenant_id, patient_id, treatment_session_id, image_category, type, storage_key, filename, mime_type, size_bytes, created_by)
			 VALUES ($1,$2,$3,$4,'image',$5,$6,$7,$8,$9) RETURNING id, created_at`,
			tid, patientID, sessionID, nullStr(in.Category), in.StorageKey, filename, mime, size, actor).Scan(&id, &created); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tid, "attachment", id, "dental.image.added",
			map[string]any{"patient_id": patientID, "size_bytes": size})
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	im := &dental.Image{
		ID: id, Category: in.Category, StorageKey: in.StorageKey, URL: s.store.URL(in.StorageKey),
		Filename: filename, MimeType: mime, SizeBytes: size, CreatedAt: created.Format(time.RFC3339),
	}
	if sessionID != nil {
		sid := sessionID.String()
		im.SessionID = &sid
	}
	return im, nil
}

// ListImages returns a session's images (sessionID set) or the general,
// un-sessioned images (sessionID nil).
func (s *Service) ListImages(ctx context.Context, patientID uuid.UUID, sessionID *uuid.UUID) ([]dental.Image, error) {
	tid, _ := actorOf(ctx)
	out := []dental.Image{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT id, coalesce(image_category,''), storage_key, filename, mime_type, size_bytes, created_at
			 FROM attachments
			 WHERE tenant_id = $1 AND patient_id = $2 AND type = 'image' AND deleted_at IS NULL
			   AND (($3::uuid IS NULL AND treatment_session_id IS NULL) OR treatment_session_id = $3)
			 ORDER BY created_at DESC`, tid, patientID, sessionID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var im dental.Image
			var created time.Time
			if e := rows.Scan(&im.ID, &im.Category, &im.StorageKey, &im.Filename, &im.MimeType, &im.SizeBytes, &created); e != nil {
				return e
			}
			im.URL = s.store.URL(im.StorageKey)
			im.CreatedAt = created.Format(time.RFC3339)
			out = append(out, im)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) DeleteImage(ctx context.Context, patientID, imageID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	var key string
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx,
			`UPDATE attachments SET deleted_at = now(), updated_at = now()
			 WHERE tenant_id = $1 AND patient_id = $2 AND id = $3 AND type = 'image' AND deleted_at IS NULL
			 RETURNING storage_key`, tid, patientID, imageID).Scan(&key)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("IMAGE_NOT_FOUND", "image not found")
		}
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	_ = s.store.Delete(ctx, key) // best effort — frees metered storage
	return nil
}
