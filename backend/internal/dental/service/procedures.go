package service

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// defaultProcedures is what a clinic starts with. It is a starting point, not a
// definition: the whole reason this table exists is that the list belongs to the
// clinic. Kept here only so a workspace that turns dental on later is not handed an
// empty picker.
// isUniqueViolation: the same name twice is a slip worth naming, not a 500.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

var defaultProcedures = []string{
	"Consultation", "X-Ray", "Teeth Cleaning", "Scaling & Polishing",
	"Tooth Extraction", "Filling (Composite)", "Filling (Amalgam)",
	"Root Canal Treatment", "Crown Placement", "Bridge",
	"Partial Denture", "Full Denture", "Teeth Whitening",
	"Orthodontic Consultation", "Braces Fitting", "Emergency Treatment",
}

// ListProcedures returns this clinic's procedures, seeding the defaults the first
// time it is asked.
//
// Seeding on read rather than on flag-enable is deliberate: a clinic can be switched
// to dental from the super-admin console, by a migration, or by a plan change, and
// only one of those paths would have remembered to seed. Doing it here means the
// picker is never empty however the clinic arrived.
func (s *Service) ListProcedures(ctx context.Context, includeRetired bool) ([]dental.Procedure, error) {
	tenantID, _ := actorOf(ctx)
	out := []dental.Procedure{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var n int
		if e := tx.QueryRow(ctx,
			`SELECT count(*) FROM dental_procedures WHERE tenant_id=$1 AND deleted_at IS NULL`,
			tenantID).Scan(&n); e != nil {
			return e
		}
		if n == 0 {
			for i, name := range defaultProcedures {
				if _, e := tx.Exec(ctx,
					`INSERT INTO dental_procedures (tenant_id, name, sort_order) VALUES ($1,$2,$3)
					 ON CONFLICT DO NOTHING`, tenantID, name, i+1); e != nil {
					return e
				}
			}
		}
		rows, e := tx.Query(ctx, `
			SELECT id, name, is_active, sort_order
			  FROM dental_procedures
			 WHERE tenant_id=$1 AND deleted_at IS NULL AND ($2 OR is_active)
			 ORDER BY sort_order, lower(name)`, tenantID, includeRetired)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var p dental.Procedure
			if e := rows.Scan(&p.ID, &p.Name, &p.IsActive, &p.SortOrder); e != nil {
				return e
			}
			out = append(out, p)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateProcedure(ctx context.Context, name string) (*dental.Procedure, error) {
	tenantID, _ := actorOf(ctx)
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, apperr.Validation("give the procedure a name")
	}
	var p dental.Procedure
	e := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// New names go to the end of the list rather than the top: the order a
		// clinic put its common procedures in is not something a new entry should
		// disturb.
		return tx.QueryRow(ctx, `
			INSERT INTO dental_procedures (tenant_id, name, sort_order)
			VALUES ($1, $2, coalesce((SELECT max(sort_order) FROM dental_procedures
			                           WHERE tenant_id=$1 AND deleted_at IS NULL), 0) + 1)
			RETURNING id, name, is_active, sort_order`,
			tenantID, name).Scan(&p.ID, &p.Name, &p.IsActive, &p.SortOrder)
	})
	if e != nil {
		if isUniqueViolation(e) {
			return nil, apperr.Conflict("PROCEDURE_EXISTS", "that procedure is already on the list")
		}
		return nil, apperr.Internal(e)
	}
	return &p, nil
}

// UpdateProcedure renames a procedure or retires it.
//
// Renaming does NOT rewrite the visits that recorded the old name — a session stores
// what was done as text, and a record of care is not something a settings screen may
// edit after the fact.
func (s *Service) UpdateProcedure(ctx context.Context, id uuid.UUID, name string, active *bool) error {
	tenantID, _ := actorOf(ctx)
	name = strings.TrimSpace(name)
	if name == "" {
		return apperr.Validation("give the procedure a name")
	}
	e := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		tag, ex := tx.Exec(ctx, `
			UPDATE dental_procedures
			   SET name = $3, is_active = coalesce($4, is_active), updated_at = now()
			 WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
			tenantID, id, name, active)
		if ex != nil {
			return ex
		}
		if tag.RowsAffected() == 0 {
			return apperr.NotFound("PROCEDURE_NOT_FOUND", "no such procedure")
		}
		return nil
	})
	if ae, ok := apperr.As(e); ok {
		return ae
	}
	if e != nil {
		if isUniqueViolation(e) {
			return apperr.Conflict("PROCEDURE_EXISTS", "another procedure already has that name")
		}
		return apperr.Internal(e)
	}
	return nil
}

// DeleteProcedure removes a name from the picker. Past visits keep theirs.
//
// Through WithTx, not the bare pool: these rows are behind row-level security, and a
// pool connection never sets app.tenant_id, so the write is refused rather than
// silently crossing a tenant. Every other method here already went through it.
func (s *Service) DeleteProcedure(ctx context.Context, id uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`UPDATE dental_procedures SET deleted_at = now() WHERE tenant_id=$1 AND id=$2`,
			tenantID, id)
		return e
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ReorderProcedures writes the order the clinic dragged them into.
func (s *Service) ReorderProcedures(ctx context.Context, ids []uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		for i, id := range ids {
			if _, e := tx.Exec(ctx,
				`UPDATE dental_procedures SET sort_order=$3, updated_at=now()
				  WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, tenantID, id, i+1); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}
