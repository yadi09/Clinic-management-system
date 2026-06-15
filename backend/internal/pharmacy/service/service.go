// Package service implements the pharmacy use-cases (Phase 4a): the dispense
// queue, the FEFO dispense flow (with a class-aware allergy guard that decrements
// stock and raises a charge), and stock adjustments.
package service

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/pharmacy"
	pharmacydb "github.com/reicb/clinicsaas/internal/pharmacy/repo/gen"
)

// Service implements pharmacy.Service.
type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
}

var _ pharmacy.Service = (*Service)(nil)

// NewService constructs a pharmacy Service.
func NewService(db *kerneldb.DB, publisher events.Publisher) *Service {
	return &Service{db: db, publisher: publisher}
}

// ListDrugs returns the drug catalog with on-hand stock, optionally filtered.
func (s *Service) ListDrugs(ctx context.Context, class *string, controlled *bool) ([]pharmacy.Drug, error) {
	tenantID, _ := actorOf(ctx)
	var out []pharmacy.Drug
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := pharmacydb.New(tx).ListDrugs(ctx, pharmacydb.ListDrugsParams{TenantID: tenantID, Class: class, Controlled: controlled})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, pharmacy.Drug{
				ID: r.ID, Name: r.Name, Form: deref(r.Form), Class: deref(r.DrugClass), IsControlled: r.IsControlled,
				UnitPrice: r.UnitPrice, ReorderLevel: int(r.ReorderLevel), IsActive: r.IsActive, OnHand: int(r.OnHand),
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SearchDrugs returns active drugs matching a query (for pickers).
func (s *Service) SearchDrugs(ctx context.Context, q string) ([]pharmacy.Drug, error) {
	tenantID, _ := actorOf(ctx)
	var out []pharmacy.Drug
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := pharmacydb.New(tx).SearchDrugs(ctx, pharmacydb.SearchDrugsParams{TenantID: tenantID, Q: &q})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, pharmacy.Drug{ID: r.ID, Name: r.Name, Class: deref(r.DrugClass), IsControlled: r.IsControlled, UnitPrice: r.UnitPrice})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ListBatches returns all stock batches with a derived status.
func (s *Service) ListBatches(ctx context.Context) ([]pharmacy.Batch, error) {
	tenantID, _ := actorOf(ctx)
	var out []pharmacy.Batch
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := pharmacydb.New(tx).ListBatches(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, pharmacy.Batch{
				ID: r.ID, DrugID: r.DrugID, DrugName: r.DrugName, BatchNo: r.BatchNo, Expiry: r.ExpiryDate,
				QtyOnHand: int(r.QtyOnHand), Quarantined: r.Quarantined, Status: batchStatus(r.ExpiryDate, r.Quarantined),
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// DispenseQueue returns the queue KPIs and the signed prescriptions to dispense.
func (s *Service) DispenseQueue(ctx context.Context) (*pharmacy.DispenseQueue, error) {
	tenantID, _ := actorOf(ctx)
	out := &pharmacy.DispenseQueue{Items: []pharmacy.DispenseQueueItem{}}
	includeDispensed := true
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		today := startOfDayUTC()
		nearExpiry := time.Now().AddDate(0, 0, 90)
		k, e := q.DispenseQueueKpis(ctx, pharmacydb.DispenseQueueKpisParams{
			TenantID: tenantID, Today: &today, NearExpiryBefore: &nearExpiry,
		})
		if e != nil {
			return e
		}
		out.KPIs = pharmacy.KPIs{ToDispense: int(k.ToDispense), DispensedToday: int(k.DispensedToday), LowStock: int(k.LowStock), NearExpiry: int(k.NearExpiry)}
		rows, e := q.ListDispenseQueue(ctx, pharmacydb.ListDispenseQueueParams{TenantID: tenantID, IncludeDispensed: &includeDispensed})
		if e != nil {
			return e
		}
		for _, r := range rows {
			flags := []string{}
			if r.HasAllergy {
				flags = append(flags, "allergy check")
			}
			out.Items = append(out.Items, pharmacy.DispenseQueueItem{
				PrescriptionID: r.ID, RxNo: r.RxNo, PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn,
				Prescriber: deref(r.Prescriber), ItemCount: int(r.ItemCount), Dispensed: r.DispensedAt != nil, Flags: flags,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// DispenseDetail loads a prescription for dispensing: items matched to catalog
// drugs with FEFO batches, plus allergy verdicts.
func (s *Service) DispenseDetail(ctx context.Context, prescriptionID uuid.UUID) (*pharmacy.DispenseDetail, error) {
	tenantID, _ := actorOf(ctx)
	var out *pharmacy.DispenseDetail
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		h, e := q.GetPrescriptionHeader(ctx, pharmacydb.GetPrescriptionHeaderParams{TenantID: tenantID, ID: prescriptionID})
		if e != nil {
			return e
		}
		allergies, e := q.ListPatientAllergiesForDispense(ctx, pharmacydb.ListPatientAllergiesForDispenseParams{TenantID: tenantID, PatientID: h.PatientID})
		if e != nil {
			return e
		}
		items, e := q.ListPrescriptionItemsForDispense(ctx, pharmacydb.ListPrescriptionItemsForDispenseParams{TenantID: tenantID, PrescriptionID: prescriptionID})
		if e != nil {
			return e
		}
		d := &pharmacy.DispenseDetail{
			PrescriptionID: h.ID, RxNo: h.RxNo, PatientName: h.FirstName + " " + h.LastName, MRN: h.Mrn,
			Prescriber: deref(h.Prescriber), Dispensed: h.DispensedAt != nil, Allergies: allergies, Items: []pharmacy.DispenseItem{},
		}
		for _, it := range items {
			di := pharmacy.DispenseItem{PrescriptionItemID: it.ID, DrugName: it.DrugName, Sig: sig(it.Dose, it.Frequency, it.Duration), Batches: []pharmacy.Batch{}}
			drug, e2 := q.FindDrugByName(ctx, pharmacydb.FindDrugByNameParams{TenantID: tenantID, Name: it.DrugName})
			if e2 == nil {
				did := drug.ID
				di.MatchedDrugID = &did
				if m := allergyMatchesDrug(allergies, drug.Name, deref(drug.DrugClass)); m != "" {
					di.AllergyConflict = "patient allergic to " + m
				}
				bs, e3 := q.ListBatchesByDrug(ctx, pharmacydb.ListBatchesByDrugParams{TenantID: tenantID, DrugID: drug.ID})
				if e3 != nil {
					return e3
				}
				for _, b := range bs {
					di.Batches = append(di.Batches, pharmacy.Batch{
						ID: b.ID, DrugID: drug.ID, BatchNo: b.BatchNo, Expiry: b.ExpiryDate, QtyOnHand: int(b.QtyOnHand),
						Quarantined: b.Quarantined, Status: batchStatus(b.ExpiryDate, b.Quarantined),
					})
				}
			} else if !errors.Is(e2, pgx.ErrNoRows) {
				return e2
			}
			d.Items = append(d.Items, di)
		}
		out = d
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("PRESCRIPTION_NOT_FOUND", "prescription not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// Dispense decrements FEFO batch stock, raises a pharmacy charge, and marks the
// prescription dispensed — blocking any line whose drug matches a patient allergy.
func (s *Service) Dispense(ctx context.Context, in pharmacy.DispenseInput) (*pharmacy.Sale, error) {
	tenantID, actor := actorOf(ctx)
	if len(in.Lines) == 0 {
		return nil, apperr.Validation("nothing to dispense")
	}
	var out pharmacy.Sale
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		h, e := q.GetPrescriptionHeader(ctx, pharmacydb.GetPrescriptionHeaderParams{TenantID: tenantID, ID: in.PrescriptionID})
		if e != nil {
			return e
		}
		// Atomically claim the prescription first: if another transaction already
		// dispensed it, this matches no row and we abort (rolling back any work).
		if _, e := q.MarkPrescriptionDispensed(ctx, pharmacydb.MarkPrescriptionDispensedParams{TenantID: tenantID, ID: in.PrescriptionID}); errors.Is(e, pgx.ErrNoRows) {
			return apperr.Conflict("ALREADY_DISPENSED", "this prescription has already been dispensed")
		} else if e != nil {
			return e
		}
		allergies, e := q.ListPatientAllergiesForDispense(ctx, pharmacydb.ListPatientAllergiesForDispenseParams{TenantID: tenantID, PatientID: h.PatientID})
		if e != nil {
			return e
		}
		type line struct {
			drugID, batchID uuid.UUID
			qty             int
			price           float64
			desc            string
		}
		var lines []line
		var subtotal float64
		today := startOfDayUTC()
		for _, ln := range in.Lines {
			if ln.Qty <= 0 {
				return apperr.Validation("quantity must be positive")
			}
			drug, e := q.GetDrug(ctx, pharmacydb.GetDrugParams{TenantID: tenantID, ID: ln.DrugID})
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.Validation("unknown drug")
			}
			if e != nil {
				return e
			}
			if m := allergyMatchesDrug(allergies, drug.Name, deref(drug.DrugClass)); m != "" {
				return apperr.Conflict("ALLERGY_CONFLICT", "blocked: patient is allergic to "+m+" ("+drug.Name+")")
			}
			// Validate the batch belongs to this drug and is dispensable.
			batch, e := q.GetBatch(ctx, pharmacydb.GetBatchParams{TenantID: tenantID, ID: ln.BatchID})
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.Validation("unknown batch")
			}
			if e != nil {
				return e
			}
			if batch.DrugID != ln.DrugID {
				return apperr.Validation("the selected batch does not belong to " + drug.Name)
			}
			if batch.Quarantined {
				return apperr.Conflict("BATCH_UNAVAILABLE", "the selected batch of "+drug.Name+" is quarantined")
			}
			if batch.ExpiryDate != nil && batch.ExpiryDate.Before(today) {
				return apperr.Conflict("BATCH_UNAVAILABLE", "the selected batch of "+drug.Name+" is expired")
			}
			if _, e := q.DecrementBatch(ctx, pharmacydb.DecrementBatchParams{Qty: int32(ln.Qty), TenantID: tenantID, ID: ln.BatchID}); errors.Is(e, pgx.ErrNoRows) {
				return apperr.Conflict("INSUFFICIENT_STOCK", "not enough stock in the selected batch for "+drug.Name)
			} else if e != nil {
				return e
			}
			price := parseMoney(drug.UnitPrice)
			subtotal += price * float64(ln.Qty)
			bid := ln.BatchID
			if e := q.InsertStockMovement(ctx, pharmacydb.InsertStockMovementParams{
				TenantID: tenantID, DrugID: ln.DrugID, BatchID: &bid, Delta: int32(-ln.Qty), Reason: "dispense",
				RefType: strPtr("prescription"), RefID: &in.PrescriptionID, CreatedBy: actor,
			}); e != nil {
				return e
			}
			lines = append(lines, line{drugID: ln.DrugID, batchID: ln.BatchID, qty: ln.Qty, price: price, desc: drug.Name})
		}
		total := money(subtotal)
		pid := h.PatientID
		rxID := in.PrescriptionID
		sale, e := q.CreateSale(ctx, pharmacydb.CreateSaleParams{
			TenantID: tenantID, SaleType: "dispense", PatientID: &pid, PrescriptionID: &rxID, Status: "charged",
			Subtotal: total, Total: total, Currency: "ETB", CounsellingNotes: strPtr(in.CounsellingNotes), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		for _, l := range lines {
			did, bid := l.drugID, l.batchID
			if e := q.CreateSaleItem(ctx, pharmacydb.CreateSaleItemParams{
				TenantID: tenantID, SaleID: sale.ID, DrugID: &did, BatchID: &bid, Description: l.desc,
				Qty: int32(l.qty), UnitPrice: money(l.price), LineTotal: money(l.price * float64(l.qty)),
			}); e != nil {
				return e
			}
		}
		out = pharmacy.Sale{ID: sale.ID, Total: sale.Total, Status: sale.Status}
		return s.publisher.Publish(ctx, tx, &tenantID, "pharmacy_sale", sale.ID, "pharmacy.dispensed",
			map[string]any{"prescription_id": in.PrescriptionID, "patient_id": h.PatientID, "total": sale.Total})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("PRESCRIPTION_NOT_FOUND", "prescription not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// AdjustStock adjusts an existing batch (BatchID set) or adds a new batch, and
// records a stock movement.
func (s *Service) AdjustStock(ctx context.Context, in pharmacy.StockAdjustInput) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		var batchID uuid.UUID
		if in.BatchID != nil {
			batch, e := q.GetBatch(ctx, pharmacydb.GetBatchParams{TenantID: tenantID, ID: *in.BatchID})
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.NotFound("BATCH_NOT_FOUND", "batch not found")
			}
			if e != nil {
				return e
			}
			if batch.DrugID != in.DrugID {
				return apperr.Validation("the selected batch does not belong to that drug")
			}
			r, e := q.AdjustBatchQty(ctx, pharmacydb.AdjustBatchQtyParams{Delta: int32(in.Delta), TenantID: tenantID, ID: *in.BatchID})
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.Conflict("INSUFFICIENT_STOCK", "the adjustment would make stock negative")
			}
			if e != nil {
				return e
			}
			batchID = r.ID
		} else {
			if in.Delta < 0 {
				return apperr.Validation("a new batch quantity must be positive")
			}
			if strings.TrimSpace(in.BatchNo) == "" {
				return apperr.Validation("a batch number is required for a new batch")
			}
			b, e := q.CreateBatch(ctx, pharmacydb.CreateBatchParams{
				TenantID: tenantID, DrugID: in.DrugID, BatchNo: in.BatchNo, ExpiryDate: in.Expiry, QtyOnHand: int32(in.Delta), CreatedBy: actor,
			})
			if e != nil {
				return e
			}
			batchID = b.ID
		}
		reason := in.Reason
		if reason == "" {
			reason = "adjust"
		}
		bid := batchID
		return q.InsertStockMovement(ctx, pharmacydb.InsertStockMovementParams{
			TenantID: tenantID, DrugID: in.DrugID, BatchID: &bid, Delta: int32(in.Delta), Reason: reason,
			RefType: strPtr("adjust"), Note: strPtr(in.Note), CreatedBy: actor,
		})
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// SetQuarantine flags/unflags a batch as quarantined.
func (s *Service) SetQuarantine(ctx context.Context, batchID uuid.UUID, quarantined bool) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return pharmacydb.New(tx).SetBatchQuarantine(ctx, pharmacydb.SetBatchQuarantineParams{Quarantined: quarantined, TenantID: tenantID, ID: batchID})
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ============================================================================
// Phase 4b-1: catalog admin, OTC sale, dashboard
// ============================================================================

// CreateDrug adds a catalog drug.
func (s *Service) CreateDrug(ctx context.Context, in pharmacy.DrugInput) (*pharmacy.Drug, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return nil, apperr.Validation("a drug name is required")
	}
	var id uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		id, e = pharmacydb.New(tx).CreateDrug(ctx, pharmacydb.CreateDrugParams{
			TenantID: tenantID, Name: in.Name, Form: strPtr(in.Form), DrugClass: strPtr(in.Class),
			IsControlled: in.IsControlled, UnitPrice: moneyStr(in.UnitPrice), ReorderLevel: int32(in.ReorderLevel), CreatedBy: actor,
		})
		return e
	})
	if err != nil {
		return nil, mapWriteErr(err, "DRUG_EXISTS", "a drug with this name already exists")
	}
	return &pharmacy.Drug{ID: id, Name: in.Name, Form: in.Form, Class: in.Class, IsControlled: in.IsControlled, UnitPrice: moneyStr(in.UnitPrice), ReorderLevel: in.ReorderLevel, IsActive: true}, nil
}

// UpdateDrug edits a catalog drug.
func (s *Service) UpdateDrug(ctx context.Context, id uuid.UUID, in pharmacy.DrugInput) error {
	tenantID, _ := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return apperr.Validation("a drug name is required")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return pharmacydb.New(tx).UpdateDrug(ctx, pharmacydb.UpdateDrugParams{
			Name: in.Name, Form: strPtr(in.Form), DrugClass: strPtr(in.Class), IsControlled: in.IsControlled,
			UnitPrice: moneyStr(in.UnitPrice), ReorderLevel: int32(in.ReorderLevel), IsActive: in.IsActive, TenantID: tenantID, ID: id,
		})
	})
	if err != nil {
		return mapWriteErr(err, "DRUG_EXISTS", "a drug with this name already exists")
	}
	return nil
}

// SellOTC records a counter sale: picks a FEFO batch per line, decrements stock,
// and records a paid sale.
func (s *Service) SellOTC(ctx context.Context, in pharmacy.OtcInput) (*pharmacy.Sale, error) {
	tenantID, actor := actorOf(ctx)
	if len(in.Lines) == 0 {
		return nil, apperr.Validation("nothing to sell")
	}
	var out pharmacy.Sale
	today := startOfDayUTC()
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		type li struct {
			drugID, batchID uuid.UUID
			qty             int
			price           float64
			desc            string
		}
		var lines []li
		var subtotal float64
		for _, ln := range in.Lines {
			if ln.Qty <= 0 {
				return apperr.Validation("quantity must be positive")
			}
			drug, e := q.GetDrug(ctx, pharmacydb.GetDrugParams{TenantID: tenantID, ID: ln.DrugID})
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.Validation("unknown drug")
			}
			if e != nil {
				return e
			}
			// FEFO: first dispensable batch with enough stock.
			batches, e := q.ListBatchesByDrug(ctx, pharmacydb.ListBatchesByDrugParams{TenantID: tenantID, DrugID: ln.DrugID})
			if e != nil {
				return e
			}
			var batchID uuid.UUID
			for _, b := range batches {
				if b.Quarantined || b.QtyOnHand < int32(ln.Qty) {
					continue
				}
				if b.ExpiryDate != nil && b.ExpiryDate.Before(today) {
					continue
				}
				batchID = b.ID
				break
			}
			if batchID == uuid.Nil {
				return apperr.Conflict("INSUFFICIENT_STOCK", "no in-date batch with enough stock for "+drug.Name)
			}
			if _, e := q.DecrementBatch(ctx, pharmacydb.DecrementBatchParams{Qty: int32(ln.Qty), TenantID: tenantID, ID: batchID}); errors.Is(e, pgx.ErrNoRows) {
				return apperr.Conflict("INSUFFICIENT_STOCK", "not enough stock for "+drug.Name)
			} else if e != nil {
				return e
			}
			price := parseMoney(drug.UnitPrice)
			subtotal += price * float64(ln.Qty)
			bid := batchID
			if e := q.InsertStockMovement(ctx, pharmacydb.InsertStockMovementParams{
				TenantID: tenantID, DrugID: ln.DrugID, BatchID: &bid, Delta: int32(-ln.Qty), Reason: "otc_sale", RefType: strPtr("otc"), CreatedBy: actor,
			}); e != nil {
				return e
			}
			lines = append(lines, li{drugID: ln.DrugID, batchID: batchID, qty: ln.Qty, price: price, desc: drug.Name})
		}
		total := subtotal - in.Discount + in.Tax
		if total < 0 {
			total = 0
		}
		sale, e := q.CreateOtcSale(ctx, pharmacydb.CreateOtcSaleParams{
			TenantID: tenantID, PatientID: in.PatientID, Subtotal: money(subtotal), Discount: money(in.Discount),
			Tax: money(in.Tax), Total: money(total), Currency: "ETB", PaymentMethod: strPtr(in.PaymentMethod), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		for _, l := range lines {
			did, bid := l.drugID, l.batchID
			if e := q.CreateSaleItem(ctx, pharmacydb.CreateSaleItemParams{
				TenantID: tenantID, SaleID: sale.ID, DrugID: &did, BatchID: &bid, Description: l.desc,
				Qty: int32(l.qty), UnitPrice: money(l.price), LineTotal: money(l.price * float64(l.qty)),
			}); e != nil {
				return e
			}
		}
		out = pharmacy.Sale{ID: sale.ID, Total: sale.Total, Status: sale.Status}
		return s.publisher.Publish(ctx, tx, &tenantID, "pharmacy_sale", sale.ID, "pharmacy.otc_sold", map[string]any{"total": sale.Total})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// Dashboard returns the pharmacy-manager overview.
func (s *Service) Dashboard(ctx context.Context) (*pharmacy.Dashboard, error) {
	tenantID, _ := actorOf(ctx)
	out := &pharmacy.Dashboard{Volume: []pharmacy.VolumePoint{}, Alerts: []string{}}
	today := startOfDayUTC()
	nearExpiry := time.Now().AddDate(0, 0, 90)
	since := startOfDayUTC().AddDate(0, 0, -13)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := pharmacydb.New(tx)
		k, e := q.DispenseQueueKpis(ctx, pharmacydb.DispenseQueueKpisParams{TenantID: tenantID, Today: &today, NearExpiryBefore: &nearExpiry})
		if e != nil {
			return e
		}
		out.DispensedToday, out.LowStock, out.NearExpiry = int(k.DispensedToday), int(k.LowStock), int(k.NearExpiry)
		v, e := q.ValueOnHand(ctx, tenantID)
		if e != nil {
			return e
		}
		out.ValueOnHand = v
		exp, e := q.CountExpiredBatches(ctx, pharmacydb.CountExpiredBatchesParams{TenantID: tenantID, Today: &today})
		if e != nil {
			return e
		}
		out.Expired = int(exp)
		vol, e := q.DispensingVolume(ctx, pharmacydb.DispensingVolumeParams{TenantID: tenantID, Since: since})
		if e != nil {
			return e
		}
		for _, p := range vol {
			out.Volume = append(out.Volume, pharmacy.VolumePoint{Day: p.Day.Format("2006-01-02"), Count: int(p.Count)})
		}
		out.OpenPOs = s.openPOCount(ctx, q, tenantID)
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	if out.LowStock > 0 {
		out.Alerts = append(out.Alerts, itoa(out.LowStock)+" items below reorder level")
	}
	if out.NearExpiry > 0 {
		out.Alerts = append(out.Alerts, itoa(out.NearExpiry)+" batches near expiry")
	}
	if out.Expired > 0 {
		out.Alerts = append(out.Alerts, itoa(out.Expired)+" expired → return")
	}
	return out, nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// moneyStr normalises a user-supplied price string to 2dp.
func moneyStr(s string) string { return money(parseMoney(s)) }

// --- helpers ---

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

// allergyMatchesDrug returns the matched allergy substance if the drug's name or
// class matches a recorded allergy on a whole token (>=4 chars). This is the
// class-aware check the catalog enables (e.g. allergy "Penicillin" blocks a drug
// whose class is "Penicillin", catching Amoxicillin).
func allergyMatchesDrug(allergies []string, drugName, drugClass string) string {
	hay := strings.ToLower(drugName + " " + drugClass)
	for _, a := range allergies {
		for _, tok := range strings.FieldsFunc(strings.ToLower(a), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
			if len([]rune(tok)) >= 4 && strings.Contains(hay, tok) {
				return a
			}
		}
	}
	return ""
}

func batchStatus(expiry *time.Time, quarantined bool) string {
	if quarantined {
		return "quarantine"
	}
	if expiry != nil {
		now := time.Now()
		if expiry.Before(now) {
			return "expired"
		}
		if expiry.Before(now.AddDate(0, 0, 90)) {
			return "near_expiry"
		}
	}
	return "ok"
}

func sig(dose, freq, dur *string) string {
	parts := []string{}
	for _, p := range []*string{dose, freq, dur} {
		if p != nil && strings.TrimSpace(*p) != "" {
			parts = append(parts, *p)
		}
	}
	return strings.Join(parts, " · ")
}

func mapWriteErr(err error, code, msg string) error {
	if err == nil {
		return nil
	}
	m := err.Error()
	if strings.Contains(m, "duplicate key") || strings.Contains(m, "unique constraint") {
		return apperr.Conflict(code, msg)
	}
	return apperr.Internal(err)
}

func money(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) }

func parseMoney(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}

func strPtr(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func startOfDayUTC() time.Time {
	n := time.Now().UTC()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}
