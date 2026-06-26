package service

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/clinical"
	clinicaldb "github.com/reicb/clinicsaas/internal/clinical/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// CreateLabReferral records an external-lab request on an open encounter.
func (s *Service) CreateLabReferral(ctx context.Context, encounterID uuid.UUID, in clinical.LabReferralInput) (*clinical.LabReferral, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Tests) == "" {
		return nil, apperr.Validation("list at least one test to request")
	}
	var out clinical.LabReferral
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		enc, e := q.GetEncounter(ctx, clinicaldb.GetEncounterParams{TenantID: tenantID, ID: encounterID})
		if e != nil {
			return e
		}
		if enc.Status == "closed" {
			return errLocked
		}
		r, e := q.CreateLabReferral(ctx, clinicaldb.CreateLabReferralParams{
			TenantID: tenantID, EncounterID: encounterID, PatientID: enc.PatientID,
			Tests: strings.TrimSpace(in.Tests), Indication: nilIfEmpty(in.Indication), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		out = clinical.LabReferral{ID: r.ID, Tests: r.Tests, Indication: deref(r.Indication), Status: r.Status, CreatedAt: r.CreatedAt}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// RecordLabReferralResult stores a returned result (any subset of summary, values,
// files) against the referral.
func (s *Service) RecordLabReferralResult(ctx context.Context, referralID uuid.UUID, in clinical.LabReferralResultInput) error {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Summary) == "" && !hasJSONItems(in.Values) && !hasJSONItems(in.Files) {
		return apperr.Validation("add a summary, some values, or an attachment")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).RecordLabReferralResult(ctx, clinicaldb.RecordLabReferralResultParams{
			TenantID: tenantID, ID: referralID, ResultSummary: nilIfEmpty(in.Summary), ExternalLab: nilIfEmpty(in.ExternalLab),
			ResultValues: jsonOrNil(in.Values), ResultFiles: jsonOrNil(in.Files), ResultedBy: actor,
		})
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// CancelLabReferral marks a referral cancelled.
func (s *Service) CancelLabReferral(ctx context.Context, referralID uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).CancelLabReferral(ctx, clinicaldb.CancelLabReferralParams{TenantID: tenantID, ID: referralID})
	}); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// rawOrNil converts a stored jsonb string to json.RawMessage (nil-safe).
func rawOrNil(s *string) json.RawMessage {
	if s == nil || *s == "" {
		return nil
	}
	return json.RawMessage(*s)
}

// jsonOrNil prepares a json.RawMessage for nullable jsonb storage.
func jsonOrNil(m json.RawMessage) *string {
	if !hasJSONItems(m) {
		return nil
	}
	s := string(m)
	return &s
}

// hasJSONItems reports whether a raw JSON value is a non-empty array/object.
func hasJSONItems(m json.RawMessage) bool {
	t := strings.TrimSpace(string(m))
	return t != "" && t != "null" && t != "[]" && t != "{}"
}
