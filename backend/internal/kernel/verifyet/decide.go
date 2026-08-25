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
// More than one gate can fail on the same payment, so the gates are all evaluated
// and the MOST SERIOUS answer wins — never the first one written. Returning on the
// first failure let a mild answer hide a grave one: on a live payment the bank said
// `candidate_account_mismatch` (the money went to a stranger's account) and the desk
// was shown "the bank shows 150.00 but this bill is 100.00" with Collect still
// enabled, because the amount gate happened to be written first. A wrong amount paid
// into somebody else's account is not a wrong amount. Everything that is wrong is
// reported, worst first.
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
	//
	// Their own agent-skill reference lists two status values the API docs do not:
	// `not_found` and `failed`. They mean different things and must not share an
	// answer. "No such transaction" is a denial the desk can act on; "the check
	// failed" is an absence of information, and refusing a patient who genuinely
	// paid because a lookup broke is the wrong way to be wrong.
	switch {
	case strings.EqualFold(r.Status, "not_found"):
		return Verdict{Reject, "The bank has no record of this transaction.", "not_found"}
	case r.Verified && strings.EqualFold(r.Status, "success"):
		// Confirmed. The remaining gates decide whether it is confirmed for US.
	case strings.EqualFold(r.Status, "failed"):
		return Verdict{Review, "The bank check failed — confirm this one by hand.", "status_failed"}
	case !r.Verified && r.Status == "":
		return Verdict{Reject, "The bank has no record of this transaction.", "not_verified"}
	default:
		// Verified without success, success without verified, or a status nobody has
		// seen before. All contradictions, none of them an approval.
		return Verdict{Review, "The bank's answer was unclear — confirm this one by hand.",
			"unclear_" + nonEmpty(r.Status, "blank")}
	}

	// Gates 2-4 are collected, not returned. See the note above: the worst answer
	// decides, so the order they appear in here carries no authority.
	var bad []Verdict
	fail := func(state, reason, detail string) { bad = append(bad, Verdict{state, reason, detail}) }

	// 2. It has to have reached OUR account. This is the gate that catches a genuine
	//    receipt for a payment made to somebody else — the one case where the desk
	//    must be stopped rather than warned. Written first because it is the question
	//    that decides whether this is our money at all.
	s := r.Settlement
	switch {
	case s == nil:
		fail(Review, "The bank did not say which account received it.", "no_settlement_data")
	case s.Ambiguous:
		// The vendor refused to guess between several registered accounts and told us
		// so instead of picking one. Guessing here would be worse than their guess.
		fail(Review, "The receiving account is ambiguous — confirm it by hand.", "ambiguous")
	case !s.Matched:
		switch s.Reason {
		case "no_registered_accounts", "missing_receiver_account":
			// Our misconfiguration, not the patient's fault. Never a rejection.
			fail(Review, "We have not told the verification service which account this clinic uses.", s.Reason)
		case "candidate_account_mismatch":
			fail(Reject, "That payment went to a different account"+into(s, r)+", not this clinic's.", s.Reason)
		case "verification_not_successful":
			fail(Reject, "The bank has no record of this transaction.", s.Reason)
		default:
			// An unrecognised reason — including one the vendor adds next year — is a
			// question, never an approval.
			fail(Review, "The receiving account could not be confirmed.", nonEmpty(s.Reason, "unmatched"))
		}
	case s.MatchConfidence != "" && !strings.EqualFold(s.MatchConfidence, "high"):
		// Matched, but only a high-confidence match may pass unattended.
		fail(Review, "The receiving account matched only weakly — confirm it by hand.",
			"low_confidence_"+s.MatchConfidence)
	}

	// 3. It has to be the right money. Compared as fixed-point text: a float here is
	//    how 1,000.00 and 999.99999 become the same number.
	if expected != "" && r.Amount != "" && Fmt(r.Amount) != Fmt(expected) {
		fail(Review, "The bank shows "+Fmt(r.Amount)+" but this bill is "+Fmt(expected)+".", "amount_mismatch")
	}
	if r.Currency != "" && !strings.EqualFold(r.Currency, "ETB") {
		fail(Review, "That payment is in "+r.Currency+", not ETB.", "currency_mismatch")
	}

	// 4. Replay. scope is "platform", so a prior confirmation may be another business
	//    entirely, or our own earlier check of this same payment. It cannot prove
	//    fraud on its own — our own reference uniqueness does that — so it raises the
	//    bar to a human rather than rejecting a patient who has genuinely paid.
	if c := r.Confirmation; c != nil && c.ConfirmedBefore && !c.IsFirstConfirmation {
		fail(Review, "This receipt has been confirmed before — check it is not a second use.", "confirmed_before")
	}

	if len(bad) == 0 {
		return Verdict{Accept, "Confirmed by the bank, to this clinic's account.", nonEmpty(s.Reason, "matched")}
	}
	return worst(bad)
}

// worst reduces the failed gates to one verdict: a rejection outranks a review, and
// every other problem is still reported after it. The desk gets stopped for the right
// reason AND told the rest, instead of learning one thing and guessing the others.
func worst(bad []Verdict) Verdict {
	lead := 0
	for i, v := range bad {
		if v.State == Reject && bad[lead].State != Reject {
			lead = i
			break
		}
	}
	out := bad[lead]
	details := []string{out.Detail}
	for i, v := range bad {
		if i == lead {
			continue
		}
		out.Reason += " " + v.Reason
		details = append(details, v.Detail)
	}
	// Every reason code, so a dispute is argued from the whole answer the bank gave
	// and not just the headline.
	out.Detail = strings.Join(details, "+")
	return out
}

// into names the account the money actually reached, when the provider tells us. The
// masked form ("2519****4531") is what the desk needs to see: it is enough to compare
// against the account on the payment method and to ask the patient where they sent it.
func into(s *Settlement, r *Result) string {
	acct := nonEmpty(s.ReceiverAccount, r.ReceiverAccount)
	if strings.TrimSpace(acct) == "" {
		return ""
	}
	return " (" + acct + ")"
}

func nonEmpty(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
