package payments

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/verifyet"
)

// Checking a claimed payment against the bank, before the clinic accepts it.
//
// The patient says "I transferred it". Until now the desk's only option was to look
// at their phone. This asks the bank three questions instead: does the transaction
// exist, is it for this amount, and did it reach THIS clinic's account.
//
// The answer is stored on the payment event — the same row that stops one reference
// paying twice — so a receipt, a dispute and a report all read one record.

// Check is what the desk is told about a claimed payment.
type Check struct {
	State  string `json:"state"` // verified | rejected | review | pending | unchecked
	Reason string `json:"reason"`
	// What the bank says, for the desk to compare against the patient's phone.
	Amount    string `json:"amount,omitempty"`
	Sender    string `json:"sender,omitempty"`
	Account   string `json:"account,omitempty"`
	When      string `json:"when,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	// Already reports that this clinic has already settled a payment with this
	// reference — our own record, not the vendor's, and the stronger of the two.
	Already bool `json:"already_used,omitempty"`
}

// Rail is the bit of a payment method verification needs: which provider, and which
// account of ours the money should have reached.
type Rail struct {
	ID      uuid.UUID
	BankKey string
	Account string
	Kind    string
}

// LoadRail reads a rail for verification. Returns nil when the rail cannot be
// verified at all (cash, a card machine, or a generic method naming no provider).
func LoadRail(ctx context.Context, tx pgx.Tx, tid, railID uuid.UUID) (*Rail, error) {
	var r Rail
	r.ID = railID
	e := tx.QueryRow(ctx,
		`SELECT coalesce(bank_key,''), coalesce(account_number,''), kind
		   FROM payment_rails WHERE tenant_id = $1 AND id = $2`,
		tid, railID).Scan(&r.BankKey, &r.Account, &r.Kind)
	if e == pgx.ErrNoRows {
		return nil, apperr.Validation("unknown payment method")
	}
	if e != nil {
		return nil, e
	}
	if r.BankKey == "" || (r.Kind != "wallet" && r.Kind != "bank") {
		return nil, nil
	}
	return &r, nil
}

// Verifier is the subset of the client this package needs, so tests do not need HTTP.
type Verifier interface {
	Live() bool
	Verify(ctx context.Context, in verifyet.Request) (*verifyet.Result, error)
	Status(ctx context.Context, requestID string) (*verifyet.Result, error)
}

// RunCheck verifies a claimed reference and records the answer.
//
// expected is the amount the clinic is owed; "" skips that gate. patientID may be nil
// (an over-the-counter sale has no patient).
//
// It never returns an error for a verdict the desk should see — a rejection is a
// result, not a failure. It errors only when the check could not be attempted, and
// even then the caller may proceed: a bank we cannot reach must not close the desk.
func RunCheck(ctx context.Context, tx pgx.Tx, v Verifier, tid uuid.UUID, rail *Rail,
	reference, expected string, patientID *uuid.UUID, waitMs int, actor *uuid.UUID) (*Check, error) {

	ref := strings.TrimSpace(reference)
	if ref == "" {
		return nil, apperr.Validation("enter the transaction reference first")
	}
	if rail == nil {
		return &Check{State: "unchecked", Reason: "This payment method has no bank or wallet to check against."}, nil
	}

	// Our own record first, and it outranks anything the vendor says: if this clinic
	// has already collected against this reference, the answer is no, whatever the
	// bank thinks. The vendor's confirmationHistory is platform-wide and cannot tell
	// our second use from another business's first.
	var priorReceipt *int64
	var priorState *string
	e := tx.QueryRow(ctx,
		`SELECT receipt_no, verify_state FROM payment_references
		  WHERE tenant_id=$1 AND payment_rail_id=$2 AND reference_norm=upper(btrim($3))`,
		tid, rail.ID, ref).Scan(&priorReceipt, &priorState)
	if e != nil && e != pgx.ErrNoRows {
		return nil, e
	}
	if priorReceipt != nil {
		return &Check{
			State:   verifyet.Reject,
			Reason:  "This clinic has already collected a payment with this reference (receipt #" + itoa(*priorReceipt) + ").",
			Already: true,
		}, nil
	}

	if v == nil || !v.Live() {
		return &Check{State: "unchecked", Reason: "Receipt verification is not switched on."}, nil
	}

	res, err := v.Verify(ctx, verifyet.Request{
		Bank:      rail.BankKey,
		Reference: ref,
		// Always explicit. Relying on the vendor's saved-account fallback would ask
		// "did this reach any account we know of", which in a multi-clinic product is
		// the wrong question and could confirm one clinic's payment against another's.
		SettlementAccount: rail.Account,
		IdempotencyKey:    idemKey(tid, rail.ID, ref),
		WaitMs:            waitMs,
	})
	if err != nil {
		return unchecked(err), nil
	}
	verdict := verifyet.Decide(res, expected)
	if err := record(ctx, tx, tid, rail.ID, ref, verdict, res, patientID, actor); err != nil {
		return nil, err
	}
	return &Check{
		State: verdict.State, Reason: verdict.Reason,
		// Two decimal places, always: the desk is holding this against a figure on a
		// phone screen, and "1000" beside "1,000.00" invites a second guess.
		Amount: verifyet.Fmt(res.Amount), Sender: res.SenderName, Account: res.ReceiverAccount,
		When: res.Timestamp, RequestID: res.RequestID,
	}, nil
}

// unchecked turns a vendor failure into something the desk can act on. The clinic is
// never blocked from taking real money because a third party is having a bad day.
func unchecked(err error) *Check {
	switch verifyet.KindOf(err) {
	case verifyet.KindNoCredit:
		return &Check{State: "unchecked", Reason: "Verification credits have run out — take the payment and check it by hand."}
	case verifyet.KindRateLimited, verifyet.KindUnavailable, verifyet.KindTransport:
		return &Check{State: "unchecked", Reason: "Could not reach the bank check just now — take the payment and check it later."}
	case verifyet.KindAuth, verifyet.KindForbidden:
		return &Check{State: "unchecked", Reason: "Verification is misconfigured — tell an administrator."}
	case verifyet.KindInvalid:
		return &Check{State: verifyet.Review, Reason: "The bank could not read those details — check the reference."}
	default:
		return &Check{State: "unchecked", Reason: "The check did not complete."}
	}
}

// record writes the verification onto the payment event, creating the row if the
// desk is checking before collecting. Never overwrites a settled row's verdict.
func record(ctx context.Context, tx pgx.Tx, tid, railID uuid.UUID, ref string,
	v verifyet.Verdict, res *verifyet.Result, patientID *uuid.UUID, actor *uuid.UUID) error {
	var settlement, confirmation []byte
	if res.Settlement != nil {
		settlement, _ = json.Marshal(res.Settlement)
	}
	if res.Confirmation != nil {
		confirmation, _ = json.Marshal(res.Confirmation)
	}
	var amount *string
	if res.Amount != "" {
		a := verifyet.Fmt(res.Amount)
		amount = &a
	}
	_, e := tx.Exec(ctx,
		`INSERT INTO payment_references
		   (tenant_id, payment_rail_id, reference, reference_norm, patient_id, settled_by,
		    verify_state, verify_reason, verify_detail, verify_request_id, verify_trace_id,
		    verified_amount, sender_name, receiver_account, settlement_match, confirmation, checked_at)
		 VALUES ($1,$2,$3,upper(btrim($3)),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
		 ON CONFLICT (tenant_id, payment_rail_id, reference_norm) DO UPDATE
		   SET verify_state = EXCLUDED.verify_state, verify_reason = EXCLUDED.verify_reason,
		       verify_detail = EXCLUDED.verify_detail, verify_request_id = EXCLUDED.verify_request_id,
		       verify_trace_id = EXCLUDED.verify_trace_id, verified_amount = EXCLUDED.verified_amount,
		       sender_name = EXCLUDED.sender_name, receiver_account = EXCLUDED.receiver_account,
		       settlement_match = EXCLUDED.settlement_match, confirmation = EXCLUDED.confirmation,
		       checked_at = now()
		 WHERE payment_references.receipt_no IS NULL`,
		tid, railID, ref, patientID, actor, v.State, v.Reason, v.Detail, res.RequestID,
		res.VendorRequestID, amount, nullif(res.SenderName), nullif(res.ReceiverAccount),
		settlement, confirmation)
	return e
}

func nullif(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// idemKey is stable for the same claim and different for a different one, so a
// double-click never spends two credits and a corrected typo is a new question.
func idemKey(tid, railID uuid.UUID, ref string) string {
	return "clinicos:" + tid.String() + ":" + railID.String() + ":" + strings.ToUpper(strings.TrimSpace(ref))
}

// VerifyStateOf reads what the last check said about a reference, for the settle path.
func VerifyStateOf(ctx context.Context, tx pgx.Tx, tid uuid.UUID, railID *uuid.UUID, ref string) (string, string, error) {
	if railID == nil || strings.TrimSpace(ref) == "" {
		return "", "", nil
	}
	var state, reason *string
	e := tx.QueryRow(ctx,
		`SELECT verify_state, verify_reason FROM payment_references
		  WHERE tenant_id=$1 AND payment_rail_id=$2 AND reference_norm=upper(btrim($3))`,
		tid, *railID, ref).Scan(&state, &reason)
	if e == pgx.ErrNoRows {
		return "", "", nil
	}
	if e != nil {
		return "", "", e
	}
	return deref(state), deref(reason), nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
