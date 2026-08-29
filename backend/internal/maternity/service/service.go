// Package service implements the maternity use-cases: compute a pregnancy dating
// via the pure internal/pregnancy package, and persist it (upsert current +
// append-only history) with an audit event, all under tenant RLS.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/maternity"
	"github.com/reicb/clinicsaas/internal/pregnancy"
)

// Service implements maternity.Service.
type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
}

var _ maternity.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, publisher events.Publisher) *Service {
	return &Service{db: db, publisher: publisher}
}

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

func fmtDate(t time.Time) string { return t.Format("2006-01-02") }
func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func (s *Service) Preview(ctx context.Context, method pregnancy.Method, in pregnancy.Inputs, gaDate time.Time) (pregnancy.Result, error) {
	r, err := pregnancy.Calculate(method, in, gaDate)
	if err != nil {
		return pregnancy.Result{}, apperr.Validation(err.Error())
	}
	return r, nil
}

// SummaryFor prices a whole worklist in one query.
//
// The triage board needs to know, per row, whether this patient already has a dating —
// without it the nurse cannot tell a recorded pregnancy from an unrecorded one, and
// re-opens the calculator to find out. Per-row fetching would be one request per
// patient on every refresh, so the board asks once for the patients it is showing.
func (s *Service) SummaryFor(ctx context.Context, patientIDs []uuid.UUID, gaDate time.Time) (map[uuid.UUID]maternity.Dating, error) {
	out := map[uuid.UUID]maternity.Dating{}
	if len(patientIDs) == 0 {
		return out, nil
	}
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT patient_id, method, calculated_lmp, updated_at FROM pregnancy_dating
			  WHERE tenant_id = $1 AND patient_id = ANY($2::uuid[])`, tid, patientIDs)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var pid uuid.UUID
			var method string
			var lmp, updated time.Time
			if e := rows.Scan(&pid, &method, &lmp, &updated); e != nil {
				return e
			}
			u := updated
			out[pid] = maternity.Dating{
				Method:    pregnancy.Method(method),
				Result:    pregnancy.ResultFromLMP(lmp, gaDate),
				UpdatedAt: &u,
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) GetDating(ctx context.Context, patientID uuid.UUID, gaDate time.Time) (*maternity.Dating, error) {
	tid, _ := actorOf(ctx)
	var method string
	var lmp, updated time.Time
	found := false
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx,
			`SELECT method, calculated_lmp, updated_at FROM pregnancy_dating WHERE tenant_id = $1 AND patient_id = $2`,
			tid, patientID).Scan(&method, &lmp, &updated)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e != nil {
			return e
		}
		found = true
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	if !found {
		return nil, nil
	}
	return &maternity.Dating{
		Method:    pregnancy.Method(method),
		Result:    pregnancy.ResultFromLMP(lmp, gaDate),
		UpdatedAt: &updated,
	}, nil
}

func (s *Service) SaveDating(ctx context.Context, patientID uuid.UUID, method pregnancy.Method, in pregnancy.Inputs, gaDate time.Time, note string) (*maternity.SaveResult, error) {
	tid, actor := actorOf(ctx)
	res, err := pregnancy.Calculate(method, in, gaDate)
	if err != nil {
		return nil, apperr.Validation(err.Error())
	}
	inputsJSON, err := json.Marshal(in)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	var redate *maternity.RedateRec
	txErr := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// prior dating (for the redating recommendation)
		var prevLMP, prevEDD time.Time
		hasPrev := false
		if e := tx.QueryRow(ctx,
			`SELECT calculated_lmp, edd FROM pregnancy_dating WHERE tenant_id = $1 AND patient_id = $2`,
			tid, patientID).Scan(&prevLMP, &prevEDD); e == nil {
			hasPrev = true
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}

		var id uuid.UUID
		if e := tx.QueryRow(ctx,
			`INSERT INTO pregnancy_dating (tenant_id, patient_id, method, inputs, calculated_lmp, edd, estimated_conception)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)
			 ON CONFLICT (tenant_id, patient_id) DO UPDATE SET
			   method = EXCLUDED.method, inputs = EXCLUDED.inputs, calculated_lmp = EXCLUDED.calculated_lmp,
			   edd = EXCLUDED.edd, estimated_conception = EXCLUDED.estimated_conception, updated_at = now()
			 RETURNING id`,
			tid, patientID, string(method), inputsJSON, fmtDate(res.CalculatedLMP), fmtDate(res.EDD), fmtDate(res.EstimatedConception)).Scan(&id); e != nil {
			return e
		}
		var notePtr *string
		if note != "" {
			notePtr = &note
		}
		if _, e := tx.Exec(ctx,
			`INSERT INTO pregnancy_dating_history (tenant_id, patient_id, method, inputs, calculated_lmp, edd, estimated_conception, recorded_by, note)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			tid, patientID, string(method), inputsJSON, fmtDate(res.CalculatedLMP), fmtDate(res.EDD), fmtDate(res.EstimatedConception), actor, notePtr); e != nil {
			return e
		}

		// Redating recommendation: replacing a prior dating with an ultrasound whose
		// EDD differs beyond the ACOG threshold. Informational — the save is explicit.
		if hasPrev && method == pregnancy.MethodUltrasound && in.UltrasoundDate != nil {
			gaAtUs := int(in.UltrasoundDate.Sub(prevLMP).Hours()/24 + 0.5)
			disc := absInt(int(res.EDD.Sub(prevEDD).Hours()/24 + 0.5))
			redate = &maternity.RedateRec{
				Recommended: pregnancy.ShouldRedate(gaAtUs, disc), DiscrepancyDays: disc,
				PreviousEDD: prevEDD, NewEDD: res.EDD,
			}
		}
		return s.publisher.Publish(ctx, tx, &tid, "pregnancy_dating", id, "maternity.dating.recorded",
			map[string]any{"patient_id": patientID, "method": string(method), "edd": fmtDate(res.EDD)})
	})
	if txErr != nil {
		return nil, apperr.Internal(txErr)
	}
	return &maternity.SaveResult{Dating: maternity.Dating{Method: method, Result: res}, Redate: redate}, nil
}

func (s *Service) History(ctx context.Context, patientID uuid.UUID) ([]maternity.HistoryEntry, error) {
	tid, _ := actorOf(ctx)
	out := []maternity.HistoryEntry{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT h.method, h.calculated_lmp, h.edd, coalesce(u.full_name,''), h.recorded_at, coalesce(h.note,'')
			 FROM pregnancy_dating_history h
			 LEFT JOIN users u ON u.id = h.recorded_by AND u.tenant_id = h.tenant_id
			 WHERE h.tenant_id = $1 AND h.patient_id = $2
			 ORDER BY h.recorded_at DESC`, tid, patientID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var h maternity.HistoryEntry
			var method string
			if e := rows.Scan(&method, &h.CalculatedLMP, &h.EDD, &h.RecordedByName, &h.RecordedAt, &h.Note); e != nil {
				return e
			}
			h.Method = pregnancy.Method(method)
			out = append(out, h)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}
