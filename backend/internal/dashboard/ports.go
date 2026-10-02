// Package dashboard answers the question the home screen should have been answering
// all along: what is happening in my clinic right now, and what needs me?
//
// What it replaced was configuration trivia — how many modules are enabled, how many
// permissions your role carries, what your role is called. All true, none of it a
// reason to open the page twice.
//
// Every money figure here comes from the finance service rather than from queries of
// its own. That is deliberate: a dashboard that computes "collected today" its own way
// is a dashboard that will eventually disagree with the Finance page, and the version
// people trust is whichever one they saw first. The first version broke this rule by
// accident — its "owed" was the cashier's half of Finance's figure, so the two pages
// showed 4,500 and 9,300 for the same debt — which is why "owed" now IS Receivables.
//
// Every figure follows the caller's active branch; nil is "all branches".
package dashboard

import "context"

// Money is the owner's half of the day. Nil for staff without finance permission —
// a receptionist should not learn the clinic's takings from a home screen.
type Money struct {
	CollectedToday string `json:"collected_today"`
	// Yesterday up to this time of day, so a morning is compared with a morning.
	// Comparing 10:00 today with all of yesterday read as a drop every single day.
	CollectedYesterdayByNow string `json:"collected_yesterday_by_now"`
	CollectedYesterday      string `json:"collected_yesterday"`
	Last7                   string `json:"last_7"`
	Prev7                   string `json:"prev_7"`
	// Fourteen days of collections, oldest first, for the tiles' trend lines.
	Series []DayPoint `json:"series"`

	// Owed is Finance's Receivables total: charges at the cashier plus treatment
	// delivered and never billed. Not period-bound — debt is owed today whatever
	// window anyone is looking at.
	Owed          string   `json:"owed"`
	OwedAtCashier string   `json:"owed_at_cashier"`
	OwedUnbilled  string   `json:"owed_unbilled"`
	OwedPatients  int      `json:"owed_patients"`
	OldestDays    int      `json:"oldest_days"`
	Aging         []Bucket `json:"aging"`
	// The patients to chase first, in Receivables' order (oldest debt first).
	TopOwers []Ower `json:"top_owers"`

	// Dental only: visits booked from today on that nobody has been charged for.
	BookedAhead  string `json:"booked_ahead"`
	BookedVisits int    `json:"booked_visits"`
}

type Bucket struct {
	Key    string `json:"key"` // 0-30 | 31-60 | 61-90 | 90+
	Label  string `json:"label"`
	Amount string `json:"amount"`
	Count  int    `json:"count"`
}

type Ower struct {
	PatientID  string `json:"patient_id"`
	Name       string `json:"name"`
	Owed       string `json:"owed"`
	OldestDays int    `json:"oldest_days"`
	Why        string `json:"why"`
}

// Flow is the clinic's day as it stands right now, counted in patients.
type Flow struct {
	// Booked is patients expected today: appointments, plus dental treatment visits,
	// which are booked inside the treatment and never reached the appointments book.
	// Missing them is how "booked today: 0" sat beside two patients in the chair.
	Booked  int `json:"booked"`
	WalkIns int `json:"walk_ins"` // arrived today with nothing booked
	Waiting int `json:"waiting"`  // in the queue, not yet called
	InChair int `json:"in_chair"` // called or with a clinician now
	// Done is patients whose visit finished today. It used to count closed doctor's
	// notes, which a dental check-out never produces, so it read 0 all day.
	Done   int `json:"done"`
	ToCome int `json:"to_come"` // booked, not arrived yet
	Late   int `json:"late"`    // of those, past their appointment time
	// Minutes. LongestWait is the person waiting longest right now; the averages are
	// over today's finished waits and visits. Zero when there is nothing to average.
	LongestWait  int    `json:"longest_wait"`
	AvgWait      int    `json:"avg_wait"`
	AvgVisit     int    `json:"avg_visit"`
	FirstArrival string `json:"first_arrival,omitempty"` // RFC3339
	// Patients booked today and not here yet, the earliest first.
	Upcoming []Upcoming `json:"upcoming"`
}

type Upcoming struct {
	PatientID string `json:"patient_id"`
	Name      string `json:"name"`
	What      string `json:"what"`
	Provider  string `json:"provider,omitempty"`
	StartsAt  string `json:"starts_at,omitempty"` // appointments only; treatment visits have a day, not a time
	LateMin   int    `json:"late_min,omitempty"`
}

// Alert is one thing that needs doing, with the money at stake and where to go.
type Alert struct {
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Detail string `json:"detail,omitempty"`
	Amount string `json:"amount,omitempty"`
	Count  int    `json:"count"`
	Href   string `json:"href"`
	// Action is the button's words: what the page behind Href lets you do.
	Action string `json:"action"`
	// PatientID when the alert is about one person, so their name can open them.
	PatientID string `json:"patient_id,omitempty"`
	// Tone drives how loudly it is drawn: money already lost reads differently from
	// a shelf that needs restocking.
	Tone string `json:"tone"` // danger | warn | info
}

// DayPoint is one day of collections.
type DayPoint struct {
	Date   string `json:"date"`
	Amount string `json:"amount"`
	Count  int    `json:"count"`
}

// WeekDay is one day of the week ahead.
type WeekDay struct {
	Date   string `json:"date"`
	Visits int    `json:"visits"`
	Amount string `json:"amount"`
}

// Today is the home screen's payload. Sections a caller may not see are simply
// absent, so the client renders what it is given rather than deciding what to hide.
type Today struct {
	// The clinic's own day and hour, so the greeting and date are Addis's, not the
	// browser's.
	Date string `json:"date"`
	Hour int    `json:"hour"`

	Money     *Money    `json:"money,omitempty"`
	Flow      *Flow     `json:"flow,omitempty"`
	Week      []WeekDay `json:"week,omitempty"`
	Attention []Alert   `json:"attention"`

	ClinicName string `json:"clinic_name,omitempty"`
	BranchName string `json:"branch_name,omitempty"` // empty means all branches
	Patients   int    `json:"patients"`
}

// Line is one slice of a breakdown.
type Line struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Amount string `json:"amount"`
	Count  int    `json:"count"`
}

// Takings is the money chart: one range, with the window before it to compare.
// Its own request, so the home screen's first answer is not held up by a chart.
type Takings struct {
	Days     int        `json:"days"`
	Total    string     `json:"total"`
	Prev     string     `json:"prev"`
	Series   []DayPoint `json:"series"`
	BySource []Line     `json:"by_source"`
	ByMethod []Line     `json:"by_method"`
}

type Service interface {
	Today(ctx context.Context) (*Today, error)
	// Takings is nil, not an error, for a caller who may not see money.
	Takings(ctx context.Context, days int) (*Takings, error)
}
