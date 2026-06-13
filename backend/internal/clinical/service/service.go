// Package service implements the clinical use-cases for Phase 3a: opening the
// visit encounter and recording triage vitals.
package service

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/clinical"
	clinicaldb "github.com/reicb/clinicsaas/internal/clinical/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// Service implements clinical.Service.
type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
}

var _ clinical.Service = (*Service)(nil)

// NewService constructs a clinical Service.
func NewService(db *kerneldb.DB, publisher events.Publisher) *Service {
	return &Service{db: db, publisher: publisher}
}

// RecordVitals opens (or reuses) the encounter for a queue entry, then appends a
// vitals row. Both happen in one transaction.
func (s *Service) RecordVitals(ctx context.Context, in clinical.RecordVitalsInput) (*clinical.Encounter, *clinical.Vitals, error) {
	tenantID, actor := actorOf(ctx)
	var outEnc clinical.Encounter
	var outV clinical.Vitals
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		qid := in.QueueEntryID
		var encID uuid.UUID
		enc, e := q.GetEncounterByQueueEntry(ctx, clinicaldb.GetEncounterByQueueEntryParams{TenantID: tenantID, QueueEntryID: &qid})
		switch {
		case e == nil:
			encID = enc.ID
			outEnc = clinical.Encounter{ID: enc.ID, PatientID: enc.PatientID, ProviderID: enc.ProviderID, DepartmentID: enc.DepartmentID, Status: enc.Status, StartedAt: enc.StartedAt}
		case errors.Is(e, pgx.ErrNoRows):
			created, e2 := q.CreateEncounter(ctx, clinicaldb.CreateEncounterParams{
				TenantID: tenantID, BranchID: in.BranchID, DepartmentID: in.DepartmentID, PatientID: in.PatientID,
				QueueEntryID: &qid, ProviderID: in.ProviderID, CreatedBy: actor,
			})
			if e2 != nil {
				return e2
			}
			encID = created.ID
			outEnc = clinical.Encounter{ID: created.ID, PatientID: created.PatientID, ProviderID: created.ProviderID, DepartmentID: created.DepartmentID, Status: created.Status, StartedAt: created.StartedAt}
		default:
			return e
		}
		v, e := q.CreateVitals(ctx, clinicaldb.CreateVitalsParams{
			TenantID: tenantID, EncounterID: encID, PatientID: in.PatientID,
			Systolic: i32(in.Vitals.Systolic), Diastolic: i32(in.Vitals.Diastolic), Pulse: i32(in.Vitals.Pulse),
			TempC: fstr(in.Vitals.TempC), RespRate: i32(in.Vitals.RespRate), Spo2: i32(in.Vitals.Spo2),
			WeightKg: fstr(in.Vitals.WeightKg), HeightCm: fstr(in.Vitals.HeightCm), Notes: strPtr(in.Vitals.Notes), RecordedBy: actor,
		})
		if e != nil {
			return e
		}
		outV = clinical.Vitals{
			ID: v.ID, RecordedAt: v.RecordedAt,
			Systolic: in.Vitals.Systolic, Diastolic: in.Vitals.Diastolic, Pulse: in.Vitals.Pulse,
			RespRate: in.Vitals.RespRate, Spo2: in.Vitals.Spo2,
			TempC: fstr(in.Vitals.TempC), WeightKg: fstr(in.Vitals.WeightKg), HeightCm: fstr(in.Vitals.HeightCm), Notes: in.Vitals.Notes,
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "encounter", encID, "clinical.vitals.recorded",
			map[string]any{"encounter_id": encID, "patient_id": in.PatientID, "queue_entry_id": qid})
	})
	if err != nil {
		return nil, nil, apperr.Internal(err)
	}
	return &outEnc, &outV, nil
}

// GetVisit returns the encounter for a queue entry (nil if none yet) and its vitals.
func (s *Service) GetVisit(ctx context.Context, queueEntryID uuid.UUID) (*clinical.Encounter, []clinical.Vitals, error) {
	tenantID, _ := actorOf(ctx)
	var enc *clinical.Encounter
	var vitals []clinical.Vitals
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		qid := queueEntryID
		e, er := q.GetEncounterByQueueEntry(ctx, clinicaldb.GetEncounterByQueueEntryParams{TenantID: tenantID, QueueEntryID: &qid})
		if errors.Is(er, pgx.ErrNoRows) {
			return nil // no encounter yet
		}
		if er != nil {
			return er
		}
		enc = &clinical.Encounter{ID: e.ID, PatientID: e.PatientID, ProviderID: e.ProviderID, DepartmentID: e.DepartmentID, Status: e.Status, StartedAt: e.StartedAt}
		rows, er := q.ListVitalsByEncounter(ctx, clinicaldb.ListVitalsByEncounterParams{TenantID: tenantID, EncounterID: e.ID})
		if er != nil {
			return er
		}
		for _, r := range rows {
			vitals = append(vitals, clinical.Vitals{
				ID: r.ID, Systolic: ip(r.Systolic), Diastolic: ip(r.Diastolic), Pulse: ip(r.Pulse),
				RespRate: ip(r.RespRate), Spo2: ip(r.Spo2), TempC: r.TempC, WeightKg: r.WeightKg, HeightCm: r.HeightCm,
				Notes: deref(r.Notes), RecordedAt: r.RecordedAt,
			})
		}
		return nil
	})
	if err != nil {
		return nil, nil, apperr.Internal(err)
	}
	return enc, vitals, nil
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

func i32(p *int) *int32 {
	if p == nil {
		return nil
	}
	v := int32(*p)
	return &v
}

func ip(p *int32) *int {
	if p == nil {
		return nil
	}
	v := int(*p)
	return &v
}

func fstr(f *float64) *string {
	if f == nil {
		return nil
	}
	s := strconv.FormatFloat(*f, 'f', -1, 64)
	return &s
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
