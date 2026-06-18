// Package service implements the card / consultation fee use-cases (Phase 3a).
// The "free re-visit" is gated on a doctor-booked follow-up within its window;
// self-initiated walk-ins always pay. See docs/patient-workflow.md.
package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	billingdb "github.com/reicb/clinicsaas/internal/billing/repo/gen"
	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// Service implements billing.Service.
type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
}

var _ billing.Service = (*Service)(nil)

// NewService constructs a billing Service.
func NewService(db *kerneldb.DB, publisher events.Publisher) *Service {
	return &Service{db: db, publisher: publisher}
}

// Assess decides whether a visit must pay the card fee.
func (s *Service) Assess(ctx context.Context, in billing.AssessInput) (*billing.Assessment, error) {
	tenantID, _ := actorOf(ctx)
	a := billing.Assessment{Currency: "ETB", Amount: "0"}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		st, e := q.GetCardSettings(ctx, tenantID)
		if errors.Is(e, pgx.ErrNoRows) {
			a.Reason = "clinic not configured"
			return nil
		}
		if e != nil {
			return e
		}
		a.Currency = st.CardCurrency
		a.Amount = st.CardFeeAmount
		a.CardEnabled = st.CardFeeEnabled
		if !st.CardFeeEnabled {
			a.Reason = "card fee not collected at this clinic"
			return nil
		}
		// Already paid today → don't double-charge.
		if _, e := q.GetCardPaymentSince(ctx, billingdb.GetCardPaymentSinceParams{TenantID: tenantID, PatientID: in.PatientID, Since: startOfDayUTC()}); e == nil {
			a.Reason = "already paid today"
			return nil
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		// A doctor-booked follow-up, attended within its window, is free.
		if in.AppointmentID != nil {
			cov, e := q.GetAppointmentCoverage(ctx, billingdb.GetAppointmentCoverageParams{TenantID: tenantID, ID: *in.AppointmentID})
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			if e == nil && cov.IsFollowup && cov.FreeUntil != nil && !time.Now().After(*cov.FreeUntil) &&
				cov.Status != "cancelled" && cov.Status != "no_show" {
				a.Reason = "covered follow-up (free)"
				return nil
			}
		}
		a.RequiresPayment = true
		a.Reason = "card fee due"
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &a, nil
}

// Collect records a card-fee payment (or a waiver) and returns the receipt.
func (s *Service) Collect(ctx context.Context, in billing.CollectInput) (*billing.Payment, error) {
	tenantID, actor := actorOf(ctx)
	var p billing.Payment
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		amount, currency := "0", "ETB"
		st, e := q.GetCardSettings(ctx, tenantID)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if e == nil {
			currency = st.CardCurrency
			if !in.Waived {
				amount = st.CardFeeAmount
			}
		}
		row, e := q.CreateCardPayment(ctx, billingdb.CreateCardPaymentParams{
			TenantID: tenantID, BranchID: in.BranchID, PatientID: in.PatientID, AppointmentID: in.AppointmentID,
			Amount: amount, Currency: currency, Waived: in.Waived, WaiveReason: strPtr(in.WaiveReason), ReceivedBy: actor,
		})
		if e != nil {
			return e
		}
		p = billing.Payment{ID: row.ID, Amount: row.Amount, Currency: row.Currency, Waived: row.Waived, WaiveReason: in.WaiveReason, PaidAt: row.PaidAt}
		return s.publisher.Publish(ctx, tx, &tenantID, "card_payment", row.ID, "billing.card.paid",
			map[string]any{"card_payment_id": row.ID, "patient_id": in.PatientID, "amount": row.Amount, "waived": row.Waived})
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &p, nil
}

// History returns a patient's recent card-fee receipts (newest first).
func (s *Service) History(ctx context.Context, patientID uuid.UUID) ([]billing.Payment, error) {
	tenantID, _ := actorOf(ctx)
	var out []billing.Payment
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := billingdb.New(tx).ListCardPaymentsByPatient(ctx, billingdb.ListCardPaymentsByPatientParams{TenantID: tenantID, PatientID: patientID})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, billing.Payment{ID: r.ID, Amount: r.Amount, Currency: r.Currency, Waived: r.Waived, WaiveReason: deref(r.WaiveReason), PaidAt: r.PaidAt})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ============================================================================
// Billing-1: service catalog + charges + cashier + cash summary
// ============================================================================

var defaultWaiverReasons = []string{"Staff / dependent", "Indigent (charity)", "Exemption program", "Courtesy / VIP", "Insurance / credit", "Follow-up", "Other"}

func (s *Service) WaiverReasons() []string { return defaultWaiverReasons }

func (s *Service) ListServices(ctx context.Context, activeOnly bool) ([]billing.ServiceItem, error) {
	tenantID, _ := actorOf(ctx)
	var ao *bool
	if activeOnly {
		t := true
		ao = &t
	}
	out := []billing.ServiceItem{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := billingdb.New(tx).ListServiceItems(ctx, billingdb.ListServiceItemsParams{TenantID: tenantID, ActiveOnly: ao})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, billing.ServiceItem{ID: r.ID, Code: r.Code, Name: r.Name, Category: r.Category, Price: r.Price, Currency: r.Currency, IsActive: r.IsActive, IsDefault: r.IsDefault})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateService(ctx context.Context, in billing.ServiceItemInput) (*billing.ServiceItem, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Code) == "" || strings.TrimSpace(in.Name) == "" {
		return nil, apperr.Validation("code and name are required")
	}
	var out billing.ServiceItem
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := billingdb.New(tx).CreateServiceItem(ctx, billingdb.CreateServiceItemParams{
			TenantID: tenantID, Code: in.Code, Name: in.Name, Category: catOrDefault(in.Category), Price: priceOrZero(in.Price), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		out = billing.ServiceItem{ID: r.ID, Code: r.Code, Name: r.Name, Category: r.Category, Price: r.Price, Currency: r.Currency, IsActive: r.IsActive, IsDefault: r.IsDefault}
		return nil
	})
	if err != nil {
		return nil, mapWrite(err, "SERVICE_EXISTS", "a service with this code already exists")
	}
	return &out, nil
}

func (s *Service) UpdateService(ctx context.Context, id uuid.UUID, in billing.ServiceItemInput) error {
	tenantID, _ := actorOf(ctx)
	if strings.TrimSpace(in.Code) == "" || strings.TrimSpace(in.Name) == "" {
		return apperr.Validation("code and name are required")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return billingdb.New(tx).UpdateServiceItem(ctx, billingdb.UpdateServiceItemParams{
			TenantID: tenantID, ID: id, Code: in.Code, Name: in.Name, Category: catOrDefault(in.Category), Price: priceOrZero(in.Price),
		})
	})
	if err != nil {
		return mapWrite(err, "SERVICE_EXISTS", "a service with this code already exists")
	}
	return nil
}

func (s *Service) SetServiceActive(ctx context.Context, id uuid.UUID, active bool) error {
	tenantID, _ := actorOf(ctx)
	return apperrOrNil(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return billingdb.New(tx).SetServiceItemActive(ctx, billingdb.SetServiceItemActiveParams{TenantID: tenantID, ID: id, IsActive: active})
	}))
}

func (s *Service) SetServiceDefault(ctx context.Context, id uuid.UUID, isDefault bool) error {
	tenantID, _ := actorOf(ctx)
	return apperrOrNil(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return billingdb.New(tx).SetServiceItemDefault(ctx, billingdb.SetServiceItemDefaultParams{TenantID: tenantID, ID: id, IsDefault: isDefault})
	}))
}

func (s *Service) DeleteService(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	return apperrOrNil(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return billingdb.New(tx).SoftDeleteServiceItem(ctx, billingdb.SoftDeleteServiceItemParams{TenantID: tenantID, ID: id})
	}))
}

var validSource = map[string]bool{"consultation": true, "service": true, "lab": true, "pharmacy": true, "other": true}

// RaiseCharge creates a pending charge against a patient.
func (s *Service) RaiseCharge(ctx context.Context, in billing.ChargeInput) (uuid.UUID, error) {
	tenantID, actor := actorOf(ctx)
	if in.PatientID == uuid.Nil || strings.TrimSpace(in.Description) == "" {
		return uuid.Nil, apperr.Validation("a patient and description are required")
	}
	src := in.Source
	if !validSource[src] {
		src = "service"
	}
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := billingdb.New(tx).CreateCharge(ctx, billingdb.CreateChargeParams{
			TenantID: tenantID, PatientID: in.PatientID, EncounterID: in.EncounterID, ServiceItemID: in.ServiceItemID,
			Source: src, Description: in.Description, Amount: priceOrZero(in.Amount), Currency: "ETB",
			BranchID: in.BranchID, DepartmentID: in.DepartmentID, ToTriage: in.ToTriage, ProviderID: in.ProviderID, CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		id = r.ID
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", r.ID, "billing.charge.raised", map[string]any{"charge_id": r.ID, "patient_id": in.PatientID, "amount": r.Amount})
	})
	if ae, ok := apperr.As(err); ok {
		return uuid.Nil, ae
	}
	if err != nil {
		return uuid.Nil, apperr.Internal(err)
	}
	return id, nil
}

func (s *Service) PendingCharges(ctx context.Context) ([]billing.PendingCharge, error) {
	tenantID, _ := actorOf(ctx)
	out := []billing.PendingCharge{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := billingdb.New(tx).ListPendingCharges(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, billing.PendingCharge{
				ID: r.ID, Source: r.Source, Description: r.Description, Amount: r.Amount, Currency: r.Currency, CreatedAt: r.CreatedAt,
				PatientID: r.PatientID, PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) PatientCharges(ctx context.Context, patientID uuid.UUID) ([]billing.ChargeRow, error) {
	tenantID, _ := actorOf(ctx)
	out := []billing.ChargeRow{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := billingdb.New(tx).ListChargesByPatient(ctx, billingdb.ListChargesByPatientParams{TenantID: tenantID, PatientID: patientID})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, billing.ChargeRow{
				ID: r.ID, Source: r.Source, Description: r.Description, Amount: r.Amount, Currency: r.Currency, Status: r.Status,
				PaymentMethod: deref(r.PaymentMethod), WaiveReason: deref(r.WaiveReason), SettledAt: r.SettledAt, CreatedAt: r.CreatedAt,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SettleCharge marks a pending charge paid and, for a routed consultation charge,
// enqueues the patient (auto-advance after payment).
func (s *Service) SettleCharge(ctx context.Context, id uuid.UUID, method string) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		row, e := q.SettleCharge(ctx, billingdb.SettleChargeParams{PaymentMethod: strPtr(method), SettledBy: actor, TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		if e := advanceIfPaid(ctx, q, tenantID, actor, row.BranchID, row.DepartmentID, row.ToTriage, row.ProviderID, row.PatientID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", row.ID, "billing.charge.paid", map[string]any{"charge_id": row.ID})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("ALREADY_SETTLED", "this charge is no longer pending")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// WaiveCharge marks a pending charge waived (free, with reason) and still advances
// the patient if it's a routed consultation charge.
func (s *Service) WaiveCharge(ctx context.Context, id uuid.UUID, reason string) error {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(reason) == "" {
		return apperr.Validation("a waiver reason is required")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		row, e := q.WaiveCharge(ctx, billingdb.WaiveChargeParams{WaiveReason: strPtr(reason), SettledBy: actor, TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		if e := advanceIfPaid(ctx, q, tenantID, actor, row.BranchID, row.DepartmentID, row.ToTriage, row.ProviderID, row.PatientID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", row.ID, "billing.charge.waived", map[string]any{"charge_id": row.ID, "reason": reason})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("ALREADY_SETTLED", "this charge is no longer pending")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) CashSince(ctx context.Context, since time.Time) (*billing.CashSummary, error) {
	tenantID, _ := actorOf(ctx)
	out := &billing.CashSummary{BySource: []billing.CashLine{}}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		col, e := q.CashCollectedSince(ctx, billingdb.CashCollectedSinceParams{TenantID: tenantID, Since: &since})
		if e != nil {
			return e
		}
		out.Collected, out.CollectedCount = col.Total, int(col.N)
		wv, e := q.CashWaivedSince(ctx, billingdb.CashWaivedSinceParams{TenantID: tenantID, Since: &since})
		if e != nil {
			return e
		}
		out.Waived, out.WaivedCount = wv.Total, int(wv.N)
		os, e := q.CashOutstanding(ctx, tenantID)
		if e != nil {
			return e
		}
		out.Outstanding, out.OutstandingCount = os.Total, int(os.N)
		by, e := q.CashBySourceSince(ctx, billingdb.CashBySourceSinceParams{TenantID: tenantID, Since: &since})
		if e != nil {
			return e
		}
		for _, r := range by {
			out.BySource = append(out.BySource, billing.CashLine{Source: r.Source, Total: r.Total, Count: int(r.N)})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// advanceIfPaid enqueues the patient (auto-advance after payment) once a routed
// visit charge is settled/waived AND nothing is still owed — so multiple line-items
// (e.g. registration + consultation) advance the patient exactly once, after the
// last payment. Routing is only set on reception's visit charges, so non-visit
// charges (a standalone procedure with no routing) never enqueue.
func advanceIfPaid(ctx context.Context, q *billingdb.Queries, tenantID uuid.UUID, actor *uuid.UUID, branchID, departmentID *uuid.UUID, toTriage bool, providerID *uuid.UUID, patientID uuid.UUID) error {
	if branchID == nil || departmentID == nil {
		return nil // not a routed visit charge
	}
	pending, e := q.CountPendingChargesByPatient(ctx, billingdb.CountPendingChargesByPatientParams{TenantID: tenantID, PatientID: patientID})
	if e != nil {
		return e
	}
	if pending > 0 {
		return nil // patient still owes — don't advance yet
	}
	active, e := q.CountActiveQueueByPatient(ctx, billingdb.CountActiveQueueByPatientParams{TenantID: tenantID, PatientID: patientID})
	if e != nil {
		return e
	}
	if active > 0 {
		return nil // already in the queue
	}
	stage := "with_doctor"
	if toTriage {
		stage = "triage"
	}
	return q.EnqueueFromCharge(ctx, billingdb.EnqueueFromChargeParams{
		TenantID: tenantID, BranchID: *branchID, DepartmentID: *departmentID, PatientID: patientID, Stage: stage, AssignedProviderID: providerID, CreatedBy: actor,
	})
}

func catOrDefault(c string) string {
	if strings.TrimSpace(c) == "" {
		return "general"
	}
	return c
}
func priceOrZero(p string) string {
	if strings.TrimSpace(p) == "" {
		return "0"
	}
	return p
}
func mapWrite(err error, code, msg string) error {
	if err == nil {
		return nil
	}
	m := err.Error()
	if strings.Contains(m, "duplicate key") || strings.Contains(m, "unique constraint") {
		return apperr.Conflict(code, msg)
	}
	return apperr.Internal(err)
}
func apperrOrNil(err error) error {
	if err == nil {
		return nil
	}
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	return apperr.Internal(err)
}

// --- helpers ---

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

func strPtr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func startOfDayUTC() time.Time {
	n := time.Now().UTC()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}
