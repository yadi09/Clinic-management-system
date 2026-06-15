package service

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/pharmacy"
	pharmacydb "github.com/reicb/clinicsaas/internal/pharmacy/repo/gen"
)

// ============================================================================
// Phase 4b-2: purchasing, stock control, reports
// ============================================================================

func (s *Service) ListSuppliers(ctx context.Context) ([]pharmacy.Supplier, error) {
	tenantID, _ := actorOf(ctx)
	var out []pharmacy.Supplier
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := pharmacydb.New(tx).ListSuppliers(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, pharmacy.Supplier{ID: r.ID, Name: r.Name, Contact: deref(r.Contact), LeadTimeDays: int(r.LeadTimeDays), IsActive: r.IsActive})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateSupplier(ctx context.Context, in pharmacy.SupplierInput) (*pharmacy.Supplier, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return nil, apperr.Validation("a supplier name is required")
	}
	var out pharmacy.Supplier
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := pharmacydb.New(tx).CreateSupplier(ctx, pharmacydb.CreateSupplierParams{
			TenantID: tenantID, Name: in.Name, Contact: strPtr(in.Contact), LeadTimeDays: int32(in.LeadTimeDays), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		out = pharmacy.Supplier{ID: r.ID, Name: r.Name, Contact: deref(r.Contact), LeadTimeDays: int(r.LeadTimeDays), IsActive: r.IsActive}
		return nil
	})
	if err != nil {
		return nil, mapWriteErr(err, "SUPPLIER_EXISTS", "a supplier with this name already exists")
	}
	return &out, nil
}

func (s *Service) ListPOs(ctx context.Context) ([]pharmacy.PO, error) {
	tenantID, _ := actorOf(ctx)
	var out []pharmacy.PO
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := pharmacydb.New(tx).ListPOs(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, pharmacy.PO{ID: r.ID, PONo: r.PoNo, Supplier: r.Supplier, Status: r.Status, ExpectedDate: r.ExpectedDate, Total: r.Total, ItemCount: int(r.ItemCount)})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) GetPO(ctx context.Context, id uuid.UUID) (*pharmacy.PODetail, error) {
	tenantID, _ := actorOf(ctx)
	var out *pharmacy.PODetail
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		h, e := q.GetPO(ctx, pharmacydb.GetPOParams{TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		d := &pharmacy.PODetail{PO: pharmacy.PO{ID: h.ID, PONo: h.PoNo, Supplier: h.Supplier, Status: h.Status, ExpectedDate: h.ExpectedDate, Total: h.Total}, Items: []pharmacy.POItem{}}
		items, e := q.ListPOItems(ctx, pharmacydb.ListPOItemsParams{TenantID: tenantID, PoID: id})
		if e != nil {
			return e
		}
		for _, it := range items {
			d.Items = append(d.Items, pharmacy.POItem{ID: it.ID, DrugID: it.DrugID, DrugName: it.DrugName, Qty: int(it.Qty), UnitCost: it.UnitCost, LineTotal: it.LineTotal, Received: it.Received})
		}
		d.ItemCount = len(d.Items)
		out = d
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("PO_NOT_FOUND", "purchase order not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreatePO(ctx context.Context, in pharmacy.POInput) (*pharmacy.PO, error) {
	tenantID, actor := actorOf(ctx)
	if in.SupplierID == uuid.Nil || len(in.Lines) == 0 {
		return nil, apperr.Validation("a supplier and at least one line are required")
	}
	var out pharmacy.PO
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		var total float64
		for _, l := range in.Lines {
			if l.Qty <= 0 {
				return apperr.Validation("quantity must be positive")
			}
			total += l.UnitCost * float64(l.Qty)
		}
		po, e := q.CreatePO(ctx, pharmacydb.CreatePOParams{
			TenantID: tenantID, SupplierID: in.SupplierID, ExpectedDate: in.ExpectedDate, Total: money(total), Notes: strPtr(in.Notes), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		for _, l := range in.Lines {
			if e := q.CreatePOItem(ctx, pharmacydb.CreatePOItemParams{
				TenantID: tenantID, PoID: po.ID, DrugID: l.DrugID, Qty: int32(l.Qty), UnitCost: money(l.UnitCost), LineTotal: money(l.UnitCost * float64(l.Qty)),
			}); e != nil {
				return e
			}
		}
		out = pharmacy.PO{ID: po.ID, PONo: po.PoNo, Status: po.Status, Total: money(total), ItemCount: len(in.Lines)}
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

func (s *Service) SetPOStatus(ctx context.Context, id uuid.UUID, status string) error {
	if status != "ordered" && status != "cancelled" {
		return apperr.Validation("status must be ordered or cancelled")
	}
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := pharmacydb.New(tx).SetPOStatus(ctx, pharmacydb.SetPOStatusParams{Status: status, TenantID: tenantID, ID: id})
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("PO_NOT_FOUND", "purchase order not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ReceivePO turns a PO into stock: one batch per line + a receive movement.
func (s *Service) ReceivePO(ctx context.Context, in pharmacy.ReceiveInput) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		po, e := q.GetPO(ctx, pharmacydb.GetPOParams{TenantID: tenantID, ID: in.POID})
		if e != nil {
			return e
		}
		if po.Status == "cancelled" {
			return apperr.Conflict("PO_CANCELLED", "this purchase order was cancelled")
		}
		// Atomically claim the PO as received first; if a concurrent receive won,
		// this matches no row and we abort (rolling back any work).
		if _, e := q.SetPOReceived(ctx, pharmacydb.SetPOReceivedParams{TenantID: tenantID, ID: in.POID}); errors.Is(e, pgx.ErrNoRows) {
			return apperr.Conflict("ALREADY_RECEIVED", "this purchase order has already been received")
		} else if e != nil {
			return e
		}
		items, e := q.ListPOItems(ctx, pharmacydb.ListPOItemsParams{TenantID: tenantID, PoID: in.POID})
		if e != nil {
			return e
		}
		rcv := map[uuid.UUID]pharmacy.ReceiveItem{}
		for _, r := range in.Items {
			rcv[r.POItemID] = r
		}
		for _, it := range items {
			r := rcv[it.ID]
			batchNo := strings.TrimSpace(r.BatchNo)
			if batchNo == "" {
				batchNo = "PO" + strconv.FormatInt(po.PoNo, 10)
			}
			b, e := q.CreateBatch(ctx, pharmacydb.CreateBatchParams{
				TenantID: tenantID, DrugID: it.DrugID, BatchNo: batchNo, ExpiryDate: r.Expiry, QtyOnHand: it.Qty, CreatedBy: actor,
			})
			if e != nil {
				return e
			}
			bid := b.ID
			poID := in.POID
			if e := q.InsertStockMovement(ctx, pharmacydb.InsertStockMovementParams{
				TenantID: tenantID, DrugID: it.DrugID, BatchID: &bid, Delta: it.Qty, Reason: "receive", RefType: strPtr("po"), RefID: &poID, CreatedBy: actor,
			}); e != nil {
				return e
			}
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "purchase_order", in.POID, "pharmacy.po_received", map[string]any{"po_no": po.PoNo})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("PO_NOT_FOUND", "purchase order not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- stock control ---

func (s *Service) CreateStockCount(ctx context.Context, note string) (uuid.UUID, error) {
	tenantID, actor := actorOf(ctx)
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		var e error
		id, e = q.CreateStockCount(ctx, pharmacydb.CreateStockCountParams{TenantID: tenantID, Note: strPtr(note), CreatedBy: actor})
		if e != nil {
			return e
		}
		return q.SnapshotStockCountItems(ctx, pharmacydb.SnapshotStockCountItemsParams{TenantID: tenantID, CountID: id})
	})
	if err != nil {
		return uuid.Nil, apperr.Internal(err)
	}
	return id, nil
}

func (s *Service) ListStockCounts(ctx context.Context) ([]pharmacy.StockCount, error) {
	tenantID, _ := actorOf(ctx)
	var out []pharmacy.StockCount
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := pharmacydb.New(tx).ListStockCounts(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, pharmacy.StockCount{ID: r.ID, Status: r.Status, CreatedAt: r.CreatedAt, ApprovedAt: r.ApprovedAt})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) GetStockCount(ctx context.Context, id uuid.UUID) (*pharmacy.StockCountDetail, error) {
	tenantID, _ := actorOf(ctx)
	var out *pharmacy.StockCountDetail
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		h, e := q.GetStockCount(ctx, pharmacydb.GetStockCountParams{TenantID: tenantID, ID: id})
		if e != nil {
			return e
		}
		d := &pharmacy.StockCountDetail{StockCount: pharmacy.StockCount{ID: h.ID, Status: h.Status, CreatedAt: h.CreatedAt, ApprovedAt: h.ApprovedAt}, Items: []pharmacy.StockCountItem{}}
		items, e := q.ListStockCountItems(ctx, pharmacydb.ListStockCountItemsParams{TenantID: tenantID, CountID: id})
		if e != nil {
			return e
		}
		for _, it := range items {
			d.Items = append(d.Items, pharmacy.StockCountItem{ID: it.ID, DrugName: it.DrugName, OnHand: int(it.OnHand), Counted: int(it.Counted), Variance: int(it.Counted) - int(it.OnHand), Adjusted: it.Adjusted})
		}
		out = d
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("COUNT_NOT_FOUND", "stock count not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) SetCounted(ctx context.Context, itemID uuid.UUID, counted int) error {
	tenantID, _ := actorOf(ctx)
	if counted < 0 {
		return apperr.Validation("counted cannot be negative")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return pharmacydb.New(tx).SetStockCountItemCounted(ctx, pharmacydb.SetStockCountItemCountedParams{Counted: int32(counted), TenantID: tenantID, ID: itemID})
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// AdjustCountItem reconciles a count line's variance to the drug's stock (applied
// to the largest batch; documented simplification for a drug-level count).
func (s *Service) AdjustCountItem(ctx context.Context, itemID uuid.UUID) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		it, e := q.GetStockCountItem(ctx, pharmacydb.GetStockCountItemParams{TenantID: tenantID, ID: itemID})
		if e != nil {
			return e
		}
		variance := int(it.Counted) - int(it.OnHand)
		if variance != 0 {
			batches, e := q.ListBatchesByDrug(ctx, pharmacydb.ListBatchesByDrugParams{TenantID: tenantID, DrugID: it.DrugID})
			if e != nil {
				return e
			}
			var target uuid.UUID
			maxQty := int32(-1)
			for _, b := range batches {
				if !b.Quarantined && b.QtyOnHand > maxQty {
					maxQty = b.QtyOnHand
					target = b.ID
				}
			}
			if target == uuid.Nil {
				if variance < 0 {
					return apperr.Conflict("INSUFFICIENT_STOCK", "no batch to reduce for this drug")
				}
				nb, e := q.CreateBatch(ctx, pharmacydb.CreateBatchParams{TenantID: tenantID, DrugID: it.DrugID, BatchNo: "COUNT-ADJ", QtyOnHand: int32(variance), CreatedBy: actor})
				if e != nil {
					return e
				}
				target = nb.ID
			} else if _, e := q.AdjustBatchQty(ctx, pharmacydb.AdjustBatchQtyParams{Delta: int32(variance), TenantID: tenantID, ID: target}); errors.Is(e, pgx.ErrNoRows) {
				return apperr.Conflict("INSUFFICIENT_STOCK", "the count variance would make a batch negative")
			} else if e != nil {
				return e
			}
			bid := target
			if e := q.InsertStockMovement(ctx, pharmacydb.InsertStockMovementParams{
				TenantID: tenantID, DrugID: it.DrugID, BatchID: &bid, Delta: int32(variance), Reason: "count", RefType: strPtr("count"), CreatedBy: actor,
			}); e != nil {
				return e
			}
		}
		return q.MarkStockCountItemAdjusted(ctx, pharmacydb.MarkStockCountItemAdjustedParams{OnHand: it.Counted, TenantID: tenantID, ID: itemID})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("COUNT_ITEM_NOT_FOUND", "count line not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) ApproveStockCount(ctx context.Context, id uuid.UUID) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return pharmacydb.New(tx).ApproveStockCount(ctx, pharmacydb.ApproveStockCountParams{ApprovedBy: actor, TenantID: tenantID, ID: id})
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- reports ---

func (s *Service) Report(ctx context.Context, kind string) (*pharmacy.Report, error) {
	tenantID, _ := actorOf(ctx)
	r := &pharmacy.Report{Rows: [][]string{}}
	today := startOfDayUTC()
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		switch kind {
		case "consumption":
			r.Columns = []string{"Drug", "Dispensed/sold qty"}
			rows, e := q.ReportConsumption(ctx, tenantID)
			if e != nil {
				return e
			}
			for _, x := range rows {
				r.Rows = append(r.Rows, []string{x.DrugName, itoa(int(x.Qty))})
			}
		case "valuation":
			r.Columns = []string{"Drug", "On hand", "Unit price", "Value"}
			rows, e := q.ReportStockValuation(ctx, tenantID)
			if e != nil {
				return e
			}
			for _, x := range rows {
				r.Rows = append(r.Rows, []string{x.DrugName, itoa(int(x.OnHand)), x.UnitPrice, x.Value})
			}
		case "controlled":
			r.Columns = []string{"When", "Drug", "Change", "Reason"}
			rows, e := q.ReportControlledRegister(ctx, tenantID)
			if e != nil {
				return e
			}
			for _, x := range rows {
				r.Rows = append(r.Rows, []string{x.CreatedAt.Format("2006-01-02 15:04"), x.DrugName, itoa(int(x.Delta)), x.Reason})
			}
		case "wastage":
			r.Columns = []string{"Drug", "Batch", "Expiry", "Qty", "Value"}
			rows, e := q.ReportWastage(ctx, pharmacydb.ReportWastageParams{TenantID: tenantID, Today: &today})
			if e != nil {
				return e
			}
			for _, x := range rows {
				r.Rows = append(r.Rows, []string{x.DrugName, x.BatchNo, fmtDate(x.ExpiryDate), itoa(int(x.QtyOnHand)), x.Value})
			}
		case "margins":
			r.Columns = []string{"Drug", "Sell", "Avg cost"}
			rows, e := q.ReportMargins(ctx, tenantID)
			if e != nil {
				return e
			}
			for _, x := range rows {
				r.Rows = append(r.Rows, []string{x.DrugName, x.Sell, x.AvgCost})
			}
		case "supplier":
			r.Columns = []string{"Supplier", "Lead time (d)", "POs", "Received"}
			rows, e := q.ReportSupplierPerformance(ctx, tenantID)
			if e != nil {
				return e
			}
			for _, x := range rows {
				r.Rows = append(r.Rows, []string{x.Supplier, itoa(int(x.LeadTimeDays)), itoa(int(x.Pos)), itoa(int(x.Received))})
			}
		default:
			return apperr.Validation("unknown report")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return r, nil
}

// openPOCount is used by the dashboard to surface awaiting-receipt POs.
func (s *Service) openPOCount(ctx context.Context, q *pharmacydb.Queries, tenantID uuid.UUID) int {
	n, err := q.CountOpenPOs(ctx, tenantID)
	if err != nil {
		return 0
	}
	return int(n)
}

func fmtDate(t *time.Time) string {
	if t == nil {
		return "—"
	}
	return t.Format("2006-01")
}
