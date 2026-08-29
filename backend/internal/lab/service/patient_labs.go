package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/lab"
)

// PatientLabs is every test this patient has ever had, newest order first.
//
// The lab could only ever be asked "what did THIS encounter order?". Nobody could
// ask "what has this patient had done?" — which is the question a scientist at the
// bench actually has (is this a repeat, and what did it read last time?) and the
// one a doctor has before ordering the same panel twice. The patient page showed
// laboratory work not at all.
//
// Written as one flat query grouped in Go rather than the per-order fan-out the
// encounter view uses: a patient with years of history would otherwise cost three
// round trips per order.
func (s *Service) PatientLabs(ctx context.Context, patientID uuid.UUID) ([]lab.EncounterOrder, error) {
	tenantID, _ := actorOf(ctx)
	out := []lab.EncounterOrder{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT o.order_no, o.priority, o.created_at,
			        i.sample_no, t.name, i.status,
			        a.name, coalesce(a.unit,''), coalesce(r.value,''), r.flag,
			        coalesce(a.ref_low::text,''), coalesce(a.ref_high::text,'')
			   FROM lab_orders o
			   JOIN lab_order_items i ON i.order_id = o.id AND i.tenant_id = o.tenant_id
			   JOIN lab_tests t ON t.id = i.test_id AND t.tenant_id = o.tenant_id
			   LEFT JOIN lab_results r ON r.order_item_id = i.id AND r.tenant_id = o.tenant_id
			   LEFT JOIN lab_analytes a ON a.id = r.analyte_id AND a.tenant_id = o.tenant_id
			  WHERE o.tenant_id = $1 AND o.patient_id = $2 AND o.deleted_at IS NULL
			  ORDER BY o.created_at DESC, o.order_no DESC, i.sample_no, a.sort_order, a.name`,
			tenantID, patientID)
		if e != nil {
			return e
		}
		defer rows.Close()

		byOrder := map[int64]*lab.EncounterOrder{}
		byItem := map[int64]*lab.EncounterOrderItem{}
		for rows.Next() {
			var orderNo, sampleNo int64
			var priority, testName, status string
			var createdAt time.Time
			var aName, aUnit, value, refLow, refHigh *string
			var flag *string
			if e := rows.Scan(&orderNo, &priority, &createdAt, &sampleNo, &testName, &status,
				&aName, &aUnit, &value, &flag, &refLow, &refHigh); e != nil {
				return e
			}
			o, ok := byOrder[orderNo]
			if !ok {
				out = append(out, lab.EncounterOrder{OrderNo: orderNo, Priority: priority, CreatedAt: createdAt, Items: []lab.EncounterOrderItem{}})
				o = &out[len(out)-1]
				byOrder[orderNo] = o
			}
			it, ok := byItem[sampleNo]
			if !ok {
				o.Items = append(o.Items, lab.EncounterOrderItem{SampleNo: sampleNo, TestName: testName, Status: status, Results: []lab.AnalyteResult{}})
				it = &o.Items[len(o.Items)-1]
				byItem[sampleNo] = it
			}
			// An ordered test that has not been run yet joins to no analyte row.
			if aName != nil {
				it.Results = append(it.Results, lab.AnalyteResult{
					Name: *aName, Unit: deref(aUnit), Value: deref(value), Flag: deref(flag),
					RefLow: deref(refLow), RefHigh: deref(refHigh),
				})
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}
