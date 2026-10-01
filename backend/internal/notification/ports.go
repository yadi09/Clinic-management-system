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
	"time"

	"github.com/google/uuid"
)

// Kinds of notification. Each one has a producer that writes it and a place on
// screen that opens it (see Href).
const (
	KindMissedVisit = "missed_visit"
)

// Notification is one item in a staff member's inbox.
type Notification struct {
	ID        uuid.UUID
	Kind      string
	Title     string
	Body      string
	PatientID *uuid.UUID
	SubjectID *uuid.UUID
	CreatedAt time.Time
	ReadAt    *time.Time
}

// Page is the newest notifications plus the unread total, which may be larger
// than the page.
type Page struct {
	Items  []Notification
	Unread int
}

// ListFilter narrows the inbox. UnreadOnly is what the sign-in pop-up asks for.
type ListFilter struct {
	UnreadOnly bool
	Limit      int
}

// Service is the inbox of the signed-in user. Every method acts on that user's
// own notifications only.
type Service interface {
	List(ctx context.Context, f ListFilter) (*Page, error)
	UnreadCount(ctx context.Context) (int, error)
	MarkRead(ctx context.Context, id uuid.UUID) error
	MarkAllRead(ctx context.Context) (int, error)
}
