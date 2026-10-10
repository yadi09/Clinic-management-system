package service

import (
	"testing"
	"time"
)

// Given a registration day and a period, When the period is added, Then a day and a
// week are exact, and a month is the same date N months on, or that month's last
// day when the date does not exist (31 January + 1 month = 28 or 29 February).
func TestREG_KERNEL_REGFEE_PeriodArithmetic(t *testing.T) {
	d := func(s string) time.Time {
		v, err := time.ParseInLocation(dateOnly, s, addis)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, c := range []struct {
		from string
		n    int
		unit string
		want string
	}{
		{"2026-10-09", 30, "day", "2026-11-08"},
		{"2026-10-09", 1, "week", "2026-10-16"},
		{"2026-10-09", 2, "month", "2026-12-09"},
		{"2026-01-31", 1, "month", "2026-02-28"},
		{"2028-01-31", 1, "month", "2028-02-29"},
		{"2026-03-31", 1, "month", "2026-04-30"},
		{"2026-11-30", 3, "month", "2027-02-28"},
		{"2026-12-15", 12, "month", "2027-12-15"},
	} {
		if got := addRegistrationPeriod(d(c.from), c.n, c.unit).Format(dateOnly); got != c.want {
			t.Errorf("%s + %d %s = %s, want %s", c.from, c.n, c.unit, got, c.want)
		}
	}
}
