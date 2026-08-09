// Package ethiocal converts between the Gregorian and Ethiopian (Ge'ez) calendars
// and computes reporting periods. Ethiopia runs ~7–8 years behind Gregorian with
// 13 months (12 × 30 days + Pagumē). Conversion goes through the Julian Day Number;
// the epoch is Meskerem 1, Year 1 EC (JDN 1724221). Verified against known anchors
// (Meskerem 1, 2018 EC = 11 Sep 2025 GC) and a full GC↔EC round-trip.
package ethiocal

import (
	"fmt"
	"time"
)

const ethEpoch = 1724221

// Months are the Latin transliterations, index 0..12 (Pagumē is the 13th).
var Months = []string{
	"Meskerem", "Tikimt", "Hidar", "Tahsas", "Tir", "Yekatit",
	"Megabit", "Miyazia", "Ginbot", "Sene", "Hamle", "Nehase", "Pagumē",
}

// EAT is Ethiopia's timezone (UTC+3, no DST). Calendar-day boundaries are computed
// in local time so "this month" matches the wall clock in the clinic.
var EAT = time.FixedZone("EAT", 3*3600)

func gregToJDN(y, m, d int) int {
	a := (14 - m) / 12
	yy := y + 4800 - a
	mm := m + 12*a - 3
	return d + (153*mm+2)/5 + 365*yy + yy/4 - yy/100 + yy/400 - 32045
}

func daysToYear(year int) int { return 365*(year-1) + year/4 }

func jdnToEth(jdn int) (year, month, day int) {
	off := jdn - ethEpoch
	year = off/365 + 1
	for daysToYear(year) > off {
		year--
	}
	for daysToYear(year+1) <= off {
		year++
	}
	doy := off - daysToYear(year)
	return year, doy/30 + 1, doy%30 + 1
}

func ethToJDN(year, month, day int) int { return daysToYear(year) + ethEpoch + 30*(month-1) + day - 1 }

func jdnToGreg(jdn int) (year, month, day int) {
	a := jdn + 32044
	b := (4*a + 3) / 146097
	c := a - 146097*b/4
	d := (4*c + 3) / 1461
	e := c - 1461*d/4
	m := (5*e + 2) / 153
	return 100*b + d - 4800 + m/10, m + 3 - 12*(m/10), e - (153*m+2)/5 + 1
}

// ToEthiopian returns the Ethiopian date for a moment, using its calendar day in
// Ethiopian local time (EAT).
func ToEthiopian(t time.Time) (year, month, day int) {
	lt := t.In(EAT)
	return jdnToEth(gregToJDN(lt.Year(), int(lt.Month()), lt.Day()))
}

// Label formats an Ethiopian year/month as e.g. "Hamle 2018".
func Label(year, month int) string { return fmt.Sprintf("%s %d", Months[month-1], year) }

// MonthRange returns the Gregorian [start, end) that spans the Ethiopian month
// containing `now`, plus that month's label ("Hamle 2018") and its Ethiopian
// year/month. Boundaries are midnight EAT.
func MonthRange(now time.Time) (start, end time.Time, label string, ey, em int) {
	ey, em, _ = ToEthiopian(now)
	sy, sm, sd := jdnToGreg(ethToJDN(ey, em, 1))
	start = time.Date(sy, time.Month(sm), sd, 0, 0, 0, 0, EAT)
	ny, nm := ey, em+1
	if nm > 13 {
		nm, ny = 1, ey+1
	}
	ny2, nm2, nd2 := jdnToGreg(ethToJDN(ny, nm, 1))
	end = time.Date(ny2, time.Month(nm2), nd2, 0, 0, 0, 0, EAT)
	return start, end, Label(ey, em), ey, em
}
