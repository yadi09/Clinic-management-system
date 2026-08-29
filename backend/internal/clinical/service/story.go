package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/clinical"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// The patient's story, as opposed to their filing.
//
// The record already answered "when did they come" — a list of dates, each with the
// diagnosis made that day. That is the shape of the filing cabinet, and it makes the
// doctor reconstruct the patient from scratch at every visit: read six rows, notice
// that three of them say diabetes, remember what was prescribed in April, hold the
// blood pressures in their head to see which way they are going.
//
// A doctor opens a record to ask three questions, and none of them is a date:
//
//	what do they carry   — the problems that keep coming back
//	what are they on     — the medicines still running
//	which way are they going — the numbers, over time
//
// This computes all three in one round trip. It is deliberately derived rather than
// stored: nobody maintains a problem list by hand, and one that is edited separately
// from the diagnoses drifts away from them within a month.

// Story returns the patient's ongoing problems, current medicines and vitals trend.
func (s *Service) Story(ctx context.Context, patientID uuid.UUID) (*clinical.Story, error) {
	tid, _ := actorOf(ctx)
	out := &clinical.Story{
		Problems:  []clinical.Problem{},
		Medicines: []clinical.Medicine{},
		Trend:     []clinical.TrendPoint{},
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Problems: the same diagnosis made more than once is a condition the patient
		// has, not an event that happened to them. Ordered by how recently it was
		// last seen, because a problem from three years ago is history and one from
		// last month is live.
		rows, e := tx.Query(ctx,
			`SELECT coalesce(d.code,''), d.description, count(*)::int,
			        min(e.started_at), max(e.started_at)
			   FROM diagnoses d
			   JOIN encounters e ON e.id = d.encounter_id AND e.tenant_id = d.tenant_id
			  WHERE d.tenant_id = $1 AND d.patient_id = $2 AND d.deleted_at IS NULL
			    AND e.deleted_at IS NULL
			  GROUP BY coalesce(d.code,''), d.description
			  ORDER BY count(*) DESC, max(e.started_at) DESC
			  LIMIT 12`, tid, patientID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var p clinical.Problem
			if e := rows.Scan(&p.Code, &p.Description, &p.Times, &p.FirstSeen, &p.LastSeen); e != nil {
				rows.Close()
				return e
			}
			out.Problems = append(out.Problems, p)
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return e
		}

		// Medicines: the most recent prescription of each drug. A drug prescribed for
		// 30 days last week is still being taken; the same drug from a year ago is
		// not, so the caller gets the date and decides.
		rows, e = tx.Query(ctx,
			`SELECT DISTINCT ON (lower(i.drug_name))
			        i.drug_name, coalesce(i.dose,''), coalesce(i.frequency,''),
			        coalesce(i.duration,''), coalesce(i.instructions,''), r.created_at
			   FROM prescription_items i
			   JOIN prescriptions r ON r.id = i.prescription_id AND r.tenant_id = i.tenant_id
			  WHERE i.tenant_id = $1 AND r.patient_id = $2 AND r.deleted_at IS NULL
			    AND r.status <> 'cancelled'
			  ORDER BY lower(i.drug_name), r.created_at DESC
			  LIMIT 20`, tid, patientID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var m clinical.Medicine
			if e := rows.Scan(&m.DrugName, &m.Dose, &m.Frequency, &m.Duration, &m.Instructions, &m.LastPrescribed); e != nil {
				rows.Close()
				return e
			}
			out.Medicines = append(out.Medicines, m)
		}
		rows.Close()
		if e := rows.Err(); e != nil {
			return e
		}

		// The trend, oldest first so a sparkline reads left to right.
		rows, e = tx.Query(ctx,
			`SELECT v.recorded_at, v.systolic, v.diastolic, v.pulse, v.spo2,
			        v.temp_c::float8, v.weight_kg::float8
			   FROM vitals v
			  WHERE v.tenant_id = $1 AND v.patient_id = $2
			  ORDER BY v.recorded_at DESC
			  LIMIT 24`, tid, patientID)
		if e != nil {
			return e
		}
		for rows.Next() {
			var t clinical.TrendPoint
			if e := rows.Scan(&t.At, &t.Systolic, &t.Diastolic, &t.Pulse, &t.SpO2, &t.TempC, &t.WeightKg); e != nil {
				rows.Close()
				return e
			}
			out.Trend = append(out.Trend, t)
		}
		rows.Close()
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	// Oldest first for the caller.
	for i, j := 0, len(out.Trend)-1; i < j; i, j = i+1, j-1 {
		out.Trend[i], out.Trend[j] = out.Trend[j], out.Trend[i]
	}
	// A problem seen once is just this visit's diagnosis; two or more is a pattern.
	// Both are returned — the caller shows the recurring ones first — but knowing
	// which is which is the whole point, so it is stated rather than inferred.
	for i := range out.Problems {
		out.Problems[i].Recurring = out.Problems[i].Times > 1
	}
	_ = time.Now
	return out, nil
}
