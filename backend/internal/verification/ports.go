// Package verification lets whoever holds a printed paper check it against the
// clinic's own record: the QR on a prescription is a link, and what the link opens
// is the record, not a copy of it. See docs/paper-verification-plan.html.
package verification

import (
	"context"

	"github.com/google/uuid"
)

// Kinds of paper that can be verified.
const (
	KindDentalRx    = "dental_rx"    // one dental prescription
	KindEncounterRx = "encounter_rx" // the medicines of one consultation
)

// Statuses a check can answer with. Anything else is "not found", which is a 404.
const (
	StatusGenuine    = "genuine"
	StatusCancelled  = "cancelled"  // the clinic withdrew it
	StatusSuperseded = "superseded" // it was changed after this paper was printed
	StatusExpired    = "expired"    // older than the validity the clinic set
)

// Issued is what the clinic's screen needs to put on the paper.
type Issued struct {
	Token string `json:"token"`
	Slug  string `json:"slug"`
	// Path is the address the QR opens, relative to the site: /v/<slug>/<token>.
	Path string `json:"path"`
	// Code is the short code printed under the QR, for typing when a QR will not scan.
	Code string `json:"code"`
	// Ref is the reference printed on the paper, so the paper and the page agree.
	Ref string `json:"ref"`
}

// Medicine is one line of what was prescribed.
type Medicine struct {
	Name         string `json:"name"`
	Dose         string `json:"dose,omitempty"`
	Frequency    string `json:"frequency,omitempty"`
	Duration     string `json:"duration,omitempty"`
	Instructions string `json:"instructions,omitempty"`
}

// Patient is deliberately thin: enough to match the paper in the hand, nothing a
// stranger could use. No phone, no card number, no address, no diagnosis.
type Patient struct {
	Name   string `json:"name"` // "Abebe K."
	Age    int    `json:"age"`
	Gender string `json:"gender,omitempty"`
}

// Checks is how often the paper has been looked at before this look.
type Checks struct {
	Before  int     `json:"before"`
	FirstAt *string `json:"first_at,omitempty"`
	LastAt  *string `json:"last_at,omitempty"`
}

// Result is the public answer. Medicines and patient are present only while the
// paper is genuine (or past its validity); a withdrawn or replaced paper shows no
// content, so nobody dispenses from it.
type Result struct {
	Status      string     `json:"status"`
	Kind        string     `json:"kind"`
	Ref         string     `json:"ref"`
	Clinic      string     `json:"clinic"`
	Branch      string     `json:"branch,omitempty"`
	Slug        string     `json:"slug"`
	HasLogo     bool       `json:"has_logo"`
	WrittenAt   string     `json:"written_at"`
	DaysAgo     int        `json:"days_ago"`
	ValidUntil  *string    `json:"valid_until,omitempty"`
	Patient     *Patient   `json:"patient,omitempty"`
	Prescriber  string     `json:"prescriber,omitempty"`
	Medicines   []Medicine `json:"medicines,omitempty"`
	Note        string     `json:"note,omitempty"`
	DispensedAt *string    `json:"dispensed_at,omitempty"`
	Checks      Checks     `json:"checks"`
}

// Service is the contract the HTTP layer uses.
type Service interface {
	// Issue (signed in) records what is being printed and returns its token. The same
	// content always returns the same token.
	Issue(ctx context.Context, kind string, subjectID uuid.UUID) (*Issued, error)
	// Check (public) answers for a token and counts the look.
	Check(ctx context.Context, slug, token string) (*Result, error)
	// ByCode (public) answers for the short code printed under the QR.
	ByCode(ctx context.Context, slug, code string) (*Result, error)
	// Logo (public) is the clinic's logo for the check page, if it has one.
	Logo(ctx context.Context, slug string) (mime string, data []byte, err error)
}
