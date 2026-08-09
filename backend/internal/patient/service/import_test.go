package service

import (
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/patient"
)

func TestParseFlexibleDate(t *testing.T) {
	want := time.Date(2017, 6, 13, 0, 0, 0, 0, time.UTC)
	for _, in := range []string{"13/06/2017", "13-06-2017", "2017-06-13", `13\06\2017`, "13.06.2017", " 13 / 06 / 2017 "} {
		got, err := parseFlexibleDate(in, calGregorian)
		if err != nil {
			t.Fatalf("%q: unexpected error %v", in, err)
		}
		if !got.Equal(want) {
			t.Errorf("%q → %s, want %s", in, got.Format("2006-01-02"), want.Format("2006-01-02"))
		}
	}

	// Excel serials (days since 1899-12-30).
	for _, tc := range []struct {
		serial string
		want   string
	}{
		{"42922", "2017-07-06"},
		{"43015", "2017-10-07"},
		{"44201", "2021-01-05"},
	} {
		got, err := parseFlexibleDate(tc.serial, calGregorian)
		if err != nil {
			t.Fatalf("serial %s: %v", tc.serial, err)
		}
		if got.Format("2006-01-02") != tc.want {
			t.Errorf("serial %s → %s, want %s", tc.serial, got.Format("2006-01-02"), tc.want)
		}
	}

	// Unambiguous month-first still resolves correctly.
	if got, err := parseFlexibleDate("06/13/2017", calGregorian); err != nil || !got.Equal(want) {
		t.Errorf("06/13/2017 → %v %v, want %s", got, err, want.Format("2006-01-02"))
	}

	// Short form with a 2-digit year, Gregorian.
	for _, in := range []string{"13/6/17", "13-6-17", "13/06/17"} {
		if got, err := parseFlexibleDate(in, calGregorian); err != nil || !got.Equal(want) {
			t.Errorf("%q → %v (%v), want %s", in, got.Format("2006-01-02"), err, want.Format("2006-01-02"))
		}
	}
	// A 2-digit year above 50 belongs to the previous century.
	if got, err := parseFlexibleDate("13/6/98", calGregorian); err != nil || got.Year() != 1998 {
		t.Errorf("13/6/98 → %v (%v), want 1998", got.Format("2006-01-02"), err)
	}

	for _, bad := range []string{"", "not a date", "31/02/2017", "13/06", "99999999", "12"} {
		if _, err := parseFlexibleDate(bad, calGregorian); err == nil {
			t.Errorf("%q should have been rejected", bad)
		}
	}
}

// Legacy registers here are written in the Ethiopian calendar; we store Gregorian.
func TestParseFlexibleDateEthiopian(t *testing.T) {
	// Anchor: Meskerem 1, 2018 EC = 11 Sep 2025 GC.
	if got, err := parseFlexibleDate("01/01/2018", calEthiopian); err != nil || got.Format("2006-01-02") != "2025-09-11" {
		t.Fatalf("Meskerem 1 2018 EC → %v (%v), want 2025-09-11", got.Format("2006-01-02"), err)
	}
	// 13 Yekatit 2017 EC = 20 Feb 2025 GC — the same digits as the Gregorian
	// example, landing ~7.5 years later.
	for _, in := range []string{"13/06/2017", "13-06-2017", `13\06\2017`, "2017-06-13"} {
		got, err := parseFlexibleDate(in, calEthiopian)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if got.Format("2006-01-02") != "2025-02-20" {
			t.Errorf("%q (EC) → %s, want 2025-02-20", in, got.Format("2006-01-02"))
		}
	}
	// The short form most registers actually use: single-digit month, 2-digit year.
	// 13/6/17 must mean exactly the same day as 13/06/2017.
	for _, in := range []string{"13/6/17", "13-6-17", `13\6\17`, "13/06/17", "13.6.17"} {
		got, err := parseFlexibleDate(in, calEthiopian)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if got.Format("2006-01-02") != "2025-02-20" {
			t.Errorf("%q (EC) → %s, want 2025-02-20 (same as 13/06/2017)", in, got.Format("2006-01-02"))
		}
	}

	// Pagumē (13th month) exists only in the Ethiopian calendar.
	if got, err := parseFlexibleDate("05/13/2015", calEthiopian); err != nil || got.Format("2006-01-02") != "2023-09-10" {
		t.Errorf("Pagumē 5 2015 EC → %v (%v), want 2023-09-10", got.Format("2006-01-02"), err)
	}
	// Ethiopian months have 30 days and Pagumē at most 6 — reject the impossible.
	for _, bad := range []string{"31/06/2017", "07/13/2016", "13/14/2017"} {
		if _, err := parseFlexibleDate(bad, calEthiopian); err == nil {
			t.Errorf("%q should be rejected as an Ethiopian date", bad)
		}
	}
	// The age is read as at the visit, so the birth year follows the CONVERTED date.
	p, reason := validateRow(patient.ImportRow{Name: "Abebe Kebede", Age: "30", VisitDate: "13/06/2017"}, calEthiopian)
	if reason != "" {
		t.Fatalf("unexpected rejection: %s", reason)
	}
	if p.firstVisit.Format("2006-01-02") != "2025-02-20" || p.dob.Year() != 1995 {
		t.Errorf("visit %s / birth year %d, want 2025-02-20 / 1995", p.firstVisit.Format("2006-01-02"), p.dob.Year())
	}
}

func TestNormalizePhone(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"0911 22 33 44", "0911223344"},
		{"+251911223344", "0911223344"},
		{"251911223344", "0911223344"},
		{"911223344", "0911223344"},
		{"(091) 122-3344", "0911223344"},
		{"", ""},
		{"+1 415 555 2671", "+14155552671"},
	} {
		got, err := normalizePhone(tc.in)
		if err != nil {
			t.Fatalf("%q: %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("%q → %q, want %q", tc.in, got, tc.want)
		}
	}
	for _, bad := range []string{"ABC123", "12345"} {
		if _, err := normalizePhone(bad); err == nil {
			t.Errorf("%q should have been rejected", bad)
		}
	}
}

func TestNormalizeGender(t *testing.T) {
	for _, tc := range []struct {
		in, want string
		ok       bool
	}{
		{"Male", "male", true}, {"M", "male", true}, {"male", "male", true},
		{"Female", "female", true}, {"F", "female", true}, {"female", "female", true},
		{" f ", "female", true},
		{"", "unknown", false},
		{"banana", "", false},
	} {
		got, ok := normalizeGender(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("%q → (%q,%v), want (%q,%v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestSplitFullName(t *testing.T) {
	for _, tc := range []struct{ in, f, m, l string }{
		{"abebe kebede", "Abebe", "", "Kebede"},
		{"ABEBE KEBEDE TESFAYE", "Abebe", "Kebede", "Tesfaye"},
		{"  yohannes   ", "Yohannes", "", ""},
		{"mary-jane o'brien", "Mary-Jane", "", "O'Brien"},
	} {
		f, m, l := splitFullName(tc.in)
		if f != tc.f || m != tc.m || l != tc.l {
			t.Errorf("%q → (%q,%q,%q), want (%q,%q,%q)", tc.in, f, m, l, tc.f, tc.m, tc.l)
		}
	}
}

func TestValidateRow(t *testing.T) {
	// Age is taken as at the visit, so the birth year comes off the visit date.
	p, reason := validateRow(patient.ImportRow{Name: "Abebe Kebede", Phone: "0911223344", Gender: "M", Age: "30", VisitDate: "13/06/2017"}, calGregorian)
	if reason != "" {
		t.Fatalf("unexpected rejection: %s", reason)
	}
	if p.dob.Year() != 1987 {
		t.Errorf("birth year %d, want 1987 (30y at the 2017 visit)", p.dob.Year())
	}
	if !p.dobEstimated {
		t.Error("a birthdate derived from an age must be flagged estimated")
	}
	if p.gender != "male" || p.phone != "0911223344" || p.last != "Kebede" {
		t.Errorf("unexpected normalisation: %+v", p)
	}

	// Missing / invalid values must be reported, not guessed at.
	for _, tc := range []struct{ row patient.ImportRow; want string }{
		{patient.ImportRow{Name: "", Age: "30"}, "Missing patient name"},
		{patient.ImportRow{Name: "A B", Age: "30", Phone: "ABC123"}, "Invalid phone number format"},
		{patient.ImportRow{Name: "A B", Age: "30", Gender: "banana"}, `Invalid gender value "banana"`},
		{patient.ImportRow{Name: "A B", Age: "abc"}, `Invalid age "abc"`},
		{patient.ImportRow{Name: "A B", Age: ""}, "Missing age (a birth year is required to create a patient)"},
		{patient.ImportRow{Name: "A B", Age: "30", VisitDate: "not a date"}, "Invalid date format in Date of Visit"},
	} {
		if _, got := validateRow(tc.row, calGregorian); got != tc.want {
			t.Errorf("row %+v → %q, want %q", tc.row, got, tc.want)
		}
	}

	// A missing gender is a warning, not a failure.
	if p, reason := validateRow(patient.ImportRow{Name: "A B", Age: "5"}, calGregorian); reason != "" || p.gender != "unknown" {
		t.Errorf("blank gender should import as unknown, got %q / %v", reason, p)
	}
}
