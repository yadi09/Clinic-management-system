// Package pregnancy is the pure, dependency-free obstetric math for pregnancy
// dating: five dating methods normalise to a single anchor — the calculated LMP —
// from which the EDD, gestational age, conception date and scheduling windows all
// derive. It has no knowledge of HTTP or the database. Dates are time.Time values
// normalised to UTC midnight; day arithmetic uses AddDate (DST-safe for date-only
// values). Constants and formulas are fixed clinical facts — do not change them.
package pregnancy

import (
	"fmt"
	"time"
)

// Method is one of the five dating methods.
type Method string

const (
	MethodLMP        Method = "LMP"
	MethodUltrasound Method = "ULTRASOUND"
	MethodKnownEDD   Method = "KNOWN_EDD"
	MethodIVF        Method = "IVF"
	MethodConception Method = "CONCEPTION"
)

const (
	gestationDays        = 280 // LMP -> birth (40 weeks)
	conceptionOffsetDays = 14  // LMP -> conception (ovulation cycle day 14)
	defaultCycleLength   = 28
)

var embryoAgeDays = map[string]int{"day3": 3, "day5": 5, "day6": 6}

// Inputs carries all possible method inputs; only the relevant fields are used.
type Inputs struct {
	FirstDayOfLMP  *time.Time `json:"firstDayOfLmp,omitempty"`
	CycleLength    *int       `json:"cycleLength,omitempty"`
	UltrasoundDate *time.Time `json:"ultrasoundDate,omitempty"`
	GAWeeks        *int       `json:"gaWeeks,omitempty"`
	GADays         *int       `json:"gaDays,omitempty"`
	EDD            *time.Time `json:"edd,omitempty"`
	TransferDate   *time.Time `json:"transferDate,omitempty"`
	EmbryoType     *string    `json:"embryoType,omitempty"`
	ConceptionDate *time.Time `json:"conceptionDate,omitempty"`
}

// GestationalAge is a gestational age on a chosen date.
type GestationalAge struct {
	Days    int    `json:"days"`
	Weeks   int    `json:"weeks"`
	RemDays int    `json:"remDays"`
	Label   string `json:"label"` // "8w 3d"
	Valid   bool   `json:"valid"` // false when the date precedes the LMP
}

// Window is a scheduling window: either a range [Start,End] or a single Point.
type Window struct {
	Start *time.Time `json:"start,omitempty"`
	End   *time.Time `json:"end,omitempty"`
	Point *time.Time `json:"point,omitempty"`
}

// Result is everything derived from the calculated LMP.
type Result struct {
	CalculatedLMP       time.Time         `json:"calculatedLmp"`
	EstimatedConception time.Time         `json:"estimatedConception"`
	EDD                 time.Time         `json:"edd"`
	GestationalAge      GestationalAge    `json:"gestationalAge"`
	Windows             map[string]Window `json:"windows"`
}

func addDays(d time.Time, n int) time.Time { return d.AddDate(0, 0, n) }
func diffDays(a, b time.Time) int          { return int(a.Sub(b).Hours()/24 + 0.5) }

func lmpFromMethod(m Method, in Inputs) (time.Time, error) {
	switch m {
	case MethodLMP:
		cl := defaultCycleLength
		if in.CycleLength != nil {
			cl = *in.CycleLength
		}
		return addDays(*in.FirstDayOfLMP, cl-defaultCycleLength), nil
	case MethodUltrasound:
		return addDays(*in.UltrasoundDate, -(*in.GAWeeks*7 + *in.GADays)), nil
	case MethodKnownEDD:
		return addDays(*in.EDD, -gestationDays), nil
	case MethodIVF:
		age, ok := embryoAgeDays[*in.EmbryoType]
		if !ok {
			return time.Time{}, fmt.Errorf("invalid embryoType %q", *in.EmbryoType)
		}
		return addDays(addDays(*in.TransferDate, -age), -conceptionOffsetDays), nil
	case MethodConception:
		return addDays(*in.ConceptionDate, -conceptionOffsetDays), nil
	default:
		return time.Time{}, fmt.Errorf("unknown method %q", m)
	}
}

// Calculate validates the inputs, derives the LMP for the method, and returns the
// full result (EDD, conception, GA on gaDate, scheduling windows).
func Calculate(m Method, in Inputs, gaDate time.Time) (Result, error) {
	if err := Validate(m, in); err != nil {
		return Result{}, err
	}
	lmp, err := lmpFromMethod(m, in)
	if err != nil {
		return Result{}, err
	}
	return ResultFromLMP(lmp, gaDate), nil
}

// ResultFromLMP derives the full result from an already-known LMP (used to
// recompute GA on a chosen date from a stored dating, without a method).
func ResultFromLMP(lmp, gaDate time.Time) Result {
	gaDays := diffDays(gaDate, lmp)
	ga := GestationalAge{Days: gaDays, Valid: gaDays >= 0}
	if ga.Valid {
		ga.Weeks, ga.RemDays = gaDays/7, gaDays%7
		ga.Label = fmt.Sprintf("%dw %dd", ga.Weeks, ga.RemDays)
	}
	return Result{
		CalculatedLMP:       lmp,
		EstimatedConception: addDays(lmp, conceptionOffsetDays),
		EDD:                 addDays(lmp, gestationDays),
		GestationalAge:      ga,
		Windows:             scheduleWindows(lmp),
	}
}

func wk(lmp time.Time, w int) time.Time { return addDays(lmp, w*7) }

// scheduleWindows returns the antenatal scheduling checklist relative to the LMP.
// Offsets are kept here as a table so clinical staff can adjust them centrally.
func scheduleWindows(lmp time.Time) map[string]Window {
	p := func(w int) Window { d := wk(lmp, w); return Window{Point: &d} }
	r := func(a, b int) Window { s, e := wk(lmp, a), wk(lmp, b); return Window{Start: &s, End: &e} }
	return map[string]Window{
		"ntScan":         r(11, 14),
		"anatomyScan":    r(18, 22),
		"typicalAnatomy": p(20),
		"glucoseScreen":  r(24, 28),
		"rhoGam":         p(28),
		"tdap":           r(27, 36),
		"gbsScreen":      r(36, 37),
		"viability":      p(23),
		"earlyTerm":      p(37),
		"fullTerm":       p(39),
		"postdates":      p(41),
	}
}

// ShouldRedate reports whether an ultrasound discrepancy exceeds the ACOG
// GA-dependent threshold that warrants redating the pregnancy by ultrasound.
func ShouldRedate(gaAtUltrasoundDays, discrepancyDays int) bool {
	switch {
	case gaAtUltrasoundDays < 63: // < 9w0d
		return discrepancyDays > 5
	case gaAtUltrasoundDays < 112: // 9w0d–15w6d
		return discrepancyDays > 7
	case gaAtUltrasoundDays < 154: // 16w0d–21w6d
		return discrepancyDays > 10
	case gaAtUltrasoundDays < 196: // 22w0d–27w6d
		return discrepancyDays > 14
	default: // >= 28w0d
		return discrepancyDays > 21
	}
}

// Validate enforces per-method required fields and sane ranges. Event dates
// (LMP/ultrasound/transfer/conception) may not be in the future; the EDD may be.
func Validate(m Method, in Inputs) error {
	notFuture := func(label string, d *time.Time) error {
		if d != nil && d.After(todayUTC()) {
			return fmt.Errorf("%s cannot be in the future", label)
		}
		return nil
	}
	switch m {
	case MethodLMP:
		if in.FirstDayOfLMP == nil {
			return fmt.Errorf("firstDayOfLmp is required")
		}
		if in.CycleLength != nil && (*in.CycleLength < 20 || *in.CycleLength > 45) {
			return fmt.Errorf("cycleLength must be between 20 and 45")
		}
		return notFuture("firstDayOfLmp", in.FirstDayOfLMP)
	case MethodUltrasound:
		if in.UltrasoundDate == nil {
			return fmt.Errorf("ultrasoundDate is required")
		}
		if in.GAWeeks == nil || in.GADays == nil {
			return fmt.Errorf("gaWeeks and gaDays are required")
		}
		if *in.GAWeeks < 0 || *in.GAWeeks > 42 {
			return fmt.Errorf("gaWeeks must be between 0 and 42")
		}
		if *in.GADays < 0 || *in.GADays > 6 {
			return fmt.Errorf("gaDays must be between 0 and 6")
		}
		return notFuture("ultrasoundDate", in.UltrasoundDate)
	case MethodKnownEDD:
		if in.EDD == nil {
			return fmt.Errorf("edd is required")
		}
		return nil
	case MethodIVF:
		if in.TransferDate == nil {
			return fmt.Errorf("transferDate is required")
		}
		if in.EmbryoType == nil {
			return fmt.Errorf("embryoType is required")
		}
		if _, ok := embryoAgeDays[*in.EmbryoType]; !ok {
			return fmt.Errorf("embryoType must be one of day3, day5, day6")
		}
		return notFuture("transferDate", in.TransferDate)
	case MethodConception:
		if in.ConceptionDate == nil {
			return fmt.Errorf("conceptionDate is required")
		}
		return notFuture("conceptionDate", in.ConceptionDate)
	default:
		return fmt.Errorf("unknown method %q", m)
	}
}

func todayUTC() time.Time {
	n := time.Now().UTC()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}
