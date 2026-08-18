// Package messaging is the clinic's voice between visits.
//
// Everything a clinic wants to tell a patient when they are not in the building —
// their card number on the day they register, tomorrow's appointment, a bill that
// has gone quiet, a New Year greeting — arrives the same way and is recorded the
// same way. The module owns three things: what the clinic says (templates), when
// it says it (rules), and what it actually said (the log).
//
// The log is the part that earns its keep. Reception is asked "did you tell me?"
// constantly, and until now the only answer was somebody's memory.
package messaging

import (
	"context"

	"github.com/google/uuid"
)

// Kinds of message. 'custom' is written per send and has no stored template.
const (
	KindWelcome     = "welcome"
	KindAppointment = "appointment_reminder"
	KindBill        = "bill_reminder"
	KindCustom      = "custom"
)

// Settings is how this clinic sends: whether at all, in which language, under
// what name, and during which hours.
type Settings struct {
	Enabled    bool   `json:"enabled"`
	Lang       string `json:"lang"` // en | am
	QuietFrom  string `json:"quiet_from"`
	QuietTo    string `json:"quiet_to"`
	SenderName string `json:"sender_name"`
	// The clinic's own campaign. SenderID is the Ethio-Telecom-approved name a
	// patient's handset displays; until it is approved the clinic's name has to
	// travel inside the body instead, costing characters on every message.
	SenderID     string `json:"sender_id,omitempty"`
	SenderStatus string `json:"sender_status"` // none | pending | approved | rejected
	// HasOwnKey says a key is stored, never what it is. A credential that can spend
	// money does not get handed back out to a browser.
	HasOwnKey bool `json:"has_own_key"`
	// BodyPrefix is what will actually lead each message — empty once the handset
	// shows the clinic's own name.
	BodyPrefix string `json:"body_prefix"`
	// Gateway describes the platform's delivery capability, not the clinic's
	// choice. A clinic can have messaging switched on while the platform has no
	// key configured, and the UI has to be able to say exactly that rather than
	// letting staff believe patients are being contacted.
	GatewayLive bool   `json:"gateway_live"`
	GatewayName string `json:"gateway_name"`
	// CostPerSegment prices a send before it happens.
	CostPerSegment float64 `json:"cost_per_segment"`
}

// SettingsInput is the editable half of Settings.
type SettingsInput struct {
	Enabled      bool
	Lang         string
	QuietFrom    string
	QuietTo      string
	SenderName   string
	SenderID     string
	SenderStatus string
	// APIKey is the clinic's own gateway key. Empty leaves whatever is stored
	// alone — a settings save must not wipe a credential just because the form did
	// not echo it back. ClearAPIKey is the explicit way to remove one.
	APIKey      string
	ClearAPIKey bool
}

// Usage is this month's spend against the plan's allowance.
//
// Counted in segments, because that is what the gateway bills: one Amharic
// greeting can be three of them, and a clinic watching a message count would
// think it had three times the room it really has.
type Usage struct {
	UsedSegments int64  `json:"used_segments"`
	Limit        *int64 `json:"limit,omitempty"` // nil = unlimited
	Sent         int64  `json:"sent"`
	Failed       int64  `json:"failed"`
	Skipped      int64  `json:"skipped"`
	Cost         string `json:"cost"`
}

// Preview is what a body will look like and cost before anyone commits to it.
type Preview struct {
	Body     string `json:"body"`
	Segments int    `json:"segments"`
	Unicode  bool   `json:"unicode"`
	Chars    int    `json:"chars"`
	// PerSegment is the character budget in force — 160 for plain Latin, 70 once
	// any Amharic appears. Shown so the number does not look arbitrary.
	PerSegment int    `json:"per_segment"`
	Cost       string `json:"cost"`
}

// LogRow is one line of "what we sent, to whom, and what happened".
type LogRow struct {
	ID         uuid.UUID `json:"-"`
	Kind       string    `json:"kind"`
	Lang       string    `json:"lang"`
	MSISDN     string    `json:"msisdn"`
	Body       string    `json:"body"`
	Segments   int       `json:"segments"`
	Cost       string    `json:"cost"`
	Status     string    `json:"status"`
	SkipReason string    `json:"skip_reason,omitempty"`
	// DeliveredAt is set only when the handset confirmed it. "Sent" and "delivered"
	// are different facts and the UI must not blur them.
	DeliveredAt string     `json:"delivered_at,omitempty"`
	LastError   string     `json:"last_error,omitempty"`
	ScheduledAt string     `json:"scheduled_for"`
	SentAt      string     `json:"sent_at,omitempty"`
	PatientID   *uuid.UUID `json:"-"`
	PatientName string     `json:"patient_name,omitempty"`
	MRN         string     `json:"mrn,omitempty"`
	CreatedAt   string     `json:"created_at"`
}

// LogFilter narrows the log. Empty fields mean "everything".
type LogFilter struct {
	Kind      string
	Status    string
	PatientID *uuid.UUID
	Limit     int
}

// Service is the messaging use-case surface.
type Service interface {
	GetSettings(ctx context.Context) (*Settings, error)
	SaveSettings(ctx context.Context, in SettingsInput) (*Settings, error)

	// Usage answers "how much of this month's allowance is gone".
	Usage(ctx context.Context) (*Usage, error)

	// Preview renders a body's length and price without queueing anything.
	Preview(ctx context.Context, body string) (*Preview, error)

	// Log is what was sent, newest first.
	Log(ctx context.Context, f LogFilter) ([]LogRow, error)

	// SendTest queues one message to a staff member's own phone so a clinic can
	// prove the whole path works — gateway, credentials, Amharic rendering — before
	// aiming it at 600 patients. It is charged like any other message, because it
	// is one.
	SendTest(ctx context.Context, rawPhone, body string) error
}
