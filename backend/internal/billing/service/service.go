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
