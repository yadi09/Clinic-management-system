package service

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/clinical"
	clinicaldb "github.com/reicb/clinicsaas/internal/clinical/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// ---- allergen library ----

func (s *Service) ListAllergens(ctx context.Context, search string, includeInactive bool) ([]clinical.Allergen, error) {
	tenantID, _ := actorOf(ctx)
	out := []clinical.Allergen{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := clinicaldb.New(tx).ListAllergens(ctx, clinicaldb.ListAllergensParams{
			TenantID: tenantID, Search: nilIfEmpty(search), IncludeInactive: &includeInactive,
		})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, clinical.Allergen{ID: r.ID, Name: r.Name, IsActive: r.IsActive})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateAllergen(ctx context.Context, name string) (*clinical.Allergen, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(name) == "" {
		return nil, apperr.Validation("an allergen name is required")
	}
	var out clinical.Allergen
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := clinicaldb.New(tx).CreateAllergen(ctx, clinicaldb.CreateAllergenParams{TenantID: tenantID, Name: strings.TrimSpace(name), CreatedBy: actor})
		if e != nil {
			return e
		}
		out = clinical.Allergen{ID: r.ID, Name: r.Name, IsActive: r.IsActive}
		return nil
	})
	if isUnique(err) {
		return nil, apperr.Conflict("ALLERGEN_EXISTS", "that allergen already exists")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

func (s *Service) UpdateAllergen(ctx context.Context, id uuid.UUID, in clinical.AllergenInput) error {
	tenantID, _ := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return apperr.Validation("an allergen name is required")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).UpdateAllergen(ctx, clinicaldb.UpdateAllergenParams{TenantID: tenantID, ID: id, Name: strings.TrimSpace(in.Name), IsActive: in.IsActive})
	})
	if isUnique(err) {
		return apperr.Conflict("ALLERGEN_EXISTS", "that allergen already exists")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) DeleteAllergen(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).DeleteAllergen(ctx, clinicaldb.DeleteAllergenParams{TenantID: tenantID, ID: id})
	}); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ---- drug library ----

func (s *Service) SearchDrugs(ctx context.Context, search string, includeInactive bool) ([]clinical.Drug, error) {
	tenantID, _ := actorOf(ctx)
	out := []clinical.Drug{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := clinicaldb.New(tx).SearchDrugs(ctx, clinicaldb.SearchDrugsParams{
			TenantID: tenantID, Search: nilIfEmpty(search), IncludeInactive: &includeInactive,
		})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, clinical.Drug{
				ID: r.ID, Name: r.Name, DefaultDose: deref(r.DefaultDose), DefaultFrequency: deref(r.DefaultFrequency),
				DefaultDuration: deref(r.DefaultDuration), DefaultInstructions: deref(r.DefaultInstructions),
				IsActive: r.IsActive, Allergens: r.Allergens,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateDrug(ctx context.Context, in clinical.DrugInput) (*clinical.Drug, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return nil, apperr.Validation("a drug name is required")
	}
	var out clinical.Drug
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		drugID, e := q.CreateDrug(ctx, clinicaldb.CreateDrugParams{
			TenantID: tenantID, Name: strings.TrimSpace(in.Name), DefaultDose: nilIfEmpty(in.DefaultDose),
			DefaultFrequency: nilIfEmpty(in.DefaultFrequency), DefaultDuration: nilIfEmpty(in.DefaultDuration),
			DefaultInstructions: nilIfEmpty(in.DefaultInstructions), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		for _, aid := range in.AllergenIDs {
			if e := q.AddDrugAllergen(ctx, clinicaldb.AddDrugAllergenParams{TenantID: tenantID, DrugID: drugID, AllergenID: aid}); e != nil {
				return e
			}
		}
		out = clinical.Drug{
			ID: drugID, Name: strings.TrimSpace(in.Name), DefaultDose: in.DefaultDose, DefaultFrequency: in.DefaultFrequency,
			DefaultDuration: in.DefaultDuration, DefaultInstructions: in.DefaultInstructions, IsActive: true, Allergens: []string{},
		}
		return nil
	})
	if isUnique(err) {
		return nil, apperr.Conflict("DRUG_EXISTS", "a drug with that name already exists")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

func (s *Service) UpdateDrug(ctx context.Context, id uuid.UUID, in clinical.DrugInput) error {
	tenantID, _ := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return apperr.Validation("a drug name is required")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		if e := q.UpdateDrug(ctx, clinicaldb.UpdateDrugParams{
			TenantID: tenantID, ID: id, Name: strings.TrimSpace(in.Name), DefaultDose: nilIfEmpty(in.DefaultDose),
			DefaultFrequency: nilIfEmpty(in.DefaultFrequency), DefaultDuration: nilIfEmpty(in.DefaultDuration),
			DefaultInstructions: nilIfEmpty(in.DefaultInstructions), IsActive: in.IsActive,
		}); e != nil {
			return e
		}
		// Replace the allergen tag set.
		if e := q.ClearDrugAllergens(ctx, clinicaldb.ClearDrugAllergensParams{TenantID: tenantID, DrugID: id}); e != nil {
			return e
		}
		for _, aid := range in.AllergenIDs {
			if e := q.AddDrugAllergen(ctx, clinicaldb.AddDrugAllergenParams{TenantID: tenantID, DrugID: id, AllergenID: aid}); e != nil {
				return e
			}
		}
		return nil
	})
	if isUnique(err) {
		return apperr.Conflict("DRUG_EXISTS", "a drug with that name already exists")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) DeleteDrug(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return clinicaldb.New(tx).DeleteDrug(ctx, clinicaldb.DeleteDrugParams{TenantID: tenantID, ID: id})
	}); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func nilIfEmpty(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// isUnique detects a Postgres unique-violation surfaced through pgx.
func isUnique(err error) bool {
	if err == nil {
		return false
	}
	m := err.Error()
	return strings.Contains(m, "duplicate key") || strings.Contains(m, "unique constraint")
}
