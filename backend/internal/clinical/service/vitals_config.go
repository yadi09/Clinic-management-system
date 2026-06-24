package service

import (
	"context"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/clinical"
	clinicaldb "github.com/reicb/clinicsaas/internal/clinical/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// fp is a tiny helper for default-catalog literals.
func fp(v float64) *float64 { return &v }

// defaultVitalCatalog is the built-in vitals form every clinic starts from. Stored
// vital_field_defs rows override these by key; a clinic that never customises just
// gets these adult defaults. Min/Max are plausibility bounds; Low/High the reference
// range. Weight/Height have no clinical low/high — only plausibility bounds.
var defaultVitalCatalog = []clinical.VitalField{
	{Key: "systolic", Label: "Systolic", Unit: "mmHg", Decimals: 0, Enabled: true, Required: false, Order: 1, Min: fp(60), Low: fp(90), High: fp(140), Max: fp(260)},
	{Key: "diastolic", Label: "Diastolic", Unit: "mmHg", Decimals: 0, Enabled: true, Required: false, Order: 2, Min: fp(30), Low: fp(60), High: fp(90), Max: fp(150)},
	{Key: "pulse", Label: "Pulse", Unit: "bpm", Decimals: 0, Enabled: true, Required: false, Order: 3, Min: fp(30), Low: fp(60), High: fp(100), Max: fp(220)},
	{Key: "resp_rate", Label: "Resp", Unit: "/min", Decimals: 0, Enabled: true, Required: false, Order: 4, Min: fp(6), Low: fp(12), High: fp(20), Max: fp(60)},
	{Key: "spo2", Label: "SpO₂", Unit: "%", Decimals: 0, Enabled: true, Required: false, Order: 5, Min: fp(50), Low: fp(94), High: fp(100), Max: fp(100)},
	{Key: "temp_c", Label: "Temp", Unit: "°C", Decimals: 1, Enabled: true, Required: false, Order: 6, Min: fp(30), Low: fp(36), High: fp(37.5), Max: fp(43)},
	{Key: "weight_kg", Label: "Weight", Unit: "kg", Decimals: 1, Enabled: true, Required: false, Order: 7, Min: fp(0.5), Max: fp(400)},
	{Key: "height_cm", Label: "Height", Unit: "cm", Decimals: 1, Enabled: true, Required: false, Order: 8, Min: fp(20), Max: fp(260)},
}

// standardVitalKeys is the set of keys a clinic may configure in Phase 1.
var standardVitalKeys = func() map[string]bool {
	m := map[string]bool{}
	for _, f := range defaultVitalCatalog {
		m[f.Key] = true
	}
	return m
}()

// mergeVitalDefs overlays stored per-clinic rows on the default catalog (by key),
// preserving the default catalog's order for any field not given an explicit order.
func mergeVitalDefs(rows []clinicaldb.ListVitalFieldDefsRow) []clinical.VitalField {
	override := make(map[string]clinicaldb.ListVitalFieldDefsRow, len(rows))
	for _, r := range rows {
		override[r.FieldKey] = r
	}
	out := make([]clinical.VitalField, 0, len(defaultVitalCatalog))
	for _, def := range defaultVitalCatalog {
		f := def
		if r, ok := override[def.Key]; ok {
			f.Label = r.Label
			f.Unit = r.Unit
			f.Decimals = int(r.Decimals)
			f.Enabled = r.Enabled
			f.Required = r.Required
			f.Order = int(r.SortOrder)
			f.Min = parseNum(r.MinVal)
			f.Low = parseNum(r.LowVal)
			f.High = parseNum(r.HighVal)
			f.Max = parseNum(r.MaxVal)
		}
		out = append(out, f)
	}
	return out
}

// effectiveFields returns the merged catalog inside the caller's transaction.
func (s *Service) effectiveFields(ctx context.Context, q *clinicaldb.Queries, tenantID uuid.UUID) ([]clinical.VitalField, error) {
	rows, e := q.ListVitalFieldDefs(ctx, tenantID)
	if e != nil {
		return nil, e
	}
	return mergeVitalDefs(rows), nil
}

// GetVitalFields returns the clinic's vitals form (defaults merged with overrides).
func (s *Service) GetVitalFields(ctx context.Context) ([]clinical.VitalField, error) {
	tenantID, _ := actorOf(ctx)
	var out []clinical.VitalField
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		out, e = s.effectiveFields(ctx, clinicaldb.New(tx), tenantID)
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SaveVitalFields upserts the clinic's vitals form. Only the standard field keys are
// accepted (custom fields are a later phase); thresholds must be non-decreasing.
func (s *Service) SaveVitalFields(ctx context.Context, fields []clinical.VitalFieldInput) error {
	tenantID, _ := actorOf(ctx)
	if len(fields) == 0 {
		return apperr.Validation("at least one vital field is required")
	}
	for _, f := range fields {
		if !standardVitalKeys[f.Key] {
			return apperr.Validation("unknown vital field: " + f.Key)
		}
		if f.Label == "" {
			return apperr.Validation("each vital field needs a label")
		}
		if f.Decimals < 0 || f.Decimals > 2 {
			return apperr.Validation("decimals must be between 0 and 2")
		}
		if e := validThresholds(f); e != nil {
			return e
		}
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := clinicaldb.New(tx)
		for _, f := range fields {
			if e := q.UpsertVitalFieldDef(ctx, clinicaldb.UpsertVitalFieldDefParams{
				TenantID: tenantID, FieldKey: f.Key, Label: f.Label, Unit: f.Unit, Decimals: int32(f.Decimals),
				Enabled: f.Enabled, Required: f.Required, SortOrder: int32(f.Order),
				MinVal: fmtNum(f.Min), LowVal: fmtNum(f.Low), HighVal: fmtNum(f.High), MaxVal: fmtNum(f.Max),
			}); e != nil {
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

// validThresholds checks that the present thresholds read min ≤ low ≤ high ≤ max.
func validThresholds(f clinical.VitalFieldInput) error {
	seq := []struct {
		name string
		v    *float64
	}{{"minimum", f.Min}, {"low", f.Low}, {"high", f.High}, {"maximum", f.Max}}
	var prev *float64
	var prevName string
	for _, s := range seq {
		if s.v == nil {
			continue
		}
		if prev != nil && *s.v < *prev {
			return apperr.Validation("vital thresholds must increase: " + f.Label + " " + prevName + " cannot exceed " + s.name)
		}
		prev, prevName = s.v, s.name
	}
	return nil
}

// validateVitals enforces the clinic's plausibility bounds and required fields when a
// vitals set is recorded. Low/High are display-only and not enforced here.
func validateVitals(fields []clinical.VitalField, v clinical.VitalsInput) error {
	provided := map[string]*float64{
		"systolic":  fromInt(v.Systolic),
		"diastolic": fromInt(v.Diastolic),
		"pulse":     fromInt(v.Pulse),
		"resp_rate": fromInt(v.RespRate),
		"spo2":      fromInt(v.Spo2),
		"temp_c":    v.TempC,
		"weight_kg": v.WeightKg,
		"height_cm": v.HeightCm,
	}
	for _, f := range fields {
		if !f.Enabled {
			continue
		}
		val := provided[f.Key]
		if val == nil {
			if f.Required {
				return apperr.Validation(f.Label + " is required")
			}
			continue
		}
		if f.Min != nil && *val < *f.Min {
			return apperr.Validation(f.Label + " is below the allowed minimum (" + trimNum(*f.Min) + " " + f.Unit + ") — check the value")
		}
		if f.Max != nil && *val > *f.Max {
			return apperr.Validation(f.Label + " is above the allowed maximum (" + trimNum(*f.Max) + " " + f.Unit + ") — check the value")
		}
	}
	return nil
}

func fromInt(p *int) *float64 {
	if p == nil {
		return nil
	}
	f := float64(*p)
	return &f
}

// parseNum converts a stored NUMERIC string to a float pointer (nil-safe).
func parseNum(s *string) *float64 {
	if s == nil {
		return nil
	}
	f, err := strconv.ParseFloat(*s, 64)
	if err != nil {
		return nil
	}
	return &f
}

// fmtNum formats a float pointer for NUMERIC storage (nil-safe).
func fmtNum(f *float64) *string {
	if f == nil {
		return nil
	}
	s := strconv.FormatFloat(*f, 'f', 2, 64)
	return &s
}

// trimNum renders a threshold for an error message without trailing zeros.
func trimNum(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}
