package phone

import "testing"

// Given the many ways a number is typed, When normalised, Then each gives the documented storage form and ok flag.
func TestREG_KERNEL_PHONE_001_NormaliseForms(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"", "", true},                              // no phone is not an error
		{"   ", "", true},                           // whitespace is no phone
		{"+++", "", false},                          // something typed, no digits
		{"n/a", "", false},                          // words instead of a number
		{"00251911223344", "0911223344", true},      // international 00 prefix
		{"251-911-223-344", "0911223344", true},     // dashes
		{"(0911) 22-33-44", "0911223344", true},     // brackets
		{"712345678", "0712345678", true},           // Safaricom, missing trunk 0
		{"0712345678", "0712345678", true},          // Safaricom stored as typed
		{"0115518000", "0115518000", true},          // landline keeps its local form
		{"+44 20 7946 0958", "+442079460958", true}, // foreign keeps + and country code
		{"0044 20 7946 0958", "+442079460958", true},
		{"12345678", "12345678", true},  // plausible foreign without plus: kept, no plus invented
		{"123456", "", false},           // under E.164 minimum → typo
		{"1234567890123456", "", false}, // over 15 digits → typo
		// 13 digits starting 251 is inside E.164 bounds, so it is kept as a +number
		// rather than mangled into a wrong mobile (MSISDN then calls it Invalid).
		{"+251 911 223 344 ext 5", "+2519112233445", true},
	}
	for _, c := range cases {
		got, ok := Normalise(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("Normalise(%q) = %q/%v, want %q/%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

// Given numbers of each status, When MSISDN is asked, Then foreign and over-long numbers are Invalid (never passed through hopefully).
func TestREG_KERNEL_PHONE_002_MSISDNRejectsForeignAndOddLengths(t *testing.T) {
	cases := []struct {
		in     string
		want   string
		status Status
	}{
		{"+44 20 7946 0958", "", Invalid},
		{"0044 20 7946 0958", "", Invalid},
		{"+2519112233445", "", Invalid}, // 13 digits: not 12, gateway would refuse
		{"00251911223344", "251911223344", OK},
		{"712345678", "", Unsupported},
		{"+++", "", Invalid},
		{"0911-22-33-44", "251911223344", OK},
	}
	for _, c := range cases {
		got, st := MSISDN(c.in)
		if got != c.want || st != c.status {
			t.Errorf("MSISDN(%q) = %q/%s, want %q/%s", c.in, got, st, c.want, c.status)
		}
	}
}

// Given every OK MSISDN, When produced, Then it is exactly 12 digits beginning 2519 (the gateway's only accepted shape).
func TestREG_KERNEL_PHONE_003_OKAlwaysGatewayShape(t *testing.T) {
	for _, in := range []string{"0911223344", "+251 911 223 344", "911223344", "00251911223344", "251911223344", "0944-000-111"} {
		got, st := MSISDN(in)
		if st != OK {
			t.Errorf("MSISDN(%q) status %s, want ok", in, st)
			continue
		}
		if len(got) != 12 || got[:4] != "2519" {
			t.Errorf("MSISDN(%q) = %q, want 12 digits starting 2519", in, got)
		}
		for _, r := range got {
			if r < '0' || r > '9' {
				t.Errorf("MSISDN(%q) = %q contains a non-digit", in, got)
			}
		}
	}
}

// Given numbers of each status, When Reachable is asked, Then only OK numbers are reachable.
func TestREG_KERNEL_PHONE_004_Reachable(t *testing.T) {
	for in, want := range map[string]bool{
		"0911223344": true, "+251911223344": true,
		"": false, "0712345678": false, "0115518000": false, "0565565": false, "+44 20 7946 0958": false,
	} {
		if got := Reachable(in); got != want {
			t.Errorf("Reachable(%q) = %v, want %v", in, got, want)
		}
	}
}

// Given the status constants, When compared, Then their wire strings are stable (the UI and stored rows key on them).
func TestREG_KERNEL_PHONE_005_StatusStrings(t *testing.T) {
	if Missing != "missing" || Invalid != "invalid" || Unsupported != "unsupported" || OK != "ok" {
		t.Errorf("status strings changed: %s %s %s %s", Missing, Invalid, Unsupported, OK)
	}
}
