// Package service implements the clinical use-cases for Phase 3a: opening the
// visit encounter and recording triage vitals.
package service

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"

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
		// Enforce the clinic's plausibility bounds + required fields (VITALS-A).
		fields, e := s.effectiveFields(ctx, q, tenantID)
		if e != nil {
			return e
		}
		if e := validateVitals(fields, in.Vitals); e != nil {
			return e
		}
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
	if ae, ok := apperr.As(err); ok {
		return nil, nil, ae
	}
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

// ============================================================================
// Phase 3b: consultation / EMR
// ============================================================================

var errLocked = apperr.Conflict("ENCOUNTER_LOCKED", "this encounter is signed and can no longer be edited")

// OpenEncounter ensures an encounter exists for a worklist (queue) entry —
// creating it (bootstrapped from the queue entry) if triage hasn't already —
// and returns the full workspace.
func (s *Service) OpenEncounter(ctx context.Context, queueEntryID uuid.UUID) (*clinical.Workspace, error) {
	tenantID, actor := actorOf(ctx)
	var ws *clinical.Workspace
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		qid := queueEntryID
		var encID uuid.UUID
		enc, e := q.GetEncounterByQueueEntry(ctx, clinicaldb.GetEncounterByQueueEntryParams{TenantID: tenantID, QueueEntryID: &qid})
		switch {
		case e == nil:
			encID = enc.ID
			// The doctor opening/resuming the consult is the provider. Claim it if
			// the encounter has none yet so it lands on their "My day" board.
			if enc.ProviderID == nil && actor != nil {
				if e2 := q.ClaimEncounterProvider(ctx, clinicaldb.ClaimEncounterProviderParams{TenantID: tenantID, ID: encID, ProviderID: actor}); e2 != nil {
					return e2
				}
			}
		case errors.Is(e, pgx.ErrNoRows):
			qe, e2 := q.GetQueueEntryForEncounter(ctx, clinicaldb.GetQueueEntryForEncounterParams{TenantID: tenantID, ID: queueEntryID})
			if errors.Is(e2, pgx.ErrNoRows) {
				return apperr.NotFound("QUEUE_ENTRY_NOT_FOUND", "queue entry not found")
			}
			if e2 != nil {
				return e2
			}
			dept := qe.DepartmentID
			// Attribute the encounter to its assigned provider, or to the doctor
			// opening it when the queue entry was never explicitly assigned (the
			// common walk-in → triage → doctor path) — otherwise provider_id stays
			// NULL and the encounter never appears on any doctor's board.
			provider := qe.AssignedProviderID
			if provider == nil {
				provider = actor
			}
			created, e3 := q.CreateEncounter(ctx, clinicaldb.CreateEncounterParams{
				TenantID: tenantID, BranchID: qe.BranchID, DepartmentID: &dept, PatientID: qe.PatientID,
				QueueEntryID: &qid, ProviderID: provider, CreatedBy: actor,
			})
			if e3 != nil {
				return e3
			}
			encID = created.ID
		default:
			return e
		}
		ws, e = loadWorkspace(ctx, q, tenantID, encID)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return ws, nil
}

// GetWorkspace returns the full encounter view by encounter id.
func (s *Service) GetWorkspace(ctx context.Context, encounterID uuid.UUID) (*clinical.Workspace, error) {
	tenantID, _ := actorOf(ctx)
	var ws *clinical.Workspace
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		ws, e = loadWorkspace(ctx, clinicaldb.New(tx), tenantID, encounterID)
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("ENCOUNTER_NOT_FOUND", "encounter not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return ws, nil
}

// SaveNote upserts the SOAP draft (rejected once signed).
func (s *Service) SaveNote(ctx context.Context, encounterID uuid.UUID, in clinical.NoteInput) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		n, e := q.GetNoteByEncounter(ctx, clinicaldb.GetNoteByEncounterParams{TenantID: tenantID, EncounterID: encounterID})
		if errors.Is(e, pgx.ErrNoRows) {
			_, e2 := q.CreateNote(ctx, clinicaldb.CreateNoteParams{
				TenantID: tenantID, EncounterID: encounterID,
				Subjective: strPtr(in.Subjective), Objective: strPtr(in.Objective),
				Assessment: strPtr(in.Assessment), Plan: strPtr(in.Plan), CreatedBy: actor,
			})
			return e2
		}
		if e != nil {
			return e
		}
		if n.Status == "signed" {
			return errLocked
		}
		_, e = q.UpdateNote(ctx, clinicaldb.UpdateNoteParams{
			Subjective: strPtr(in.Subjective), Objective: strPtr(in.Objective),
			Assessment: strPtr(in.Assessment), Plan: strPtr(in.Plan), TenantID: tenantID, EncounterID: encounterID,
		})
		return e
	})
	return mapErr(err)
}

// AddDiagnosis appends a diagnosis, snapshotting the chosen catalog entry.
func (s *Service) AddDiagnosis(ctx context.Context, encounterID uuid.UUID, in clinical.DiagnosisInput) (*clinical.Diagnosis, error) {
	tenantID, actor := actorOf(ctx)
	var out clinical.Diagnosis
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		enc, e := q.GetEncounter(ctx, clinicaldb.GetEncounterParams{TenantID: tenantID, ID: encounterID})
		if e != nil {
			return e
		}
		if enc.Status == "closed" {
			return errLocked
		}
		desc, code := in.Description, in.Code
		var catID, catalogID *uuid.UUID
		if in.CatalogID != nil {
			entry, e2 := q.GetCatalogEntry(ctx, clinicaldb.GetCatalogEntryParams{TenantID: tenantID, ID: *in.CatalogID})
			if errors.Is(e2, pgx.ErrNoRows) {
				return apperr.Validation("unknown diagnosis")
			}
			if e2 != nil {
				return e2
			}
			if desc == "" {
				desc = entry.Name
			}
			if code == "" {
				code = deref(entry.Code)
			}
			cid := entry.CategoryID
			catID, catalogID = &cid, in.CatalogID
		}
		if strings.TrimSpace(desc) == "" {
			return apperr.Validation("a diagnosis is required")
		}
		// At most one primary per encounter: demote any existing primary first.
		if in.IsPrimary {
			if e := q.ClearPrimaryDiagnoses(ctx, clinicaldb.ClearPrimaryDiagnosesParams{TenantID: tenantID, EncounterID: encounterID}); e != nil {
				return e
			}
		}
		row, e := q.CreateDiagnosis(ctx, clinicaldb.CreateDiagnosisParams{
			TenantID: tenantID, EncounterID: encounterID, PatientID: enc.PatientID,
			CatalogID: catalogID, CategoryID: catID, Code: strPtr(code), Description: desc, IsPrimary: in.IsPrimary, CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		out = clinical.Diagnosis{ID: row.ID, Code: deref(row.Code), Description: row.Description, IsPrimary: row.IsPrimary}
		return nil
	})
	if e := mapErr(err); e != nil {
		return nil, e
	}
	return &out, nil
}

// RemoveDiagnosis deletes a diagnosis (while the encounter is open).
func (s *Service) RemoveDiagnosis(ctx context.Context, encounterID, diagnosisID uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	return mapErr(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		if e := ensureOpen(ctx, q, tenantID, encounterID); e != nil {
			return e
		}
		return q.DeleteDiagnosis(ctx, clinicaldb.DeleteDiagnosisParams{TenantID: tenantID, ID: diagnosisID, EncounterID: encounterID})
	}))
}

// AddMedication appends a prescription line — blocked if the drug matches a
// patient allergy (clinical-safety guard).
func (s *Service) AddMedication(ctx context.Context, encounterID uuid.UUID, in clinical.MedicationInput) (*clinical.Medication, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.DrugName) == "" {
		return nil, apperr.Validation("a medication name is required")
	}
	var out clinical.Medication
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		enc, e := q.GetEncounter(ctx, clinicaldb.GetEncounterParams{TenantID: tenantID, ID: encounterID})
		if e != nil {
			return e
		}
		if enc.Status == "closed" {
			return errLocked
		}
		// Allergy guard: warn (overridable) when the drug's tagged allergens — or its
		// name — match a recorded patient allergy. The doctor proceeds by supplying an
		// override reason, which we record on the item for accountability.
		allergies, e := q.ListPatientAllergies(ctx, clinicaldb.ListPatientAllergiesParams{TenantID: tenantID, PatientID: enc.PatientID})
		if e != nil {
			return e
		}
		var drugAllergens []string
		if in.DrugID != nil {
			drugAllergens, e = q.GetDrugAllergenNames(ctx, clinicaldb.GetDrugAllergenNamesParams{TenantID: tenantID, DrugID: *in.DrugID})
			if e != nil {
				return e
			}
		}
		if conflicts := allergyConflicts(in.DrugName, drugAllergens, allergies); len(conflicts) > 0 && strings.TrimSpace(in.OverrideReason) == "" {
			return apperr.Conflict("ALLERGY_CONFLICT", "Patient is allergic to "+strings.Join(conflicts, ", ")+" — review before prescribing.")
		}
		// One prescription per encounter; create on first item.
		rxID, e := q.GetPrescriptionByEncounter(ctx, clinicaldb.GetPrescriptionByEncounterParams{TenantID: tenantID, EncounterID: encounterID})
		if errors.Is(e, pgx.ErrNoRows) {
			rxID, e = q.CreatePrescription(ctx, clinicaldb.CreatePrescriptionParams{TenantID: tenantID, EncounterID: encounterID, PatientID: enc.PatientID, CreatedBy: actor})
		}
		if e != nil {
			return e
		}
		item, e := q.CreatePrescriptionItem(ctx, clinicaldb.CreatePrescriptionItemParams{
			TenantID: tenantID, PrescriptionID: rxID, DrugName: in.DrugName,
			Dose: strPtr(in.Dose), Frequency: strPtr(in.Frequency), Duration: strPtr(in.Duration), Instructions: strPtr(in.Instructions),
			DrugID: in.DrugID, AllergyOverride: nilIfEmpty(in.OverrideReason),
		})
		if e != nil {
			return e
		}
		out = clinical.Medication{
			ID: item.ID, DrugName: item.DrugName, Dose: deref(item.Dose), Frequency: deref(item.Frequency),
			Duration: deref(item.Duration), Instructions: deref(item.Instructions),
		}
		return nil
	})
	if e := mapErr(err); e != nil {
		return nil, e
	}
	return &out, nil
}

// RemoveMedication deletes a prescription line (while the encounter is open).
func (s *Service) RemoveMedication(ctx context.Context, encounterID, itemID uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	return mapErr(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		if e := ensureOpen(ctx, q, tenantID, encounterID); e != nil {
			return e
		}
		return q.DeletePrescriptionItem(ctx, clinicaldb.DeletePrescriptionItemParams{TenantID: tenantID, ID: itemID, EncounterID: encounterID})
	}))
}

// SignAndClose signs the note (immutable) and closes the encounter, emitting
// clinical.encounter.closed. The caller then moves the queue entry to done.
func (s *Service) SignAndClose(ctx context.Context, encounterID uuid.UUID) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		enc, e := q.GetEncounter(ctx, clinicaldb.GetEncounterParams{TenantID: tenantID, ID: encounterID})
		if e != nil {
			return e
		}
		if enc.Status == "closed" {
			return errLocked
		}
		// Ensure a note row exists, then sign it.
		if _, e := q.GetNoteByEncounter(ctx, clinicaldb.GetNoteByEncounterParams{TenantID: tenantID, EncounterID: encounterID}); errors.Is(e, pgx.ErrNoRows) {
			if _, e2 := q.CreateNote(ctx, clinicaldb.CreateNoteParams{TenantID: tenantID, EncounterID: encounterID, CreatedBy: actor}); e2 != nil {
				return e2
			}
		} else if e != nil {
			return e
		}
		if _, e := q.SignNote(ctx, clinicaldb.SignNoteParams{SignedBy: actor, TenantID: tenantID, EncounterID: encounterID}); e != nil {
			return e
		}
		if _, e := q.CloseEncounter(ctx, clinicaldb.CloseEncounterParams{TenantID: tenantID, ID: encounterID}); e != nil {
			return e
		}
		payload := map[string]any{"encounter_id": encounterID, "patient_id": enc.PatientID}
		if enc.QueueEntryID != nil {
			payload["queue_entry_id"] = *enc.QueueEntryID
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "encounter", encounterID, "clinical.encounter.closed", payload)
	})
	return mapErr(err)
}

// SetAside parks an open encounter as awaiting_results — the doctor's "set aside
// while labs run" action. It stays editable; only SignAndClose locks it. Emits
// clinical.encounter.set_aside. No-op-with-conflict if it isn't currently open.
func (s *Service) SetAside(ctx context.Context, encounterID uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	return mapErr(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		if _, e := q.SetEncounterAwaitingResults(ctx, clinicaldb.SetEncounterAwaitingResultsParams{TenantID: tenantID, ID: encounterID}); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.Conflict("INVALID_STATE", "only an open encounter can be set aside")
			}
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "encounter", encounterID, "clinical.encounter.set_aside",
			map[string]any{"encounter_id": encounterID})
	}))
}

// MyBoard returns the doctor's own in-progress (open/awaiting-results, with a
// pending-lab count for the reason) and closed-today encounters.
// MyBoard returns the doctor's open encounters (always, regardless of age — an
// open encounter must stay visible until closed) plus encounters closed since
// `doneSince` (the "Done" window; zero defaults to the last 24h).
func (s *Service) MyBoard(ctx context.Context, providerID uuid.UUID, doneSince time.Time, doneUntil *time.Time) (*clinical.Board, error) {
	tenantID, _ := actorOf(ctx)
	out := &clinical.Board{Active: []clinical.BoardActive{}, Done: []clinical.BoardDone{}}
	if doneSince.IsZero() {
		doneSince = time.Now().Add(-24 * time.Hour)
	}
	since := doneSince
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		act, e := q.ListMyActiveEncounters(ctx, clinicaldb.ListMyActiveEncountersParams{TenantID: tenantID, ProviderID: &providerID})
		if e != nil {
			return e
		}
		for _, r := range act {
			out.Active = append(out.Active, clinical.BoardActive{
				EncounterID: r.ID, QueueEntryID: r.QueueEntryID, Status: r.Status, StartedAt: r.StartedAt,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, PendingLabs: int(r.PendingLabs),
			})
		}
		done, e := q.ListMyDoneEncountersToday(ctx, clinicaldb.ListMyDoneEncountersTodayParams{TenantID: tenantID, ProviderID: &providerID, Since: &since, Until: doneUntil})
		if e != nil {
			return e
		}
		for _, r := range done {
			out.Done = append(out.Done, clinical.BoardDone{
				EncounterID: r.ID, ClosedAt: r.ClosedAt, StartedAt: r.StartedAt,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// History returns a patient's past encounters (newest first) for the timeline.
func (s *Service) History(ctx context.Context, patientID uuid.UUID) ([]clinical.HistoryItem, error) {
	tenantID, _ := actorOf(ctx)
	var out []clinical.HistoryItem
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := clinicaldb.New(tx).ListPatientEncounters(ctx, clinicaldb.ListPatientEncountersParams{TenantID: tenantID, PatientID: patientID})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, clinical.HistoryItem{
				ID: r.ID, StartedAt: r.StartedAt, Status: r.Status, Type: "Consultation",
				ProviderName: deref(r.ProviderName), PrimaryDx: r.PrimaryDx,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// --- diagnosis catalog ---

func (s *Service) ListCategories(ctx context.Context) ([]clinical.DiagnosisCategory, error) {
	tenantID, _ := actorOf(ctx)
	var out []clinical.DiagnosisCategory
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := clinicaldb.New(tx).ListDiagnosisCategories(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, clinical.DiagnosisCategory{ID: r.ID, Name: r.Name, SortOrder: int(r.SortOrder), IsActive: r.IsActive})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateCategory(ctx context.Context, in clinical.CategoryInput) (*clinical.DiagnosisCategory, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return nil, apperr.Validation("category name is required")
	}
	var out clinical.DiagnosisCategory
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := clinicaldb.New(tx).CreateDiagnosisCategory(ctx, clinicaldb.CreateDiagnosisCategoryParams{
			TenantID: tenantID, Name: in.Name, SortOrder: int32(in.SortOrder), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		out = clinical.DiagnosisCategory{ID: r.ID, Name: r.Name, SortOrder: int(r.SortOrder), IsActive: r.IsActive}
		return nil
	})
	if err != nil {
		return nil, mapWriteErr(err, "CATEGORY_EXISTS", "a category with this name already exists")
	}
	return &out, nil
}

func (s *Service) UpdateCategory(ctx context.Context, id uuid.UUID, in clinical.CategoryInput) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).UpdateDiagnosisCategory(ctx, clinicaldb.UpdateDiagnosisCategoryParams{
			Name: in.Name, SortOrder: int32(in.SortOrder), IsActive: in.IsActive, TenantID: tenantID, ID: id,
		})
	})
	if err != nil {
		return mapWriteErr(err, "CATEGORY_EXISTS", "a category with this name already exists")
	}
	return nil
}

func (s *Service) DeleteCategory(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	return apperrOrNil(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).DeleteDiagnosisCategory(ctx, clinicaldb.DeleteDiagnosisCategoryParams{TenantID: tenantID, ID: id})
	}))
}

func (s *Service) SearchCatalog(ctx context.Context, search string, categoryID *uuid.UUID, includeInactive bool) ([]clinical.CatalogEntry, error) {
	tenantID, _ := actorOf(ctx)
	var inc *bool
	if includeInactive {
		t := true
		inc = &t
	}
	var out []clinical.CatalogEntry
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := clinicaldb.New(tx).ListDiagnosisCatalog(ctx, clinicaldb.ListDiagnosisCatalogParams{
			TenantID: tenantID, Search: strPtr(search), CategoryID: categoryID, IncludeInactive: inc,
		})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, clinical.CatalogEntry{ID: r.ID, CategoryID: r.CategoryID, CategoryName: r.CategoryName, Code: deref(r.Code), Name: r.Name, IsActive: r.IsActive})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateCatalogEntry(ctx context.Context, in clinical.CatalogEntryInput) (*clinical.CatalogEntry, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" || in.CategoryID == uuid.Nil {
		return nil, apperr.Validation("category and name are required")
	}
	var out clinical.CatalogEntry
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := clinicaldb.New(tx).CreateDiagnosisCatalogEntry(ctx, clinicaldb.CreateDiagnosisCatalogEntryParams{
			TenantID: tenantID, CategoryID: in.CategoryID, Code: strPtr(in.Code), Name: in.Name, CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		out = clinical.CatalogEntry{ID: r.ID, CategoryID: r.CategoryID, Code: deref(r.Code), Name: r.Name, IsActive: r.IsActive}
		return nil
	})
	if err != nil {
		return nil, mapWriteErr(err, "DIAGNOSIS_CODE_EXISTS", "a diagnosis with this code already exists")
	}
	return &out, nil
}

func (s *Service) UpdateCatalogEntry(ctx context.Context, id uuid.UUID, in clinical.CatalogEntryInput) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).UpdateDiagnosisCatalogEntry(ctx, clinicaldb.UpdateDiagnosisCatalogEntryParams{
			CategoryID: in.CategoryID, Code: strPtr(in.Code), Name: in.Name, IsActive: in.IsActive, TenantID: tenantID, ID: id,
		})
	})
	if err != nil {
		return mapWriteErr(err, "DIAGNOSIS_CODE_EXISTS", "a diagnosis with this code already exists")
	}
	return nil
}

func (s *Service) DeleteCatalogEntry(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	return apperrOrNil(s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).DeleteDiagnosisCatalogEntry(ctx, clinicaldb.DeleteDiagnosisCatalogEntryParams{TenantID: tenantID, ID: id})
	}))
}

// loadWorkspace assembles the full encounter view within a transaction.
func loadWorkspace(ctx context.Context, q *clinicaldb.Queries, tenantID, encID uuid.UUID) (*clinical.Workspace, error) {
	enc, e := q.GetEncounter(ctx, clinicaldb.GetEncounterParams{TenantID: tenantID, ID: encID})
	if e != nil {
		return nil, e
	}
	ws := &clinical.Workspace{
		EncounterID: enc.ID, Status: enc.Status, StartedAt: enc.StartedAt,
		BranchID: enc.BranchID, DepartmentID: enc.DepartmentID, ProviderID: enc.ProviderID,
	}

	b, e := q.GetPatientBanner(ctx, clinicaldb.GetPatientBannerParams{TenantID: tenantID, ID: enc.PatientID})
	if e != nil {
		return nil, e
	}
	ws.Patient = clinical.PatientBanner{
		PatientID: enc.PatientID, Name: b.FirstName + " " + b.LastName, MRN: b.Mrn,
		Age: ageOf(b.Dob), Gender: b.Gender, BloodGroup: deref(b.BloodGroup),
	}

	al, e := q.ListPatientAllergies(ctx, clinicaldb.ListPatientAllergiesParams{TenantID: tenantID, PatientID: enc.PatientID})
	if e != nil {
		return nil, e
	}
	ws.Allergies = []clinical.Allergy{}
	for _, a := range al {
		ws.Allergies = append(ws.Allergies, clinical.Allergy{Substance: a.Substance, Severity: a.Severity, Reaction: deref(a.Reaction)})
	}

	vt, e := q.ListVitalsByEncounter(ctx, clinicaldb.ListVitalsByEncounterParams{TenantID: tenantID, EncounterID: encID})
	if e != nil {
		return nil, e
	}
	ws.Vitals = []clinical.Vitals{}
	for _, r := range vt {
		ws.Vitals = append(ws.Vitals, clinical.Vitals{
			ID: r.ID, Systolic: ip(r.Systolic), Diastolic: ip(r.Diastolic), Pulse: ip(r.Pulse),
			RespRate: ip(r.RespRate), Spo2: ip(r.Spo2), TempC: r.TempC, WeightKg: r.WeightKg, HeightCm: r.HeightCm,
			Notes: deref(r.Notes), RecordedAt: r.RecordedAt,
		})
	}

	if n, e := q.GetNoteByEncounter(ctx, clinicaldb.GetNoteByEncounterParams{TenantID: tenantID, EncounterID: encID}); e == nil {
		ws.Note = clinical.Note{Subjective: deref(n.Subjective), Objective: deref(n.Objective), Assessment: deref(n.Assessment), Plan: deref(n.Plan), Status: n.Status, SignedAt: n.SignedAt}
	} else if errors.Is(e, pgx.ErrNoRows) {
		ws.Note = clinical.Note{Status: "draft"}
	} else {
		return nil, e
	}

	dx, e := q.ListDiagnosesByEncounter(ctx, clinicaldb.ListDiagnosesByEncounterParams{TenantID: tenantID, EncounterID: encID})
	if e != nil {
		return nil, e
	}
	ws.Diagnoses = []clinical.Diagnosis{}
	for _, d := range dx {
		ws.Diagnoses = append(ws.Diagnoses, clinical.Diagnosis{ID: d.ID, Code: deref(d.Code), Description: d.Description, IsPrimary: d.IsPrimary, CategoryName: deref(d.CategoryName)})
	}

	rx, e := q.ListPrescriptionsByEncounter(ctx, clinicaldb.ListPrescriptionsByEncounterParams{TenantID: tenantID, EncounterID: encID})
	if e != nil {
		return nil, e
	}
	ws.Prescription = []clinical.Medication{}
	for _, m := range rx {
		ws.Prescription = append(ws.Prescription, clinical.Medication{ID: m.ID, DrugName: m.DrugName, Dose: deref(m.Dose), Frequency: deref(m.Frequency), Duration: deref(m.Duration), Instructions: deref(m.Instructions), Allergens: m.Allergens, AllergyOverride: deref(m.AllergyOverride)})
	}
	refs, e := q.ListLabReferralsByEncounter(ctx, clinicaldb.ListLabReferralsByEncounterParams{TenantID: tenantID, EncounterID: encID})
	if e != nil {
		return nil, e
	}
	ws.LabReferrals = []clinical.LabReferral{}
	for _, r := range refs {
		ws.LabReferrals = append(ws.LabReferrals, clinical.LabReferral{
			ID: r.ID, Tests: r.Tests, Indication: deref(r.Indication), Status: r.Status, ResultSummary: deref(r.ResultSummary),
			ResultValues: rawOrNil(r.ResultValues), ResultFiles: rawOrNil(r.ResultFiles), ExternalLab: deref(r.ExternalLab),
			ResultedAt: r.ResultedAt, CreatedAt: r.CreatedAt,
		})
	}
	return ws, nil
}

func ensureOpen(ctx context.Context, q *clinicaldb.Queries, tenantID, encID uuid.UUID) error {
	enc, e := q.GetEncounter(ctx, clinicaldb.GetEncounterParams{TenantID: tenantID, ID: encID})
	if e != nil {
		return e
	}
	if enc.Status == "closed" {
		return errLocked
	}
	return nil
}

// allergyMatches reports whether a prescribed drug name matches a recorded
// allergy substance. It compares on whole tokens (>=4 chars) of the substance,
// so "Amoxicillin" blocks "Amoxicillin 500mg" but a short/garbage substring like
// "pen" or a phrase like "no penicillin" won't wrongly block unrelated drugs.
// Name-based only — drug-class intelligence (penicillin→amoxicillin) needs a
// drug database (a later phase).
func allergyMatches(drug, substance string) bool {
	d := strings.ToLower(drug)
	tokens := strings.FieldsFunc(strings.ToLower(substance), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, tok := range tokens {
		if len([]rune(tok)) >= 4 && strings.Contains(d, tok) {
			return true
		}
	}
	return false
}

// allergyConflicts returns the patient-allergy substances that clash with the drug
// being prescribed — matched against the drug's library allergen tags (exact, case-
// insensitive, plus token overlap) and, as a fallback, the free-typed drug name.
func allergyConflicts(drugName string, drugAllergens []string, allergies []clinicaldb.ListPatientAllergiesRow) []string {
	seen := map[string]bool{}
	var out []string
	for _, a := range allergies {
		hit := allergyMatches(drugName, a.Substance)
		for _, al := range drugAllergens {
			if hit {
				break
			}
			if strings.EqualFold(strings.TrimSpace(al), strings.TrimSpace(a.Substance)) || allergyMatches(al, a.Substance) {
				hit = true
			}
		}
		if hit && !seen[a.Substance] {
			seen[a.Substance] = true
			out = append(out, a.Substance)
		}
	}
	return out
}

func ageOf(dob time.Time) int {
	now := time.Now()
	y := now.Year() - dob.Year()
	if now.YearDay() < dob.YearDay() {
		y--
	}
	if y < 0 {
		return 0
	}
	return y
}

// mapErr maps tx errors to app errors (locked/not-found/internal).
func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("ENCOUNTER_NOT_FOUND", "encounter not found")
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

func mapWriteErr(err error, code, msg string) error {
	if err == nil {
		return nil
	}
	m := err.Error()
	if strings.Contains(m, "duplicate key") || strings.Contains(m, "unique constraint") {
		return apperr.Conflict(code, msg)
	}
	return apperr.Internal(err)
}

// ImportHistory stores a migrated record as a back-dated, signed historical
// encounter + note, so it shows in the patient's timeline and feeds the AI
// co-pilot's past-history summary. No queue entry; provider is left unset.
func (s *Service) ImportHistory(ctx context.Context, in clinical.HistoryImportInput) (uuid.UUID, error) {
	tenantID, actor := actorOf(ctx)
	subjective := strPtr(in.Subjective)
	objective := strPtr(in.Objective)
	assessment := strPtr(in.Assessment)
	plan := strPtr(in.Plan)
	if subjective == nil && objective == nil && assessment == nil && plan == nil {
		return uuid.Nil, apperr.Validation("enter at least one section of the patient's past history")
	}
	when := time.Now()
	if d := strings.TrimSpace(in.Date); d != "" {
		t, e := time.Parse("2006-01-02", d)
		if e != nil {
			return uuid.Nil, apperr.Validation("date must be YYYY-MM-DD")
		}
		when = t
	}
	branch := activeBranchOf(ctx)
	var encID uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		if branch == nil {
			b, e := q.GetDefaultBranch(ctx, tenantID)
			if e != nil {
				if errors.Is(e, pgx.ErrNoRows) {
					return apperr.Validation("add a branch before importing records")
				}
				return e
			}
			branch = &b
		}
		enc, e := q.ImportHistoricalEncounter(ctx, clinicaldb.ImportHistoricalEncounterParams{
			TenantID: tenantID, BranchID: *branch, PatientID: in.PatientID, ProviderID: nil, StartedAt: when, CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		encID = enc
		_, e = q.ImportHistoricalNote(ctx, clinicaldb.ImportHistoricalNoteParams{
			TenantID: tenantID, EncounterID: enc, Subjective: subjective, Objective: objective, Assessment: assessment, Plan: plan,
			SignedBy: actor, SignedAt: &when, CreatedBy: actor,
		})
		return e
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return uuid.Nil, ae
		}
		return uuid.Nil, apperr.Internal(err)
	}
	return encID, nil
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

// activeBranchOf returns the branch the request is scoped to (nil = all-branches).
func activeBranchOf(ctx context.Context) *uuid.UUID {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		return p.ActiveBranchID
	}
	return nil
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
