// Package service implements inpatient bed management: wards/beds configuration,
// admit/discharge/transfer, the live board, and reporting. Bed fees bill through
// the billing.Charger spine (source='bed'); day counting uses Addis local time.
package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/inpatient"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
	billing   billing.Charger
}

var _ inpatient.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, publisher events.Publisher, charger billing.Charger) *Service {
	return &Service{db: db, publisher: publisher, billing: charger}
}

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

func activeBranchOf(ctx context.Context) *uuid.UUID {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		return p.ActiveBranchID
	}
	return nil
}

func money(s string) float64    { f, _ := strconv.ParseFloat(s, 64); return f }
func fmtMoney(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) }

// --- wards ---

func (s *Service) ListWards(ctx context.Context) ([]inpatient.Ward, error) {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	out := []inpatient.Ward{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT w.id, w.branch_id, w.name, w.is_active,
			   (SELECT count(*) FROM beds b WHERE b.ward_id = w.id AND b.is_active)::int
			 FROM wards w
			 WHERE w.tenant_id = $1 AND ($2::uuid IS NULL OR w.branch_id = $2) AND w.is_active
			 ORDER BY w.name`, tid, br)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var w inpatient.Ward
			if e := rows.Scan(&w.ID, &w.BranchID, &w.Name, &w.IsActive, &w.BedCount); e != nil {
				return e
			}
			out = append(out, w)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateWard(ctx context.Context, in inpatient.WardInput) (*inpatient.Ward, error) {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	if br == nil {
		return nil, apperr.Validation("switch to a specific branch to add a ward")
	}
	if in.Name == "" {
		return nil, apperr.Validation("ward name is required")
	}
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `INSERT INTO wards (tenant_id, branch_id, name) VALUES ($1,$2,$3) RETURNING id`, tid, *br, in.Name).Scan(&id)
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &inpatient.Ward{ID: id, BranchID: *br, Name: in.Name, IsActive: true}, nil
}

func (s *Service) UpdateWard(ctx context.Context, id uuid.UUID, in inpatient.WardInput) error {
	tid, _ := actorOf(ctx)
	active := true
	if in.IsActive != nil {
		active = *in.IsActive
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx, `UPDATE wards SET name = COALESCE(NULLIF($3,''), name), is_active = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
			tid, id, in.Name, active)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("WARD_NOT_FOUND", "ward not found")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- beds ---

func (s *Service) ListBeds(ctx context.Context) ([]inpatient.Bed, error) {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	out := []inpatient.Bed{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT b.id, b.ward_id, w.name, b.label, b.bed_type, b.daily_rate::text, b.out_of_service, b.is_active, coalesce(b.note,'')
			 FROM beds b JOIN wards w ON w.id = b.ward_id AND w.tenant_id = b.tenant_id
			 WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR b.branch_id = $2) AND b.is_active
			 ORDER BY w.name, b.label`, tid, br)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var b inpatient.Bed
			if e := rows.Scan(&b.ID, &b.WardID, &b.WardName, &b.Label, &b.BedType, &b.DailyRate, &b.OutOfService, &b.IsActive, &b.Note); e != nil {
				return e
			}
			out = append(out, b)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateBed(ctx context.Context, in inpatient.BedInput) (*inpatient.Bed, error) {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	if br == nil {
		return nil, apperr.Validation("switch to a specific branch to add a bed")
	}
	if in.Label == "" || in.WardID == uuid.Nil {
		return nil, apperr.Validation("ward and bed label are required")
	}
	bt := in.BedType
	if bt == "" {
		bt = "general"
	}
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`INSERT INTO beds (tenant_id, branch_id, ward_id, label, bed_type, daily_rate, note)
			 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
			tid, *br, in.WardID, in.Label, bt, orZero(in.DailyRate), nullStr(in.Note)).Scan(&id)
	})
	if err != nil {
		if isUnique(err) {
			return nil, apperr.Conflict("BED_LABEL_TAKEN", "a bed with that label already exists in this ward")
		}
		return nil, apperr.Internal(err)
	}
	return &inpatient.Bed{ID: id, WardID: in.WardID, Label: in.Label, BedType: bt, DailyRate: orZero(in.DailyRate), IsActive: true, Note: in.Note}, nil
}

func (s *Service) UpdateBed(ctx context.Context, id uuid.UUID, in inpatient.BedInput) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// If deactivating, block while occupied.
		if in.IsActive != nil && !*in.IsActive {
			var occ int
			if e := tx.QueryRow(ctx, `SELECT count(*) FROM bed_admissions WHERE tenant_id=$1 AND bed_id=$2 AND status='active'`, tid, id).Scan(&occ); e != nil {
				return e
			}
			if occ > 0 {
				return apperr.Conflict("BED_OCCUPIED", "discharge the patient before removing this bed")
			}
		}
		ct, e := tx.Exec(ctx,
			`UPDATE beds SET
			   ward_id = COALESCE($3, ward_id),
			   label = COALESCE(NULLIF($4,''), label),
			   bed_type = COALESCE(NULLIF($5,''), bed_type),
			   daily_rate = COALESCE($6, daily_rate),
			   out_of_service = COALESCE($7, out_of_service),
			   is_active = COALESCE($8, is_active),
			   note = COALESCE($9, note),
			   updated_at = now()
			 WHERE tenant_id = $1 AND id = $2`,
			tid, id, nullUUID(in.WardID), in.Label, in.BedType, nullRate(in.DailyRate), in.OutOfService, in.IsActive, nullStr(in.Note))
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("BED_NOT_FOUND", "bed not found")
		}
		return nil
	})
	if isUnique(err) {
		return apperr.Conflict("BED_LABEL_TAKEN", "a bed with that label already exists in this ward")
	}
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- board ---

func (s *Service) Board(ctx context.Context) ([]inpatient.BoardBed, error) {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	out := []inpatient.BoardBed{}
	now := time.Now()
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT b.id, b.ward_id, w.name, b.label, b.bed_type, b.daily_rate::text, b.out_of_service,
			        a.id, a.patient_id, p.first_name, p.last_name, p.mrn, a.admitted_at, a.daily_rate::text, a.payment_due_at,
			        greatest(0, (a.expected_discharge - (a.admitted_at AT TIME ZONE 'Africa/Addis_Ababa')::date)) AS planned_nights,
			        (a.payment_due_at IS NOT NULL AND a.payment_due_at < now() AND c.status = 'pending') AS overdue
			 FROM beds b
			 JOIN wards w ON w.id = b.ward_id AND w.tenant_id = b.tenant_id
			 LEFT JOIN bed_admissions a ON a.bed_id = b.id AND a.tenant_id = b.tenant_id AND a.status = 'active'
			 LEFT JOIN patients p ON p.id = a.patient_id AND p.tenant_id = b.tenant_id
			 LEFT JOIN charges c ON c.id = a.deposit_charge_id AND c.tenant_id = b.tenant_id
			 WHERE b.tenant_id = $1 AND ($2::uuid IS NULL OR b.branch_id = $2) AND b.is_active
			 ORDER BY w.name, b.label`, tid, br)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var bb inpatient.BoardBed
			var admID, patID *uuid.UUID
			var first, last, mrn *string
			var admittedAt, dueAt *time.Time
			var admRate *string
			var overdue *bool
			var planned *int
			if e := rows.Scan(&bb.ID, &bb.WardID, &bb.WardName, &bb.Label, &bb.BedType, &bb.DailyRate, &bb.OutOfService,
				&admID, &patID, &first, &last, &mrn, &admittedAt, &admRate, &dueAt, &planned, &overdue); e != nil {
				return e
			}
			if admID != nil {
				bb.Occupied = true
				bb.AdmissionID, bb.PatientID = admID, patID
				bb.PatientName = deref(first) + " " + deref(last)
				bb.MRN = deref(mrn)
				bb.AdmittedAt = admittedAt
				bb.PaymentDueAt = dueAt
				bb.Overdue = overdue != nil && *overdue
				if planned != nil {
					bb.PlannedNights = *planned
				}
				// Priced below, from the segments, so the board and the bill agree.
				_ = admRate
			}
			out = append(out, bb)
		}
		if e := rows.Err(); e != nil {
			return e
		}
		live := []uuid.UUID{}
		for _, b := range out {
			if b.AdmissionID != nil {
				live = append(live, *b.AdmissionID)
			}
		}
		costs, e := stayMoney(ctx, tx, tid, live, now.Format(time.RFC3339Nano))
		if e != nil {
			return e
		}
		for i := range out {
			if out[i].AdmissionID == nil {
				continue
			}
			c := costs[*out[i].AdmissionID]
			out[i].Days = c.Nights
			out[i].EstCost = fmtMoney(c.Amount)
			out[i].Paid = fmtMoney(c.Paid)
			out[i].Unbilled = fmtMoney(c.Unbilled)
			out[i].Outstanding = fmtMoney(c.Outstanding)
			out[i].CoveredNights = c.CoveredNights
			out[i].CoveredThru = c.CoveredThru
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// --- admit / discharge / transfer ---

func (s *Service) Admit(ctx context.Context, in inpatient.AdmitInput) (*inpatient.Admission, error) {
	tid, actor := actorOf(ctx)
	deposit := money(in.DepositAmount)
	var res inpatient.Admission
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var branchID uuid.UUID
		var rate string
		var active, oos bool
		var wardName, bedLabel string
		e := tx.QueryRow(ctx,
			`SELECT b.branch_id, b.daily_rate::text, b.is_active, b.out_of_service, w.name, b.label
			 FROM beds b JOIN wards w ON w.id=b.ward_id AND w.tenant_id=b.tenant_id
			 WHERE b.tenant_id=$1 AND b.id=$2`, tid, in.BedID).Scan(&branchID, &rate, &active, &oos, &wardName, &bedLabel)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("BED_NOT_FOUND", "bed not found")
		}
		if e != nil {
			return e
		}
		if !active || oos {
			return apperr.Validation("that bed is not available")
		}

		var id uuid.UUID
		var admittedAt time.Time
		e = tx.QueryRow(ctx,
			`INSERT INTO bed_admissions (tenant_id, branch_id, patient_id, bed_id, daily_rate, deposit_amount, charged_amount, payment_due_at, expected_discharge, admitted_by, note)
			 VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10) RETURNING id, admitted_at`,
			tid, branchID, in.PatientID, in.BedID, rate, fmtMoney(deposit), in.PaymentDueAt, in.ExpectedDischarge, actor, nullStr(in.Note)).Scan(&id, &admittedAt)
		if isUnique(e) {
			return apperr.Conflict("ALREADY_ADMITTED", "that bed is occupied, or the patient is already admitted to a bed")
		}
		if e != nil {
			return e
		}

		// The stay's first segment. Money is computed from these, never from the
		// admission's own bed_id/daily_rate, which Transfer moves.
		if _, e := tx.Exec(ctx,
			`INSERT INTO bed_admission_stays (tenant_id, admission_id, bed_id, daily_rate, from_at)
			 VALUES ($1,$2,$3,$4,$5)`, tid, id, in.BedID, rate, admittedAt); e != nil {
			return e
		}

		if deposit > 0 {
			cid, ce := s.billing.RaiseChargeTx(ctx, tx, billing.ChargeInput{
				PatientID: in.PatientID, BranchID: &branchID, Source: "bed",
				Description: fmt.Sprintf("Bed deposit — %s / %s", wardName, bedLabel), Amount: fmtMoney(deposit),
			})
			if ce != nil {
				return ce
			}
			if _, e := tx.Exec(ctx, `UPDATE bed_admissions SET deposit_charge_id=$1 WHERE tenant_id=$2 AND id=$3`, cid, tid, id); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `UPDATE charges SET admission_id=$1 WHERE tenant_id=$2 AND id=$3`, id, tid, cid); e != nil {
				return e
			}
		}
		res = inpatient.Admission{
			ID: id, PatientID: in.PatientID, BedID: in.BedID, WardName: wardName, BedLabel: bedLabel,
			AdmittedAt: admittedAt, Status: "active", DailyRate: rate, PaymentDueAt: in.PaymentDueAt,
			// A fresh admission has crossed no midnight: one night, at this bed's rate.
			Days: 1,
		}
		res.EstCost = fmtMoney(money(rate))
		return s.publisher.Publish(ctx, tx, &tid, "bed_admission", id, "inpatient.admitted",
			map[string]any{"admission_id": id, "patient_id": in.PatientID, "bed_id": in.BedID, "deposit": fmtMoney(deposit)})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &res, nil
}

func (s *Service) Discharge(ctx context.Context, admissionID uuid.UUID) (*inpatient.Admission, error) {
	tid, actor := actorOf(ctx)
	var res inpatient.Admission
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var patientID, bedID, branchID uuid.UUID
		var admittedAt time.Time
		var rate, charged, wardName, bedLabel, mrn, first, last string
		var status string
		e := tx.QueryRow(ctx,
			`SELECT a.patient_id, a.bed_id, a.branch_id, a.admitted_at, a.daily_rate::text, a.charged_amount::text, a.status,
			        w.name, b.label, p.mrn, p.first_name, p.last_name
			 FROM bed_admissions a
			 JOIN beds b ON b.id=a.bed_id AND b.tenant_id=a.tenant_id
			 JOIN wards w ON w.id=b.ward_id AND w.tenant_id=a.tenant_id
			 JOIN patients p ON p.id=a.patient_id AND p.tenant_id=a.tenant_id
			 WHERE a.tenant_id=$1 AND a.id=$2`, tid, admissionID).Scan(
			&patientID, &bedID, &branchID, &admittedAt, &rate, &charged, &status, &wardName, &bedLabel, &mrn, &first, &last)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("ADMISSION_NOT_FOUND", "admission not found")
		}
		if e != nil {
			return e
		}
		if status != "active" {
			return apperr.Validation("this admission is already discharged")
		}
		now := time.Now()
		// Close the open segment first, then price every bed the patient actually
		// occupied. `rate` below is only the LAST bed's and is no longer what the
		// stay costs.
		if _, e := tx.Exec(ctx,
			`UPDATE bed_admission_stays SET to_at=$3 WHERE tenant_id=$1 AND admission_id=$2 AND to_at IS NULL`,
			tid, admissionID, now); e != nil {
			return e
		}
		costs, e := stayMoney(ctx, tx, tid, []uuid.UUID{admissionID}, now.Format(time.RFC3339Nano))
		if e != nil {
			return e
		}
		cost := costs[admissionID]
		nights := cost.Nights
		total := cost.Amount
		// Whatever the stay ran up that nobody has asked for yet. Taken from the
		// charges themselves, so a deposit and any number of top-ups are already
		// accounted for and the patient is never billed twice for the same night.
		remainder := cost.Unbilled
		newCharged := cost.Billed
		if remainder > 0.005 {
			cid, ce := s.billing.RaiseChargeTx(ctx, tx, billing.ChargeInput{
				PatientID: patientID, BranchID: &branchID, Source: "bed",
				Description: fmt.Sprintf("Bed stay — %s / %s (%d day%s)", wardName, bedLabel, nights, plural(nights)), Amount: fmtMoney(remainder),
			})
			if ce != nil {
				return ce
			}
			if _, e := tx.Exec(ctx, `UPDATE charges SET admission_id=$1 WHERE tenant_id=$2 AND id=$3`, admissionID, tid, cid); e != nil {
				return e
			}
			newCharged = cost.Billed + remainder
		}
		_ = charged
		if _, e := tx.Exec(ctx,
			`UPDATE bed_admissions SET status='discharged', discharged_at=now(), charged_amount=$3, discharged_by=$4, updated_at=now()
			 WHERE tenant_id=$1 AND id=$2`, tid, admissionID, fmtMoney(newCharged), actor); e != nil {
			return e
		}
		res = inpatient.Admission{
			ID: admissionID, PatientID: patientID, BedID: bedID, PatientName: first + " " + last, MRN: mrn,
			WardName: wardName, BedLabel: bedLabel, AdmittedAt: admittedAt, DischargedAt: &now, Status: "discharged",
			DailyRate: rate, Days: nights, EstCost: fmtMoney(total),
		}
		return s.publisher.Publish(ctx, tx, &tid, "bed_admission", admissionID, "inpatient.discharged",
			map[string]any{"admission_id": admissionID, "patient_id": patientID, "nights": nights, "total": fmtMoney(total)})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &res, nil
}

func (s *Service) Transfer(ctx context.Context, admissionID, newBedID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var status string
		if e := tx.QueryRow(ctx, `SELECT status FROM bed_admissions WHERE tenant_id=$1 AND id=$2`, tid, admissionID).Scan(&status); errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("ADMISSION_NOT_FOUND", "admission not found")
		} else if e != nil {
			return e
		}
		if status != "active" {
			return apperr.Validation("only an active admission can be transferred")
		}
		var rate string
		var active, oos bool
		if e := tx.QueryRow(ctx, `SELECT daily_rate::text, is_active, out_of_service FROM beds WHERE tenant_id=$1 AND id=$2`, tid, newBedID).Scan(&rate, &active, &oos); errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("BED_NOT_FOUND", "bed not found")
		} else if e != nil {
			return e
		}
		if !active || oos {
			return apperr.Validation("that bed is not available")
		}
		ct, e := tx.Exec(ctx, `UPDATE bed_admissions SET bed_id=$3, daily_rate=$4, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='active'`,
			tid, admissionID, newBedID, rate)
		if isUnique(e) {
			return apperr.Conflict("BED_OCCUPIED", "that bed is already occupied")
		}
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("ADMISSION_NOT_FOUND", "admission not found")
		}
		// The admission row now names the CURRENT bed, which is what the board wants.
		// What the patient is billed comes from the segments, so the nights already
		// spent in the old bed keep the old bed's rate — before this, the transfer
		// silently repriced the entire stay.
		moved := time.Now()
		if _, e := tx.Exec(ctx,
			`UPDATE bed_admission_stays SET to_at=$3 WHERE tenant_id=$1 AND admission_id=$2 AND to_at IS NULL`,
			tid, admissionID, moved); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx,
			`INSERT INTO bed_admission_stays (tenant_id, admission_id, bed_id, daily_rate, from_at)
			 VALUES ($1,$2,$3,$4,$5)`, tid, admissionID, newBedID, rate, moved); e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tid, "bed_admission", admissionID, "inpatient.transferred",
			map[string]any{"admission_id": admissionID, "bed_id": newBedID})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- report ---

func (s *Service) Report(ctx context.Context) (*inpatient.Report, error) {
	tid, _ := actorOf(ctx)
	br := activeBranchOf(ctx)
	rep := &inpatient.Report{ByWard: []inpatient.WardOccupancy{}, Overdue: []inpatient.Admission{}}
	now := time.Now()
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// occupancy totals
		var oos int
		if e := tx.QueryRow(ctx,
			`SELECT count(*)::int, count(*) FILTER (WHERE out_of_service)::int
			 FROM beds WHERE tenant_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) AND is_active`, tid, br).Scan(&rep.TotalBeds, &oos); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx,
			`SELECT count(*)::int FROM bed_admissions WHERE tenant_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) AND status='active'`, tid, br).Scan(&rep.Occupied); e != nil {
			return e
		}
		rep.CurrentPatients = rep.Occupied
		rep.Available = rep.TotalBeds - rep.Occupied - oos
		if rep.Available < 0 {
			rep.Available = 0
		}
		// by ward
		wr, e := tx.Query(ctx,
			`SELECT w.name, count(b.*)::int,
			        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bed_admissions a WHERE a.bed_id=b.id AND a.status='active'))::int
			 FROM wards w JOIN beds b ON b.ward_id=w.id AND b.tenant_id=w.tenant_id AND b.is_active
			 WHERE w.tenant_id=$1 AND ($2::uuid IS NULL OR w.branch_id=$2) AND w.is_active
			 GROUP BY w.name ORDER BY w.name`, tid, br)
		if e != nil {
			return e
		}
		for wr.Next() {
			var wo inpatient.WardOccupancy
			if e := wr.Scan(&wo.Ward, &wo.Total, &wo.Occupied); e != nil {
				wr.Close()
				return e
			}
			rep.ByWard = append(rep.ByWard, wo)
		}
		wr.Close()
		if e := wr.Err(); e != nil {
			return e
		}
		// avg length of stay (discharged)
		var avg *float64
		if e := tx.QueryRow(ctx,
			`SELECT avg(extract(epoch FROM (discharged_at - admitted_at))/86400.0)
			 FROM bed_admissions WHERE tenant_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) AND status='discharged'`, tid, br).Scan(&avg); e != nil {
			return e
		}
		if avg != nil {
			rep.AvgLOSDays = math.Round(*avg*10) / 10
		}
		// bed revenue (collected)
		var rev string
		if e := tx.QueryRow(ctx,
			`SELECT coalesce(sum(amount),0)::text FROM charges
			 WHERE tenant_id=$1 AND source='bed' AND status='paid' AND ($2::uuid IS NULL OR branch_id=$2)`, tid, br).Scan(&rev); e != nil {
			return e
		}
		rep.BedRevenue = rev
		// overdue admissions
		or, e := tx.Query(ctx,
			`SELECT a.id, a.admitted_at, a.daily_rate::text, a.payment_due_at, w.name, b.label, p.first_name, p.last_name, p.mrn
			 FROM bed_admissions a
			 JOIN beds b ON b.id=a.bed_id AND b.tenant_id=a.tenant_id
			 JOIN wards w ON w.id=b.ward_id AND w.tenant_id=a.tenant_id
			 JOIN patients p ON p.id=a.patient_id AND p.tenant_id=a.tenant_id
			 LEFT JOIN charges c ON c.id=a.deposit_charge_id AND c.tenant_id=a.tenant_id
			 WHERE a.tenant_id=$1 AND ($2::uuid IS NULL OR a.branch_id=$2) AND a.status='active'
			   AND a.payment_due_at IS NOT NULL AND a.payment_due_at < now() AND c.status='pending'
			 ORDER BY a.payment_due_at`, tid, br)
		if e != nil {
			return e
		}
		for or.Next() {
			var a inpatient.Admission
			var rate string
			var first, last string
			if e := or.Scan(&a.ID, &a.AdmittedAt, &rate, &a.PaymentDueAt, &a.WardName, &a.BedLabel, &first, &last, &a.MRN); e != nil {
				or.Close()
				return e
			}
			a.PatientName = first + " " + last
			a.Status = "active"
			a.DailyRate = rate
			a.Overdue = true
			rep.Overdue = append(rep.Overdue, a)
		}
		or.Close()
		if e := or.Err(); e != nil {
			return e
		}
		ids := make([]uuid.UUID, 0, len(rep.Overdue))
		for _, a := range rep.Overdue {
			ids = append(ids, a.ID)
		}
		costs, e := stayCosts(ctx, tx, tid, ids, now.Format(time.RFC3339Nano))
		if e != nil {
			return e
		}
		for i := range rep.Overdue {
			c := costs[rep.Overdue[i].ID]
			rep.Overdue[i].Days = c.Nights
			rep.Overdue[i].EstCost = fmtMoney(c.Amount)
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return rep, nil
}

// --- helpers ---

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
func orZero(s string) string {
	if s == "" {
		return "0"
	}
	return s
}
func nullRate(s string) *string { // for COALESCE update: empty = keep existing
	if s == "" {
		return nil
	}
	return &s
}
func nullUUID(u uuid.UUID) *uuid.UUID {
	if u == uuid.Nil {
		return nil
	}
	return &u
}
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
func isUnique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

// TopUp asks the family for more of the running bed bill.
//
// A bed accrued its cost silently and raised a single charge at discharge, so a
// thirty-day stay had nothing on the cashier after the deposit — the desk could not
// take a payment even when the family arrived offering one. Staff think in nights
// ("another ten days"), so Nights is the primary input and is priced at the bed the
// patient is in now; Amount covers the part payment that is not a whole number of
// nights.
//
// Paying ahead is allowed and is the common case: a family that books thirty days and
// pays for ten has covered more nights than the patient has yet slept. Nothing here
// caps the ask at what has accrued.
func (s *Service) TopUp(ctx context.Context, admissionID uuid.UUID, in inpatient.TopUpInput) (*inpatient.Admission, error) {
	tid, _ := actorOf(ctx)
	var res inpatient.Admission
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var patientID, branchID uuid.UUID
		var status, wardName, bedLabel, rate string
		e := tx.QueryRow(ctx,
			`SELECT a.patient_id, a.branch_id, a.status, w.name, b.label, b.daily_rate::text
			   FROM bed_admissions a
			   JOIN beds b ON b.id=a.bed_id AND b.tenant_id=a.tenant_id
			   JOIN wards w ON w.id=b.ward_id AND w.tenant_id=a.tenant_id
			  WHERE a.tenant_id=$1 AND a.id=$2`, tid, admissionID).
			Scan(&patientID, &branchID, &status, &wardName, &bedLabel, &rate)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("ADMISSION_NOT_FOUND", "admission not found")
		}
		if e != nil {
			return e
		}
		if status != "active" {
			return apperr.Validation("this patient has already been discharged")
		}

		// What to ask for, in order of how deliberate the request is.
		amount := 0.0
		desc := ""
		switch {
		case in.Nights > 0:
			amount = round2(float64(in.Nights) * money(rate))
			desc = fmt.Sprintf("Bed — %s / %s (%d night%s)", wardName, bedLabel, in.Nights, plural(in.Nights))
		case in.Amount != "":
			amount = money(in.Amount)
			desc = fmt.Sprintf("Bed — %s / %s (part payment)", wardName, bedLabel)
		default:
			// No figure given: ask for everything the stay has run up that nobody
			// has billed yet.
			m, me := stayMoney(ctx, tx, tid, []uuid.UUID{admissionID}, time.Now().Format(time.RFC3339Nano))
			if me != nil {
				return me
			}
			amount = m[admissionID].Unbilled
			desc = fmt.Sprintf("Bed — %s / %s (to date)", wardName, bedLabel)
		}
		if amount <= 0.005 {
			return apperr.Validation("there is nothing to bill for this bed yet")
		}

		cid, ce := s.billing.RaiseChargeTx(ctx, tx, billing.ChargeInput{
			PatientID: patientID, BranchID: &branchID, Source: "bed",
			Description: desc, Amount: fmtMoney(amount),
		})
		if ce != nil {
			return ce
		}
		if _, e := tx.Exec(ctx, `UPDATE charges SET admission_id=$1 WHERE tenant_id=$2 AND id=$3`, admissionID, tid, cid); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx,
			`UPDATE bed_admissions SET charged_amount = charged_amount + $3, updated_at=now()
			  WHERE tenant_id=$1 AND id=$2`, tid, admissionID, fmtMoney(amount)); e != nil {
			return e
		}
		res = inpatient.Admission{ID: admissionID, PatientID: patientID, WardName: wardName, BedLabel: bedLabel,
			Status: status, DailyRate: rate, EstCost: fmtMoney(amount)}
		return s.publisher.Publish(ctx, tx, &tid, "bed_admission", admissionID, "inpatient.topped_up",
			map[string]any{"admission_id": admissionID, "patient_id": patientID, "amount": fmtMoney(amount), "nights": in.Nights})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &res, nil
}
