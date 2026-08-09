// Package ethiopian converts between the Ethiopian (Ge'ez) and Gregorian
// calendars. It is a direct port of frontend/src/lib/ethiopian.ts — same epoch,
// same leap rule — so a date typed or displayed in the UI and a date stored by a
// server-side import always agree.
//
// The Ethiopian calendar has 13 months: 12 of 30 days plus Pagumē (5 days, 6 in a
// leap year). It runs ~7–8 years behind the Gregorian calendar; the new year
// (Meskerem 1) falls around 11 September. Verified anchor: Meskerem 1, 2018 EC =
// 11 Sep 2025 GC.
package ethiopian

import (
	"fmt"
	"time"
)

// epoch is the JDN of Meskerem 1, year 1 EC (Amete Mihret).
const epoch = 1724221

// Months are the Latin transliterations, index 0..12 (Pagumē is the 13th).
var Months = [13]string{
	"Meskerem", "Tikimt", "Hidar", "Tahsas", "Tir", "Yekatit",
	"Megabit", "Miyazia", "Ginbot", "Sene", "Hamle", "Nehase", "Pagumē",
}

// daysToYear counts days from the epoch to Meskerem 1 of year. The integer
// division matches the leap rule below (Go truncates and EC years are positive,
// so this agrees with the reference implementation's floor()).
func daysToYear(year int) int { return 365*(year-1) + year/4 }

func toJDN(year, month, day int) int {
	return daysToYear(year) + epoch + 30*(month-1) + day - 1
}

func jdnToGregorian(jdn int) (year, month, day int) {
	a := jdn + 32044
	b := (4*a + 3) / 146097
	c := a - (146097*b)/4
	d := (4*c + 3) / 1461
	e := c - (1461*d)/4
	m := (5*e + 2) / 153
	return 100*b + d - 4800 + m/10, m + 3 - 12*(m/10), e - (153*m+2)/5 + 1
}

// IsLeap reports whether Pagumē has 6 days in this Ethiopian year.
func IsLeap(year int) bool { return ((year%4)+4)%4 == 3 }

// DaysInMonth returns 30 for months 1–12; Pagumē (13) has 5 or 6.
func DaysInMonth(year, month int) int {
	if month == 13 {
		if IsLeap(year) {
			return 6
		}
		return 5
	}
	return 30
}

// ToGregorian converts an Ethiopian date to Gregorian midnight UTC, validating
// the Ethiopian calendar's own bounds (13 months, 30-day months, short Pagumē).
func ToGregorian(year, month, day int) (time.Time, error) {
	if month < 1 || month > 13 {
		return time.Time{}, fmt.Errorf("Ethiopian month %d is out of range (1–13)", month)
	}
	if max := DaysInMonth(year, month); day < 1 || day > max {
		return time.Time{}, fmt.Errorf("%s %d, %d EC is not a real date (that month has %d days)", Months[month-1], day, year, max)
	}
	y, m, d := jdnToGregorian(toJDN(year, month, day))
	return time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC), nil
}
