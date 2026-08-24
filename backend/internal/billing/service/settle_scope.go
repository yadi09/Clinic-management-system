package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	billingdb "github.com/reicb/clinicsaas/internal/billing/repo/gen"
)

// Settling one visit, or one deliberately chosen part of it.
//
// The generated query settles EVERY pending charge a patient has, which is right for
// the cashier: it is looking at all of them and its button names the true total. It
// is wrong for reception, where a patient can arrive owing 1,200 ETB from last month
// and 300 ETB for today — a button that says "Collect 300" must take 300.
//
// One receipt either way: a payment event is a payment event, whether it covered one
// charge or six.

type settleScope struct {
	tenantID, patientID uuid.UUID
	method              string
	actor               *uuid.UUID
	receiptNo           int64
	// only limits the settlement to these charges. Empty = the whole visit.
	only []uuid.UUID
}

func settleScoped(ctx context.Context, tx pgx.Tx, q *billingdb.Queries, sc settleScope) ([]billingdb.SettleVisitRow, error) {
	if len(sc.only) == 0 {
		return q.SettleVisit(ctx, billingdb.SettleVisitParams{
			PaymentMethod: strPtr(sc.method), SettledBy: sc.actor, ReceiptNo: &sc.receiptNo,
			TenantID: sc.tenantID, PatientID: sc.patientID,
		})
	}
	// Same statement, narrowed. Raw pgx because sqlc is not available here to
	// regenerate, and hand-editing generated code is worse than one honest query.
	rows, err := tx.Query(ctx,
		`UPDATE charges SET status = 'paid', payment_method = $3, settled_by = $4,
		        settled_at = now(), receipt_no = $5, updated_at = now()
		  WHERE tenant_id = $1 AND patient_id = $2 AND status = 'pending' AND deleted_at IS NULL
		    AND id = ANY($6)
		 RETURNING id, amount, branch_id, department_id, to_triage, provider_id`,
		sc.tenantID, sc.patientID, strPtr(sc.method), sc.actor, sc.receiptNo, sc.only)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []billingdb.SettleVisitRow{}
	for rows.Next() {
		var r billingdb.SettleVisitRow
		if e := rows.Scan(&r.ID, &r.Amount, &r.BranchID, &r.DepartmentID, &r.ToTriage, &r.ProviderID); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
