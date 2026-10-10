// Package scheduling defines the public contracts of the scheduling module:
// appointments (free booking with conflict prevention) and the live department
// queue.
package scheduling

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// BookInput books an appointment (free model: start + duration). When IsFollowup
// is set the appointment is a covered follow-up: FreeUntil bounds the free window,
// OrderedBy records the doctor who ordered it (defaults to the actor), and
// OriginEncounterID links it back to the visit that spawned it.
type BookInput struct {
	BranchID          uuid.UUID
	PatientID         uuid.UUID
	ProviderID        uuid.UUID
	DepartmentID      *uuid.UUID
	ResourceID        *uuid.UUID
	StartsAt          time.Time
	DurationMin       int
	Reason            string
	IsFollowup        bool
	FreeUntil         *time.Time
	OrderedBy         *uuid.UUID
	OriginEncounterID *uuid.UUID
}

// RescheduleInput changes an appointment's time/provider/resource.
type RescheduleInput struct {
	StartsAt     time.Time
	DurationMin  int
	ProviderID   uuid.UUID
	DepartmentID *uuid.UUID
	ResourceID   *uuid.UUID
	Reason       string
}

// Appointment is an enriched calendar row.
type Appointment struct {
	ID                uuid.UUID  `json:"-"`
	PatientID         uuid.UUID  `json:"-"`
	ProviderID        uuid.UUID  `json:"-"`
	DepartmentID      *uuid.UUID `json:"-"`
	ResourceID        *uuid.UUID `json:"-"`
	OrderedBy         *uuid.UUID `json:"-"`
	OriginEncounterID *uuid.UUID `json:"-"`
	StartsAt          time.Time  `json:"starts_at"`
	EndsAt            time.Time  `json:"ends_at"`
	Status            string     `json:"status"`
	Reason            string     `json:"reason,omitempty"`
	IsFollowup        bool       `json:"is_followup"`
	FreeUntil         *time.Time `json:"free_until,omitempty"`
	PatientName       string     `json:"patient_name"`
	MRN               string     `json:"mrn"`
	ProviderName      string     `json:"provider_name"`
	ProviderActive    bool       `json:"provider_active"`
	OrderedByName     string     `json:"ordered_by_name,omitempty"`
	DepartmentName    string     `json:"department_name,omitempty"`
}

// QueueEntry is a row on the department queue board.
type QueueEntry struct {
	ID                 uuid.UUID  `json:"-"`
	PatientID          uuid.UUID  `json:"-"`
	AppointmentID      *uuid.UUID `json:"-"`
	AssignedProviderID *uuid.UUID `json:"-"`
	State              string     `json:"state"`
	Stage              string     `json:"stage"`
	Priority           int        `json:"priority"`
	EnqueuedAt         time.Time  `json:"enqueued_at"`
	CalledAt           *time.Time `json:"called_at,omitempty"`
	StartedAt          *time.Time `json:"started_at,omitempty"`
	EndedAt            *time.Time `json:"ended_at,omitempty"`
	PatientName        string     `json:"patient_name"`
	MRN                string     `json:"mrn"`
	ProviderName       string     `json:"provider_name,omitempty"`
	HasVitals          bool       `json:"has_vitals"`
	InLab              bool       `json:"in_lab"`
}

// WorklistEntry is a patient on a doctor's personal worklist.
type WorklistEntry struct {
	ID             uuid.UUID  `json:"-"`
	PatientID      uuid.UUID  `json:"-"`
	DepartmentID   uuid.UUID  `json:"-"`
	State          string     `json:"state"`
	Stage          string     `json:"stage"`
	Priority       int        `json:"priority"`
	EnqueuedAt     time.Time  `json:"enqueued_at"`
	CalledAt       *time.Time `json:"called_at,omitempty"`
	StartedAt      *time.Time `json:"started_at,omitempty"`
	PatientName    string     `json:"patient_name"`
	MRN            string     `json:"mrn"`
	DepartmentName string     `json:"department_name,omitempty"`
}

// WalkInInput enqueues a patient without a prior appointment.
type WalkInInput struct {
	BranchID     uuid.UUID
	DepartmentID uuid.UUID
	PatientID    uuid.UUID
	Priority     int
	ToTriage     bool
	ProviderID   *uuid.UUID
	// SelectChargeIDs are earlier unpaid bills the patient agreed to pay now. They hold
	// the patient at the cashier, like the intake fee, and the patient goes to ProviderID
	// once they are cleared.
	SelectChargeIDs []uuid.UUID
}

// ArrivalResult says what receiving a patient did, at either door: an appointment
// checked in, or a walk-in enqueued. ChargeIDs are the intake charges it raised —
// none for a covered follow-up — so the desk can collect exactly this visit and
// nothing else the patient happens to owe.
//
// The walk-in door reported only Gated for a while, so reception had no ids to scope
// a collect to and simply skipped the walk-in whenever there was a fee. A searched
// patient who owed the registration fee was then neither charged nor queued: the desk
// pressed Collect, the mutation did nothing, and the patient never reached the
// cashier. Both doors report the same thing now.
type ArrivalResult struct {
	Gated     bool
	ChargeIDs []uuid.UUID
}

// CheckInInput controls how an appointment patient is routed on check-in.
type CheckInInput struct {
	Priority   int
	ToTriage   bool
	ProviderID *uuid.UUID
	// DepartmentID rescues an appointment booked before a department was required.
	// Used ONLY when the appointment has none — it can never reroute a patient away
	// from the department they were actually booked into.
	DepartmentID *uuid.UUID
	// SelectChargeIDs: see WalkInInput.
	SelectChargeIDs []uuid.UUID
}

// Service is the scheduling module API.
type Service interface {
	Book(ctx context.Context, in BookInput) (*Appointment, error)
	List(ctx context.Context, branchID uuid.UUID, from, to time.Time, providerID *uuid.UUID) ([]Appointment, error)
	// ListFollowups returns follow-up appointments in [from, to) for the lens
	// (due / upcoming / overdue / needs-handoff).
	ListFollowups(ctx context.Context, branchID uuid.UUID, from, to time.Time) ([]Appointment, error)
	// ListForPatient returns one patient's appointments across a date range — their
	// own schedule rather than a day on the clinic calendar.
	ListForPatient(ctx context.Context, patientID uuid.UUID, from, to time.Time) ([]Appointment, error)
	Reschedule(ctx context.Context, id uuid.UUID, in RescheduleInput) (*Appointment, error)
	SetStatus(ctx context.Context, id uuid.UUID, status, cancelReason string) error
	MarkFollowup(ctx context.Context, id uuid.UUID, freeUntil time.Time) error
	// ReassignProvider hands a follow-up to a covering doctor (changes who attends;
	// leaves ordered_by intact). A time conflict is rejected.
	ReassignProvider(ctx context.Context, id, providerID uuid.UUID, note string) error
	// CheckIn / EnqueueWalkIn return gated=true when an intake charge was raised and
	// the patient must pay before entering the queue (vs. enqueued immediately when free).
	CheckIn(ctx context.Context, id uuid.UUID, in CheckInInput) (*ArrivalResult, error)
	EnqueueWalkIn(ctx context.Context, in WalkInInput) (*ArrivalResult, error)

	ListQueue(ctx context.Context, departmentID uuid.UUID, stage string, from time.Time, until *time.Time) ([]QueueEntry, error)
	ListWorklist(ctx context.Context, providerID uuid.UUID, from time.Time, until *time.Time) ([]WorklistEntry, error)
	// ListUnassigned returns patients past triage but not yet assigned to any
	// doctor — the pick-up pool for a doctor's My day.
	ListUnassigned(ctx context.Context, from time.Time, until *time.Time) ([]WorklistEntry, error)
	AssignProvider(ctx context.Context, id, providerID uuid.UUID) error
	TransitionQueue(ctx context.Context, id uuid.UUID, state string) error
	SetQueuePriority(ctx context.Context, id uuid.UUID, priority int) error

	// ReceptionToday is the front desk's whole screen in one request.
	ReceptionToday(ctx context.Context) (*ReceptionToday, error)
	// ReceptionCard is everything the desk needs to know about one patient standing in
	// front of it: today's booking and session, missed visits, the next visit and the
	// itemised unpaid bills.
	ReceptionCard(ctx context.Context, patientID uuid.UUID) (*ReceptionCard, error)
}

// --- reception: the clinic's front door ---------------------------------------
//
// Reception's question is not "which appointment record exists" but "who is in front
// of me, and what do I need to know before I send them in". These rows carry the
// three facts the desk could not previously see: how late someone is, what they owe,
// and whether this particular visit is already paid for by a covered follow-up.

// ReceptionPatient is one person on the reception list.
type ReceptionPatient struct {
	PatientID string `json:"patient_id"`
	Name      string `json:"name"`
	MRN       string `json:"mrn"`
	Age       int    `json:"age"`
	Sex       string `json:"sex,omitempty"`
	Phone     string `json:"phone,omitempty"`

	// The booking, when there is one. A walk-in already in the queue has none.
	AppointmentID  string `json:"appointment_id,omitempty"`
	StartsAt       string `json:"starts_at,omitempty"`
	ProviderID     string `json:"provider_id,omitempty"`
	ProviderName   string `json:"provider_name,omitempty"`
	DepartmentID   string `json:"department_id,omitempty"`
	DepartmentName string `json:"department_name,omitempty"`
	Reason         string `json:"reason,omitempty"`
	IsFollowup     bool   `json:"is_followup"`
	// FreeUntil is the coverage window on a doctor-booked follow-up. Past it, the
	// visit is chargeable again — which is why the date is shown, not just the fact.
	FreeUntil string `json:"free_until,omitempty"`
	// LateMinutes is how far past the slot we are. Negative means not due yet.
	LateMinutes int `json:"late_minutes"`

	// Money already raised and unpaid, whatever visit it came from. The same
	// definition Finance uses for "Owed to you": charges sitting at status 'pending'.
	Owed           string `json:"owed,omitempty"`
	OwedOldestDays int    `json:"owed_oldest_days,omitempty"`
	// OwedAgreed is true when every pending charge was deliberately deferred —
	// treat-now-pay-later — rather than simply never collected.
	OwedAgreed bool `json:"owed_agreed,omitempty"`
	// Unbilled is dental treatment given (or a down payment agreed) that nobody has
	// sent to the cashier yet — not part of Owed, because "Take payment" settles
	// only what is at the cashier. Without it the desk saw a patient who owed
	// nothing walk out with treatment unbilled (audit D10). Same predicate as the
	// dental Unbilled report, on the shared dental.SessionMoneySQL.
	Unbilled string `json:"unbilled,omitempty"`

	// Where they are once received.
	Stage        string `json:"stage,omitempty"` // triage | with_doctor
	WaitingSince string `json:"waiting_since,omitempty"`
	// Finished is true once the visit is closed. Reception needs the difference:
	// somebody still in the queue must not be received twice, but somebody the
	// doctor has finished with may genuinely need sending back — and telling the
	// desk they are "waiting since 08:09" when they left an hour ago is a lie the
	// screen has no business telling.
	Finished bool `json:"finished,omitempty"`
}

// ReceptionToday is the whole front desk in one request.
type ReceptionToday struct {
	// Expected: booked today and not yet arrived, earliest slot first.
	Expected []ReceptionPatient `json:"expected"`
	// Waiting: received and in the queue, longest wait first.
	Waiting []ReceptionPatient `json:"waiting"`
	// Seen: finished today.
	Seen []ReceptionPatient `json:"seen"`
	// Recent: the last patients received on earlier days, newest first. What a desk with
	// nobody booked reaches for: returning patients are the usual walk-ins.
	Recent []ReceptionPatient `json:"recent"`
	// NextBooking: the next day with anyone booked, so an empty day can say when the
	// diary fills again.
	NextBooking *NextBooking `json:"next_booking,omitempty"`
}

// NextBooking is the first day after today that has bookings, and how many.
type NextBooking struct {
	StartsAt string `json:"starts_at"`
	Count    int    `json:"count"`
}

// ReceptionCard answers, for one patient, what the receptionist needs before deciding.
type ReceptionCard struct {
	// Today's booking, if any, and today's planned treatment session, if any.
	Appointment *CardVisit `json:"appointment,omitempty"`
	Session     *CardVisit `json:"session,omitempty"`
	// Missed: no-shows and missed treatment sessions in the last 90 days, newest first.
	Missed []CardVisit `json:"missed"`
	// Next: the next booking or planned session after today.
	Next *CardVisit `json:"next,omitempty"`
	// Bills are earlier unpaid charges, oldest first. Today's own intake fee is not
	// listed: the fee block already handles it.
	Bills         []CardBill `json:"bills"`
	OwedTotal     string     `json:"owed_total"`
	UnbilledTotal string     `json:"unbilled_total"`
	// UsualProviderID/Name is who the patient last saw — the sensible default.
	UsualProviderID   string `json:"usual_provider_id,omitempty"`
	UsualProviderName string `json:"usual_provider_name,omitempty"`
	LastVisitAt       string `json:"last_visit_at,omitempty"`
	// InQueue is true when the patient is already received today and not finished.
	InQueue bool `json:"in_queue"`
}

// CardVisit is one booking or treatment session, in the words the desk repeats.
type CardVisit struct {
	Kind           string `json:"kind"` // appointment | session
	AppointmentID  string `json:"appointment_id,omitempty"`
	When           string `json:"when"` // RFC3339 for a booking, YYYY-MM-DD for a session
	Title          string `json:"title"`
	ProviderName   string `json:"provider_name,omitempty"`
	DepartmentName string `json:"department_name,omitempty"`
	Status         string `json:"status,omitempty"`
	IsFollowup     bool   `json:"is_followup,omitempty"`
}

// CardBill is one unpaid charge the patient could pay now.
type CardBill struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Amount      string `json:"amount"`
	Source      string `json:"source"`
	CreatedAt   string `json:"created_at"`
	AgeDays     int    `json:"age_days"`
	// AtCashier: raised as a routed visit charge, already waiting at the cashier.
	AtCashier bool `json:"at_cashier"`
	// Agreed: the clinic agreed to wait (treat now, pay later), with the reason.
	Agreed     bool   `json:"agreed"`
	AgreedWhy  string `json:"agreed_why,omitempty"`
	DeskPicked bool   `json:"desk_picked"`
}
