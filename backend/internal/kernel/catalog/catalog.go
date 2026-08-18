// Package catalog holds the one rule about who may put a priced service on a
// patient.
//
// The rule is per service, not per role, because clinics disagree about it: a
// two-room practice wants the front desk to add a cleaning, a larger one wants
// every clinical item to come from the chair. Expressing that as a column on the
// service lets each clinic answer for itself.
//
// It lives in the kernel because two modules raise charges — billing, for the
// general catalogue, and dental, when a treatment plan is built from a catalogued
// procedure. A rule enforced in one of those and not the other is not a rule; it
// is a suggestion with a second door next to it.
package catalog

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// AssertMayAssign checks the caller against the service's own rule. A nil service
// id means the charge was typed free-hand and there is no catalogue rule to apply.
func AssertMayAssign(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, serviceID *uuid.UUID) error {
	if serviceID == nil {
		return nil
	}
	var rule string
	e := tx.QueryRow(ctx,
		`SELECT assignable_by FROM service_items
		  WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, tenantID, *serviceID).Scan(&rule)
	if errors.Is(e, pgx.ErrNoRows) {
		return apperr.Validation("that service is not in the catalogue")
	}
	if e != nil {
		return e
	}
	if rule == "either" {
		return nil
	}
	p, ok := tenancy.PrincipalFromContext(ctx)
	if !ok {
		return apperr.Forbidden("NOT_ALLOWED", "not allowed to assign this service")
	}
	// "Clinician" is whoever records clinical work — a dentist, a doctor in an
	// encounter. "Reception" is whoever takes money at the desk. Someone who is both
	// (a small clinic's owner, very common here) passes either way.
	clinician := p.HasPermission("encounter.manage") || p.HasPermission("dental.manage")
	reception := p.HasPermission("payment.charge") || p.HasPermission("patient.create")
	if (rule == "clinician" && clinician) || (rule == "reception" && reception) {
		return nil
	}
	if rule == "clinician" {
		return apperr.Forbidden("CLINICIAN_ONLY", "only clinical staff can add this service to a patient")
	}
	return apperr.Forbidden("RECEPTION_ONLY", "this service is added at the front desk")
}
