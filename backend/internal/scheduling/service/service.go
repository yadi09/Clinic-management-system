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
}

var _ scheduling.Service = (*Service)(nil)

// NewService constructs a scheduling Service.
func NewService(db *kerneldb.DB, publisher events.Publisher) *Service {
	return &Service{db: db, publisher: publisher}
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
	ends := in.StartsAt.Add(time.Duration(dur) * time.Minute)

	var row schedulingdb.CreateAppointmentRow
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		row, e = schedulingdb.New(tx).CreateAppointment(ctx, schedulingdb.CreateAppointmentParams{
			TenantID: tenantID, BranchID: in.BranchID, DepartmentID: in.DepartmentID, PatientID: in.PatientID,
			ProviderID: in.ProviderID, ResourceID: in.ResourceID, StartsAt: in.StartsAt, EndsAt: ends,
			Reason: strPtr(in.Reason), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "appointment", row.ID, "scheduling.appointment.booked",
			map[string]any{"appointment_id": row.ID, "patient_id": in.PatientID, "provider_id": in.ProviderID, "starts_at": in.StartsAt})
	}); err != nil {
		return nil, mapBookErr(err)
	}
	return &scheduling.Appointment{
		ID: row.ID, PatientID: in.PatientID, ProviderID: in.ProviderID, DepartmentID: in.DepartmentID,
		ResourceID: in.ResourceID, StartsAt: row.StartsAt, EndsAt: row.EndsAt, Status: row.Status, Reason: in.Reason,
	}, nil
}

// List returns appointments in [from, to) for a branch, optionally one provider.
func (s *Service) List(ctx context.Context, branchID uuid.UUID, from, to time.Time, providerID *uuid.UUID) ([]scheduling.Appointment, error) {
	tenantID, _ := actorOf(ctx)
	var out []scheduling.Appointment
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListAppointments(ctx, schedulingdb.ListAppointmentsParams{
			TenantID: tenantID, BranchID: branchID, FromTs: from, ToTs: to, ProviderID: providerID,
		})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, scheduling.Appointment{
				ID: r.ID, PatientID: r.PatientID, ProviderID: r.ProviderID, DepartmentID: r.DepartmentID,
				ResourceID: r.ResourceID, StartsAt: r.StartsAt, EndsAt: r.EndsAt, Status: r.Status, Reason: deref(r.Reason),
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, ProviderName: r.ProviderName, DepartmentName: deref(r.DepartmentName),
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

// CheckIn marks an appointment checked-in and enqueues the patient (FR-QUE-01).
// Routing: to triage (nurse assigns later) or straight to a doctor (the chosen
// provider, defaulting to the appointment's booked provider).
func (s *Service) CheckIn(ctx context.Context, id uuid.UUID, in scheduling.CheckInInput) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		appt, e := q.GetAppointment(ctx, schedulingdb.GetAppointmentParams{TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		if appt.DepartmentID == nil {
			return apperr.Validation("assign a department to the appointment before check-in")
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
		qe, e := q.CreateQueueEntry(ctx, schedulingdb.CreateQueueEntryParams{
			TenantID: tenantID, BranchID: appt.BranchID, DepartmentID: *appt.DepartmentID, PatientID: appt.PatientID,
			AppointmentID: &id, Stage: stage, AssignedProviderID: prov, Priority: int32(in.Priority), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		notifyQueue(ctx, q, tenantID, qe.BranchID, qe.DepartmentID)
		return s.publisher.Publish(ctx, tx, &tenantID, "appointment", id, "scheduling.patient.checked_in",
			map[string]any{"appointment_id": id, "patient_id": appt.PatientID})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("APPOINTMENT_NOT_FOUND", "appointment not found")
	}
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// EnqueueWalkIn adds a patient to a department queue without an appointment.
func (s *Service) EnqueueWalkIn(ctx context.Context, in scheduling.WalkInInput) error {
	tenantID, actor := actorOf(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := schedulingdb.New(tx)
		stage := "with_doctor"
		if in.ToTriage {
			stage = "triage"
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
}

// ListQueue returns today's queue entries for a department, optionally filtered
// to a stage ("triage" or "with_doctor"; empty = all).
func (s *Service) ListQueue(ctx context.Context, departmentID uuid.UUID, stage string) ([]scheduling.QueueEntry, error) {
	tenantID, _ := actorOf(ctx)
	var st *string
	if stage != "" {
		st = &stage
	}
	var out []scheduling.QueueEntry
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListQueue(ctx, schedulingdb.ListQueueParams{TenantID: tenantID, DepartmentID: departmentID, Since: startOfDayUTC(), Stage: st})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, scheduling.QueueEntry{
				ID: r.ID, PatientID: r.PatientID, AppointmentID: r.AppointmentID, AssignedProviderID: r.AssignedProviderID,
				State: r.State, Stage: r.Stage, Priority: int(r.Priority),
				EnqueuedAt: r.EnqueuedAt, CalledAt: r.CalledAt, StartedAt: r.StartedAt, EndedAt: r.EndedAt,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, ProviderName: deref(r.ProviderName),
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
func (s *Service) ListWorklist(ctx context.Context, providerID uuid.UUID) ([]scheduling.WorklistEntry, error) {
	tenantID, _ := actorOf(ctx)
	var out []scheduling.WorklistEntry
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := schedulingdb.New(tx).ListWorklist(ctx, schedulingdb.ListWorklistParams{TenantID: tenantID, AssignedProviderID: &providerID, Since: startOfDayUTC()})
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
