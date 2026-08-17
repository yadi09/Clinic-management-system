// Package finance answers the questions a clinic owner actually asks about money.
//
// The old page answered one of them — "what did we take today" — and answered it
// on a single screen with no comparison, no ageing, and no way to act on anything
// it showed. An owner asks five:
//
//	what did we take, and is that normal        -> Overview
//	who owes me, and for how long               -> Receivables
//	is the drawer what we billed                -> Cash & shifts
//	what actually earns                         -> Services
//	what is booked but not yet earned           -> Treatment book (dental)
//
// One thing this package deliberately does NOT do is say "profit". There is no
// expenses table in this system, so every figure here is revenue. Labelling
// revenue as profit is the kind of number an owner makes a hiring decision on.
package finance

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Filter is the period and branch every tab shares.
type Filter struct {
	From   time.Time
	To     time.Time
	Branch *uuid.UUID
}

// Days is the span in whole days, used to place the comparison window directly
// before the selected one ("vs previous period" means the same length, not "last
// month" — comparing 3 days against 30 flatters or damns for no reason).
func (f Filter) Days() int {
	d := int(f.To.Sub(f.From).Hours() / 24)
	if d < 1 {
		return 1
	}
	return d
}

type DayPoint struct {
	Date   string `json:"date"`
	Amount string `json:"amount"`
}

// Line is one row of a breakdown — by source, by service, by month.
type Line struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Amount string `json:"amount"`
	Count  int    `json:"count"`
}

// Alert is something on this page that a person should do something about. Each
// one carries where to go, because a number nobody can act on is decoration.
type Alert struct {
	Kind   string `json:"kind"` // shift_variance | unbilled | overdue | stalled
	Text   string `json:"text"`
	Amount string `json:"amount,omitempty"`
	Count  int    `json:"count"`
	Href   string `json:"href"`
}

type Overview struct {
	Collected      string `json:"collected"` // net of refunds, settled in the period
	CollectedCount int    `json:"collected_count"`
	CollectedPrev  string `json:"collected_prev"` // same-length window immediately before
	Refunded       string `json:"refunded"`
	Waived         string `json:"waived"`
	// Outstanding is NOT period-bound: money owed is owed today regardless of the
	// window being looked at, and scoping it to a date range hides the old debt
	// that matters most.
	Outstanding         string     `json:"outstanding"`
	OutstandingPatients int        `json:"outstanding_patients"`
	OldestDays          int        `json:"oldest_days"`
	BookedAhead         string     `json:"booked_ahead"`
	BookedVisits        int        `json:"booked_visits"`
	Series              []DayPoint `json:"series"`
	SeriesPrev          []DayPoint `json:"series_prev"`
	BySource            []Line     `json:"by_source"`
	Attention           []Alert    `json:"attention"`
}

type Bucket struct {
	Key    string `json:"key"` // 0-30 | 31-60 | 61-90 | 90+
	Label  string `json:"label"`
	Amount string `json:"amount"`
	Count  int    `json:"count"`
}

// ReceivableRow is one patient who owes money, aged by the OLDEST debt rather
// than the largest — old debt is the debt that never arrives.
type ReceivableRow struct {
	PatientID  uuid.UUID `json:"-"`
	ID         string    `json:"id"`
	MRN        string    `json:"mrn"`
	Name       string    `json:"name"`
	Phone      string    `json:"phone,omitempty"`
	Owed       string    `json:"owed"`
	OldestDays int       `json:"oldest_days"`
	Bucket     string    `json:"bucket"`
	LastPaid   string    `json:"last_paid,omitempty"`
	// Why it is owed, in the patient's terms: with the cashier now, or treatment
	// delivered that nobody has billed. They are chased differently.
	Why string `json:"why"`
}

type Receivables struct {
	Total   string          `json:"total"`
	Count   int             `json:"count"`
	Buckets []Bucket        `json:"buckets"`
	Rows    []ReceivableRow `json:"rows"`
}

// Dental is the slice of the dental module finance needs. Defined here as a port
// so the money that dental already computes is READ rather than reimplemented —
// a second copy of "what does this session owe" is a second answer to it.
type Dental interface {
	UnbilledTotal(ctx context.Context) (amount string, count int, err error)
	UnbilledByPatient(ctx context.Context) ([]UnbilledPatient, error)
	BookedAhead(ctx context.Context, branch *uuid.UUID) (amount string, visits int, err error)
}

// UnbilledPatient is treatment delivered and never billed, per patient.
type UnbilledPatient struct {
	PatientID uuid.UUID
	Amount    string
	OldestDay int
}

type Service interface {
	Overview(ctx context.Context, f Filter) (*Overview, error)
	Receivables(ctx context.Context, f Filter) (*Receivables, error)
	Cash(ctx context.Context, f Filter) (*CashView, error)
	Services(ctx context.Context, f Filter) ([]ServiceLine, error)
	Book(ctx context.Context, f Filter) (*Book, error)
}

// --- Cash & shifts -----------------------------------------------------------

type Shift struct {
	Date     string `json:"date"`
	Cashier  string `json:"cashier"`
	Expected string `json:"expected"`
	Counted  string `json:"counted"`
	Variance string `json:"variance"`
	Note     string `json:"note,omitempty"`
}

type CashView struct {
	Shifts    []Shift `json:"shifts"`
	ByMethod  []Line  `json:"by_method"`
	ByCashier []Line  `json:"by_cashier"`
	ByBranch  []Line  `json:"by_branch"`
	// Money taken today by a cashier who has not counted their drawer. Not an
	// error — the day may still be running — but the owner should see it.
	OpenDrawers []Line `json:"open_drawers"`
	Variance    string `json:"variance"`
}

// --- Services ----------------------------------------------------------------

type ServiceLine struct {
	Label   string `json:"label"`
	Source  string `json:"source"`
	Count   int    `json:"count"`
	Revenue string `json:"revenue"`
	Avg     string `json:"avg"`
}

// --- Treatment book (dental) -------------------------------------------------

type PlanAtRisk struct {
	PatientID uuid.UUID `json:"-"`
	ID        string    `json:"id"`
	Patient   string    `json:"patient"`
	MRN       string    `json:"mrn"`
	Phone     string    `json:"phone,omitempty"`
	Plan      string    `json:"plan"`
	AtRisk    string    `json:"at_risk"`
	Reason    string    `json:"reason"`
	DaysIdle  int       `json:"days_idle"`
}

type Book struct {
	Total   string       `json:"total"`
	Visits  int          `json:"visits"`
	ByMonth []Line       `json:"by_month"`
	AtRisk  []PlanAtRisk `json:"at_risk"`
}
