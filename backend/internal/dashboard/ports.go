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
// people trust is whichever one they saw first.
package dashboard

import "context"

// Money is the owner's half of the day. Nil for staff without finance permission —
// a receptionist should not learn the clinic's takings from a home screen.
type Money struct {
	CollectedToday     string `json:"collected_today"`
	CollectedYesterday string `json:"collected_yesterday"`
	// Owed is deliberately NOT period-bound: money owed is owed today whatever
	// window you are looking at, and scoping it hides the old debt that matters.
	Owed         string `json:"owed"`
	OwedPatients int    `json:"owed_patients"`
	OldestDays   int    `json:"oldest_days"`
	BookedAhead  string `json:"booked_ahead"`
	BookedVisits int    `json:"booked_visits"`
}

// Flow is the clinic's day as it stands right now.
type Flow struct {
	Waiting     int `json:"waiting"`      // in the queue, not yet called
	InConsult   int `json:"in_consult"`   // with a clinician now
	SeenToday   int `json:"seen_today"`   // encounters closed today
	BookedToday int `json:"booked_today"` // appointments on today's calendar
	Arrived     int `json:"arrived"`      // of those, checked in
	// Overdue is booked earlier today and still not arrived — the list the front
	// desk should be phoning, not a statistic.
	Overdue int `json:"overdue"`
}

// Alert is one thing that needs doing, with the money at stake and where to go.
type Alert struct {
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Amount string `json:"amount,omitempty"`
	Count  int    `json:"count"`
	Href   string `json:"href"`
	// Tone drives how loudly it is drawn: money already lost reads differently from
	// a shelf that needs restocking.
	Tone string `json:"tone"` // danger | warn | info
}

// DayPoint is one day of collections, for the trend strip.
type DayPoint struct {
	Date   string `json:"date"`
	Amount string `json:"amount"`
}

// Today is the whole payload. Sections a caller may not see are simply absent, so
// the client renders what it is given rather than deciding what to hide.
type Today struct {
	Money     *Money     `json:"money,omitempty"`
	Flow      *Flow      `json:"flow,omitempty"`
	Series    []DayPoint `json:"series,omitempty"`
	Attention []Alert    `json:"attention"`
	// Greeting context the header already needs, so the page makes one request.
	ClinicName string `json:"clinic_name,omitempty"`
	Patients   int    `json:"patients"`
}

type Service interface {
	Today(ctx context.Context) (*Today, error)
}
