package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/patient"
)

// The clinic's day is Addis, not the session's UTC — the same rule the queue, the
// Z-report and the bed board are held to.
const addisTZ = "Africa/Addis_Ababa"

// Overview answers "what is true about this patient right now", filling only the
// blocks the caller is entitled to. Everything is one transaction and one round
// trip: the page that used to make the desk guess now opens with the answer.
func (s *Service) Overview(ctx context.Context, patientID uuid.UUID, scope patient.OverviewScope) (*patient.Overview, error) {
	tenantID, _ := actor(ctx)
	out := &patient.Overview{}

	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// --- where they are, if they are here ------------------------------
		// A bed outranks a queue entry: an admitted patient is in the building in
		// a way that a waiting-room ticket is not.
		var p patient.Presence
		var ward, bed string
		var admittedAt time.Time
		e := tx.QueryRow(ctx,
			`SELECT w.name, b.label, a.admitted_at
			   FROM bed_admissions a
			   JOIN beds b ON b.id=a.bed_id AND b.tenant_id=a.tenant_id
			   JOIN wards w ON w.id=b.ward_id AND w.tenant_id=a.tenant_id
			  WHERE a.tenant_id=$1 AND a.patient_id=$2 AND a.status='active'`,
			tenantID, patientID).Scan(&ward, &bed, &admittedAt)
		if e == nil {
			out.HereNow = &patient.Presence{
				Kind: "bed", Where: ward + " · " + bed, Since: admittedAt,
				Nights: int(time.Since(admittedAt).Hours() / 24),
			}
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return e
		} else {
			var dept, provider string
			e = tx.QueryRow(ctx,
				`SELECT q.state, coalesce(q.stage,''), q.enqueued_at,
				        coalesce(d.name,''), coalesce(u.full_name,'')
				   FROM queue_entries q
				   LEFT JOIN departments d ON d.id=q.department_id AND d.tenant_id=q.tenant_id
				   LEFT JOIN users u ON u.id=q.assigned_provider_id AND u.tenant_id=q.tenant_id
				  WHERE q.tenant_id=$1 AND q.patient_id=$2 AND q.deleted_at IS NULL
				    AND (q.enqueued_at AT TIME ZONE '`+addisTZ+`')::date
				      = (now() AT TIME ZONE '`+addisTZ+`')::date
				    AND q.state IN ('waiting','called','in_consult')
				  ORDER BY q.enqueued_at DESC LIMIT 1`,
				tenantID, patientID).Scan(&p.State, &p.Stage, &p.Since, &dept, &provider)
			if e == nil {
				p.Kind, p.Where, p.Provider = "queue", dept, provider
				out.HereNow = &p
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}

		// --- the last visit -------------------------------------------------
		// The date is not clinical: reception may know when someone was last seen.
		// The reason is, and is only read for a caller who may read the record.
		if scope.Clinical || scope.Schedule {
			var v patient.VisitBrief
			var status string
			e := tx.QueryRow(ctx,
				`SELECT e.started_at, e.status, coalesce(u.full_name,'')
				   FROM encounters e
				   LEFT JOIN users u ON u.id=e.provider_id AND u.tenant_id=e.tenant_id
				  WHERE e.tenant_id=$1 AND e.patient_id=$2 AND e.deleted_at IS NULL
				  ORDER BY e.started_at DESC LIMIT 1`,
				tenantID, patientID).Scan(&v.At, &status, &v.Provider)
			if e == nil {
				v.Open = status != "closed"
				if scope.Clinical {
					var dx string
					if e := tx.QueryRow(ctx,
						`SELECT d.description FROM diagnoses d
						   JOIN encounters e ON e.id=d.encounter_id AND e.tenant_id=d.tenant_id
						  WHERE d.tenant_id=$1 AND e.patient_id=$2
						  ORDER BY d.is_primary DESC, d.created_at DESC LIMIT 1`,
						tenantID, patientID).Scan(&dx); e == nil {
						v.Diagnosis = dx
					} else if !errors.Is(e, pgx.ErrNoRows) {
						return e
					}
				} else {
					v.Provider = "" // who saw them is part of the record, not the desk's
				}
				out.LastVisit = &v
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}

		// --- money ----------------------------------------------------------
		if scope.Money {
			var m patient.MoneyBrief
			if e := tx.QueryRow(ctx,
				`SELECT coalesce(sum(amount),0)::text,
				        coalesce(max((now() AT TIME ZONE '`+addisTZ+`')::date
				                   - (created_at AT TIME ZONE '`+addisTZ+`')::date), 0),
				        coalesce(bool_and(deferred_at IS NOT NULL), false)
				   FROM charges
				  WHERE tenant_id=$1 AND patient_id=$2 AND status='pending' AND deleted_at IS NULL`,
				tenantID, patientID).Scan(&m.Owed, &m.OldestDays, &m.AllAgreed); e != nil {
				return e
			}
			if e := tx.QueryRow(ctx,
				`SELECT max(settled_at) FROM charges
				  WHERE tenant_id=$1 AND patient_id=$2 AND status='paid' AND deleted_at IS NULL`,
				tenantID, patientID).Scan(&m.LastPaidAt); e != nil {
				return e
			}
			out.Money = &m
		}

		// --- what is booked next --------------------------------------------
		if scope.Schedule {
			var a patient.ApptBrief
			e := tx.QueryRow(ctx,
				`SELECT a.starts_at, coalesce(u.full_name,''), coalesce(d.name,''), a.is_followup
				   FROM appointments a
				   LEFT JOIN users u ON u.id=a.provider_id AND u.tenant_id=a.tenant_id
				   LEFT JOIN departments d ON d.id=a.department_id AND d.tenant_id=a.tenant_id
				  WHERE a.tenant_id=$1 AND a.patient_id=$2 AND a.deleted_at IS NULL
				    AND a.status IN ('booked','confirmed') AND a.starts_at >= now()
				  ORDER BY a.starts_at LIMIT 1`,
				tenantID, patientID).Scan(&a.StartsAt, &a.Provider, &a.Department, &a.IsFollowup)
			if e == nil {
				out.Next = &a
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}

		// --- the bench ------------------------------------------------------
		if scope.Labs {
			var l patient.LabBrief
			if e := tx.QueryRow(ctx,
				`SELECT count(*) FILTER (WHERE i.status IN ('ordered','collected','in_process')),
				        count(*) FILTER (WHERE i.status = 'resulted'),
				        count(*) FILTER (WHERE i.critical_flag AND i.status <> 'cancelled'),
				        max(i.resulted_at)
				   FROM lab_orders o
				   JOIN lab_order_items i ON i.order_id=o.id AND i.tenant_id=o.tenant_id
				  WHERE o.tenant_id=$1 AND o.patient_id=$2 AND o.deleted_at IS NULL`,
				tenantID, patientID).Scan(&l.OnTheBench, &l.ToValidate, &l.Critical, &l.LastAt); e != nil {
				return e
			}
			if l.OnTheBench+l.ToValidate+l.Critical > 0 || l.LastAt != nil {
				out.Labs = &l
			}
		}

		// --- the last set of vitals ------------------------------------------
		if scope.Vitals {
			var v patient.VitalsBrief
			e := tx.QueryRow(ctx,
				`SELECT recorded_at, systolic, diastolic, pulse, temp_c::text, resp_rate, spo2,
				        weight_kg::text, height_cm::text
				   FROM vitals
				  WHERE tenant_id=$1 AND patient_id=$2
				  ORDER BY recorded_at DESC LIMIT 1`,
				tenantID, patientID).Scan(&v.RecordedAt, &v.Systolic, &v.Diastolic, &v.Pulse,
				&v.TempC, &v.RespRate, &v.SpO2, &v.WeightKg, &v.HeightCm)
			if e == nil {
				out.Vitals = &v
			} else if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}
