package ethiocal

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/testkit"
)

// ec builds an EAT-midnight moment for a Gregorian date.
func gc(y, m, d int) time.Time { return time.Date(y, time.Month(m), d, 0, 0, 0, 0, EAT) }

func ecString(y, m, d int) string { return fmt.Sprintf("%d-%02d-%02d", y, m, d) }

// Given well-known civil anchors, When converted to EC, Then each lands on the published Ethiopian date.
func TestREG_KERNEL_ETHIOCAL_001_KnownAnchors(t *testing.T) {
	cases := []struct {
		name    string
		g       time.Time
		y, m, d int
	}{
		{"New Year 2018 EC (doc anchor)", gc(2025, 9, 11), 2018, 1, 1},
		{"New Year 2017 EC", gc(2024, 9, 11), 2017, 1, 1},
		// 2015 EC is leap (2015 % 4 == 3), so Pagumē has 6 days and 2016 starts on Sep 12,
		// the September before Gregorian leap year 2024.
		{"New Year 2016 EC falls on Sep 12", gc(2023, 9, 12), 2016, 1, 1},
		{"Pagumē 6 2015 exists (leap)", gc(2023, 9, 11), 2015, 13, 6},
		{"New Year 2012 EC falls on Sep 12", gc(2019, 9, 12), 2012, 1, 1},
		{"New Year 2019 EC", gc(2026, 9, 11), 2019, 1, 1},
		{"Genna 2018 (Jan 7 = Tahsas 29)", gc(2026, 1, 7), 2018, 4, 29},
		{"Genna 2016 (Jan 7 = Tahsas 28 after a leap year)", gc(2024, 1, 7), 2016, 4, 28},
		{"Adwa (Yekatit 23 = Mar 2)", gc(2025, 3, 2), 2017, 6, 23},
		{"Timket 2018 (Tir 11 = Jan 19)", gc(2026, 1, 19), 2018, 5, 11},
		{"Gregorian leap day", gc(2024, 2, 29), 2016, 6, 21},
		{"today in this repo's world", gc(2026, 10, 3), 2019, 1, 23},
		{"Pagumē 5 in a common year", gc(2026, 9, 10), 2018, 13, 5},
		{"Pagumē 1 in a common year", gc(2026, 9, 6), 2018, 13, 1},
	}
	for _, c := range cases {
		y, m, d := ToEthiopian(c.g)
		if y != c.y || m != c.m || d != c.d {
			t.Errorf("%s: ToEthiopian(%s) = %s, want %s", c.name, c.g.Format("2006-01-02"), ecString(y, m, d), ecString(c.y, c.m, c.d))
		}
	}
}

// Given a moment near midnight, When converted, Then the EC day follows the clock in Addis (UTC+3), not UTC.
func TestREG_KERNEL_ETHIOCAL_002_DayBoundaryIsEAT(t *testing.T) {
	// 2025-09-10 21:30Z is 00:30 on Sep 11 in Addis: already New Year.
	if y, m, d := ToEthiopian(time.Date(2025, 9, 10, 21, 30, 0, 0, time.UTC)); ecString(y, m, d) != "2018-01-01" {
		t.Errorf("21:30Z on Sep 10 = %s, want 2018-01-01 (EAT is +3)", ecString(y, m, d))
	}
	// 20:59Z is still 23:59 on Sep 10 in Addis: Pagumē 5 of 2017.
	if y, m, d := ToEthiopian(time.Date(2025, 9, 10, 20, 59, 0, 0, time.UTC)); ecString(y, m, d) != "2017-13-05" {
		t.Errorf("20:59Z on Sep 10 = %s, want 2017-13-05", ecString(y, m, d))
	}
	// A moment in some other zone is converted by its instant, not its wall clock.
	ny := time.FixedZone("NY", -4*3600)
	if y, m, d := ToEthiopian(time.Date(2025, 9, 10, 18, 0, 0, 0, ny)); ecString(y, m, d) != "2018-01-01" {
		t.Errorf("18:00 New York on Sep 10 (=01:00 EAT Sep 11) = %s, want 2018-01-01", ecString(y, m, d))
	}
}

// Given every EC year 1890..2110, When the year is laid out, Then Pagumē has 6 days exactly when year%4==3, and New Year is Sep 11, or Sep 12 in the year before a Gregorian leap year.
func TestREG_KERNEL_ETHIOCAL_003_LeapYearsAndNewYear(t *testing.T) {
	for ey := 1890; ey <= 2110; ey++ {
		ny := ethToJDN(ey+1, 1, 1)
		pagume := ny - ethToJDN(ey, 13, 1)
		want := 5
		if ey%4 == 3 {
			want = 6
		}
		if pagume != want {
			t.Errorf("EC %d: Pagumē has %d days, want %d", ey, pagume, want)
		}
		gy, gm, gd := jdnToGreg(ethToJDN(ey, 1, 1))
		// Between 1900 and 2099 (Gregorian) New Year is Sep 11, or Sep 12 when the
		// following Gregorian year is a leap year.
		if gy >= 1901 && gy <= 2098 {
			wantDay := 11
			if (gy+1)%4 == 0 {
				wantDay = 12
			}
			if gm != 9 || gd != wantDay {
				t.Errorf("Meskerem 1, %d EC = %d-%02d-%02d, want Sep %d", ey, gy, gm, gd, wantDay)
			}
		}
		if gy-ey != 7 && gy-ey != 8 {
			t.Errorf("EC %d starts in GC %d — must be 7 years behind at New Year", ey, gy)
		}
	}
}

// Given every day 1800..2200, When converted GC→EC→GC, Then it round-trips and the EC date advances by exactly one valid day each time.
func TestREG_KERNEL_ETHIOCAL_004_RoundTripAndContinuity(t *testing.T) {
	start := gregToJDN(1800, 1, 1)
	end := gregToJDN(2200, 12, 31)
	py, pm, pd := jdnToEth(start - 1)
	for jdn := start; jdn <= end; jdn++ {
		gy, gm, gd := jdnToGreg(jdn)
		if gregToJDN(gy, gm, gd) != jdn {
			t.Fatalf("Gregorian round-trip broke at JDN %d (%d-%d-%d)", jdn, gy, gm, gd)
		}
		y, m, d := jdnToEth(jdn)
		if m < 1 || m > 13 || d < 1 || d > 30 || (m == 13 && d > 6) || (m == 13 && d == 6 && y%4 != 3) {
			t.Fatalf("JDN %d → impossible EC date %s", jdn, ecString(y, m, d))
		}
		if ethToJDN(y, m, d) != jdn {
			t.Fatalf("EC round-trip broke at %d-%02d-%02d → %s", gy, gm, gd, ecString(y, m, d))
		}
		// Continuity: next day of (py,pm,pd).
		ny, nm, nd := py, pm, pd+1
		if (pm <= 12 && nd > 30) || (pm == 13 && nd > 5+boolInt(py%4 == 3)) {
			nd, nm = 1, pm+1
			if nm > 13 {
				nm, ny = 1, py+1
			}
		}
		if y != ny || m != nm || d != nd {
			t.Fatalf("EC skipped/repeated a day at GC %d-%02d-%02d: got %s after %s", gy, gm, gd, ecString(y, m, d), ecString(py, pm, pd))
		}
		py, pm, pd = y, m, d
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Given the frontend's own month-start table (generated from frontend/src/lib/ethiopian.ts), When the backend converts the same Gregorian days 1900..2100, Then both calendars agree on every single day.
func TestREG_KERNEL_ETHIOCAL_005_AgreesWithFrontendEveryDay(t *testing.T) {
	f, err := os.Open("testdata/frontend_month_starts.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	type start struct {
		g          time.Time
		y, m, days int
	}
	var starts []start
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var gs string
		var s start
		if _, err := fmt.Sscanf(line, "%s %d %d %d", &gs, &s.y, &s.m, &s.days); err != nil {
			t.Fatalf("bad golden line %q: %v", line, err)
		}
		g, err := time.ParseInLocation("2006-01-02", gs, EAT)
		if err != nil {
			t.Fatal(err)
		}
		s.g = g
		starts = append(starts, s)
	}
	if len(starts) < 2600 {
		t.Fatalf("golden table too short (%d rows)", len(starts))
	}
	mismatches := 0
	for i, s := range starts {
		// Every day of this EC month, per the frontend, maps to (y, m, 1..days).
		for k := 0; k < s.days; k++ {
			day := s.g.AddDate(0, 0, k)
			if i+1 < len(starts) && !day.Before(starts[i+1].g) {
				t.Errorf("frontend month %d-%02d spills into the next month start", s.y, s.m)
				break
			}
			y, m, d := ToEthiopian(day)
			if y != s.y || m != s.m || d != k+1 {
				mismatches++
				if mismatches <= 10 {
					t.Errorf("GC %s: backend %s, frontend %s", day.Format("2006-01-02"), ecString(y, m, d), ecString(s.y, s.m, k+1))
				}
			}
		}
		if i+1 < len(starts) {
			if got := int(starts[i+1].g.Sub(s.g).Hours()/24 + 0.5); got != s.days {
				t.Errorf("frontend month %d-%02d has %d days in the table, %d by its own count", s.y, s.m, got, s.days)
			}
		}
	}
	if mismatches > 0 {
		t.Errorf("backend and frontend disagree on %d days", mismatches)
	}
}

// Given a moment in a regular month, When MonthRange is asked, Then it spans that EC month's 30 days, midnight EAT to midnight EAT, with its label.
func TestREG_KERNEL_ETHIOCAL_006_MonthRangeRegularMonth(t *testing.T) {
	start, end, label, ey, em := MonthRange(time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC))
	// 2026-07-20 = Hamle 13, 2018; Hamle 1 = 2026-07-08.
	if label != "Hamle 2018" || ey != 2018 || em != 11 {
		t.Fatalf("label/ey/em = %q/%d/%d, want Hamle 2018/2018/11", label, ey, em)
	}
	if !start.Equal(gc(2026, 7, 8)) || !end.Equal(gc(2026, 8, 7)) {
		t.Fatalf("range = [%s, %s), want [2026-07-08, 2026-08-07) EAT", start, end)
	}
	if start.Location() != EAT || start.Hour() != 0 {
		t.Errorf("start must be midnight EAT, got %s", start)
	}
	if end.Sub(start) != 30*24*time.Hour {
		t.Errorf("a regular EC month is 30 days, got %s", end.Sub(start))
	}
}

// Given a moment in Pagumē, When MonthRange is asked, Then it ends at the next Meskerem 1 — 5 days in a common year, 6 in a leap year — and rolls the year.
func TestREG_KERNEL_ETHIOCAL_007_MonthRangePagumeRollsYear(t *testing.T) {
	start, end, label, ey, em := MonthRange(gc(2026, 9, 8).Add(10 * time.Hour))
	if label != "Pagumē 2018" || ey != 2018 || em != 13 {
		t.Fatalf("got %q/%d/%d, want Pagumē 2018/2018/13", label, ey, em)
	}
	if !start.Equal(gc(2026, 9, 6)) || !end.Equal(gc(2026, 9, 11)) {
		t.Fatalf("common Pagumē = [%s, %s), want [Sep 6, Sep 11)", start, end)
	}
	start, end, label, _, _ = MonthRange(gc(2023, 9, 11))
	if label != "Pagumē 2015" || !start.Equal(gc(2023, 9, 6)) || !end.Equal(gc(2023, 9, 12)) {
		t.Fatalf("leap Pagumē = %q [%s, %s), want Pagumē 2015 [Sep 6, Sep 12)", label, start, end)
	}
	if end.Sub(start) != 6*24*time.Hour {
		t.Errorf("leap Pagumē must be 6 days, got %s", end.Sub(start))
	}
	// The next month after Pagumē is Meskerem of the following year.
	_, _, label, ey, em = MonthRange(end)
	if label != "Meskerem 2016" || ey != 2016 || em != 1 {
		t.Errorf("the moment Pagumē ends must be Meskerem 2016, got %q", label)
	}
}

// Given an instant exactly on a month boundary, When MonthRange is asked, Then the boundary belongs to the new month ([start, end) is half-open).
func TestREG_KERNEL_ETHIOCAL_008_MonthRangeHalfOpen(t *testing.T) {
	_, _, label, _, _ := MonthRange(gc(2025, 9, 11))
	if label != "Meskerem 2018" {
		t.Errorf("midnight EAT Sep 11 belongs to Meskerem 2018, got %q", label)
	}
	_, end, label, _, _ := MonthRange(gc(2025, 9, 11).Add(-time.Nanosecond))
	if label != "Pagumē 2017" || !end.Equal(gc(2025, 9, 11)) {
		t.Errorf("1ns before New Year: %q ending %s, want Pagumē 2017 ending Sep 11", label, end)
	}
}

// Given each month number, When labelled, Then the transliteration and year read as staff expect.
func TestREG_KERNEL_ETHIOCAL_009_Labels(t *testing.T) {
	if len(Months) != 13 {
		t.Fatalf("13 months, got %d", len(Months))
	}
	for m, want := range map[int]string{1: "Meskerem 2018", 4: "Tahsas 2018", 11: "Hamle 2018", 12: "Nehase 2018", 13: "Pagumē 2018"} {
		if got := Label(2018, m); got != want {
			t.Errorf("Label(2018,%d) = %q, want %q", m, got, want)
		}
	}
}

// Given an out-of-range month, When labelled, Then it panics rather than inventing a name (no validation — callers only pass months from ToEthiopian).
func TestREG_KERNEL_ETHIOCAL_010_LabelInvalidMonthPanics(t *testing.T) {
	for _, m := range []int{0, 14} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("Label(2018,%d) did not panic", m)
				}
			}()
			_ = Label(2018, m)
		}()
	}
}

// Given a date before the EC epoch (e.g. a zero time.Time), When converted, Then the backend agrees with the frontend (which uses floor division).
func TestREG_KERNEL_ETHIOCAL_011_PreEpochAgreesWithFrontend(t *testing.T) {
	// Values produced by frontend/src/lib/ethiopian.ts toEthiopian (TZ=Africa/Addis_Ababa).
	cases := []struct {
		g       time.Time
		y, m, d int
	}{
		{time.Time{}, -7, 5, 8}, // 0001-01-01 — a zero time.Time
		{gc(5, 6, 15), -3, 10, 23},
		{gc(8, 8, 26), 0, 13, 5},
		{gc(8, 8, 27), 1, 1, 1}, // the epoch itself
		{gc(9, 1, 1), 1, 5, 8},
	}
	bad := []string{}
	for _, c := range cases {
		y, m, d := ToEthiopian(c.g)
		if y != c.y || m != c.m || d != c.d {
			bad = append(bad, fmt.Sprintf("%s: backend %s, frontend %s", c.g.In(EAT).Format("2006-01-02"), ecString(y, m, d), ecString(c.y, c.m, c.d)))
		}
	}
	testkit.KnownBug(t, "NEW-KERNEL-ETHIOCAL-1", len(bad) > 0,
		"before the EC epoch (Gregorian 8 AD, incl. zero time.Time) Go's truncating year/4 in daysToYear disagrees with the frontend's Math.floor: "+strings.Join(bad, "; "))
}
