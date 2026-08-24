// Package service implements the scheduling use-cases: appointment booking with
// DB-enforced conflict prevention, and the live department queue (changes emit
// a Postgres NOTIFY consumed by the SSE stream).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/scheduling"
	schedulingdb "github.com/reicb/clinicsaas/internal/scheduling/repo/gen"
)

const defaultDuration = 30

var validStatus = map[string]bool{"confirmed": true, "cancelled": true, "completed": true, "no_show": true}
var validQueueState = map[string]bool{"waiting": true, "called": true, "in_consult": true, "done": true, "no_show": true}

// Service implements scheduling.Service.
type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
	billing   billing.Charger
}

var _ scheduling.Service = (*Service)(nil)

// NewService constructs a scheduling Service. The billing Charger lets walk-in /
// appointment check-in raise the default intake charge so the queue entry is gated
// on payment (no free bypass of the cashier).
func NewService(db *kerneldb.DB, publisher events.Publisher, charger billing.Charger) *Service {
	return &Service{db: db, publisher: publisher, billing: charger}
}

// Book creates an appointment; overlapping provider/resource times are rejected
// by the DB exclusion constraints (FR-APT-01).
func (s *Service) Book(ctx context.Context, in scheduling.BookInput) (*scheduling.Appointment, error) {
	tenantID, actor := actorOf(ctx)
	dur := in.DurationMin
	if dur <= 0 {
		dur = defaultDuration
	}
	if dur > 240 {
		return nil, apperr.Validation("duration must be 240 minutes or less")
	}
	if in.StartsAt.IsZero() {
		return nil, apperr.Validation("a start time is required")
	}
	// A department is what makes an appointment receivable. Check-in refuses an
	// appointment without one ("assign a department before check-in"), so booking
	// without it produced a record the front desk could not process — two of them
	// were sitting in a live clinic's diary. It is required here, at the only gate
	// every caller passes through.
	if in.DepartmentID == nil {
		return nil, apperr.Validation("choose a department — the front desk cannot receive an appointment without one")
	}
	ends := in.StartsAt.Add(time.Duration(dur) * time.Minute)
	// A follow-up is owned by the doctor who ordered it; default that to the actor.
	orderedBy := in.OrderedBy
	if in.IsFollowup && orderedBy == nil {
		orderedBy = actor
	}

	var row schedulingdb.CreateAppointmentRow
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		row, e = schedulingdb.New(tx).CreateAppointment(ctx, schedulingdb.CreateAppointmentParams{
			TenantID: tenantID, BranchID: in.BranchID, DepartmentID: in.DepartmentID, PatientID: in.PatientID,
			ProviderID: in.ProviderID, ResourceID: in.ResourceID, StartsAt: in.StartsAt, EndsAt: ends,
			Reason: strPtr(in.Reason), IsFollowup: in.IsFollowup, FreeUntil: in.FreeUntil,
			OrderedBy: orderedBy, OriginEncounterID: in.OriginEncounterID, CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		event := "scheduling.appointment.booked"
		if in.IsFollowup {
			event = "scheduling.followup.booked"
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "appointment", row.ID, event,
			map[string]any{"appointment_id": row.ID, "patient_id": in.PatientID, "provider_id": in.ProviderID, "starts_at": in.StartsAt, "is_followup": in.IsFollowup})
	}); err != nil {
		return nil, mapBookErr(err)
	}
	return &scheduling.Appointment{
		ID: row.ID, PatientID: in.PatientID, ProviderID: in.ProviderID, DepartmentID: in.DepartmentID,
		ResourceID: in.ResourceID, OrderedBy: orderedBy, OriginEncounterID: in.OriginEncounterID,
		StartsAt: row.StartsAt, EndsAt: row.EndsAt, Status: row.Status, Reason: in.Reason, IsFollowup: in.IsFollowup, FreeUntil: in.FreeUntil,
	}, nil
}

// List returns appointments in [from, to) for a branch, optionally one provider.
func (s *Service) List(ctx context.Context, branchID uuid.UUID, from, to time.Time, providerID *uuid.UUID) ([]scheduling.Appointment, error) {
	tenantID, _ := actorOf(ctx)
	// Branch isolation: a user scoped to a concrete active branch only ever sees
	// that branch's appointments, regardless of the branch requested by the client.
	if ab := activeBranchOf(ctx); ab != nil {
		branchID = *ab
	}
	var out []scheduling.Appointment
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListAppointments(ctx, schedulingdb.ListAppointmentsParams{
			TenantID: tenantID, BranchID: branchID, FromTs: from, ToTs: to, ProviderID: providerID, OnlyFollowup: false,
		})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, scheduling.Appointment{
				ID: r.ID, PatientID: r.PatientID, ProviderID: r.ProviderID, DepartmentID: r.DepartmentID,
				ResourceID: r.ResourceID, OrderedBy: r.OrderedBy, OriginEncounterID: r.OriginEncounterID,
				StartsAt: r.StartsAt, EndsAt: r.EndsAt, Status: r.Status, Reason: deref(r.Reason),
				IsFollowup: r.IsFollowup, FreeUntil: r.FreeUntil,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, ProviderName: r.ProviderName, ProviderActive: r.ProviderActive,
				OrderedByName: deref(r.OrderedByName), DepartmentName: deref(r.DepartmentName),
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ListForPatient returns one patient's appointments across the whole date range —
// the patient's own schedule, rather than a day on the clinic's calendar.
//
// Unlike List this is NOT branch-scoped by default: a patient's history belongs to
// the patient, and a clinic with two branches should still see one timeline. A user
// pinned to a single branch stays pinned, so branch isolation is never weakened.
func (s *Service) ListForPatient(ctx context.Context, patientID uuid.UUID, from, to time.Time) ([]scheduling.Appointment, error) {
	tenantID, _ := actorOf(ctx)
	branch := activeBranchOf(ctx) // nil = "all branches" scope
	out := []scheduling.Appointment{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT a.id, a.patient_id, a.provider_id, a.department_id, a.resource_id,
			        a.starts_at, a.ends_at, a.status, coalesce(a.reason,''), a.is_followup, a.free_until,
			        a.ordered_by, a.origin_encounter_id,
			        p.first_name, coalesce(p.last_name,''), p.mrn,
			        u.full_name, (u.status = 'active'),
			        coalesce(ob.full_name,''), coalesce(d.name,'')
			 FROM appointments a
			 JOIN patients p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
			 JOIN users u ON u.id = a.provider_id AND u.tenant_id = a.tenant_id
			 LEFT JOIN users ob ON ob.id = a.ordered_by AND ob.tenant_id = a.tenant_id
			 LEFT JOIN departments d ON d.id = a.department_id AND d.tenant_id = a.tenant_id
			 WHERE a.tenant_id = $1 AND a.patient_id = $2 AND a.deleted_at IS NULL
			   AND a.starts_at >= $3 AND a.starts_at < $4
			   AND ($5::uuid IS NULL OR a.branch_id = $5)
			 ORDER BY a.starts_at`,
			tenantID, patientID, from, to, branch)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var a scheduling.Appointment
			var first, last string
			if e := rows.Scan(&a.ID, &a.PatientID, &a.ProviderID, &a.DepartmentID, &a.ResourceID,
				&a.StartsAt, &a.EndsAt, &a.Status, &a.Reason, &a.IsFollowup, &a.FreeUntil,
				&a.OrderedBy, &a.OriginEncounterID,
				&first, &last, &a.MRN, &a.ProviderName, &a.ProviderActive,
				&a.OrderedByName, &a.DepartmentName); e != nil {
				return e
			}
			a.PatientName = strings.TrimSpace(first + " " + last)
			out = append(out, a)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ListFollowups returns follow-up appointments in [from, to) for the follow-up
// lens. Branch isolation matches List: a branch-scoped user only sees their branch.
func (s *Service) ListFollowups(ctx context.Context, branchID uuid.UUID, from, to time.Time) ([]scheduling.Appointment, error) {
	tenantID, _ := actorOf(ctx)
	if ab := activeBranchOf(ctx); ab != nil {
		branchID = *ab
	}
	var out []scheduling.Appointment
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListFollowups(ctx, schedulingdb.ListFollowupsParams{
			TenantID: tenantID, BranchID: branchID, FromTs: from, ToTs: to,
		})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, scheduling.Appointment{
				ID: r.ID, PatientID: r.PatientID, ProviderID: r.ProviderID, DepartmentID: r.DepartmentID,
				ResourceID: r.ResourceID, OrderedBy: r.OrderedBy, OriginEncounterID: r.OriginEncounterID,
				StartsAt: r.StartsAt, EndsAt: r.EndsAt, Status: r.Status, Reason: deref(r.Reason),
				IsFollowup: r.IsFollowup, FreeUntil: r.FreeUntil,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, ProviderName: r.ProviderName, ProviderActive: r.ProviderActive,
				OrderedByName: deref(r.OrderedByName), DepartmentName: deref(r.DepartmentName),
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// Reschedule moves an appointment (conflict-checked).
func (s *Service) Reschedule(ctx context.Context, id uuid.UUID, in scheduling.RescheduleInput) (*scheduling.Appointment, error) {
	tenantID, _ := actorOf(ctx)
	dur := in.DurationMin
	if dur <= 0 {
		dur = defaultDuration
	}
	// Same rule as booking: a reschedule must not be able to strip the department out
	// and leave a booking the desk cannot receive.
	if in.DepartmentID == nil {
		return nil, apperr.Validation("choose a department — the front desk cannot receive an appointment without one")
	}
	ends := in.StartsAt.Add(time.Duration(dur) * time.Minute)
	var appt schedulingdb.GetAppointmentRow
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		if _, e := q.RescheduleAppointment(ctx, schedulingdb.RescheduleAppointmentParams{
			StartsAt: in.StartsAt, EndsAt: ends, ProviderID: in.ProviderID, ResourceID: in.ResourceID,
			DepartmentID: in.DepartmentID, Reason: strPtr(in.Reason), TenantID: tenantID, ID: id,
		}); e != nil {
			return e
		}
		var e error
		appt, e = q.GetAppointment(ctx, schedulingdb.GetAppointmentParams{TenantID: tenantID, ID: id})
		return e
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("APPOINTMENT_NOT_FOUND", "appointment not found")
		}
		return nil, mapBookErr(err)
	}
	return &scheduling.Appointment{
		ID: appt.ID, PatientID: appt.PatientID, ProviderID: appt.ProviderID, DepartmentID: appt.DepartmentID,
		ResourceID: appt.ResourceID, StartsAt: appt.StartsAt, EndsAt: appt.EndsAt, Status: appt.Status, Reason: deref(appt.Reason),
	}, nil
}

// SetStatus confirms/cancels/completes/no-shows an appointment (FR-APT-02).
func (s *Service) SetStatus(ctx context.Context, id uuid.UUID, status, cancelReason string) error {
	if !validStatus[status] {
		return apperr.Validation("invalid status")
	}
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := schedulingdb.New(tx).SetAppointmentStatus(ctx, schedulingdb.SetAppointmentStatusParams{
			Status: status, CancelReason: strPtr(cancelReason), TenantID: tenantID, ID: id,
		})
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("APPOINTMENT_NOT_FOUND", "appointment not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// MarkFollowup flags an appointment as a covered (doctor-booked) follow-up that
// is free of the card fee when attended on or before freeUntil.
func (s *Service) MarkFollowup(ctx context.Context, id uuid.UUID, freeUntil time.Time) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := schedulingdb.New(tx).SetAppointmentFollowup(ctx, schedulingdb.SetAppointmentFollowupParams{
			IsFollowup: true, FreeUntil: &freeUntil, TenantID: tenantID, ID: id,
		})
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("APPOINTMENT_NOT_FOUND", "appointment not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ReassignProvider hands a follow-up (or any appointment) to a covering doctor:
// it changes who attends (provider_id) while leaving ordered_by intact, so the
// record still shows who ordered it. A time clash with the new provider's schedule
// is rejected by the DB exclusion constraint (APPOINTMENT_CONFLICT).
func (s *Service) ReassignProvider(ctx context.Context, id, providerID uuid.UUID, note string) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		row, e := q.ReassignAppointmentProvider(ctx, schedulingdb.ReassignAppointmentProviderParams{
			ProviderID: providerID, TenantID: tenantID, ID: id,
		})
		if e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "appointment", id, "scheduling.appointment.reassigned",
			map[string]any{"appointment_id": id, "patient_id": row.PatientID, "provider_id": providerID, "ordered_by": row.OrderedBy, "reassigned_by": actor, "note": note})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("APPOINTMENT_NOT_FOUND", "appointment not found")
	}
	if err != nil {
		return mapBookErr(err)
	}
	return nil
}

// CheckIn marks an appointment checked-in and enqueues the patient (FR-QUE-01).
// Routing: to triage (nurse assigns later) or straight to a doctor (the chosen
// provider, defaulting to the appointment's booked provider).
func (s *Service) CheckIn(ctx context.Context, id uuid.UUID, in scheduling.CheckInInput) (*scheduling.CheckInResult, error) {
	tenantID, actor := actorOf(ctx)
	out := &scheduling.CheckInResult{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		appt, e := q.GetAppointment(ctx, schedulingdb.GetAppointmentParams{TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		// Booking now requires a department, but appointments made before that rule
		// exist and are otherwise unreceivable — a dead row in a live diary. The desk
		// can supply one at the door. It never overrides a department the appointment
		// already has: that would quietly send a patient somewhere they were not booked.
		dept := appt.DepartmentID
		rescued := false
		if dept == nil {
			dept = in.DepartmentID
			rescued = dept != nil
		}
		if dept == nil {
			return apperr.Validation("this appointment has no department — choose one to receive the patient")
		}
		// Write it back, so the diary agrees with the queue. Otherwise the department
		// lives only on the charge and the appointment keeps reading as department-less
		// on every other surface that shows it. Raw SQL: sqlc is not available here.
		if rescued {
			if _, e := tx.Exec(ctx, `UPDATE appointments SET department_id = $1, updated_at = now()
				WHERE tenant_id = $2 AND id = $3 AND department_id IS NULL`, *dept, tenantID, id); e != nil {
				return e
			}
		}
		// Clinic policy: when triage is required, no door sends straight to a doctor.
		if req, _ := q.ClinicRequiresTriage(ctx, tenantID); req {
			in.ToTriage = true
		}
		if _, e := q.SetAppointmentStatus(ctx, schedulingdb.SetAppointmentStatusParams{Status: "checked_in", TenantID: tenantID, ID: id}); e != nil {
			return e
		}
		stage := "with_doctor"
		prov := in.ProviderID
		if in.ToTriage {
			stage = "triage"
		} else if prov == nil {
			p := appt.ProviderID
			prov = &p
		}
		// Billing gate: raise the default intake charge (routed). If any was raised the
		// patient waits for payment — settlement enqueues them (advanceIfPaid). Otherwise
		// (no default fee) enqueue immediately.
		ids, e := s.billing.RaiseIntakeChargeIDsTx(ctx, tx, billing.IntakeInput{
			PatientID: appt.PatientID, BranchID: appt.BranchID, DepartmentID: *dept, ToTriage: in.ToTriage, ProviderID: prov,
			AppointmentID: &id,
		})
		if e != nil {
			return e
		}
		// The desk needs to know WHICH charges this arrival created, so it can collect
		// exactly this visit and not whatever else the patient owes.
		out.ChargeIDs = ids
		out.Gated = len(ids) > 0
		if !out.Gated {
			qe, e := q.CreateQueueEntry(ctx, schedulingdb.CreateQueueEntryParams{
				TenantID: tenantID, BranchID: appt.BranchID, DepartmentID: *dept, PatientID: appt.PatientID,
				AppointmentID: &id, Stage: stage, AssignedProviderID: prov, Priority: int32(in.Priority), CreatedBy: actor,
			})
			if e != nil {
				return e
			}
			notifyQueue(ctx, q, tenantID, qe.BranchID, qe.DepartmentID)
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "appointment", id, "scheduling.patient.checked_in",
			map[string]any{"appointment_id": id, "patient_id": appt.PatientID, "gated": out.Gated})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("APPOINTMENT_NOT_FOUND", "appointment not found")
	}
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// EnqueueWalkIn adds a patient to a department queue without an appointment.
func (s *Service) EnqueueWalkIn(ctx context.Context, in scheduling.WalkInInput) (bool, error) {
	tenantID, actor := actorOf(ctx)
	var gated bool
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		// Clinic policy: when triage is required, no door sends straight to a doctor.
		if req, _ := q.ClinicRequiresTriage(ctx, tenantID); req {
			in.ToTriage = true
		}
		stage := "with_doctor"
		if in.ToTriage {
			stage = "triage"
		}
		// Billing gate: raise the default intake charge (routed). If any was raised the
		// patient waits for payment (settlement enqueues them); otherwise enqueue now.
		raised, e := s.billing.RaiseIntakeChargesTx(ctx, tx, billing.IntakeInput{
			PatientID: in.PatientID, BranchID: in.BranchID, DepartmentID: in.DepartmentID, ToTriage: in.ToTriage, ProviderID: in.ProviderID,
		})
		if e != nil {
			return e
		}
		gated = raised > 0
		if gated {
			return nil
		}
		qe, e := q.CreateQueueEntry(ctx, schedulingdb.CreateQueueEntryParams{
			TenantID: tenantID, BranchID: in.BranchID, DepartmentID: in.DepartmentID, PatientID: in.PatientID,
			AppointmentID: nil, Stage: stage, AssignedProviderID: in.ProviderID, Priority: int32(in.Priority), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		notifyQueue(ctx, q, tenantID, qe.BranchID, qe.DepartmentID)
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return false, ae
	}
	if err != nil {
		return false, apperr.Internal(err)
	}
	return gated, nil
}

// ListQueue returns a department's queue entries within [from, until) — used by
// the live board's date filter (today / yesterday / last 3 days). A zero `from`
// defaults to the start of today (UTC); a nil `until` means no upper bound.
// Optionally filtered to a stage ("triage" or "with_doctor"; empty = all).
func (s *Service) ListQueue(ctx context.Context, departmentID uuid.UUID, stage string, from time.Time, until *time.Time) ([]scheduling.QueueEntry, error) {
	tenantID, _ := actorOf(ctx)
	var st *string
	if stage != "" {
		st = &stage
	}
	if from.IsZero() {
		from = startOfDayUTC()
	}
	var out []scheduling.QueueEntry
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListQueue(ctx, schedulingdb.ListQueueParams{TenantID: tenantID, BranchID: activeBranchOf(ctx), DepartmentID: departmentID, Since: from, Until: until, Stage: st})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, scheduling.QueueEntry{
				ID: r.ID, PatientID: r.PatientID, AppointmentID: r.AppointmentID, AssignedProviderID: r.AssignedProviderID,
				State: r.State, Stage: r.Stage, Priority: int(r.Priority),
				EnqueuedAt: r.EnqueuedAt, CalledAt: r.CalledAt, StartedAt: r.StartedAt, EndedAt: r.EndedAt,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, ProviderName: deref(r.ProviderName), HasVitals: r.HasVitals, InLab: r.InLab,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ListUnassigned returns patients past triage (stage=with_doctor) who are waiting
// but not yet claimed by any doctor — the pick-up pool. Windowed by `from`.
func (s *Service) ListUnassigned(ctx context.Context, from time.Time, until *time.Time) ([]scheduling.WorklistEntry, error) {
	tenantID, _ := actorOf(ctx)
	if from.IsZero() {
		from = startOfDayUTC()
	}
	var out []scheduling.WorklistEntry
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListUnassignedReady(ctx, schedulingdb.ListUnassignedReadyParams{TenantID: tenantID, BranchID: activeBranchOf(ctx), Since: from, Until: until})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, scheduling.WorklistEntry{
				ID: r.ID, PatientID: r.PatientID, DepartmentID: r.DepartmentID, State: r.State, Stage: r.Stage, Priority: int(r.Priority),
				EnqueuedAt: r.EnqueuedAt, CalledAt: r.CalledAt, StartedAt: r.StartedAt,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, DepartmentName: deref(r.DepartmentName),
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ListWorklist returns the active patients assigned to one provider (their
// personal "patients waiting for me" list), across departments.
func (s *Service) ListWorklist(ctx context.Context, providerID uuid.UUID, from time.Time, until *time.Time) ([]scheduling.WorklistEntry, error) {
	tenantID, _ := actorOf(ctx)
	if from.IsZero() {
		from = startOfDayUTC()
	}
	var out []scheduling.WorklistEntry
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListWorklist(ctx, schedulingdb.ListWorklistParams{TenantID: tenantID, AssignedProviderID: &providerID, BranchID: activeBranchOf(ctx), Since: from, Until: until})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, scheduling.WorklistEntry{
				ID: r.ID, PatientID: r.PatientID, DepartmentID: r.DepartmentID, State: r.State, Stage: r.Stage, Priority: int(r.Priority),
				EnqueuedAt: r.EnqueuedAt, CalledAt: r.CalledAt, StartedAt: r.StartedAt,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, DepartmentName: deref(r.DepartmentName),
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// AssignProvider routes a queue entry to a doctor (and moves it to the
// with-doctor stage), so it appears on that doctor's worklist.
func (s *Service) AssignProvider(ctx context.Context, id, providerID uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		// Triage gate: a patient cannot be sent to a doctor until vitals are recorded.
		if rd, e := q.GetTriageReadiness(ctx, schedulingdb.GetTriageReadinessParams{TenantID: tenantID, ID: id}); e == nil {
			if rd.Stage == "triage" && !rd.HasVitals {
				return apperr.Conflict("VITALS_REQUIRED", "record vitals before assigning the patient to a doctor")
			}
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		r, e := q.AssignQueueProvider(ctx, schedulingdb.AssignQueueProviderParams{AssignedProviderID: &providerID, TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		notifyQueue(ctx, q, tenantID, r.BranchID, r.DepartmentID)
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("QUEUE_ENTRY_NOT_FOUND", "queue entry not found")
	}
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// TransitionQueue moves a queue entry to a new state (FR-QUE-01).
func (s *Service) TransitionQueue(ctx context.Context, id uuid.UUID, state string) error {
	if !validQueueState[state] {
		return apperr.Validation("invalid queue state")
	}
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		r, e := q.TransitionQueueEntry(ctx, schedulingdb.TransitionQueueEntryParams{State: state, TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		notifyQueue(ctx, q, tenantID, r.BranchID, r.DepartmentID)
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("QUEUE_ENTRY_NOT_FOUND", "queue entry not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// SetQueuePriority updates a queue entry's triage priority (FR-QUE-03).
func (s *Service) SetQueuePriority(ctx context.Context, id uuid.UUID, priority int) error {
	tenantID, _ := actorOf(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return schedulingdb.New(tx).SetQueuePriority(ctx, schedulingdb.SetQueuePriorityParams{Priority: int32(priority), TenantID: tenantID, ID: id})
	})
}

// --- helpers ---

func notifyQueue(ctx context.Context, q *schedulingdb.Queries, tenantID, branchID, departmentID uuid.UUID) {
	payload, _ := json.Marshal(map[string]string{
		"tenant_id": tenantID.String(), "branch_id": branchID.String(), "department_id": departmentID.String(),
	})
	_ = q.NotifyQueue(ctx, string(payload))
}

func mapBookErr(err error) error {
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23P01" { // exclusion_violation
		return apperr.Conflict("APPOINTMENT_CONFLICT", "the provider or room is already booked for that time")
	}
	return apperr.Internal(err)
}

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

// activeBranchOf returns the branch the request is scoped to, or nil for the
// consolidated "all branches" view (clinic-wide users). Branch-scoped reads pass
// this so operational data (queues, appointments) never leaks across branches.
func activeBranchOf(ctx context.Context) *uuid.UUID {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		return p.ActiveBranchID
	}
	return nil
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
