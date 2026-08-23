package verifyet

import "strings"

// The verdict a verification earns. Fail closed: anything unrecognised, ambiguous or
// unexpected lands in Review, never in Accept.
const (
	// Accept — the bank confirms this money, for this amount, into our account.
	Accept = "verified"
	// Reject — the bank contradicts the claim. Real receipt, wrong receiver; or no
	// such transaction.
	Reject = "rejected"
	// Review — something a person must look at. Also where every unknown lands.
	Review = "review"
	// Pending — the vendor has not finished yet.
	Pending = "pending"
)

// Verdict is the decision and the reason it was reached, in words a clinic can read.
type Verdict struct {
	State  string
	Reason string
	// Detail is the machine reason (the vendor's own code where there is one), kept
	// on the record so a dispute can be argued from evidence rather than memory.
	Detail string
}

// Decide turns a verification into accept / reject / review.
//
// Deliberately NOT `if verified { accept }`. A receipt can be completely genuine and
// still not be a payment to this clinic — that is the entire reason the settlement
// check exists — and it can be genuine, to the right account, and for the wrong
// amount. Every gate below has to pass.
//
// expected is what the clinic is owed, as a decimal string; "" skips the amount gate
// (a deliberate choice by the caller, not a default).
//
// The failure mode this is written against: marking a bill paid for money that never
// arrived. Every ambiguity therefore biases to Review, where a human decides.
func Decide(r *Result, expected string) Verdict {
	if r == nil {
		return Verdict{Review, "The verification did not come back — check it by hand.", "no_result"}
	}
	if !r.Done() {
		return Verdict{Pending, "Still checking with the bank.", r.ProcessingStatus}
	}
	if r.ProcessingStatus == "failed" {
		return Verdict{Review, "The bank could not complete the check — verify it by hand.", "processing_failed"}
	}
	// 1. The bank has to actually confirm the transaction.
	if !r.Verified || !strings.EqualFold(r.Status, "success") {
		return Verdict{Reject, "The bank has no record of this transaction.", "not_verified"}
	}

	// 2. It has to be the right money. Compared as fixed-point text: a float here is
	//    how 1,000.00 and 999.99999 become the same number.
	if expected != "" && r.Amount != "" && Fmt(r.Amount) != Fmt(expected) {
		return Verdict{Review,
			"The bank shows " + Fmt(r.Amount) + " but this bill is " + Fmt(expected) + ".",
			"amount_mismatch"}
	}
	if r.Currency != "" && !strings.EqualFold(r.Currency, "ETB") {
		return Verdict{Review, "That payment is in " + r.Currency + ", not ETB.", "currency_mismatch"}
	}

	// 3. It has to have reached OUR account. This is the gate that catches a genuine
	//    receipt for a payment made to somebody else.
	s := r.Settlement
	if s == nil {
		return Verdict{Review, "The bank did not say which account received it.", "no_settlement_data"}
	}
	if s.Ambiguous {
		// The vendor refused to guess between several registered accounts and told us
		// so instead of picking one. Guessing here would be worse than their guess.
		return Verdict{Review, "The receiving account is ambiguous — confirm it by hand.", "ambiguous"}
	}
	if !s.Matched {
		switch s.Reason {
		case "no_registered_accounts", "missing_receiver_account":
			// Our misconfiguration, not the patient's fault. Never a rejection.
			return Verdict{Review,
				"We have not told the verification service which account this clinic uses.",
				s.Reason}
		case "candidate_account_mismatch":
			return Verdict{Reject, "That payment went to a different account.", s.Reason}
		case "verification_not_successful":
			return Verdict{Reject, "The bank has no record of this transaction.", s.Reason}
		default:
			// An unrecognised reason — including one the vendor adds next year — is a
			// question, never an approval.
			return Verdict{Review, "The receiving account could not be confirmed.", nonEmpty(s.Reason, "unmatched")}
		}
	}
	// Matched, but only a high-confidence match may pass unattended.
	if s.MatchConfidence != "" && !strings.EqualFold(s.MatchConfidence, "high") {
		return Verdict{Review, "The receiving account matched only weakly — confirm it by hand.",
			"low_confidence_" + s.MatchConfidence}
	}

	// 4. Replay. scope is "platform", so a prior confirmation may be another business
	//    entirely, or our own earlier check of this same payment. It cannot prove
	//    fraud on its own — our own reference uniqueness does that — so it raises the
	//    bar to a human rather than rejecting a patient who has genuinely paid.
	if c := r.Confirmation; c != nil && c.ConfirmedBefore && !c.IsFirstConfirmation {
		return Verdict{Review, "This receipt has been confirmed before — check it is not a second use.", "confirmed_before"}
	}

	return Verdict{Accept, "Confirmed by the bank, to this clinic's account.", nonEmpty(s.Reason, "matched")}
}

func nonEmpty(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
