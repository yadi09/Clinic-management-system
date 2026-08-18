// Package phone turns whatever someone typed into a number a network will accept.
//
// The clinic's register is not tidy. On the live data these are all real rows:
// "0911223344", "+251911223344", "0911 22 33 44", "9099531331", "0565565". The
// first three are one reachable person written three ways; the last two are not
// phone numbers at all, and no amount of formatting will make them dial.
//
// Two jobs, deliberately kept apart:
//
//	Normalise  — the storage form, local "09xxxxxxxx". What the patient record
//	             holds and what duplicate-matching compares.
//	MSISDN     — the wire form, "2519xxxxxxxx". What the SMS gateway wants, with
//	             no plus and no leading zero.
//
// The second is the reason this package exists rather than staying a private
// helper in the CSV importer: sending is the first thing that has to tell the
// difference between "no number", "not a real number", and "fine", and it has to
// tell a person which one it hit.
package phone

import (
	"regexp"
	"strings"
)

var nonDigit = regexp.MustCompile(`\D`)

// Status says how usable a number is. The three cases get different words in the
// UI because they need different actions: chase the patient for a number, fix a
// typo, or nothing.
type Status string

const (
	// Missing: no number on file at all.
	Missing Status = "missing"
	// Invalid: something is there, but it cannot be dialled — a truncated entry,
	// a digit dropped, a landline stub. Someone has to look at the record.
	Invalid Status = "invalid"
	// Unsupported: a real, dialable Ethiopian mobile the SMS gateway will not take.
	// Safaricom Ethiopia numbers (07…) are the case: the gateway is a direct Ethio
	// Telecom integration and requires a 2519 prefix, rejecting anything else with
	// error 10000. Told apart from Invalid because the record is fine and there is
	// nothing for staff to correct — the message simply cannot go this way.
	Unsupported Status = "unsupported"
	// OK: a mobile number this gateway will route to.
	OK Status = "ok"
)

// Normalise reduces a phone to the comparable local form so "0911 22 33 44",
// "+251911223344" and "251911223344" all become "0911223344". Ethiopian numbers
// come back 0-prefixed; anything foreign keeps its + country code. An empty input
// is not an error — plenty of patients have no phone.
func Normalise(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", true
	}
	plus := strings.HasPrefix(s, "+") || strings.HasPrefix(s, "00")
	d := nonDigit.ReplaceAllString(s, "")
	if d == "" {
		return "", false
	}
	d = strings.TrimPrefix(d, "00")
	switch {
	case strings.HasPrefix(d, "251") && len(d) == 12: // +251 9xx xxx xxx → 09xx xxx xxx
		return "0" + d[3:], true
	case len(d) == 9 && (strings.HasPrefix(d, "9") || strings.HasPrefix(d, "7")): // missing trunk 0
		return "0" + d, true
	case len(d) == 10 && strings.HasPrefix(d, "0"):
		return d, true
	}
	if len(d) < 7 || len(d) > 15 { // ITU E.164 bounds — outside them it is a typo
		return "", false
	}
	if plus {
		return "+" + d, true
	}
	return d, true
}

// MSISDN renders a number the way the gateway wants it: 251XXXXXXXXX, no plus.
//
// Only Ethiopian mobiles are accepted. A landline or a foreign number returns
// Invalid rather than being passed through hopefully — the send would be rejected
// or, worse, silently charged and dropped, and a failure we can predict should not
// be a failure we discover later on a bill.
func MSISDN(raw string) (string, Status) {
	if strings.TrimSpace(raw) == "" {
		return "", Missing
	}
	local, ok := Normalise(raw)
	if !ok || local == "" {
		return "", Invalid
	}
	// The gateway requires exactly 12 digits beginning 2519 — a direct Ethio
	// Telecom integration. 09… is that; 07… (Safaricom Ethiopia) is a genuine
	// mobile it will not carry, and sending anyway would spend a request to be
	// told 10000. Landlines (011…, 025…) cannot take an SMS at all.
	if len(local) == 10 && strings.HasPrefix(local, "09") {
		return "251" + local[1:], OK
	}
	if len(local) == 10 && strings.HasPrefix(local, "07") {
		return "", Unsupported
	}
	if strings.HasPrefix(local, "+2519") && len(local) == 13 {
		return local[1:], OK
	}
	if strings.HasPrefix(local, "+2517") && len(local) == 13 {
		return "", Unsupported
	}
	return "", Invalid
}

// Reachable is the yes/no the audience builder needs.
func Reachable(raw string) bool {
	_, st := MSISDN(raw)
	return st == OK
}
