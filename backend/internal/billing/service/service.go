// Package service implements the card / consultation fee use-cases (Phase 3a).
// The "free re-visit" is gated on a doctor-booked follow-up within its window;
// self-initiated walk-ins always pay. See docs/patient-workflow.md.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/billing"
	billingdb "github.com/reicb/clinicsaas/internal/billing/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/catalog"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/payments"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// Service implements billing.Service.
type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
	// Receipt verification. nil, or a client with no key, simply means the desk is
	// never offered a bank check — every other path behaves as it always has.
	verifier payments.Verifier
	waitMs   int
}

var _ billing.Service = (*Service)(nil)
var _ billing.Charger = (*Service)(nil)

// NewService constructs a billing Service.
func NewService(db *kerneldb.DB, publisher events.Publisher) *Service {
	return &Service{db: db, publisher: publisher}
}

// WithVerifier attaches receipt verification. Config-gated at the composition root,
// so a deployment without a key never grows the surface at all.
func (s *Service) WithVerifier(v payments.Verifier, waitMs int) *Service {
	s.verifier, s.waitMs = v, waitMs
	return s
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

// assignableOrDefault keeps the column to its three legal values. "either" is the
// default because a clinic that has not thought about it should not be blocked.
func assignableOrDefault(v string) string {
	switch strings.TrimSpace(v) {
	case "reception", "clinician", "either":
		return strings.TrimSpace(v)
	}
	return "either"
}

func (s *Service) ListServices(ctx context.Context, activeOnly bool) ([]billing.ServiceItem, error) {
	tenantID, _ := actorOf(ctx)
	var ao *bool
	if activeOnly {
		t := true
		ao = &t
	}
	out := []billing.ServiceItem{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Raw pgx: assignable_by was added after these queries were generated and
		// sqlc is not available in this tree. Same query otherwise.
		rows, e := tx.Query(ctx,
			`SELECT id, code, name, category, price::text, currency, is_active, is_default, assignable_by
			   FROM service_items
			  WHERE tenant_id = $1 AND deleted_at IS NULL
			    AND ($2::bool IS NULL OR is_active = $2)
			  ORDER BY category, name`, tenantID, ao)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var it billing.ServiceItem
			if e := rows.Scan(&it.ID, &it.Code, &it.Name, &it.Category, &it.Price, &it.Currency,
				&it.IsActive, &it.IsDefault, &it.AssignableBy); e != nil {
				return e
			}
			out = append(out, it)
		}
		return rows.Err()
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
		return tx.QueryRow(ctx,
			`INSERT INTO service_items (tenant_id, code, name, category, price, assignable_by, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)
			 RETURNING id, code, name, category, price::text, currency, is_active, is_default, assignable_by`,
			tenantID, strings.TrimSpace(in.Code), strings.TrimSpace(in.Name), catOrDefault(in.Category),
			priceOrZero(in.Price), assignableOrDefault(in.AssignableBy), actor,
		).Scan(&out.ID, &out.Code, &out.Name, &out.Category, &out.Price, &out.Currency,
			&out.IsActive, &out.IsDefault, &out.AssignableBy)
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
		_, e := tx.Exec(ctx,
			`UPDATE service_items
			    SET code = $3, name = $4, category = $5, price = $6, assignable_by = $7, updated_at = now()
			  WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
			tenantID, id, strings.TrimSpace(in.Code), strings.TrimSpace(in.Name), catOrDefault(in.Category),
			priceOrZero(in.Price), assignableOrDefault(in.AssignableBy))
		return e
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

// SetServiceProviders replaces the staff assigned to a service.
func (s *Service) SetServiceProviders(ctx context.Context, serviceID uuid.UUID, userIDs []uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	return apperrOrNil(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		if e := q.ClearServiceProviders(ctx, billingdb.ClearServiceProvidersParams{TenantID: tenantID, ServiceItemID: serviceID}); e != nil {
			return e
		}
		for _, uid := range userIDs {
			if e := q.AddServiceProvider(ctx, billingdb.AddServiceProviderParams{TenantID: tenantID, ServiceItemID: serviceID, UserID: uid}); e != nil {
				return e
			}
		}
		return nil
	}))
}

func (s *Service) ServiceProviderIDs(ctx context.Context, serviceID uuid.UUID) ([]uuid.UUID, error) {
	tenantID, _ := actorOf(ctx)
	out := []uuid.UUID{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ids, e := billingdb.New(tx).ListServiceProviderIDs(ctx, billingdb.ListServiceProviderIDsParams{TenantID: tenantID, ServiceItemID: serviceID})
		if e != nil {
			return e
		}
		out = ids
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) ProvidersForServices(ctx context.Context, serviceIDs []uuid.UUID) ([]billing.Provider, error) {
	tenantID, _ := actorOf(ctx)
	out := []billing.Provider{}
	if len(serviceIDs) == 0 {
		return out, nil
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := billingdb.New(tx).ListProvidersForServices(ctx, billingdb.ListProvidersForServicesParams{TenantID: tenantID, ServiceIds: serviceIDs})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, billing.Provider{ID: r.ID, FullName: r.FullName})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

var validSource = map[string]bool{"consultation": true, "service": true, "lab": true, "pharmacy": true, "bed": true, "dental": true, "other": true}

// RaiseCharge creates a pending charge against a patient (own transaction).
func (s *Service) RaiseCharge(ctx context.Context, in billing.ChargeInput) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Enforced here rather than by hiding the option in the UI: a rule about who
		// may sell a root canal is worth nothing if the request still succeeds.
		tid, _ := actorOf(ctx)
		if e := catalog.AssertMayAssign(ctx, tx, tid, in.ServiceItemID); e != nil {
			return e
		}
		var e error
		id, e = s.RaiseChargeTx(ctx, tx, in)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return uuid.Nil, ae
	}
	if err != nil {
		return uuid.Nil, apperr.Internal(err)
	}
	return id, nil
}

// RaiseChargeBatch registers all of a visit's charges in one transaction. It first
// guards against a duplicate registration: if the patient still has unpaid charges
// at the cashier, or is already in an active visit, it raises nothing and returns a
// conflict — so reception can't send the same patient (and the same services) twice.
func (s *Service) RaiseChargeBatch(ctx context.Context, in billing.ChargeBatchInput) ([]uuid.UUID, error) {
	if in.PatientID == uuid.Nil {
		return nil, apperr.Validation("a patient is required")
	}
	if len(in.Items) == 0 {
		return nil, apperr.Validation("at least one service is required")
	}
	tenantID, _ := actorOf(ctx)
	var ids []uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		pending, e := q.CountPendingChargesByPatient(ctx, billingdb.CountPendingChargesByPatientParams{TenantID: tenantID, PatientID: in.PatientID})
		if e != nil {
			return e
		}
		if pending > 0 {
			return apperr.Conflict("PATIENT_HAS_PENDING_CHARGES", "this patient already has unpaid charges at the cashier — settle or void them before registering the visit again")
		}
		active, e := q.CountActiveQueueByPatient(ctx, billingdb.CountActiveQueueByPatientParams{TenantID: tenantID, PatientID: in.PatientID})
		if e != nil {
			return e
		}
		if active > 0 {
			return apperr.Conflict("PATIENT_HAS_ACTIVE_VISIT", "this patient is already in an active visit — finish or close it before registering again")
		}
		branch, dept := in.BranchID, in.DepartmentID
		for _, it := range in.Items {
			// The visit-registration path, which is where reception picks services. The
			// whole batch is refused rather than partly registered: half a visit is
			// harder to unpick than none.
			if e := catalog.AssertMayAssign(ctx, tx, tenantID, it.ServiceItemID); e != nil {
				return e
			}
			cid, e := s.RaiseChargeTx(ctx, tx, billing.ChargeInput{
				PatientID: in.PatientID, ServiceItemID: it.ServiceItemID, Source: it.Source, Description: it.Description, Amount: it.Amount,
				BranchID: &branch, DepartmentID: &dept, ToTriage: in.ToTriage, ProviderID: in.ProviderID,
			})
			if e != nil {
				return e
			}
			ids = append(ids, cid)
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return ids, nil
}

// RaiseChargeTx creates a pending charge inside the caller's transaction, so a
// module (lab, pharmacy) can bill atomically alongside its own write.
func (s *Service) RaiseChargeTx(ctx context.Context, tx pgx.Tx, in billing.ChargeInput) (uuid.UUID, error) {
	tenantID, actor := actorOf(ctx)
	if in.PatientID == uuid.Nil || strings.TrimSpace(in.Description) == "" {
		return uuid.Nil, apperr.Validation("a patient and description are required")
	}
	src := in.Source
	if !validSource[src] {
		src = "service"
	}
	r, e := billingdb.New(tx).CreateCharge(ctx, billingdb.CreateChargeParams{
		TenantID: tenantID, PatientID: in.PatientID, EncounterID: in.EncounterID, ServiceItemID: in.ServiceItemID,
		Source: src, Description: in.Description, Amount: priceOrZero(in.Amount), Currency: "ETB",
		BranchID: in.BranchID, DepartmentID: in.DepartmentID, ToTriage: in.ToTriage, ProviderID: in.ProviderID, CreatedBy: actor,
	})
	if e != nil {
		return uuid.Nil, e
	}
	if e := s.publisher.Publish(ctx, tx, &tenantID, "charge", r.ID, "billing.charge.raised", map[string]any{"charge_id": r.ID, "patient_id": in.PatientID, "amount": r.Amount}); e != nil {
		return uuid.Nil, e
	}
	return r.ID, nil
}

// RaiseIntakeChargesTx raises the default-service charges (routed) for a patient
// entering the clinic, so settlement gates the queue entry. Returns the count raised.
func (s *Service) RaiseIntakeChargesTx(ctx context.Context, tx pgx.Tx, in billing.IntakeInput) (int, error) {
	ids, err := s.RaiseIntakeChargeIDsTx(ctx, tx, in)
	return len(ids), err
}

// RaiseIntakeChargeIDsTx does the raising and says which charges it created.
func (s *Service) RaiseIntakeChargeIDsTx(ctx context.Context, tx pgx.Tx, in billing.IntakeInput) ([]uuid.UUID, error) {
	tenantID, actor := actorOf(ctx)
	q := billingdb.New(tx)
	// A doctor-booked follow-up attended within its window is free: raise no intake
	// charge so the patient enqueues immediately (same rule as the card-fee Assess).
	if in.AppointmentID != nil {
		cov, e := q.GetAppointmentCoverage(ctx, billingdb.GetAppointmentCoverageParams{TenantID: tenantID, ID: *in.AppointmentID})
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if e == nil && cov.IsFollowup && cov.FreeUntil != nil && !time.Now().After(*cov.FreeUntil) &&
			cov.Status != "cancelled" && cov.Status != "no_show" {
			return nil, nil
		}
	}
	out := []uuid.UUID{}
	defaults, e := q.ListDefaultServices(ctx, tenantID)
	if e != nil {
		return nil, e
	}
	// Today's intake fee, if it is already standing, IS the answer — raise nothing and
	// hand back the charges that exist.
	//
	// Neither door checked this. A fee-gated arrival is not queued until it is paid, so
	// the patient stays in Expected with the buttons live: pressing "Send to cashier"
	// twice, or Collect after it, charged the registration fee twice. Idempotent rather
	// than a conflict, because the desk pressing again means "deal with this arrival",
	// and the standing charge is what dealing with it means.
	//
	// Scoped to TODAY and to the default services, both deliberately: an unpaid debt
	// from last month must not make today's visit free, and a lab test the patient owes
	// for is not a registration fee. Today is Addis, not the session's UTC — see the
	// day-boundary rule that has bitten the Z-report, deposit ageing and the finance
	// chart.
	if len(defaults) > 0 {
		ids := make([]uuid.UUID, 0, len(defaults))
		svc := make([]uuid.UUID, 0, len(defaults))
		for _, d := range defaults {
			svc = append(svc, d.ID)
		}
		rows, e := tx.Query(ctx,
			`SELECT id FROM charges
			  WHERE tenant_id = $1 AND patient_id = $2 AND status = 'pending' AND deleted_at IS NULL
			    AND service_item_id = ANY($3::uuid[])
			    AND created_at >= (((now() AT TIME ZONE 'Africa/Addis_Ababa')::date) AT TIME ZONE 'Africa/Addis_Ababa')
			  ORDER BY created_at`,
			tenantID, in.PatientID, svc)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var cid uuid.UUID
			if e := rows.Scan(&cid); e != nil {
				rows.Close()
				return nil, e
			}
			ids = append(ids, cid)
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return nil, e
		}
		if len(ids) > 0 {
			return ids, nil
		}
	}
	branch, dept := in.BranchID, in.DepartmentID
	for _, d := range defaults {
		r, e := q.CreateCharge(ctx, billingdb.CreateChargeParams{
			TenantID: tenantID, PatientID: in.PatientID, Source: "consultation", Description: d.Name, Amount: priceOrZero(d.Price), Currency: "ETB",
			ServiceItemID: &d.ID, BranchID: &branch, DepartmentID: &dept, ToTriage: in.ToTriage, ProviderID: in.ProviderID, CreatedBy: actor,
		})
		if e != nil {
			return nil, e
		}
		if e := s.publisher.Publish(ctx, tx, &tenantID, "charge", r.ID, "billing.charge.raised", map[string]any{"charge_id": r.ID, "patient_id": in.PatientID, "amount": r.Amount}); e != nil {
			return nil, e
		}
		out = append(out, r.ID)
	}
	return out, nil
}

// ChargeStatusTx reports a charge's status for a pre-pay gate.
func (s *Service) ChargeStatusTx(ctx context.Context, tx pgx.Tx, id uuid.UUID) (string, error) {
	tenantID, _ := actorOf(ctx)
	st, e := billingdb.New(tx).ChargeStatus(ctx, billingdb.ChargeStatusParams{TenantID: tenantID, ID: id})
	if errors.Is(e, pgx.ErrNoRows) {
		return "", apperr.NotFound("CHARGE_NOT_FOUND", "charge not found")
	}
	if e != nil {
		return "", e
	}
	return st, nil
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

func (s *Service) PatientCharges(ctx context.Context, patientID uuid.UUID) (*billing.PatientLedger, error) {
	tenantID, _ := actorOf(ctx)
	led := &billing.PatientLedger{Rows: []billing.ChargeRow{}}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Totals over the WHOLE account, not the page below. A statement that totals
		// fifty rows and prints a signature block under it is worse than no statement.
		if e := tx.QueryRow(ctx,
			`SELECT coalesce(sum(amount) FILTER (WHERE source <> 'refund' AND status IN ('paid','pending')),0)::text,
			        coalesce(sum(amount) FILTER (WHERE source <> 'refund' AND status = 'paid'),0)::text,
			        coalesce(sum(-amount) FILTER (WHERE source = 'refund' AND status = 'paid'),0)::text,
			        coalesce(sum(amount) FILTER (WHERE source <> 'refund' AND status = 'pending'),0)::text,
			        coalesce(sum(amount) FILTER (WHERE status = 'waived'),0)::text,
			        count(*)
			 FROM charges WHERE tenant_id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
			tenantID, patientID).Scan(&led.Charged, &led.Paid, &led.Refunded, &led.Awaiting, &led.Waived, &led.TotalCount); e != nil {
			return e
		}
		// Paid is what the clinic HOLDS: settled minus refunded.
		led.Paid = fmtMoney2(parseMoneyB(led.Paid) - parseMoneyB(led.Refunded))

		// Raw pgx rather than the generated query: this needs the settling cashier's
		// name, and sqlc is not available in this environment to regenerate.
		rows, e := tx.Query(ctx,
			`SELECT c.id, c.source, c.description, c.amount, c.currency, c.status,
			        c.payment_method, c.waive_reason, c.settled_at, c.created_at, c.receipt_no,
			        coalesce(u.full_name, '')
			 FROM charges c
			 LEFT JOIN users u ON u.id = c.settled_by AND u.tenant_id = c.tenant_id
			 WHERE c.tenant_id = $1 AND c.patient_id = $2 AND c.deleted_at IS NULL
			 ORDER BY c.created_at DESC LIMIT 50`, tenantID, patientID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var r billing.ChargeRow
			var method, waive *string
			if e := rows.Scan(&r.ID, &r.Source, &r.Description, &r.Amount, &r.Currency, &r.Status,
				&method, &waive, &r.SettledAt, &r.CreatedAt, &r.ReceiptNo, &r.SettledBy); e != nil {
				return e
			}
			r.PaymentMethod, r.WaiveReason = deref(method), deref(waive)
			led.Rows = append(led.Rows, r)
		}
		if e := rows.Err(); e != nil {
			return e
		}
		led.Truncated = led.TotalCount > len(led.Rows)
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return led, nil
}

// fmtMoney2 formats a float as a 2dp money string.
func fmtMoney2(f float64) string { return money2(f) }

// SettleCharge marks a pending charge paid and, for a routed consultation charge,
// enqueues the patient (auto-advance after payment).
func (s *Service) SettleCharge(ctx context.Context, id uuid.UUID, in billing.SettleInput) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		railID, method, ref, e := payments.Resolve(ctx, tx, tenantID, in.RailID, in.Method, in.Reference, in.Force)
		if e != nil {
			return e
		}
		row, e := q.SettleCharge(ctx, billingdb.SettleChargeParams{PaymentMethod: strPtr(method), SettledBy: actor, TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		if e := stampReceipt(ctx, q, tenantID, row.ID); e != nil {
			return e
		}
		if e := payments.StampCharges(ctx, tx, tenantID, []uuid.UUID{row.ID}, railID, ref); e != nil {
			return e
		}
		// After the receipt is stamped, so the "already used" message can name it.
		var receiptNo *int64
		var amount string
		if e := tx.QueryRow(ctx, `SELECT receipt_no, amount::text FROM charges WHERE tenant_id=$1 AND id=$2`,
			tenantID, row.ID).Scan(&receiptNo, &amount); e != nil {
			return e
		}
		if e := payments.ClaimReference(ctx, tx, tenantID, railID, ref, receiptNo, &row.PatientID, amount, actor); e != nil {
			return e
		}
		if e := advanceIfPaid(ctx, tx, q, tenantID, actor, row.BranchID, row.DepartmentID, row.ToTriage, row.ProviderID, row.PatientID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", row.ID, "billing.charge.paid", map[string]any{"charge_id": row.ID})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("ALREADY_SETTLED", "this charge is no longer pending")
	}
	// Everything the settle refuses for a reason the desk can act on — an unusable
	// payment method, a missing reference, a reference already used — arrives here as
	// an apperr. Without this it was flattened into "an unexpected error occurred",
	// which is the one message that tells a cashier nothing.
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// SettleVisit collects ALL of a patient's pending charges in one go under a single
// receipt number, then advances the patient once. This is the cashier's one-click
// visit checkout (vs. SettleCharge for a single line).
func (s *Service) SettleVisit(ctx context.Context, patientID uuid.UUID, in billing.SettleInput) (*billing.VisitSettlement, error) {
	tenantID, actor := actorOf(ctx)
	var out billing.VisitSettlement
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		railID, method, ref, e := payments.Resolve(ctx, tx, tenantID, in.RailID, in.Method, in.Reference, in.Force)
		if e != nil {
			return e
		}
		no, e := q.NextReceiptNo(ctx, tenantID)
		if e != nil {
			return e
		}
		rows, e := settleScoped(ctx, tx, q, settleScope{
			tenantID: tenantID, patientID: patientID, method: method, actor: actor,
			receiptNo: no, only: in.ChargeIDs,
		})
		if e != nil {
			return e
		}
		if len(rows) == 0 {
			return apperr.Conflict("NOTHING_PENDING", "no pending charges for this patient")
		}
		var total float64
		var routed *billingdb.SettleVisitRow
		ids := make([]uuid.UUID, 0, len(rows))
		for i := range rows {
			ids = append(ids, rows[i].ID)
			total += parseMoneyB(rows[i].Amount)
			if routed == nil && rows[i].BranchID != nil && rows[i].DepartmentID != nil {
				routed = &rows[i]
			}
		}
		if routed != nil {
			if e := advanceIfPaid(ctx, tx, q, tenantID, actor, routed.BranchID, routed.DepartmentID, routed.ToTriage, routed.ProviderID, patientID); e != nil {
				return e
			}
		}
		if e := payments.StampCharges(ctx, tx, tenantID, ids, railID, ref); e != nil {
			return e
		}
		// One payment event for the whole checkout, whether it settled one charge or six.
		if e := payments.ClaimReference(ctx, tx, tenantID, railID, ref, &no, &patientID, money2(total), actor); e != nil {
			return e
		}
		out = billing.VisitSettlement{ReceiptNo: no, Total: money2(total), Count: len(rows)}
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", patientID, "billing.visit.paid",
			map[string]any{"patient_id": patientID, "receipt_no": no, "total": out.Total, "count": out.Count})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
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
		if e := advanceIfPaid(ctx, tx, q, tenantID, actor, row.BranchID, row.DepartmentID, row.ToTriage, row.ProviderID, row.PatientID); e != nil {
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

// DeferVisit lets a patient be treated now and billed later.
//
// Not a waiver: the money is still owed, still at the cashier, still in the ageing.
// What changes is that a person decided it, with a reason, and the fee stops holding
// the patient at the door. A clinic that treats a staff member's child, or someone
// brought in bleeding, is not writing the money off — and until now those were the
// same button.
//
// Scoped to a visit rather than a charge because that is the decision being made: you
// let the PATIENT through, not one line of their bill.
func (s *Service) DeferVisit(ctx context.Context, patientID uuid.UUID, reason string, chargeIDs []uuid.UUID) (int, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(reason) == "" {
		return 0, apperr.Validation("say why this patient is being treated before paying — it goes on the record")
	}
	var n int
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		// Either the charges the desk named, or everything still pending for the patient.
		rows, e := tx.Query(ctx,
			`UPDATE charges SET deferred_at = now(), deferred_by = $3, defer_reason = $4, updated_at = now()
			  WHERE tenant_id = $1 AND patient_id = $2 AND status = 'pending' AND deleted_at IS NULL
			    AND deferred_at IS NULL
			    AND ($5::uuid[] IS NULL OR id = ANY($5))
			  RETURNING id, branch_id, department_id, to_triage, provider_id`,
			tenantID, patientID, actor, strings.TrimSpace(reason), nullUUIDs(chargeIDs))
		if e != nil {
			return e
		}
		type row struct {
			id       uuid.UUID
			branch   *uuid.UUID
			dept     *uuid.UUID
			toTriage bool
			provider *uuid.UUID
		}
		var got []row
		for rows.Next() {
			var r row
			if e := rows.Scan(&r.id, &r.branch, &r.dept, &r.toTriage, &r.provider); e != nil {
				rows.Close()
				return e
			}
			got = append(got, r)
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return e
		}
		n = len(got)
		if n == 0 {
			return apperr.Conflict("NOTHING_TO_DEFER", "there is nothing pending on this visit to defer")
		}
		for _, r := range got {
			if e := s.publisher.Publish(ctx, tx, &tenantID, "charge", r.id, "billing.charge.deferred",
				map[string]any{"charge_id": r.id, "patient_id": patientID, "reason": reason}); e != nil {
				return e
			}
		}
		// Now that nothing unagreed is outstanding, let them through the door.
		last := got[len(got)-1]
		return advanceIfPaid(ctx, tx, q, tenantID, actor, last.branch, last.dept, last.toTriage, last.provider, patientID)
	})
	if ae, ok := apperr.As(err); ok {
		return 0, ae
	}
	if err != nil {
		return 0, apperr.Internal(err)
	}
	return n, nil
}

// nullUUIDs turns an empty selection into SQL NULL, which the UPDATE reads as
// "every pending charge" rather than "none".
func nullUUIDs(ids []uuid.UUID) any {
	if len(ids) == 0 {
		return nil
	}
	return ids
}

// VoidCharge retires a still-pending charge (keying error / patient left). It is
// distinct from a waiver (no service given, free) — a void simply cancels the bill.
func (s *Service) VoidCharge(ctx context.Context, id uuid.UUID, reason string) error {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(reason) == "" {
		return apperr.Validation("a reason is required to void a charge")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		row, e := q.VoidCharge(ctx, billingdb.VoidChargeParams{VoidReason: strPtr(reason), VoidedBy: actor, TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", row.ID, "billing.charge.voided", map[string]any{"charge_id": row.ID, "reason": reason})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("NOT_PENDING", "only a pending charge can be voided")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// VoidChargeTx voids a still-pending charge inside the caller's transaction, so a
// module (e.g. dental reversing a mistaken collect) can undo a bill atomically.
// WaiveChargeTx writes off a pending charge inside the caller's transaction, so a
// module can raise-then-waive in one atomic step and leave an auditable "forgiven"
// row rather than simply never billing.
func (s *Service) WaiveChargeTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) error {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(reason) == "" {
		return apperr.Validation("a reason is required to write off a charge")
	}
	q := billingdb.New(tx)
	row, e := q.WaiveCharge(ctx, billingdb.WaiveChargeParams{WaiveReason: strPtr(reason), SettledBy: actor, TenantID: tenantID, ID: id})
	if errors.Is(e, pgx.ErrNoRows) {
		return apperr.Conflict("NOT_PENDING", "only a pending charge can be written off")
	}
	if e != nil {
		return e
	}
	return s.publisher.Publish(ctx, tx, &tenantID, "charge", row.ID, "billing.charge.waived",
		map[string]any{"charge_id": row.ID, "reason": reason})
}

// UnwaiveChargeTx reverses a write-off by voiding the waived charge.
//
// The row is kept and marked void rather than deleted: "we forgave this, then we
// changed our minds" is two decisions and both belong in the ledger. Voiding is what
// takes it out of the waived totals — leaving it waived meant an undone write-off was
// still counted as money the clinic had given away.
func (s *Service) UnwaiveChargeTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) error {
	tenantID, actor := actorOf(ctx)
	ct, e := tx.Exec(ctx,
		`UPDATE charges SET status = 'void', void_reason = $3, voided_by = $4, voided_at = now(), updated_at = now()
		 WHERE tenant_id = $1 AND id = $2 AND status = 'waived' AND deleted_at IS NULL`,
		tenantID, id, reason, actor)
	if e != nil {
		return e
	}
	if ct.RowsAffected() == 0 {
		return apperr.Conflict("NOT_WAIVED", "only a written-off charge can be reinstated")
	}
	return s.publisher.Publish(ctx, tx, &tenantID, "charge", id, "billing.charge.unwaived",
		map[string]any{"charge_id": id, "reason": reason})
}

func (s *Service) VoidChargeTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, reason string) error {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(reason) == "" {
		reason = "reversed"
	}
	q := billingdb.New(tx)
	row, e := q.VoidCharge(ctx, billingdb.VoidChargeParams{VoidReason: strPtr(reason), VoidedBy: actor, TenantID: tenantID, ID: id})
	if errors.Is(e, pgx.ErrNoRows) {
		return apperr.Conflict("NOT_PENDING", "only a pending charge can be voided")
	}
	if e != nil {
		return e
	}
	return s.publisher.Publish(ctx, tx, &tenantID, "charge", row.ID, "billing.charge.voided", map[string]any{"charge_id": row.ID, "reason": reason})
}

// alreadyRefunded maps migration 00047's unique index onto the same message the
// application-level check gives, so losing the race reads as "already refunded"
// rather than as a 500. The index is the real guarantee; the checks are courtesy.
func alreadyRefunded(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && strings.Contains(pgErr.ConstraintName, "reverses")
}

// RefundCharge reverses a settled (paid) charge by posting a linked negative entry
// dated now — so day/Z reports stay correct and the refund is auditable. The
// original paid charge is left intact. Refunding twice is rejected.
func (s *Service) RefundCharge(ctx context.Context, id uuid.UUID, reason string) error {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(reason) == "" {
		return apperr.Validation("a reason is required to refund a charge")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		orig, e := q.GetCharge(ctx, billingdb.GetChargeParams{TenantID: tenantID, ID: id})
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("CHARGE_NOT_FOUND", "charge not found")
		}
		if e != nil {
			return e
		}
		if orig.Status != "paid" {
			return apperr.Conflict("NOT_REFUNDABLE", "only a paid charge can be refunded")
		}
		if orig.Source == "refund" {
			return apperr.Conflict("NOT_REFUNDABLE", "a refund entry cannot itself be refunded")
		}
		// Lock the original before counting reversals. CountReversals is an unlocked
		// read, so without this two concurrent refunds of the same charge — or one
		// double-clicked button, or a retried request — both see zero and both post a
		// negative row, paying the patient back twice. Migration 00047 makes the second
		// insert fail regardless; this turns that race into a clean queue instead of an
		// error, and keeps the friendly message.
		var locked uuid.UUID
		if e := tx.QueryRow(ctx,
			`SELECT id FROM charges WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
			tenantID, id).Scan(&locked); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.NotFound("CHARGE_NOT_FOUND", "charge not found")
			}
			return e
		}
		n, e := q.CountReversals(ctx, billingdb.CountReversalsParams{TenantID: tenantID, ID: &id})
		if e != nil {
			return e
		}
		if n > 0 {
			return apperr.Conflict("ALREADY_REFUNDED", "this charge has already been refunded")
		}
		rev, e := q.CreateReversalCharge(ctx, billingdb.CreateReversalChargeParams{
			TenantID: tenantID, PatientID: orig.PatientID, EncounterID: orig.EncounterID,
			Description: "Refund: " + reason + " (re: " + orig.Description + ")",
			Amount:      negate(orig.Amount), Currency: orig.Currency,
			PaymentMethod: strPtr("refund"), SettledBy: actor, ReversesChargeID: &id, CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		if e := stampReceipt(ctx, q, tenantID, rev.ID); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", rev.ID, "billing.charge.refunded",
			map[string]any{"refund_charge_id": rev.ID, "original_charge_id": id, "amount": rev.Amount, "reason": reason})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if alreadyRefunded(err) {
		return apperr.Conflict("ALREADY_REFUNDED", "this charge has already been refunded")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// PaymentsSince lists completed payments (grouped by receipt) for the cashier's
// "Paid today" audit view, newest first.
func (s *Service) PaymentsSince(ctx context.Context, since time.Time, until *time.Time) ([]billing.PaidVisit, error) {
	tenantID, _ := actorOf(ctx)
	out := []billing.PaidVisit{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Raw pgx rather than the generated query: this needs the settling cashier's
		// name so a reprinted receipt keeps the name of whoever actually took the
		// money. sqlc is not available in this environment to regenerate.
		rows, e := tx.Query(ctx,
			`SELECT c.receipt_no, c.patient_id, p.first_name, p.last_name, p.mrn,
			        c.description, c.amount, c.currency, c.payment_method, c.settled_at,
			        EXISTS (SELECT 1 FROM charges r WHERE r.reverses_charge_id = c.id AND r.deleted_at IS NULL) AS refunded,
			        coalesce(u.full_name, ''),
			        coalesce(pr.label, ''), coalesce(c.payment_reference, '')
			 FROM charges c
			 JOIN patients p ON p.id = c.patient_id AND p.tenant_id = c.tenant_id
			 LEFT JOIN users u ON u.id = c.settled_by AND u.tenant_id = c.tenant_id
			 LEFT JOIN payment_rails pr ON pr.id = c.payment_rail_id AND pr.tenant_id = c.tenant_id
			 WHERE c.tenant_id = $1 AND c.status = 'paid' AND c.source <> 'refund'
			   AND c.receipt_no IS NOT NULL AND c.settled_at >= $2 AND ($3::timestamptz IS NULL OR c.settled_at < $3)
			 ORDER BY c.settled_at DESC, c.receipt_no DESC
			 LIMIT 300`, tenantID, &since, until)
		if e != nil {
			return e
		}
		defer rows.Close()
		idx := map[int64]int{} // receipt_no → position in out
		for rows.Next() {
			var receiptNo *int64
			var patientID uuid.UUID
			var first, last, mrn, description, amount, currency, settledBy, railLabel, reference string
			var method *string
			var settledAt *time.Time
			var refunded bool
			if e := rows.Scan(&receiptNo, &patientID, &first, &last, &mrn, &description, &amount,
				&currency, &method, &settledAt, &refunded, &settledBy, &railLabel, &reference); e != nil {
				return e
			}
			if receiptNo == nil {
				continue
			}
			no := *receiptNo
			pos, ok := idx[no]
			if !ok {
				out = append(out, billing.PaidVisit{
					ReceiptNo: no, PatientID: patientID, PatientName: first + " " + last, MRN: mrn,
					Currency: currency, Method: deref(method), MethodLabel: railLabel, Reference: reference,
					SettledAt: settledAt, SettledBy: settledBy, Refunded: true,
				})
				pos = len(out) - 1
				idx[no] = pos
			}
			out[pos].Lines = append(out[pos].Lines, billing.PaidLine{Description: description, Amount: amount})
			out[pos].Total = money2(parseMoneyB(out[pos].Total) + parseMoneyB(amount))
			if !refunded {
				out[pos].Refunded = false // a payment is "refunded" only if every line is
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// RefundVisit refunds an entire receipt — every still-refundable line gets a linked
// negative reversing entry. Manager-gated. Reuses the per-charge reversal logic.
func (s *Service) RefundVisit(ctx context.Context, receiptNo int64, reason string) error {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(reason) == "" {
		return apperr.Validation("a reason is required to refund")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		// Lock every charge on this receipt first. GetRefundableByReceipt is an
		// unlocked read, so two concurrent whole-receipt refunds would both see the
		// same refundable lines and both post reversals — the patient paid back twice.
		if _, e := tx.Exec(ctx,
			`SELECT 1 FROM charges WHERE tenant_id = $1 AND receipt_no = $2 AND deleted_at IS NULL FOR UPDATE`,
			tenantID, receiptNo); e != nil {
			return e
		}
		rows, e := q.GetRefundableByReceipt(ctx, billingdb.GetRefundableByReceiptParams{TenantID: tenantID, ReceiptNo: &receiptNo})
		if e != nil {
			return e
		}
		if len(rows) == 0 {
			return apperr.Conflict("NOTHING_TO_REFUND", "this payment has already been fully refunded")
		}
		for _, r := range rows {
			origID := r.ID
			rev, e := q.CreateReversalCharge(ctx, billingdb.CreateReversalChargeParams{
				TenantID: tenantID, PatientID: r.PatientID, EncounterID: r.EncounterID,
				Description: "Refund: " + reason + " (re: " + r.Description + ")",
				Amount:      negate(r.Amount), Currency: r.Currency,
				PaymentMethod: strPtr("refund"), SettledBy: actor, ReversesChargeID: &origID, CreatedBy: actor,
			})
			if e != nil {
				return e
			}
			if e := stampReceipt(ctx, q, tenantID, rev.ID); e != nil {
				return e
			}
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "charge", uuid.Nil, "billing.visit.refunded",
			map[string]any{"receipt_no": receiptNo, "lines": len(rows), "reason": reason})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if alreadyRefunded(err) {
		return apperr.Conflict("ALREADY_REFUNDED", "part of this payment has already been refunded")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) CashSince(ctx context.Context, since time.Time, until *time.Time) (*billing.CashSummary, error) {
	tenantID, _ := actorOf(ctx)
	out := &billing.CashSummary{BySource: []billing.CashLine{}}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		col, e := q.CashCollectedSince(ctx, billingdb.CashCollectedSinceParams{TenantID: tenantID, Since: &since, Until: until})
		if e != nil {
			return e
		}
		out.Collected, out.CollectedCount = col.Total, int(col.N)
		wv, e := q.CashWaivedSince(ctx, billingdb.CashWaivedSinceParams{TenantID: tenantID, Since: &since, Until: until})
		if e != nil {
			return e
		}
		out.Waived, out.WaivedCount = wv.Total, int(wv.N)
		os, e := q.CashOutstanding(ctx, tenantID)
		if e != nil {
			return e
		}
		out.Outstanding, out.OutstandingCount = os.Total, int(os.N)
		rf, e := q.CashRefundedSince(ctx, billingdb.CashRefundedSinceParams{TenantID: tenantID, Since: &since, Until: until})
		if e != nil {
			return e
		}
		out.Refunded, out.RefundedCount = rf.Total, int(rf.N)
		by, e := q.CashBySourceSince(ctx, billingdb.CashBySourceSinceParams{TenantID: tenantID, Since: &since, Until: until})
		if e != nil {
			return e
		}
		for _, r := range by {
			out.BySource = append(out.BySource, billing.CashLine{Source: r.Source, Total: r.Total, Count: int(r.N)})
		}
		bm, e := q.CashByMethodSince(ctx, billingdb.CashByMethodSinceParams{TenantID: tenantID, Since: &since, Until: until})
		if e != nil {
			return e
		}
		for _, r := range bm {
			out.ByMethod = append(out.ByMethod, billing.CashGroup{Label: r.Method, Total: r.Total, Count: int(r.N)})
		}
		bc, e := q.CashByCashierSince(ctx, billingdb.CashByCashierSinceParams{TenantID: tenantID, Since: &since, Until: until})
		if e != nil {
			return e
		}
		for _, r := range bc {
			out.ByCashier = append(out.ByCashier, billing.CashGroup{Label: r.Cashier, Total: r.Total, Count: int(r.N)})
		}
		bb, e := q.CashByBranchSince(ctx, billingdb.CashByBranchSinceParams{TenantID: tenantID, Since: &since, Until: until})
		if e != nil {
			return e
		}
		for _, r := range bb {
			out.ByBranch = append(out.ByBranch, billing.CashGroup{Label: r.Branch, Total: r.Total, Count: int(r.N)})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// stampReceipt assigns the next per-tenant receipt number to a charge that just
// took money (a settlement or a refund slip).
func stampReceipt(ctx context.Context, q *billingdb.Queries, tenantID, chargeID uuid.UUID) error {
	no, e := q.NextReceiptNo(ctx, tenantID)
	if e != nil {
		return e
	}
	return q.SetChargeReceipt(ctx, billingdb.SetChargeReceiptParams{ReceiptNo: &no, TenantID: tenantID, ID: chargeID})
}

// ExpectedForDay returns the acting cashier's collected drawer for a business day
// (by method + total), and any existing closeout for that day.
func (s *Service) ExpectedForDay(ctx context.Context, date string) (*billing.ExpectedDay, error) {
	tenantID, actor := actorOf(ctx)
	if actor == nil {
		return nil, apperr.Validation("a cashier is required")
	}
	day, err := parseDay(date)
	if err != nil {
		return nil, err
	}
	out := &billing.ExpectedDay{BusinessDate: day.Format("2006-01-02"), ByMethod: []billing.CashGroup{}, ExpectedTotal: "0"}
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		dayEnd := day.Add(24 * time.Hour)
		rows, e := q.ExpectedForCashierDay(ctx, billingdb.ExpectedForCashierDayParams{TenantID: tenantID, CashierID: actor, DayStart: &day, DayEnd: &dayEnd})
		if e != nil {
			return e
		}
		var total float64
		for _, r := range rows {
			out.ByMethod = append(out.ByMethod, billing.CashGroup{Label: r.Method, Total: r.Total, Count: int(r.N)})
			total += parseMoneyB(r.Total)
		}
		out.ExpectedTotal = money2(total)
		rec, e := q.GetReconciliation(ctx, billingdb.GetReconciliationParams{TenantID: tenantID, CashierID: *actor, BusinessDate: day})
		if e == nil {
			out.Closed = true
			out.Reconciliation = &billing.Reconciliation{
				ID: rec.ID, CashierID: rec.CashierID, BusinessDate: rec.BusinessDate.Format("2006-01-02"),
				ExpectedTotal: rec.ExpectedTotal, CountedTotal: rec.CountedTotal, Variance: rec.Variance, Note: deref(rec.Note), ClosedAt: rec.ClosedAt,
			}
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		return nil
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// DayCloses lists the acting cashier's business days in [from,to] — what each day
// took and whether it was closed — so a day someone forgot to close still shows up
// and can be caught up later. Days are UTC-based, matching ExpectedForDay's window.
func (s *Service) DayCloses(ctx context.Context, from, to string) ([]billing.DaySummary, error) {
	tenantID, actor := actorOf(ctx)
	if actor == nil {
		return nil, apperr.Validation("a cashier is required")
	}
	fromDay, err := parseDay(from)
	if err != nil {
		return nil, err
	}
	toDay, err := parseDay(to)
	if err != nil {
		return nil, err
	}
	out := []billing.DaySummary{}
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`WITH act AS (
			   SELECT (settled_at AT TIME ZONE 'UTC')::date AS day, sum(amount)::numeric AS total, count(*)::int AS n
			   FROM charges
			   WHERE tenant_id = $1 AND settled_by = $2 AND status = 'paid' AND source <> 'refund'
			     AND settled_at >= $3::date AND settled_at < ($4::date + INTERVAL '1 day')
			   GROUP BY 1
			 ), rec AS (
			   SELECT business_date AS day, counted_total, variance, coalesce(note,'') AS note, closed_at
			   FROM cash_reconciliations
			   WHERE tenant_id = $1 AND cashier_id = $2 AND business_date >= $3::date AND business_date <= $4::date
			 ), days AS (SELECT day FROM act UNION SELECT day FROM rec)
			 SELECT d.day::text, coalesce(a.total,0)::text, coalesce(a.n,0),
			        (r.day IS NOT NULL), coalesce(r.counted_total::text,''), coalesce(r.variance::text,''),
			        coalesce(r.note,''), r.closed_at
			 FROM days d
			 LEFT JOIN act a ON a.day = d.day
			 LEFT JOIN rec r ON r.day = d.day
			 ORDER BY d.day DESC`,
			tenantID, *actor, fromDay, toDay)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var d billing.DaySummary
			var closedAt *time.Time
			if e := rows.Scan(&d.BusinessDate, &d.ExpectedTotal, &d.Count, &d.Closed, &d.CountedTotal, &d.Variance, &d.Note, &closedAt); e != nil {
				return e
			}
			d.ClosedAt = closedAt
			out = append(out, d)
		}
		return rows.Err()
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// CloseDay records a counted drawer against the expected total for the acting
// cashier and returns the Z-report (idempotent per cashier per day).
func (s *Service) CloseDay(ctx context.Context, in billing.CloseDayInput) (*billing.Reconciliation, error) {
	tenantID, actor := actorOf(ctx)
	if actor == nil {
		return nil, apperr.Validation("a cashier is required")
	}
	day, err := parseDay(in.BusinessDate)
	if err != nil {
		return nil, err
	}
	counted := parseMoneyB(in.Counted)
	var out billing.Reconciliation
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := billingdb.New(tx)
		dayEnd := day.Add(24 * time.Hour)
		rows, e := q.ExpectedForCashierDay(ctx, billingdb.ExpectedForCashierDayParams{TenantID: tenantID, CashierID: actor, DayStart: &day, DayEnd: &dayEnd})
		if e != nil {
			return e
		}
		var expected float64
		methods := map[string]string{}
		for _, r := range rows {
			expected += parseMoneyB(r.Total)
			methods[r.Method] = r.Total
		}
		byMethodJSON, _ := json.Marshal(methods)
		variance := counted - expected
		rec, e := q.InsertReconciliation(ctx, billingdb.InsertReconciliationParams{
			TenantID: tenantID, CashierID: *actor, BusinessDate: day,
			ExpectedTotal: money2(expected), CountedTotal: money2(counted), Variance: money2(variance),
			ByMethod: string(byMethodJSON), Note: strPtr(in.Note), ClosedBy: actor,
		})
		if e != nil {
			return e
		}
		out = billing.Reconciliation{
			ID: rec.ID, CashierID: *actor, BusinessDate: day.Format("2006-01-02"),
			ExpectedTotal: money2(expected), CountedTotal: money2(counted), Variance: money2(variance), Note: in.Note, ClosedAt: rec.ClosedAt,
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "cash_reconciliation", rec.ID, "billing.day.closed",
			map[string]any{"cashier_id": *actor, "business_date": out.BusinessDate, "variance": out.Variance})
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// Reconciliations lists closeouts — the acting cashier's own, or all (finance view).
func (s *Service) Reconciliations(ctx context.Context, all bool) ([]billing.Reconciliation, error) {
	tenantID, actor := actorOf(ctx)
	out := []billing.Reconciliation{}
	var filter *uuid.UUID
	if !all {
		filter = actor
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := billingdb.New(tx).ListReconciliations(ctx, billingdb.ListReconciliationsParams{TenantID: tenantID, CashierID: filter})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, billing.Reconciliation{
				ID: r.ID, CashierID: r.CashierID, Cashier: r.Cashier, BusinessDate: r.BusinessDate.Format("2006-01-02"),
				ExpectedTotal: r.ExpectedTotal, CountedTotal: r.CountedTotal, Variance: r.Variance, Note: deref(r.Note), ClosedAt: r.ClosedAt,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// parseDay parses a YYYY-MM-DD business date (UTC midnight); empty = today UTC.
func parseDay(s string) (time.Time, error) {
	if strings.TrimSpace(s) == "" {
		return startOfDayUTC(), nil
	}
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, apperr.Validation("date must be YYYY-MM-DD")
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC), nil
}

func parseMoneyB(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f
}

func money2(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) }

// advanceIfPaid enqueues the patient (auto-advance after payment) once a routed
// visit charge is settled/waived AND nothing is still owed — so multiple line-items
// (e.g. registration + consultation) advance the patient exactly once, after the
// last payment. Routing is only set on reception's visit charges, so non-visit
// charges (a standalone procedure with no routing) never enqueue.
func advanceIfPaid(ctx context.Context, tx pgx.Tx, q *billingdb.Queries, tenantID uuid.UUID, actor *uuid.UUID, branchID, departmentID *uuid.UUID, toTriage bool, providerID *uuid.UUID, patientID uuid.UUID) error {
	if branchID == nil || departmentID == nil {
		return nil // not a routed visit charge
	}
	// The gate is about THIS VISIT's fee, not about everything the patient has ever
	// owed. Counting every pending charge meant an unrelated debt — a dental
	// instalment from last month, say — kept a patient who had just paid today's
	// consultation out of the queue, with nothing on any screen saying why. A clinic
	// deciding not to see someone over an old balance is a care decision for a human,
	// not a side effect of a COUNT.
	//
	// Routed charges (department set) are the ones raised to let a patient in; those
	// are what must be clear. Raw pgx because sqlc cannot be regenerated here.
	// A deferred charge is money the clinic has agreed to be owed, so it does not hold
	// the patient at the door — that is the whole point of agreeing to it. It stays
	// pending and stays owed; it simply stops being a gate.
	var pending int
	if e := tx.QueryRow(ctx,
		`SELECT count(*)::int FROM charges
		  WHERE tenant_id = $1 AND patient_id = $2 AND status = 'pending'
		    AND deleted_at IS NULL AND department_id IS NOT NULL
		    AND deferred_at IS NULL`,
		tenantID, patientID).Scan(&pending); e != nil {
		return e
	}
	if pending > 0 {
		return nil // this visit is not paid for yet
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
	// Clinic policy: when triage is required, force the triage stage (the provider is
	// assigned by the nurse afterwards) — no door can bypass it.
	if req, _ := q.ClinicRequiresTriage(ctx, tenantID); req {
		stage = "triage"
		providerID = nil
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

// negate flips the sign of a decimal-string amount (for refund reversing entries).
func negate(p string) string {
	p = strings.TrimSpace(p)
	switch {
	case p == "" || p == "0" || p == "0.00":
		return "0"
	case strings.HasPrefix(p, "-"):
		return p[1:]
	default:
		return "-" + p
	}
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
