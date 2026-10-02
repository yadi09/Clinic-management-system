// Package notification is the in-app inbox behind the bell in the top bar and the
// pop-up shown at sign-in.
//
// Each notification belongs to one staff member, so reading it is personal: one
// receptionist opening it does not hide it from the owner. Notifications are
// written by producers (see the produce package) running in the worker; this
// package only lets a signed-in user read and dismiss their own.
//
// Not to be confused with kernel/notify, which is the outbound email/SMS adapter.
package notification

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Kinds of notification. Each one has a producer that writes it and a place on
// screen that opens it (see Href).
const (
	KindMissedVisit = "missed_visit"
	// KindPatientWaiting: a patient is in this doctor's queue, waiting to be seen.
	// A live kind: the screen also shows a short pop-up and can speak it.
	KindPatientWaiting = "patient_waiting"
)

// Notification is one item in a staff member's inbox.
type Notification struct {
	ID        uuid.UUID
	Kind      string
	Title     string
	Body      string
	PatientID *uuid.UUID
	SubjectID *uuid.UUID
	// Data is the same facts as fields, by kind (for a missed visit: patient,
	// card, course, visit, date). A JSON object; {} when there are none.
	Data      json.RawMessage
	CreatedAt time.Time
	ReadAt    *time.Time
}

// Page is one stretch of the inbox, newest first, plus the unread total (which
// may be larger than the page). Next is set when there is more: pass it as Before
// to continue exactly where this page ended.
type Page struct {
	Items  []Notification
	Unread int
	Next   *uuid.UUID
}

// Status filters by read state.
const (
	StatusAll    = ""
	StatusUnread = "unread"
	StatusRead   = "read"
)

// ListFilter narrows the inbox. Every field is optional.
type ListFilter struct {
	Status string // StatusAll, StatusUnread or StatusRead
	Kind   string // one kind, or "" for every kind
	// Before continues after this notification (the previous page's Next). Paging
	// by position rather than page number costs the same on the hundredth page as
	// the first, and nothing is skipped or shown twice when new ones arrive.
	Before *uuid.UUID
	Limit  int
}

// Counts is the unread total, and unread per kind, for the category filters.
type Counts struct {
	Unread int
	ByKind map[string]int
}

// Service is the inbox of the signed-in user. Every method acts on that user's
// own notifications only.
type Service interface {
	List(ctx context.Context, f ListFilter) (*Page, error)
	UnreadCount(ctx context.Context) (int, error)
	Counts(ctx context.Context) (*Counts, error)
	MarkRead(ctx context.Context, id uuid.UUID) error
	// MarkAllRead marks every unread notification read, or only those of one kind.
	MarkAllRead(ctx context.Context, kind string) (int, error)
}
