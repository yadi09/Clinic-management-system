package verifyet

import "testing"

func good() *Result {
	return &Result{
		ProcessingStatus: "completed", Status: "success", Verified: true,
		Amount: "1000", Currency: "ETB",
		Settlement:   &Settlement{Matched: true, MatchConfidence: "high", Reason: "receiver_account_exact_match"},
		Confirmation: &Confirmation{Scope: "platform", IsFirstConfirmation: true},
	}
}

func TestDecideAcceptsOnlyWhenEverythingHolds(t *testing.T) {
	if v := Decide(good(), "1000"); v.State != Accept {
		t.Fatalf("want accept, got %s (%s)", v.State, v.Reason)
	}
	// The vendor's number-or-string amount, and trailing-zero forms, must compare equal.
	for _, pair := range [][2]string{{"1000", "1000.00"}, {"1000.00", "1000"}, {"1000.0", "1000.000"}} {
		r := good()
		r.Amount = pair[0]
		if v := Decide(r, pair[1]); v.State != Accept {
			t.Fatalf("%v should compare equal, got %s", pair, v.State)
		}
	}
}

func TestDecideRejectsWhatTheBankDenies(t *testing.T) {
	r := good()
	r.Verified = false
	if v := Decide(r, "1000"); v.State != Reject {
		t.Fatalf("unverified must reject, got %s", v.State)
	}
	r = good()
	r.Status = "pending"
	if v := Decide(r, "1000"); v.State != Reject {
		t.Fatalf("non-success must reject, got %s", v.State)
	}
	// Genuine receipt, wrong receiver: the case the whole settlement check exists for.
	r = good()
	r.Settlement = &Settlement{Matched: false, Reason: "candidate_account_mismatch"}
	if v := Decide(r, "1000"); v.State != Reject {
		t.Fatalf("wrong receiver must reject, got %s", v.State)
	}
}

func TestDecideSendsEveryDoubtToAHuman(t *testing.T) {
	cases := map[string]func(*Result){
		"wrong amount":        func(r *Result) { r.Amount = "900" },
		"wrong currency":      func(r *Result) { r.Currency = "USD" },
		"no settlement data":  func(r *Result) { r.Settlement = nil },
		"ambiguous":           func(r *Result) { r.Settlement = &Settlement{Matched: false, Ambiguous: true, CandidateCount: 2} },
		"no registered accts": func(r *Result) { r.Settlement = &Settlement{Matched: false, Reason: "no_registered_accounts"} },
		"missing receiver":    func(r *Result) { r.Settlement = &Settlement{Matched: false, Reason: "missing_receiver_account"} },
		"low confidence":      func(r *Result) { r.Settlement.MatchConfidence = "medium" },
		"confirmed before":    func(r *Result) { r.Confirmation = &Confirmation{ConfirmedBefore: true} },
		// The one that matters most: a reason code the vendor invents next year.
		"unknown reason":  func(r *Result) { r.Settlement = &Settlement{Matched: false, Reason: "some_new_code_2027"} },
		"unknown no code": func(r *Result) { r.Settlement = &Settlement{Matched: false} },
		"failed":          func(r *Result) { r.ProcessingStatus = "failed" },
	}
	for name, mutate := range cases {
		r := good()
		mutate(r)
		if v := Decide(r, "1000"); v.State != Review {
			t.Errorf("%s: want review, got %s (%s)", name, v.State, v.Reason)
		}
	}
}

func TestDecidePendingAndMissing(t *testing.T) {
	for _, st := range []string{"queued", "running", ""} {
		r := good()
		r.ProcessingStatus = st
		if v := Decide(r, "1000"); v.State != Pending {
			t.Errorf("%q: want pending, got %s", st, v.State)
		}
	}
	if v := Decide(nil, "1000"); v.State != Review {
		t.Fatalf("a missing result must be reviewed, not accepted: %s", v.State)
	}
}

// An amount we did not ask about must not be invented into a match.
func TestDecideSkipsAmountOnlyWhenAsked(t *testing.T) {
	r := good()
	r.Amount = "5"
	if v := Decide(r, ""); v.State != Accept {
		t.Fatalf("no expectation means no amount gate, got %s", v.State)
	}
	if v := Decide(r, "1000"); v.State != Review {
		t.Fatalf("an expectation must be enforced, got %s", v.State)
	}
}
