// Package service implements the laboratory use-cases (Phase 5a).
package service

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/lab"
	labdb "github.com/reicb/clinicsaas/internal/lab/repo/gen"
)

// Service implements lab.Service.
type Service struct {
	db        *kerneldb.DB
	publisher events.Publisher
}

var _ lab.Service = (*Service)(nil)

// NewService constructs a lab Service.
func NewService(db *kerneldb.DB, publisher events.Publisher) *Service {
	return &Service{db: db, publisher: publisher}
}

// ---- catalog ----

func (s *Service) ListTests(ctx context.Context, activeOnly bool) ([]lab.LabTest, error) {
	tenantID, _ := actorOf(ctx)
	var ao *bool
	if activeOnly {
		t := true
		ao = &t
	}
	var out []lab.LabTest
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := labdb.New(tx).ListLabTests(ctx, labdb.ListLabTestsParams{TenantID: tenantID, ActiveOnly: ao})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, lab.LabTest{ID: r.ID, Code: r.Code, Name: r.Name, Specimen: deref(r.Specimen), IsActive: r.IsActive, AnalyteCount: int(r.AnalyteCount)})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) ListAnalytes(ctx context.Context, testID uuid.UUID) ([]lab.Analyte, error) {
	tenantID, _ := actorOf(ctx)
	var out []lab.Analyte
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := labdb.New(tx).ListAnalytesByTest(ctx, labdb.ListAnalytesByTestParams{TenantID: tenantID, TestID: testID})
		if e != nil {
			return e
		}
		for _, a := range rows {
			out = append(out, lab.Analyte{ID: a.ID, Name: a.Name, Unit: deref(a.Unit), RefLow: deref(a.RefLow), RefHigh: deref(a.RefHigh), CriticalLow: deref(a.CriticalLow), CriticalHigh: deref(a.CriticalHigh)})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) CreateTest(ctx context.Context, code, name, specimen string) (*lab.LabTest, error) {
	tenantID, actor := actorOf(ctx)
	if strings.TrimSpace(code) == "" || strings.TrimSpace(name) == "" {
		return nil, apperr.Validation("code and name are required")
	}
	var out lab.LabTest
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := labdb.New(tx).CreateLabTest(ctx, labdb.CreateLabTestParams{TenantID: tenantID, Code: code, Name: name, Specimen: strPtr(specimen), CreatedBy: actor})
		if e != nil {
			return e
		}
		out = lab.LabTest{ID: r.ID, Code: r.Code, Name: r.Name, Specimen: deref(r.Specimen), IsActive: r.IsActive}
		return nil
	})
	if err != nil {
		return nil, mapWriteErr(err, "TEST_EXISTS", "a test with this code already exists")
	}
	return &out, nil
}

func (s *Service) AddAnalyte(ctx context.Context, testID uuid.UUID, in lab.Analyte) error {
	tenantID, _ := actorOf(ctx)
	if strings.TrimSpace(in.Name) == "" {
		return apperr.Validation("analyte name is required")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return labdb.New(tx).CreateAnalyte(ctx, labdb.CreateAnalyteParams{
			TenantID: tenantID, TestID: testID, Name: in.Name, Unit: strPtr(in.Unit),
			RefLow: strPtr(in.RefLow), RefHigh: strPtr(in.RefHigh), CriticalLow: strPtr(in.CriticalLow), CriticalHigh: strPtr(in.CriticalHigh),
		})
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ImportCatalog bulk-loads tests + analytes (one row per analyte). Tests are
// reused/created by code; an analyte already present on its test is skipped. The
// whole import is one transaction (all-or-nothing).
func (s *Service) ImportCatalog(ctx context.Context, rows []lab.CatalogImportRow) (*lab.CatalogImportResult, error) {
	tenantID, actor := actorOf(ctx)
	res := &lab.CatalogImportResult{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := labdb.New(tx)
		testByCode := map[string]uuid.UUID{}
		seen := map[uuid.UUID]map[string]bool{} // testID -> lower(analyte name) set
		for _, r := range rows {
			code, name := strings.TrimSpace(r.TestCode), strings.TrimSpace(r.TestName)
			if code == "" || name == "" {
				continue
			}
			lc := strings.ToLower(code)
			tid, ok := testByCode[lc]
			if !ok {
				ex, e := q.GetLabTestByCode(ctx, labdb.GetLabTestByCodeParams{TenantID: tenantID, Code: code})
				switch {
				case e == nil:
					tid = ex.ID
				case errors.Is(e, pgx.ErrNoRows):
					created, e2 := q.CreateLabTest(ctx, labdb.CreateLabTestParams{TenantID: tenantID, Code: code, Name: name, Specimen: strPtr(r.Specimen), CreatedBy: actor})
					if e2 != nil {
						return e2
					}
					tid = created.ID
					res.TestsCreated++
				default:
					return e
				}
				testByCode[lc] = tid
				set := map[string]bool{}
				cur, e := q.ListAnalytesByTest(ctx, labdb.ListAnalytesByTestParams{TenantID: tenantID, TestID: tid})
				if e != nil {
					return e
				}
				for _, a := range cur {
					set[strings.ToLower(a.Name)] = true
				}
				seen[tid] = set
			}
			an := strings.TrimSpace(r.AnalyteName)
			if an == "" {
				continue
			}
			if seen[tid][strings.ToLower(an)] {
				res.RowsSkippedDup++
				continue
			}
			if e := q.CreateAnalyte(ctx, labdb.CreateAnalyteParams{
				TenantID: tenantID, TestID: tid, Name: an, Unit: strPtr(r.Unit),
				RefLow: strPtr(r.RefLow), RefHigh: strPtr(r.RefHigh), CriticalLow: strPtr(r.CriticalLow), CriticalHigh: strPtr(r.CriticalHigh),
				SortOrder: int32(len(seen[tid])),
			}); e != nil {
				return e
			}
			seen[tid][strings.ToLower(an)] = true
			res.AnalytesAdded++
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return res, nil
}

// FindSample resolves a scanned/typed sample number to its item id + status.
func (s *Service) FindSample(ctx context.Context, sampleNo int64) (*lab.SampleRef, error) {
	tenantID, _ := actorOf(ctx)
	var out *lab.SampleRef
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := labdb.New(tx).FindOrderItemBySampleNo(ctx, labdb.FindOrderItemBySampleNoParams{TenantID: tenantID, SampleNo: sampleNo})
		if e != nil {
			return e
		}
		out = &lab.SampleRef{ID: r.ID, Status: r.Status}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("SAMPLE_NOT_FOUND", "no sample with that number")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ---- orders ----

func (s *Service) CreateOrder(ctx context.Context, in lab.OrderInput) (*lab.Order, error) {
	tenantID, actor := actorOf(ctx)
	if in.PatientID == uuid.Nil || len(in.TestIDs) == 0 {
		return nil, apperr.Validation("a patient and at least one test are required")
	}
	priority := in.Priority
	if priority != "routine" && priority != "urgent" && priority != "stat" {
		priority = "routine"
	}
	var out lab.Order
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := labdb.New(tx)
		o, e := q.CreateLabOrder(ctx, labdb.CreateLabOrderParams{
			TenantID: tenantID, EncounterID: in.EncounterID, PatientID: in.PatientID, ProviderID: actor,
			Priority: priority, ClinicalNote: strPtr(in.ClinicalNote), CreatedBy: actor,
		})
		if e != nil {
			return e
		}
		out = lab.Order{ID: o.ID, OrderNo: o.OrderNo, Priority: priority, ClinicalNote: in.ClinicalNote, Items: []lab.OrderItemBrief{}}
		for _, tid := range in.TestIDs {
			t, e := q.GetLabTest(ctx, labdb.GetLabTestParams{TenantID: tenantID, ID: tid})
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.Validation("unknown test")
			}
			if e != nil {
				return e
			}
			item, e := q.CreateLabOrderItem(ctx, labdb.CreateLabOrderItemParams{TenantID: tenantID, OrderID: o.ID, TestID: tid, Specimen: t.Specimen})
			if e != nil {
				return e
			}
			out.Items = append(out.Items, lab.OrderItemBrief{ID: item.ID, SampleNo: item.SampleNo, Status: "ordered", TestName: t.Name})
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "lab_order", o.ID, "lab.order.created", map[string]any{"order_no": o.OrderNo, "patient_id": in.PatientID})
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

func (s *Service) EncounterLabs(ctx context.Context, encounterID uuid.UUID) ([]lab.EncounterOrder, error) {
	tenantID, _ := actorOf(ctx)
	out := []lab.EncounterOrder{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := labdb.New(tx)
		orders, e := q.ListOrdersByEncounter(ctx, labdb.ListOrdersByEncounterParams{TenantID: tenantID, EncounterID: &encounterID})
		if e != nil {
			return e
		}
		for _, o := range orders {
			eo := lab.EncounterOrder{OrderNo: o.OrderNo, Priority: o.Priority, CreatedAt: o.CreatedAt, Items: []lab.EncounterOrderItem{}}
			items, e := q.ListOrderItems(ctx, labdb.ListOrderItemsParams{TenantID: tenantID, OrderID: o.ID})
			if e != nil {
				return e
			}
			for _, it := range items {
				eoi := lab.EncounterOrderItem{SampleNo: it.SampleNo, TestName: it.TestName, Status: it.Status, Results: []lab.AnalyteResult{}}
				res, e := q.ListResultsByItem(ctx, labdb.ListResultsByItemParams{TenantID: tenantID, OrderItemID: it.ID})
				if e != nil {
					return e
				}
				for _, r := range res {
					eoi.Results = append(eoi.Results, lab.AnalyteResult{Name: r.Name, Unit: deref(r.Unit), Value: deref(r.Value), Flag: r.Flag, RefLow: deref(r.RefLow), RefHigh: deref(r.RefHigh)})
				}
				eo.Items = append(eo.Items, eoi)
			}
			out = append(out, eo)
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) PendingLabs(ctx context.Context, encounterID uuid.UUID) (*lab.PendingSummary, error) {
	tenantID, _ := actorOf(ctx)
	out := &lab.PendingSummary{Tests: []string{}}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := labdb.New(tx)
		n, e := q.CountPendingLabsByEncounter(ctx, labdb.CountPendingLabsByEncounterParams{TenantID: tenantID, EncounterID: &encounterID})
		if e != nil {
			return e
		}
		out.Count = int(n)
		names, e := q.ListPendingTestNamesByEncounter(ctx, labdb.ListPendingTestNamesByEncounterParams{TenantID: tenantID, EncounterID: &encounterID})
		if e != nil {
			return e
		}
		out.Tests = append(out.Tests, names...)
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ---- worklist + processing ----

func (s *Service) Worklist(ctx context.Context, status string) ([]lab.WorklistItem, error) {
	tenantID, _ := actorOf(ctx)
	var st *string
	if status != "" {
		st = &status
	}
	var out []lab.WorklistItem
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := labdb.New(tx).ListLabWorklist(ctx, labdb.ListLabWorklistParams{TenantID: tenantID, Status: st})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, lab.WorklistItem{
				ID: r.ID, SampleNo: r.SampleNo, Status: r.Status, OrderedAt: r.OrderedAt, Priority: r.Priority,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, TestName: r.TestName,
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) OrderItem(ctx context.Context, itemID uuid.UUID) (*lab.OrderItemDetail, error) {
	tenantID, _ := actorOf(ctx)
	var out *lab.OrderItemDetail
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := labdb.New(tx)
		it, e := q.GetOrderItem(ctx, labdb.GetOrderItemParams{TenantID: tenantID, ID: itemID})
		if e != nil {
			return e
		}
		d := &lab.OrderItemDetail{
			ID: it.ID, SampleNo: it.SampleNo, Status: it.Status, Specimen: deref(it.Specimen), TestName: it.TestName,
			PatientName: it.FirstName + " " + it.LastName, MRN: it.Mrn, Priority: it.Priority, ClinicalNote: deref(it.ClinicalNote),
			OrderedBy: deref(it.OrderedBy), Critical: it.CriticalFlag, NotifiedAt: it.NotifiedAt, NotifiedByName: deref(it.NotifiedByName),
			Analytes: []lab.AnalyteResult{},
		}
		analytes, e := q.ListAnalytesByTest(ctx, labdb.ListAnalytesByTestParams{TenantID: tenantID, TestID: it.TestID})
		if e != nil {
			return e
		}
		res, e := q.ListResultsByItem(ctx, labdb.ListResultsByItemParams{TenantID: tenantID, OrderItemID: itemID})
		if e != nil {
			return e
		}
		existing := map[uuid.UUID]labdb.ListResultsByItemRow{}
		for _, r := range res {
			existing[r.AnalyteID] = r
		}
		for _, a := range analytes {
			ar := lab.AnalyteResult{AnalyteID: a.ID, Name: a.Name, Unit: deref(a.Unit), RefLow: deref(a.RefLow), RefHigh: deref(a.RefHigh), Flag: "normal"}
			if r, ok := existing[a.ID]; ok {
				ar.Value = deref(r.Value)
				ar.Flag = r.Flag
			}
			d.Analytes = append(d.Analytes, ar)
		}
		out = d
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("SAMPLE_NOT_FOUND", "sample not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) Accession(ctx context.Context, itemID uuid.UUID, collectedBy string) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := labdb.New(tx).AccessionItem(ctx, labdb.AccessionItemParams{CollectedBy: strPtr(collectedBy), TenantID: tenantID, ID: itemID})
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("INVALID_STATE", "sample is not in the ordered state")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) SaveResults(ctx context.Context, itemID uuid.UUID, results []lab.ResultInput) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := labdb.New(tx)
		it, e := q.GetOrderItem(ctx, labdb.GetOrderItemParams{TenantID: tenantID, ID: itemID})
		if e != nil {
			return e
		}
		if it.Status == "validated" {
			return apperr.Conflict("INVALID_STATE", "results are validated and locked")
		}
		analytes, e := q.ListAnalytesByTest(ctx, labdb.ListAnalytesByTestParams{TenantID: tenantID, TestID: it.TestID})
		if e != nil {
			return e
		}
		ranges := map[uuid.UUID]labdb.ListAnalytesByTestRow{}
		for _, a := range analytes {
			ranges[a.ID] = a
		}
		for _, r := range results {
			a, ok := ranges[r.AnalyteID]
			if !ok {
				return apperr.Validation("unknown analyte for this test")
			}
			flag := flagFor(r.Value, a.RefLow, a.RefHigh, a.CriticalLow, a.CriticalHigh)
			if e := q.UpsertResult(ctx, labdb.UpsertResultParams{TenantID: tenantID, OrderItemID: itemID, AnalyteID: r.AnalyteID, Value: strPtr(r.Value), Flag: flag}); e != nil {
				return e
			}
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("SAMPLE_NOT_FOUND", "sample not found")
	}
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) SubmitResults(ctx context.Context, itemID uuid.UUID) error {
	tenantID, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := labdb.New(tx).SubmitResults(ctx, labdb.SubmitResultsParams{TenantID: tenantID, ID: itemID})
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("INVALID_STATE", "sample must be accessioned before submitting results")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) ValidateItem(ctx context.Context, itemID uuid.UUID) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := labdb.New(tx)
		r, e := q.ValidateItem(ctx, labdb.ValidateItemParams{ValidatedBy: actor, TenantID: tenantID, ID: itemID})
		if e != nil {
			return e
		}
		// Flag the sample if any result is critical; escalate via an event so the
		// ordering clinician sees it on their results inbox (and must acknowledge).
		res, e := q.ListResultsByItem(ctx, labdb.ListResultsByItemParams{TenantID: tenantID, OrderItemID: itemID})
		if e != nil {
			return e
		}
		critical := false
		for _, x := range res {
			if x.Flag == "critical" {
				critical = true
				break
			}
		}
		if critical {
			if e := q.MarkItemCritical(ctx, labdb.MarkItemCriticalParams{TenantID: tenantID, ID: itemID}); e != nil {
				return e
			}
			if e := s.publisher.Publish(ctx, tx, &tenantID, "lab_order_item", r, "lab.result.critical", map[string]any{"item_id": itemID}); e != nil {
				return e
			}
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "lab_order_item", r, "lab.result.validated", map[string]any{"item_id": itemID, "critical": critical})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("INVALID_STATE", "results must be submitted before validation")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// MarkNotified records that a validated result was communicated to the ordering
// clinician (the critical-callback acknowledgement). Idempotent guard: only a
// validated, not-yet-notified sample can be acknowledged.
func (s *Service) MarkNotified(ctx context.Context, itemID uuid.UUID) error {
	tenantID, actor := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := labdb.New(tx).MarkItemNotified(ctx, labdb.MarkItemNotifiedParams{NotifiedBy: actor, TenantID: tenantID, ID: itemID})
		if e != nil {
			return e
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "lab_order_item", r, "lab.result.notified", map[string]any{"item_id": itemID})
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Conflict("ALREADY_NOTIFIED", "this result is not validated or has already been acknowledged")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ResultsInbox returns the ordering doctor's returned results (unacknowledged
// criticals first, then most-recently validated).
func (s *Service) ResultsInbox(ctx context.Context, providerID uuid.UUID) ([]lab.InboxItem, error) {
	tenantID, _ := actorOf(ctx)
	out := []lab.InboxItem{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := labdb.New(tx).ListResultsInbox(ctx, labdb.ListResultsInboxParams{TenantID: tenantID, ProviderID: &providerID})
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, lab.InboxItem{
				ID: r.ID, EncounterID: r.EncounterID, SampleNo: r.SampleNo, TestName: r.TestName,
				PatientName: r.FirstName + " " + r.LastName, MRN: r.Mrn, Priority: r.Priority,
				ValidatedAt: r.ValidatedAt, Critical: r.CriticalFlag, NotifiedAt: r.NotifiedAt,
				CriticalCount: int(r.CriticalCount), AbnormalCount: int(r.AbnormalCount),
			})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// InboxCount returns the number of unacknowledged critical results for a provider
// (the nav alert badge).
func (s *Service) InboxCount(ctx context.Context, providerID uuid.UUID) (int, error) {
	tenantID, _ := actorOf(ctx)
	var n int
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		c, e := labdb.New(tx).CountInboxCriticals(ctx, labdb.CountInboxCriticalsParams{TenantID: tenantID, ProviderID: &providerID})
		if e != nil {
			return e
		}
		n = int(c)
		return nil
	})
	if err != nil {
		return 0, apperr.Internal(err)
	}
	return n, nil
}

// --- helpers ---

func actorOf(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

// flagFor computes a result flag from the analyte's reference/critical ranges.
// Non-numeric values are treated as normal (e.g. "positive").
func flagFor(value string, refLow, refHigh, critLow, critHigh *string) string {
	v, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return "normal"
	}
	if f := parseFp(critLow); f != nil && v <= *f {
		return "critical"
	}
	if f := parseFp(critHigh); f != nil && v >= *f {
		return "critical"
	}
	if f := parseFp(refLow); f != nil && v < *f {
		return "low"
	}
	if f := parseFp(refHigh); f != nil && v > *f {
		return "high"
	}
	return "normal"
}

func parseFp(s *string) *float64 {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(*s), 64)
	if err != nil {
		return nil
	}
	return &v
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
