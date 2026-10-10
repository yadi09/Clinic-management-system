package service

// The registration fee policy (FEAT-REG-1).
//
// Clinics differ on how often a patient pays registration: once in their life, or
// again after a week, a month, two months. The rule is the clinic's, set once in its
// settings, and applies to every patient. This file is the only place it is decided:
// the arrival charge (RaiseIntakeChargeIDsTx) and the desk's preview
// (RegistrationStatus) both ask registrationStatusTx, so the screen can never promise
// a fee the server then does not raise, or the other way round.

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// addis is the clinic's clock. Ethiopia keeps UTC+3 all year (no daylight saving),
// so a fixed zone is exact and does not depend on the server's time-zone database.
var addis = time.FixedZone("EAT", 3*3600)

const dateOnly = "2006-01-02"

// RegistrationPolicy returns the clinic's rule. A clinic that never chose one has
// the old rule, every visit, with no registration service named.
func (s *Service) RegistrationPolicy(ctx context.Context) (*billing.RegistrationPolicy, error) {
	tid, _ := actorOf(ctx)
	var out *billing.RegistrationPolicy
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		out, e = loadRegistrationPolicyTx(ctx, tx, tid)
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SaveRegistrationPolicy replaces the clinic's rule. The registration service must
// be one of the clinic's live arrival ("default") services: a rule on anything else
// would never be consulted, which reads as a setting that silently does nothing.
func (s *Service) SaveRegistrationPolicy(ctx context.Context, in billing.RegistrationPolicy) (*billing.RegistrationPolicy, error) {
	tid, actor := actorOf(ctx)
	switch in.Rule {
	case "every_visit", "once":
		in.EveryCount, in.EveryUnit = nil, ""
	case "every":
		if in.EveryCount == nil || *in.EveryCount < 1 || *in.EveryCount > 3650 {
			return nil, apperr.Validation("say how long registration lasts: a number from 1 to 3650").WithField("every_count", "invalid")
		}
		if in.EveryUnit != "day" && in.EveryUnit != "week" && in.EveryUnit != "month" {
			return nil, apperr.Validation("registration lasts a number of days, weeks or months").WithField("every_unit", "invalid")
		}
	default:
		return nil, apperr.Validation("rule must be every_visit, once or every").WithField("rule", "invalid")
	}
	if in.Rule != "every_visit" && in.ServiceID == nil {
		return nil, apperr.Validation("choose which fee is the registration fee").WithField("service_id", "required")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var unit *string
		if in.EveryUnit != "" {
			unit = &in.EveryUnit
		}
		// Written only when the named fee is one of this clinic's live arrival fees
		// (or none is named): no row written means it was not.
		ct, e := tx.Exec(ctx,
			`INSERT INTO registration_fee_policies
			   (tenant_id, service_item_id, rule, every_count, every_unit, paper_patients_registered, updated_at, updated_by)
			 SELECT $1, $2, $3, $4, $5, $6, now(), $7
			  WHERE $2::uuid IS NULL OR EXISTS (SELECT 1 FROM service_items
			          WHERE tenant_id = $1 AND id = $2 AND is_default AND is_active AND deleted_at IS NULL)
			 ON CONFLICT (tenant_id) DO UPDATE SET
			   service_item_id = EXCLUDED.service_item_id, rule = EXCLUDED.rule,
			   every_count = EXCLUDED.every_count, every_unit = EXCLUDED.every_unit,
			   paper_patients_registered = EXCLUDED.paper_patients_registered,
			   updated_at = now(), updated_by = EXCLUDED.updated_by`,
			tid, in.ServiceID, in.Rule, in.EveryCount, unit, in.PaperPatientsRegistered, actor)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.Validation("the registration fee must be one of the fees charged when a patient arrives").WithField("service_id", "invalid")
		}
		return s.publisher.Publish(ctx, tx, &tid, "registration_policy", tid, "billing.registration_policy.saved",
			map[string]any{"rule": in.Rule, "every_count": in.EveryCount, "every_unit": in.EveryUnit,
				"paper_patients_registered": in.PaperPatientsRegistered})
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		return nil, apperr.Internal(err)
	}
	return s.RegistrationPolicy(ctx)
}

// RegistrationStatus is the desk's preview for one patient: does this arrival owe
// the registration fee, and why.
func (s *Service) RegistrationStatus(ctx context.Context, patientID uuid.UUID) (*billing.RegistrationStatus, error) {
	tid, _ := actorOf(ctx)
	var out *billing.RegistrationStatus
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var exists bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM patients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL)`,
			tid, patientID).Scan(&exists); e != nil {
			return e
		}
		if !exists {
			return apperr.NotFound("PATIENT_NOT_FOUND", "patient not found")
		}
		pol, e := loadRegistrationPolicyTx(ctx, tx, tid)
		if e != nil {
			return e
		}
		out, e = registrationStatusTx(ctx, tx, tid, patientID, pol, time.Now())
		return e
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func loadRegistrationPolicyTx(ctx context.Context, tx pgx.Tx, tid uuid.UUID) (*billing.RegistrationPolicy, error) {
	p := billing.RegistrationPolicy{Rule: "every_visit", PaperPatientsRegistered: true}
	var unit *string
	var count *int32
	err := tx.QueryRow(ctx,
		`SELECT service_item_id, rule, every_count, every_unit, paper_patients_registered
		   FROM registration_fee_policies WHERE tenant_id = $1`, tid).
		Scan(&p.ServiceID, &p.Rule, &count, &unit, &p.PaperPatientsRegistered)
	if errors.Is(err, pgx.ErrNoRows) {
		return &p, nil
	}
	if err != nil {
		return nil, err
	}
	if count != nil {
		n := int(*count)
		p.EveryCount = &n
	}
	if unit != nil {
		p.EveryUnit = *unit
	}
	return &p, nil
}

// registrationStatusTx applies the clinic's rule to one patient at the moment now.
//
// A registration counts when it was paid, waived (the clinic chose to let the
// patient in), or agreed to be paid later; a voided fee never happened, and a
// refunded one was given back, so neither counts. An unpaid fee from an earlier day
// is still owed: raising another would double the debt, so it counts too, as owed.
// A patient brought over from the paper register registered on paper; with the
// clinic's switch on, they count as registered on the day they were brought in.
// Every date is the clinic's Addis day.
func registrationStatusTx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID,
	pol *billing.RegistrationPolicy, now time.Time) (*billing.RegistrationStatus, error) {
	st := &billing.RegistrationStatus{ServiceID: pol.ServiceID, Rule: pol.Rule}
	if pol.ServiceID == nil {
		st.Due, st.Reason = true, "no_policy"
		return st, nil
	}
	if pol.Rule == "every_visit" {
		st.Due, st.Reason = true, "every_visit"
		return st, nil
	}

	var lastPaid, lastOwed *time.Time
	if err := tx.QueryRow(ctx, `
		SELECT max((c.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date)
		         FILTER (WHERE c.status IN ('paid','waived') OR c.deferred_at IS NOT NULL),
		       max((c.created_at AT TIME ZONE 'Africa/Addis_Ababa')::date)
		         FILTER (WHERE c.status = 'pending' AND c.deferred_at IS NULL)
		  FROM charges c
		 WHERE c.tenant_id = $1 AND c.patient_id = $2 AND c.service_item_id = $3 AND c.deleted_at IS NULL
		   AND c.status <> 'void'
		   AND NOT EXISTS (SELECT 1 FROM charges r
		                    WHERE r.tenant_id = c.tenant_id AND r.reverses_charge_id = c.id AND r.deleted_at IS NULL)`,
		tid, patientID, *pol.ServiceID).Scan(&lastPaid, &lastOwed); err != nil {
		return nil, err
	}
	var paperDay *time.Time
	if pol.PaperPatientsRegistered {
		if err := tx.QueryRow(ctx,
			`SELECT CASE WHEN first_visit_date IS NOT NULL
			             THEN (created_at AT TIME ZONE 'Africa/Addis_Ababa')::date END
			   FROM patients WHERE tenant_id = $1 AND id = $2`, tid, patientID).Scan(&paperDay); err != nil {
			return nil, err
		}
	}

	today := now.In(addis).Format(dateOnly)
	switch {
	case lastOwed != nil && (lastPaid == nil || !lastOwed.Before(*lastPaid)) && lastOwed.Format(dateOnly) != today:
		// An unpaid registration from an earlier visit is still owed; this arrival
		// does not add another. (Today's own pending fee is handed back by the
		// same-day rule in RaiseIntakeChargeIDsTx.)
		st.Reason, st.RegisteredOn = "owed", lastOwed.Format(dateOnly)
		return st, nil
	case lastPaid != nil:
		st.Reason, st.RegisteredOn = "registered", lastPaid.Format(dateOnly)
	case paperDay != nil:
		st.Reason, st.RegisteredOn = "paper", paperDay.Format(dateOnly)
	default:
		st.Due, st.Reason = true, "never_registered"
		return st, nil
	}
	if pol.Rule == "once" {
		return st, nil
	}
	from, err := time.ParseInLocation(dateOnly, st.RegisteredOn, addis)
	if err != nil {
		return nil, err
	}
	until := addRegistrationPeriod(from, *pol.EveryCount, pol.EveryUnit)
	st.ValidUntil = until.Format(dateOnly)
	if today >= st.ValidUntil {
		st.Due, st.Reason = true, "expired"
	}
	return st, nil
}

// addRegistrationPeriod is the day registration runs out: n days, weeks or calendar
// months after the day it was registered. A month from 31 January is the last day of
// February, not 3 March: a clinic that says "monthly" means the same date next
// month, or the month's end when there is no such date.
func addRegistrationPeriod(from time.Time, n int, unit string) time.Time {
	switch unit {
	case "week":
		return from.AddDate(0, 0, 7*n)
	case "month":
		y, m, d := from.Date()
		first := time.Date(y, m+time.Month(n), 1, 0, 0, 0, 0, from.Location())
		last := first.AddDate(0, 1, -1).Day()
		if d > last {
			d = last
		}
		return time.Date(first.Year(), first.Month(), d, 0, 0, 0, 0, from.Location())
	default:
		return from.AddDate(0, 0, n)
	}
}
