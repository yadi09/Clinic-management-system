// Package service implements the patient module use-cases. All access is
// tenant-scoped via kernel/db.WithTx (RLS enforced); registration allocates a
// per-tenant MRN, runs duplicate detection (FR-PAT-03), and emits a
// PatientRegistered event for audit/indexing.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/storage"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/patient"
	patientdb "github.com/reicb/clinicsaas/internal/patient/repo/gen"
)

const dateLayout = "2006-01-02"

// Service implements patient.Service.
type Service struct {
	db        *kerneldb.DB
	store     storage.Provider
	publisher events.Publisher
}

var _ patient.Service = (*Service)(nil)

// NewService constructs a patient Service.
func NewService(db *kerneldb.DB, store storage.Provider, publisher events.Publisher) *Service {
	return &Service{db: db, store: store, publisher: publisher}
}

// Create registers a patient, detecting likely duplicates first (FR-PAT-03).
// When duplicates are found and Force is false, it returns them with a nil
// patient and nil error so the caller can prompt for confirmation.
func (s *Service) Create(ctx context.Context, in patient.PatientInput) (*patient.Patient, []patient.Duplicate, error) {
	tenantID, actor := actor(ctx)
	dob, err := parseDOB(in.DOB)
	if err != nil {
		return nil, nil, apperr.Validation("dob must be YYYY-MM-DD").WithField("dob", "invalid date")
	}
	// Only the first name is required (clinic feedback, 2026-10-01): reception often
	// has a name and a phone number and nothing else, and must not invent the rest.
	if strings.TrimSpace(in.FirstName) == "" {
		return nil, nil, apperr.Validation("the first name is required")
	}

	if !in.Force {
		var dups []patient.Duplicate
		if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
			rows, e := patientdb.New(tx).FindDuplicateCandidates(ctx, patientdb.FindDuplicateCandidatesParams{
				TenantID:   tenantID,
				FirstName:  in.FirstName,
				LastName:   in.LastName,
				Dob:        dob,
				Phone:      in.Phone,
				NationalID: in.NationalID,
			})
			if e != nil {
				return e
			}
			for _, r := range rows {
				dups = append(dups, patient.Duplicate{
					ID:         r.ID,
					MRN:        r.Mrn,
					FullName:   r.FirstName + " " + r.LastName,
					DOB:        fmtDOB(r.Dob),
					Phone:      deref(r.Phone),
					NationalID: deref(r.NationalID),
				})
			}
			return nil
		}); err != nil {
			return nil, nil, apperr.Internal(err)
		}
		if len(dups) > 0 {
			return nil, dups, nil
		}
	}

	var created patientdb.CreatePatientRow
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := patientdb.New(tx)
		// Enforce the plan's patient cap (effective, honouring any per-clinic override).
		if e := limits.EnsurePatientRoom(ctx, tx, tenantID); e != nil {
			return e
		}
		// A supplied MRN preserves the clinic's existing card ID (data import);
		// otherwise auto-generate the next sequential P###### number.
		mrn := strings.TrimSpace(in.MRN)
		if mrn == "" {
			seq, e := q.NextMRNValue(ctx, tenantID)
			if e != nil {
				return e
			}
			mrn = fmt.Sprintf("P%06d", seq)
		}
		var e error
		created, e = q.CreatePatient(ctx, patientdb.CreatePatientParams{
			TenantID:         tenantID,
			Mrn:              mrn,
			FirstName:        strings.TrimSpace(in.FirstName),
			MiddleName:       strPtr(in.MiddleName),
			LastName:         strings.TrimSpace(in.LastName),
			Gender:           defaultStr(in.Gender, "unknown"),
			Dob:              dob,
			NationalID:       strPtr(in.NationalID),
			PassportNo:       strPtr(in.PassportNo),
			Phone:            strPtr(in.Phone),
			Email:            strPtr(in.Email),
			Address:          jsonOrEmpty(in.Address),
			EmergencyContact: jsonOrEmpty(in.EmergencyContact),
			BloodGroup:       strPtr(in.BloodGroup),
			CreatedBy:        actor,
		})
		if e != nil {
			return e
		}
		if in.DOBEstimated {
			if _, e := tx.Exec(ctx, `UPDATE patients SET dob_estimated = true WHERE tenant_id = $1 AND id = $2`,
				tenantID, created.ID); e != nil {
				return e
			}
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "patient", created.ID, "patient.patient.registered",
			map[string]any{"patient_id": created.ID, "mrn": created.Mrn})
	}); err != nil {
		return nil, nil, mapWriteErr(err)
	}

	p, err := s.Get(ctx, created.ID)
	if err != nil {
		return nil, nil, err
	}
	return &p.Patient, nil, nil
}

// Update edits a patient's demographics.
func (s *Service) Update(ctx context.Context, id uuid.UUID, in patient.PatientInput) (*patient.Patient, error) {
	tenantID, _ := actor(ctx)
	dob, err := parseDOB(in.DOB)
	if err != nil {
		return nil, apperr.Validation("dob must be YYYY-MM-DD").WithField("dob", "invalid date")
	}
	// Only what the caller sent is written. The first name is always sent (it is
	// required); every other field is kept as stored unless the request carried it,
	// so an edit that does not show passport, address or emergency contact cannot
	// erase them. A field sent empty is cleared, as before.
	sent := func(k string) bool { return in.Sent == nil || in.Sent[k] }
	set := []string{"first_name = $3"}
	args := []any{tenantID, id, strings.TrimSpace(in.FirstName)}
	for _, c := range []struct {
		key, cast string
		val       any
	}{
		{"middle_name", "", strPtr(in.MiddleName)},
		{"last_name", "", strings.TrimSpace(in.LastName)},
		{"gender", "", defaultStr(in.Gender, "unknown")},
		{"dob", "", dob},
		{"national_id", "", strPtr(in.NationalID)},
		{"passport_no", "", strPtr(in.PassportNo)},
		{"phone", "", strPtr(in.Phone)},
		{"email", "", strPtr(in.Email)},
		{"blood_group", "", strPtr(in.BloodGroup)},
		{"address", "::jsonb", jsonOrEmpty(in.Address)},
		{"emergency_contact", "::jsonb", jsonOrEmpty(in.EmergencyContact)},
	} {
		if sent(c.key) {
			args = append(args, c.val)
			set = append(set, fmt.Sprintf("%s = $%d%s", c.key, len(args), c.cast))
		}
	}
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE patients SET `+strings.Join(set, ", ")+`, updated_at = now()
			  WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, args...)
		return e
	}); err != nil {
		return nil, mapWriteErr(err)
	}
	prof, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	return &prof.Patient, nil
}

// Get returns a patient's full profile.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (*patient.Profile, error) {
	tenantID, _ := actor(ctx)
	var prof patient.Profile
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := patientdb.New(tx)
		row, e := q.GetPatientByID(ctx, patientdb.GetPatientByIDParams{TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		prof.Patient = patient.Patient{
			ID: row.ID, MRN: row.Mrn, FirstName: row.FirstName, MiddleName: deref(row.MiddleName),
			LastName: row.LastName, Gender: row.Gender, DOB: fmtDOB(row.Dob),
			NationalID: deref(row.NationalID), PassportNo: deref(row.PassportNo),
			Phone: deref(row.Phone), Email: deref(row.Email), BloodGroup: deref(row.BloodGroup),
			Address: rawOrNil(row.Address), EmergencyContact: rawOrNil(row.EmergencyContact),
			CreatedAt: row.CreatedAt,
		}
		if e := tx.QueryRow(ctx, `SELECT dob_estimated FROM patients WHERE tenant_id = $1 AND id = $2`,
			tenantID, id).Scan(&prof.Patient.DOBEstimated); e != nil {
			return e
		}
		al, e := q.ListAllergies(ctx, patientdb.ListAllergiesParams{TenantID: tenantID, PatientID: id})
		if e != nil {
			return e
		}
		for _, a := range al {
			prof.Allergies = append(prof.Allergies, patient.Allergy{ID: a.ID, Substance: a.Substance, Reaction: deref(a.Reaction), Severity: a.Severity, CreatedAt: a.CreatedAt})
		}
		cs, e := q.ListConditions(ctx, patientdb.ListConditionsParams{TenantID: tenantID, PatientID: id})
		if e != nil {
			return e
		}
		for _, c := range cs {
			prof.Conditions = append(prof.Conditions, patient.Condition{ID: c.ID, ICDCode: deref(c.IcdCode), Description: c.Description, Status: c.Status, OnsetDate: dateOrEmpty(c.OnsetDate), CreatedAt: c.CreatedAt})
		}
		at, e := q.ListAttachments(ctx, patientdb.ListAttachmentsParams{TenantID: tenantID, PatientID: id})
		if e != nil {
			return e
		}
		for _, a := range at {
			prof.Attachments = append(prof.Attachments, patient.Attachment{ID: a.ID, Type: a.Type, StorageKey: a.StorageKey, URL: s.store.URL(a.StorageKey), Filename: a.Filename, MimeType: a.MimeType, SizeBytes: a.SizeBytes, CreatedAt: a.CreatedAt})
		}
		gs, e := q.ListGuardians(ctx, patientdb.ListGuardiansParams{TenantID: tenantID, PatientID: id})
		if e != nil {
			return e
		}
		for _, g := range gs {
			prof.Guardians = append(prof.Guardians, patient.Guardian{ID: g.ID, GuardianPatientID: g.GuardianPatientID, Relationship: g.Relationship, CreatedAt: g.CreatedAt})
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("PATIENT_NOT_FOUND", "patient not found")
		}
		return nil, apperr.Internal(err)
	}
	return &prof, nil
}

// searchWhere is the shared predicate for the list and its total (FR-PAT-04:
// full-text + trigram over name/MRN/phone), plus the optional gender filter.
const searchWhere = `
	WHERE tenant_id = $1 AND deleted_at IS NULL
	  AND (
	    $2::text = ''
	    OR concat_ws(' ', first_name, middle_name, last_name) ILIKE '%' || $2 || '%'
	    OR search_tsv @@ websearch_to_tsquery('simple', $2)
	    OR lower(first_name || ' ' || last_name) % lower($2)
	    OR mrn ILIKE '%' || $2 || '%'
	    OR phone ILIKE '%' || $2 || '%'
	  )
	  AND ($3::text = '' OR gender = $3)`

// Search returns a paginated, optionally filtered patient list.
func (s *Service) Search(ctx context.Context, f patient.SearchFilter, page, pageSize int) (*patient.SearchResult, error) {
	tenantID, _ := actor(ctx)
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	q := strings.TrimSpace(f.Query)
	gender := strings.ToLower(strings.TrimSpace(f.Gender))
	switch gender {
	case "", "male", "female", "other", "unknown":
	default:
		return nil, apperr.Validation("gender filter must be male, female, other or unknown")
	}
	res := &patient.SearchResult{Page: page, PageSize: pageSize}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		args := []any{tenantID, q, gender}
		var total int64
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM patients`+searchWhere, args...).Scan(&total); e != nil {
			return e
		}
		res.Total = int(total)
		rows, e := tx.Query(ctx,
			`SELECT id, mrn, first_name, coalesce(middle_name,''), last_name, gender, dob, coalesce(phone,''), coalesce(email,'')
			 FROM patients`+searchWhere+`
			 ORDER BY last_name, first_name
			 LIMIT $4 OFFSET $5`,
			append(args, pageSize, (page-1)*pageSize)...)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var it patient.Summary
			var dob *time.Time // unknown for a patient registered without an age
			if e := rows.Scan(&it.ID, &it.MRN, &it.FirstName, &it.MiddleName, &it.LastName, &it.Gender, &dob, &it.Phone, &it.Email); e != nil {
				return e
			}
			it.DOB = fmtDOB(dob)
			res.Items = append(res.Items, it)
		}
		return rows.Err()
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		return nil, apperr.Internal(err)
	}
	return res, nil
}

// Delete soft-deletes a patient.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actor(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return patientdb.New(tx).SoftDeletePatient(ctx, patientdb.SoftDeletePatientParams{TenantID: tenantID, ID: id})
	})
}

func (s *Service) AddAllergy(ctx context.Context, patientID uuid.UUID, in patient.AllergyInput) (uuid.UUID, error) {
	tenantID, actor := actor(ctx)
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = patientdb.New(tx).AddAllergy(ctx, patientdb.AddAllergyParams{
			TenantID: tenantID, PatientID: patientID, Substance: in.Substance,
			Reaction: strPtr(in.Reaction), Severity: defaultStr(in.Severity, "mild"), CreatedBy: actor,
		})
		return e
	})
	if err != nil {
		return uuid.Nil, mapWriteErr(err)
	}
	return id, nil
}

func (s *Service) RemoveAllergy(ctx context.Context, patientID, id uuid.UUID) error {
	tenantID, _ := actor(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return patientdb.New(tx).RemoveAllergy(ctx, patientdb.RemoveAllergyParams{TenantID: tenantID, PatientID: patientID, ID: id})
	})
}

func (s *Service) AddCondition(ctx context.Context, patientID uuid.UUID, in patient.ConditionInput) (uuid.UUID, error) {
	tenantID, actor := actor(ctx)
	var onset *time.Time
	if in.OnsetDate != "" {
		t, err := parseDOB(in.OnsetDate)
		if err != nil {
			return uuid.Nil, apperr.Validation("onset_date must be YYYY-MM-DD")
		}
		onset = t
	}
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = patientdb.New(tx).AddCondition(ctx, patientdb.AddConditionParams{
			TenantID: tenantID, PatientID: patientID, IcdCode: strPtr(in.ICDCode),
			Description: in.Description, Status: defaultStr(in.Status, "active"), OnsetDate: onset, CreatedBy: actor,
		})
		return e
	})
	if err != nil {
		return uuid.Nil, mapWriteErr(err)
	}
	return id, nil
}

func (s *Service) RemoveCondition(ctx context.Context, patientID, id uuid.UUID) error {
	tenantID, _ := actor(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return patientdb.New(tx).RemoveCondition(ctx, patientdb.RemoveConditionParams{TenantID: tenantID, PatientID: patientID, ID: id})
	})
}

func (s *Service) AddGuardian(ctx context.Context, patientID uuid.UUID, in patient.GuardianInput) (uuid.UUID, error) {
	tenantID, actor := actor(ctx)
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = patientdb.New(tx).AddGuardian(ctx, patientdb.AddGuardianParams{
			TenantID: tenantID, PatientID: patientID, GuardianPatientID: in.GuardianPatientID,
			GuardianUserID: nil, Relationship: in.Relationship, CreatedBy: actor,
		})
		return e
	})
	if err != nil {
		return uuid.Nil, mapWriteErr(err)
	}
	return id, nil
}

// SignAttachmentUpload returns a signed direct-upload target for a patient file.
// The storage quota is enforced first, so an over-cap tenant can't upload more.
func (s *Service) SignAttachmentUpload(ctx context.Context, patientID uuid.UUID, in patient.AttachmentSignInput) (storage.UploadTarget, error) {
	tenantID, _ := actor(ctx)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return limits.EnsureStorageRoom(ctx, tx, tenantID)
	}); err != nil {
		if ae, ok := apperr.As(err); ok {
			return storage.UploadTarget{}, ae
		}
		return storage.UploadTarget{}, apperr.Internal(err)
	}
	resourceType := "raw"
	if in.Type == "image" {
		resourceType = "image"
	}
	return s.store.SignUpload(ctx, storage.UploadOptions{Folder: attachmentFolder(tenantID, patientID), ResourceType: resourceType, Tags: []string{"patient"}})
}

// RecordAttachment persists attachment metadata after a direct upload. It prefers
// the real stored size (via the provider's Sizer) over the client-declared one, so
// a client can't under-report its size to dodge the storage quota.
func (s *Service) RecordAttachment(ctx context.Context, patientID uuid.UUID, in patient.AttachmentInput) (*patient.Attachment, error) {
	tenantID, actor := actor(ctx)
	// Only a key the upload step handed out for this clinic and this patient (SEC-1):
	// anything else could point the record, and a later delete, at another clinic's file.
	if !storage.KeyInFolder(in.StorageKey, attachmentFolder(tenantID, patientID)) {
		return nil, apperr.Validation("that file was not uploaded for this patient").WithField("storage_key", "invalid")
	}
	size := in.SizeBytes
	if sizer, ok := s.store.(storage.Sizer); ok {
		if real, e := sizer.Size(ctx, in.StorageKey); e == nil && real > 0 {
			size = real
		}
	}
	var row patientdb.CreateAttachmentRow
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		row, e = patientdb.New(tx).CreateAttachment(ctx, patientdb.CreateAttachmentParams{
			TenantID: tenantID, PatientID: patientID, Type: in.Type, StorageKey: in.StorageKey,
			Filename: in.Filename, MimeType: in.MimeType, SizeBytes: size, CreatedBy: actor,
		})
		return e
	}); err != nil {
		return nil, mapWriteErr(err)
	}
	return &patient.Attachment{
		ID: row.ID, Type: in.Type, StorageKey: in.StorageKey, URL: s.store.URL(in.StorageKey),
		Filename: in.Filename, MimeType: in.MimeType, SizeBytes: size, CreatedAt: row.CreatedAt,
	}, nil
}

// RemoveAttachment soft-deletes the record. The stored file is KEPT: nothing backs
// the file store up and removal is one tap, so the object stays until a retention
// rule says it may go (AUD-02). It is unreachable meanwhile: links are short-lived
// signed URLs minted only for visible rows.
func (s *Service) RemoveAttachment(ctx context.Context, patientID, id uuid.UUID) error {
	tenantID, _ := actor(ctx)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := patientdb.New(tx)
		if _, e := q.GetAttachment(ctx, patientdb.GetAttachmentParams{TenantID: tenantID, PatientID: patientID, ID: id}); e != nil {
			return e
		}
		return q.RemoveAttachment(ctx, patientdb.RemoveAttachmentParams{TenantID: tenantID, PatientID: patientID, ID: id})
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.NotFound("ATTACHMENT_NOT_FOUND", "attachment not found")
		}
		return apperr.Internal(err)
	}
	return nil
}

// --- helpers ---

// attachmentFolder is where a patient's files live: one folder per clinic per patient.
func attachmentFolder(tenantID, patientID uuid.UUID) string {
	return fmt.Sprintf("%s/patients/%s", tenantID, patientID)
}

func actor(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

// parseDOB reads an optional date of birth: empty means unknown (nil).
func parseDOB(s string) (*time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return nil, err
	}
	if t.After(time.Now().AddDate(0, 0, 1)) {
		return nil, fmt.Errorf("date of birth in the future")
	}
	return &t, nil
}

// fmtDOB writes a date of birth for the API: "" when it is not known.
func fmtDOB(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format(dateLayout)
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func strPtr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

func defaultStr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

func jsonOrEmpty(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	return string(raw)
}

func rawOrNil(p *string) json.RawMessage {
	if p == nil || *p == "" {
		return nil
	}
	return json.RawMessage(*p)
}

func dateOrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format(dateLayout)
}

func mapWriteErr(err error) error {
	if err == nil {
		return nil
	}
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	msg := err.Error()
	if strings.Contains(msg, "idx_patients_mrn") {
		return apperr.Conflict("MRN_TAKEN", "that card ID is already used by another patient")
	}
	if strings.Contains(msg, "duplicate key") || strings.Contains(msg, "unique constraint") {
		return apperr.Conflict("PATIENT_CONFLICT", "a record with these details already exists")
	}
	return apperr.Internal(err)
}
