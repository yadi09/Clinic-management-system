// Package crm is the vendor's own sales pipeline: the clinics ClinicOS wants as
// customers, the campaigns used to win them, and every call and visit along the way.
//
// It sits beside platform rather than inside any tenant. None of this is clinic data
// — it is the business's own — so it runs on the privileged connection above the
// tenant boundary, and the tables are explicitly revoked from the tenant role.
package crm

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Phase is one step of a campaign. Order is everything: a prospect is always at
// exactly one, and "done" means the next one.
type Phase struct {
	ID     uuid.UUID `json:"-"`
	Seq    int       `json:"seq"`
	Name   string    `json:"name"`
	Intent string    `json:"intent,omitempty"`
	// How many prospects are sitting on this step right now.
	Waiting int `json:"waiting"`
}

type Campaign struct {
	ID       uuid.UUID `json:"-"`
	Name     string    `json:"name"`
	Goal     string    `json:"goal,omitempty"`
	IsActive bool      `json:"is_active"`
	Phases   []Phase   `json:"phases"`
	// Live counts, so a campaign reads as a pipeline rather than a definition.
	Active   int       `json:"active"`
	SignedUp int       `json:"signed_up"`
	Created  time.Time `json:"created_at"`
}

type CampaignInput struct {
	Name   string
	Goal   string
	Phases []PhaseInput
}

type PhaseInput struct {
	ID     string // existing phase (opaque id), empty for a new one
	Name   string
	Intent string
}

// Prospect is a clinic being courted, with everything a rep needs in the street.
type Prospect struct {
	ID          uuid.UUID `json:"-"`
	ClinicName  string    `json:"clinic_name"`
	ContactName string    `json:"contact_name,omitempty"`
	ContactRole string    `json:"contact_role,omitempty"`
	Phone       string    `json:"phone,omitempty"`
	PhoneAlt    string    `json:"phone_alt,omitempty"`
	Email       string    `json:"email,omitempty"`
	Address     string    `json:"address,omitempty"`
	MapURL      string    `json:"map_url,omitempty"`
	Note        string    `json:"note,omitempty"`
	Source      string    `json:"source"`
	Status      string    `json:"status"`
	Priority    string    `json:"priority"`
	// What the rep decided to do next, and the day it is due. A pipeline without
	// these is a list of names; with them it is a day's work.
	NextAction   string  `json:"next_action,omitempty"`
	NextActionAt *string `json:"next_action_at,omitempty"`
	// Why this clinic is on the worklist, filled only by Worklist().
	Reason string `json:"reason,omitempty"`
	// Days since anyone touched it; -1 when nobody ever has.
	SilentDays  int     `json:"silent_days"`
	ReadyOn     *string `json:"ready_on,omitempty"`
	OutcomeNote string  `json:"outcome_note,omitempty"`

	OwnerID   *uuid.UUID `json:"-"`
	OwnerName string     `json:"owner_name,omitempty"`

	// Where they are, when there is a live campaign.
	EnrollmentID *uuid.UUID `json:"-"`
	CampaignID   *uuid.UUID `json:"-"`
	CampaignName string     `json:"campaign_name,omitempty"`
	PhaseID      *uuid.UUID `json:"-"`
	PhaseName    string     `json:"phase_name,omitempty"`
	PhaseSeq     int        `json:"phase_seq,omitempty"`
	PhaseCount   int        `json:"phase_count,omitempty"`

	// The last time anybody touched this clinic, and how. The whole reason the
	// pipeline is shared: nobody should phone a clinic a colleague called yesterday.
	LastTouchAt   *time.Time `json:"last_touch_at,omitempty"`
	LastTouchKind string     `json:"last_touch_kind,omitempty"`
	LastTouchBy   string     `json:"last_touch_by,omitempty"`
	Touches       int        `json:"touches"`

	CreatedAt time.Time `json:"created_at"`
}

type ProspectInput struct {
	ClinicName  string
	ContactName string
	ContactRole string
	Phone       string
	PhoneAlt    string
	Email       string
	Address     string
	MapURL      string
	Note        string
	Source      string
	Priority    string
	OwnerID     *uuid.UUID
	CampaignID  *uuid.UUID // enrol straight away, at phase 1
}

// Duplicate is an existing prospect that looks like the one being added. Reps work
// the same streets; the same clinic gets collected twice unless someone says so.
type Duplicate struct {
	ID         uuid.UUID `json:"-"`
	ClinicName string    `json:"clinic_name"`
	Phone      string    `json:"phone,omitempty"`
	OwnerName  string    `json:"owner_name,omitempty"`
	Status     string    `json:"status"`
	Why        string    `json:"why"`
}

// Touch is one contact: a call, a visit, a message, or a note to self.
type Touch struct {
	ID         uuid.UUID `json:"-"`
	Kind       string    `json:"kind"`
	Note       string    `json:"note,omitempty"`
	HappenedAt time.Time `json:"happened_at"`
	ByName     string    `json:"by_name,omitempty"`
}

// Step is one completed phase, for the prospect's history.
type Step struct {
	PhaseName string    `json:"phase_name"`
	Seq       int       `json:"seq"`
	Note      string    `json:"note,omitempty"`
	DoneBy    string    `json:"done_by,omitempty"`
	DoneAt    time.Time `json:"done_at"`
}

// Outcome closes a prospect out: they signed, they are not ready, or it is a no.
type Outcome struct {
	Status  string // signed_up | not_yet | not_interested
	ReadyOn string // YYYY-MM-DD, required for not_yet
	Note    string
}

// Filter narrows the prospect list. Every field is optional; empty means "any".
type Filter struct {
	Q        string
	Status   string
	Owner    string
	Priority string
	// Flag is a question rather than a column: never (nobody has made contact),
	// overdue (the next step's day has passed), due (it is today), chase (they said
	// come back and that day has come), silent (a fortnight with no contact).
	Flag string
}

// Rep is a marketing account, for assignment and for the admin's staff list.
type Rep struct {
	ID       uuid.UUID `json:"-"`
	Email    string    `json:"email"`
	FullName string    `json:"full_name"`
	Role     string    `json:"role"`
	Status   string    `json:"status"`
	// What they are carrying right now.
	Open     int `json:"open"`
	SignedUp int `json:"signed_up"`
}

// Board is the pipeline for one campaign: its phases, each with the prospects on it.
type Board struct {
	Campaign Campaign   `json:"campaign"`
	Columns  []BoardCol `json:"columns"`
}

type BoardCol struct {
	Phase     Phase      `json:"phase"`
	Prospects []Prospect `json:"prospects"`
}

// Service is the CRM API.
type Service interface {
	ListCampaigns(ctx context.Context) ([]Campaign, error)
	CreateCampaign(ctx context.Context, in CampaignInput) (*Campaign, error)
	UpdateCampaign(ctx context.Context, id uuid.UUID, in CampaignInput) error
	SetCampaignActive(ctx context.Context, id uuid.UUID, active bool) error
	GetBoard(ctx context.Context, campaignID uuid.UUID) (*Board, error)

	ListProspects(ctx context.Context, f Filter) ([]Prospect, error)
	// Worklist is one rep's day: what is overdue, due, promised or going cold.
	Worklist(ctx context.Context, owner string) ([]Prospect, error)
	SetPriority(ctx context.Context, id uuid.UUID, priority string) error
	SetNextAction(ctx context.Context, id uuid.UUID, note, on string) error
	GetProspect(ctx context.Context, id uuid.UUID) (*Prospect, []Touch, []Step, error)
	CheckDuplicates(ctx context.Context, name, phone string) ([]Duplicate, error)
	CreateProspect(ctx context.Context, in ProspectInput) (*Prospect, error)
	UpdateProspect(ctx context.Context, id uuid.UUID, in ProspectInput) error
	Assign(ctx context.Context, id uuid.UUID, ownerID *uuid.UUID) error

	Enrol(ctx context.Context, prospectID, campaignID uuid.UUID) error
	CompletePhase(ctx context.Context, prospectID uuid.UUID, note string) (*Prospect, error)
	SetOutcome(ctx context.Context, prospectID uuid.UUID, out Outcome) error
	Reopen(ctx context.Context, prospectID uuid.UUID) error

	LogTouch(ctx context.Context, prospectID uuid.UUID, kind, note, happenedAt string) error

	ListReps(ctx context.Context) ([]Rep, error)
	CreateRep(ctx context.Context, email, fullName, role, password string) (*Rep, error)
	SetRepStatus(ctx context.Context, id uuid.UUID, status string) error

	// ImportInbound pulls website enquiries that are not yet in the pipeline.
	ImportInbound(ctx context.Context, campaignID *uuid.UUID) (int, error)
}
