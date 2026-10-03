package verifyet

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Given a saved key and an env key, When the Resolving client calls out, Then the saved key wins and is cached between calls.
func TestREG_KERNEL_VERIFYET_020_ResolvingPrefersSavedKeyAndCaches(t *testing.T) {
	f, srv := newFake(t, jsonReply(200, verifiedSubmit))
	var lookups int32
	r := NewResolving(func(context.Context) (string, error) {
		atomic.AddInt32(&lookups, 1)
		return "saved-key", nil
	}, "env-key", srv.URL, quiet())
	if !r.Live() {
		t.Fatal("saved key must make the client live")
	}
	if _, err := r.Verify(context.Background(), Request{Reference: "a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Status(context.Background(), "req-1"); err != nil {
		t.Fatal(err)
	}
	if got := f.last().Key; got != "saved-key" {
		t.Fatalf("saved key must beat env, sent %q", got)
	}
	if n := atomic.LoadInt32(&lookups); n != 1 {
		t.Fatalf("lookup must be cached for %s, ran %d times", cacheFor, n)
	}
}

// Given a rotated key, When the cache window has passed, Then the next call uses the new key; an empty saved key falls back to env.
func TestREG_KERNEL_VERIFYET_021_ResolvingPicksUpRotationAndEnvFallback(t *testing.T) {
	f, srv := newFake(t, jsonReply(200, verifiedSubmit))
	key := "first"
	r := NewResolving(func(context.Context) (string, error) { return key, nil }, "env-key", srv.URL, quiet())
	_, _ = r.Verify(context.Background(), Request{Reference: "a"})
	first := r.current
	key = "second"
	r.fetched = time.Now().Add(-2 * cacheFor) // expire the cache
	_, _ = r.Verify(context.Background(), Request{Reference: "a"})
	if f.last().Key != "second" || r.current == first {
		t.Fatalf("rotation not picked up: sent %q", f.last().Key)
	}
	// Same key after expiry: client is reused, not rebuilt.
	same := r.current
	r.fetched = time.Now().Add(-2 * cacheFor)
	_, _ = r.Verify(context.Background(), Request{Reference: "a"})
	if r.current != same {
		t.Fatal("unchanged key must not rebuild the client")
	}
	key = ""
	r.fetched = time.Now().Add(-2 * cacheFor)
	_, _ = r.Verify(context.Background(), Request{Reference: "a"})
	if f.last().Key != "env-key" {
		t.Fatalf("empty saved key must fall back to env, sent %q", f.last().Key)
	}
}

// Given the key store errors, When a client already exists, Then it keeps serving the old key; with none, it falls back to env (or stays off).
func TestREG_KERNEL_VERIFYET_022_ResolvingSurvivesLookupErrors(t *testing.T) {
	f, srv := newFake(t, jsonReply(200, verifiedSubmit))
	fail := false
	r := NewResolving(func(context.Context) (string, error) {
		if fail {
			return "", errors.New("db down")
		}
		return "good", nil
	}, "", srv.URL, quiet())
	_, _ = r.Verify(context.Background(), Request{Reference: "a"})
	fail = true
	r.fetched = time.Now().Add(-2 * cacheFor)
	if _, err := r.Verify(context.Background(), Request{Reference: "a"}); err != nil {
		t.Fatal(err)
	}
	if f.last().Key != "good" || time.Since(r.fetched) > time.Second {
		t.Fatalf("a DB blip must keep the old key and re-arm the cache; sent %q", f.last().Key)
	}

	// Cold start with a failing store and no env key: not live, nothing sent.
	before := f.count()
	cold := NewResolving(func(context.Context) (string, error) { return "", errors.New("down") }, "", srv.URL, quiet())
	if cold.Live() {
		t.Fatal("no key anywhere must not be live")
	}
	if _, err := cold.Verify(context.Background(), Request{Reference: "a"}); KindOf(err) != KindAuth {
		t.Fatalf("want auth error, got %v", err)
	}
	if f.count() != before {
		t.Fatal("must not call out without a key")
	}
	// Cold start with a failing store but an env key: env is used.
	envOnly := NewResolving(func(context.Context) (string, error) { return "", errors.New("down") }, "env", srv.URL, quiet())
	_, _ = envOnly.Verify(context.Background(), Request{Reference: "a"})
	if f.last().Key != "env" {
		t.Fatalf("env fallback, sent %q", f.last().Key)
	}
	// No lookup function at all: env only.
	nolookup := NewResolving(nil, "env2", srv.URL, quiet())
	_, _ = nolookup.Status(context.Background(), "id")
	if f.last().Key != "env2" {
		t.Fatalf("nil lookup must use env, sent %q", f.last().Key)
	}
}

// Given edge-case results, When decided, Then none of them is accepted and the reasons say why.
func TestREG_KERNEL_VERIFYET_030_DecideEdgeCases(t *testing.T) {
	var nilRes *Result
	if nilRes.Done() {
		t.Fatal("nil result is never done")
	}
	// verified=false, blank status: bank has no record.
	r := good()
	r.Verified, r.Status = false, ""
	if v := Decide(r, "1000"); v.State != Reject || v.Detail != "not_verified" {
		t.Fatalf("got %+v", v)
	}
	// verified with blank status: unclear_blank.
	r = good()
	r.Status = ""
	if v := Decide(r, "1000"); v.State != Review || v.Detail != "unclear_blank" {
		t.Fatalf("got %+v", v)
	}
	// Wrong account with no account named anywhere: no "()" in the message.
	r = good()
	r.ReceiverAccount = ""
	r.Settlement = &Settlement{Matched: false, Reason: "candidate_account_mismatch", ReceiverAccount: "  "}
	v := Decide(r, "1000")
	if v.State != Reject || strings.Contains(v.Reason, "(") {
		t.Fatalf("got %+v", v)
	}
	// Account taken from the result when the settlement omits it.
	r.ReceiverAccount = "1000****99"
	if v := Decide(r, "1000"); !strings.Contains(v.Reason, "(1000****99)") {
		t.Fatalf("got %q", v.Reason)
	}
	// Several reviews, no reject: first review leads, every detail kept.
	r = good()
	r.Amount, r.Currency = "1", "USD"
	v = Decide(r, "1000")
	if v.State != Review || v.Detail != "amount_mismatch+currency_mismatch" ||
		!strings.Contains(v.Reason, "USD") {
		t.Fatalf("got %+v", v)
	}
	// Accept with an empty settlement reason reports "matched".
	r = good()
	r.Settlement.Reason = ""
	if v := Decide(r, "1000"); v.State != Accept || v.Detail != "matched" {
		t.Fatalf("got %+v", v)
	}
	// Case-insensitive status/currency/confidence.
	r = good()
	r.Status, r.Currency, r.Settlement.MatchConfidence = "SUCCESS", "etb", "HIGH"
	if v := Decide(r, "1000"); v.State != Accept {
		t.Fatalf("got %+v", v)
	}
	// not_found with verified=true is still the bank saying no.
	r = good()
	r.Status = "NOT_FOUND"
	if v := Decide(r, "1000"); v.State != Reject {
		t.Fatalf("got %+v", v)
	}
}

// Given vendor amounts in odd forms, When normalised, Then no float is invented and garbage becomes "".
func TestREG_KERNEL_VERIFYET_031_AmountNormalisation(t *testing.T) {
	cases := map[string]string{"": "", " 12.50 ": "12.50", "abc": "", "1e3": "1e3"}
	for in, want := range cases {
		if got := decimalOf(json.Number(in)); got != want {
			t.Errorf("decimalOf(%q) = %q, want %q", in, got, want)
		}
	}
	if Fmt("1e3") != "1000.00" || Fmt("x") != "x" || Fmt(" 7 ") != "7.00" {
		t.Fatalf("Fmt: %q %q %q", Fmt("1e3"), Fmt("x"), Fmt(" 7 "))
	}
	// An envelope with an item that has no terminal status keeps ProcessingStatus blank: pending.
	res := assemble("", &verification{ProcessingStatus: ""}, []item{{Status: "pending"}}, nil, "")
	if v := Decide(res, ""); v.State != Pending {
		t.Fatalf("got %+v", v)
	}
	if res := assemble("id", nil, nil, nil, "x"); res.RequestID != "id" || res.VendorRequestID != "x" || res.Done() {
		t.Fatalf("bare assemble: %+v", res)
	}
}
