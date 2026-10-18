// Package portal is the patient's own page: they sign in with the card number printed
// on their patient card and see their treatment, what they have paid and owe, and
// their teeth. Everything is read from the same records the clinic works with, so the
// patient and the cashier can never be shown two different numbers.
package portal

import (
	"context"

	"github.com/reicb/clinicsaas/internal/dental"
)

// Settings is what a clinic lets its patients see.
type Settings struct {
	Enabled      bool   `json:"enabled"`
	ShowMoney    bool   `json:"show_money"`
	ShowUnbilled bool   `json:"show_unbilled"`
	ShowTeeth    bool   `json:"show_teeth"`
	Show3D       bool   `json:"show_3d"`
	AllowPay     bool   `json:"allow_pay"`
	WelcomeNote  string `json:"welcome_note"`
	// Slug is read-only: the clinic's address, so its screen can show the portal link.
	Slug string `json:"slug,omitempty"`
}

// Session is what the patient gets back after signing in.
type Session struct {
	Token     string `json:"token"`
	ExpiresIn int    `json:"expires_in"` // seconds
}

type Clinic struct {
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	Phone   string `json:"phone,omitempty"`
	HasLogo bool   `json:"has_logo"`
}

type Visit struct {
	Seq    int    `json:"seq"`
	Date   string `json:"date"`   // YYYY-MM-DD, the clinic's calendar
	Status string `json:"status"` // planned | done
	What   string `json:"what"`
	Paid   string `json:"paid,omitempty"` // paid | billed | unpaid (only when money is shown)
}

type Treatment struct {
	Title  string  `json:"title"`
	Tooth  string  `json:"tooth,omitempty"`
	Status string  `json:"status"` // active | completed
	Done   int     `json:"done"`
	Of     int     `json:"of"`
	Visits []Visit `json:"visits"`
	// Money for this course. Present only when the clinic shows money.
	Planned   string `json:"planned,omitempty"`
	Collected string `json:"collected,omitempty"`
}

type Receipt struct {
	No     int64  `json:"no"`
	Date   string `json:"date"`
	What   string `json:"what"`
	Method string `json:"method,omitempty"`
	Amount string `json:"amount"`
}

type Money struct {
	Paid string `json:"paid"`
	// Billed and waiting for payment.
	ToPay string `json:"to_pay"`
	// Treatment delivered but no bill raised yet. Absent when the clinic hides it.
	Unbilled *string `json:"unbilled,omitempty"`
}

type NextVisit struct {
	Date  string `json:"date"`
	Title string `json:"title"`
	Seq   int    `json:"seq"`
	Of    int    `json:"of"`
}

// ChartItem is one thing recorded on a tooth. Only what a patient needs: no staff
// names, no clinical notes, no timestamps.
type ChartItem struct {
	ID        string  `json:"id"`
	Tooth     int     `json:"tooth"`
	Kind      string  `json:"kind"`
	Surface   string  `json:"surface,omitempty"`
	Material  string  `json:"material,omitempty"`
	Status    string  `json:"status"`
	BridgeEnd int     `json:"bridge_end,omitempty"`
	DoneOn    *string `json:"done_on,omitempty"`
}

// Chart is the patient's teeth: the items and where each tooth sits.
type Chart struct {
	Items     []ChartItem                `json:"items"`
	Positions map[string]dental.Position `json:"positions"`
}

// Me is the whole page.
type Me struct {
	Clinic     Clinic      `json:"clinic"`
	FirstName  string      `json:"first_name"`
	Settings   Settings    `json:"settings"`
	Next       *NextVisit  `json:"next,omitempty"`
	Treatments []Treatment `json:"treatments"`
	Money      *Money      `json:"money,omitempty"`
	Receipts   []Receipt   `json:"receipts,omitempty"`
	Chart      *Chart      `json:"chart,omitempty"`
	Today      string      `json:"today"`
}

// PayItem is something the patient could pay now. Key is opaque to the browser: it says
// whether this is a bill already raised ("c:<id>") or a visit not yet billed ("s:<id>").
type PayItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Amount   string `json:"amount"`
	Hint     string `json:"hint,omitempty"`
	Payable  bool   `json:"payable"`
	Upcoming bool   `json:"upcoming,omitempty"` // the next visit, paid ahead
	Date     string `json:"date,omitempty"`     // the visit's day (YYYY-MM-DD), for a visit paid ahead
}

// PayRail is a way the clinic can be paid from a phone: a wallet or bank account.
type PayRail struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	Kind          string `json:"kind"`
	AccountName   string `json:"account_name,omitempty"`
	AccountNumber string `json:"account_number"`
}

type PayOptions struct {
	Items []PayItem `json:"items"`
	Rails []PayRail `json:"rails"`
	// Open is the patient's attempts that nobody has finished yet.
	Open []PayStatus `json:"open"`
}

type PayInput struct {
	Items     []string `json:"items"`
	RailID    string   `json:"rail_id"`
	Reference string   `json:"reference"`
}

// PayStatus is where one attempt stands, in words for the patient.
type PayStatus struct {
	ID        string `json:"id"`
	State     string `json:"state"` // checking | waiting | paid | rejected
	Amount    string `json:"amount"`
	Rail      string `json:"rail"`
	Reference string `json:"reference"`
	Reason    string `json:"reason,omitempty"`
	ReceiptNo *int64 `json:"receipt_no,omitempty"`
	Date      string `json:"date"`
}

// StaffPayment is an attempt the cashier has to look at.
type StaffPayment struct {
	PayStatus
	Patient      string `json:"patient"`
	MRN          string `json:"mrn"`
	PatientID    string `json:"patient_id"`
	Items        string `json:"items"`
	VerifyState  string `json:"verify_state,omitempty"`
	VerifyReason string `json:"verify_reason,omitempty"`
}

// Service is the portal's behaviour.
type Service interface {
	// Login returns a short-lived token for the patient whose card number this is.
	// Every failure — no such clinic, portal off, no such card — is the same error.
	Login(ctx context.Context, slug, card, ip string) (*Session, error)
	Me(ctx context.Context, slug, token string) (*Me, error)
	GetSettings(ctx context.Context) (*Settings, error)
	SaveSettings(ctx context.Context, in Settings) (*Settings, error)

	// Pay from home. All three are the patient's own: the patient is the one in the token.
	PayOptions(ctx context.Context, slug, token string) (*PayOptions, error)
	Pay(ctx context.Context, slug, token string, in PayInput) (*PayStatus, error)
	PayStatus(ctx context.Context, slug, token, id string) (*PayStatus, error)

	// The cashier's side: attempts nobody has confirmed, and the two decisions.
	ListPayments(ctx context.Context) ([]StaffPayment, error)
	ConfirmPayment(ctx context.Context, id string) (*PayStatus, error)
	RejectPayment(ctx context.Context, id, reason string) error
}
