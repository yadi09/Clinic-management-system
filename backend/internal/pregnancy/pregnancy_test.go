package pregnancy

import (
	"testing"
	"time"
)

func d(y int, m time.Month, day int) time.Time   { return time.Date(y, m, day, 0, 0, 0, 0, time.UTC) }
func dp(y int, m time.Month, day int) *time.Time { t := d(y, m, day); return &t }
func ip(n int) *int                              { s := n; return &s }
func sp(s string) *string                        { return &s }

func TestCalculate_AssertionTable(t *testing.T) {
	cases := []struct {
		name       string
		method     Method
		in         Inputs
		gaDate     time.Time
		lmp        time.Time
		edd        time.Time
		conception time.Time
		gaLabel    string // "" = skip
	}{
		{
			name: "LMP", method: MethodLMP,
			in:     Inputs{FirstDayOfLMP: dp(2026, 1, 1), CycleLength: ip(28)},
			gaDate: d(2026, 3, 1),
			lmp:    d(2026, 1, 1), edd: d(2026, 10, 8), conception: d(2026, 1, 15), gaLabel: "8w 3d",
		},
		{
			name: "LMP long cycle", method: MethodLMP,
			in:  Inputs{FirstDayOfLMP: dp(2026, 1, 1), CycleLength: ip(35)},
			lmp: d(2026, 1, 8), edd: d(2026, 10, 15), conception: d(2026, 1, 22),
		},
		{
			name: "IVF day5", method: MethodIVF,
			in:  Inputs{TransferDate: dp(2026, 1, 15), EmbryoType: sp("day5")},
			lmp: d(2025, 12, 27), edd: d(2026, 10, 3), conception: d(2026, 1, 10),
		},
		{
			name: "ULTRASOUND 10w0d", method: MethodUltrasound,
			in:  Inputs{UltrasoundDate: dp(2026, 3, 1), GAWeeks: ip(10), GADays: ip(0)},
			lmp: d(2025, 12, 21), edd: d(2026, 9, 27), conception: d(2026, 1, 4),
		},
		{
			name: "KNOWN_EDD", method: MethodKnownEDD,
			in:  Inputs{EDD: dp(2026, 10, 8)},
			lmp: d(2026, 1, 1), edd: d(2026, 10, 8), conception: d(2026, 1, 15),
		},
		{
			name: "CONCEPTION", method: MethodConception,
			in:  Inputs{ConceptionDate: dp(2026, 1, 15)},
			lmp: d(2026, 1, 1), edd: d(2026, 10, 8), conception: d(2026, 1, 15),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ga := c.gaDate
			if ga.IsZero() {
				ga = c.lmp // any date; GA not asserted in these rows
			}
			r, err := Calculate(c.method, c.in, ga)
			if err != nil {
				t.Fatalf("Calculate: %v", err)
			}
			if !r.CalculatedLMP.Equal(c.lmp) {
				t.Errorf("LMP = %s, want %s", r.CalculatedLMP.Format("2006-01-02"), c.lmp.Format("2006-01-02"))
			}
			if !r.EDD.Equal(c.edd) {
				t.Errorf("EDD = %s, want %s", r.EDD.Format("2006-01-02"), c.edd.Format("2006-01-02"))
			}
			if !r.EstimatedConception.Equal(c.conception) {
				t.Errorf("conception = %s, want %s", r.EstimatedConception.Format("2006-01-02"), c.conception.Format("2006-01-02"))
			}
			// invariants
			if diffDays(r.EDD, r.CalculatedLMP) != 280 {
				t.Errorf("EDD-LMP = %d, want 280", diffDays(r.EDD, r.CalculatedLMP))
			}
			if diffDays(r.EDD, r.EstimatedConception) != 266 {
				t.Errorf("EDD-conception = %d, want 266", diffDays(r.EDD, r.EstimatedConception))
			}
			if c.gaLabel != "" && r.GestationalAge.Label != c.gaLabel {
				t.Errorf("GA label = %q, want %q", r.GestationalAge.Label, c.gaLabel)
			}
		})
	}
}

func TestGA_WholeWeekAndInvalid(t *testing.T) {
	// GA at the EDD is exactly 40w 0d.
	r, _ := Calculate(MethodLMP, Inputs{FirstDayOfLMP: dp(2026, 1, 1)}, d(2026, 10, 8))
	if r.GestationalAge.Label != "40w 0d" || r.GestationalAge.Days != 280 {
		t.Errorf("GA at EDD = %q (%d days), want 40w 0d / 280", r.GestationalAge.Label, r.GestationalAge.Days)
	}
	// A date before the LMP is not a valid GA.
	r2, _ := Calculate(MethodLMP, Inputs{FirstDayOfLMP: dp(2026, 1, 1)}, d(2025, 12, 1))
	if r2.GestationalAge.Valid || r2.GestationalAge.Label != "" {
		t.Errorf("GA before LMP: Valid=%v Label=%q, want false/empty", r2.GestationalAge.Valid, r2.GestationalAge.Label)
	}
}

func TestGA_LeapYearSpan(t *testing.T) {
	// Jan 1 → Dec 31 of a leap year is 365 days (crosses Feb 29) = 52w 1d.
	r, _ := Calculate(MethodLMP, Inputs{FirstDayOfLMP: dp(2024, 1, 1)}, d(2024, 12, 31))
	if r.GestationalAge.Days != 365 || r.GestationalAge.Label != "52w 1d" {
		t.Errorf("leap span = %d days / %q, want 365 / 52w 1d", r.GestationalAge.Days, r.GestationalAge.Label)
	}
}

func TestScheduleWindows(t *testing.T) {
	r, _ := Calculate(MethodLMP, Inputs{FirstDayOfLMP: dp(2026, 1, 1)}, d(2026, 3, 1))
	nt := r.Windows["ntScan"]
	if nt.Start == nil || !nt.Start.Equal(d(2026, 3, 19)) || nt.End == nil || !nt.End.Equal(d(2026, 4, 9)) {
		t.Errorf("ntScan window wrong: %+v", nt)
	}
	full := r.Windows["fullTerm"]
	if full.Point == nil || !full.Point.Equal(d(2026, 10, 1)) { // 39 weeks after Jan 1 = EDD-7
		t.Errorf("fullTerm point wrong: %+v", full)
	}
}

func TestShouldRedate_Boundaries(t *testing.T) {
	cases := []struct {
		ga, disc int
		want     bool
	}{
		{62, 5, false}, {62, 6, true}, // <9w0d → >5
		{63, 7, false}, {63, 8, true}, // 9w0d–15w6d → >7
		{112, 10, false}, {112, 11, true}, // 16w0d–21w6d → >10
		{154, 14, false}, {154, 15, true}, // 22w0d–27w6d → >14
		{196, 21, false}, {196, 22, true}, // ≥28w0d → >21
	}
	for _, c := range cases {
		if got := ShouldRedate(c.ga, c.disc); got != c.want {
			t.Errorf("ShouldRedate(%d,%d) = %v, want %v", c.ga, c.disc, got, c.want)
		}
	}
}

func TestValidate_Rejections(t *testing.T) {
	bad := []struct {
		name   string
		method Method
		in     Inputs
	}{
		{"cycle too high", MethodLMP, Inputs{FirstDayOfLMP: dp(2026, 1, 1), CycleLength: ip(50)}},
		{"cycle too low", MethodLMP, Inputs{FirstDayOfLMP: dp(2026, 1, 1), CycleLength: ip(10)}},
		{"gaDays=7", MethodUltrasound, Inputs{UltrasoundDate: dp(2026, 3, 1), GAWeeks: ip(10), GADays: ip(7)}},
		{"missing ultrasoundDate", MethodUltrasound, Inputs{GAWeeks: ip(10), GADays: ip(0)}},
		{"missing lmp", MethodLMP, Inputs{}},
		{"bad embryoType", MethodIVF, Inputs{TransferDate: dp(2026, 1, 15), EmbryoType: sp("day4")}},
		{"missing conception", MethodConception, Inputs{}},
	}
	for _, c := range bad {
		if err := Validate(c.method, c.in); err == nil {
			t.Errorf("%s: expected a validation error, got nil", c.name)
		}
	}
}
