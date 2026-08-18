package phone

import "testing"

// Every "invalid" case below is a real row from the live patient register.
func TestMSISDN(t *testing.T) {
	cases := []struct {
		in     string
		want   string
		status Status
	}{
		{"0911223344", "251911223344", OK},
		{"0911 22 33 44", "251911223344", OK},
		{"+251911223344", "251911223344", OK},
		{"251911223344", "251911223344", OK},
		{"911223344", "251911223344", OK},
		// Safaricom Ethiopia: a real mobile, but this gateway is Ethio-Telecom-direct
		// and requires a 2519 prefix, so it is refused locally rather than at cost.
		{"0712345678", "", Unsupported},
		{"+251712345678", "", Unsupported},
		{"", "", Missing},
		{"   ", "", Missing},
		{"0565565", "", Invalid},     // truncated
		{"9099531331", "", Invalid},  // ten digits, no leading 0, not a mobile shape
		{"90715699555", "", Invalid}, // eleven digits
		{"0115518000", "", Invalid},  // Addis landline — a real number, cannot take SMS
		{"abcdefg", "", Invalid},
	}
	for _, c := range cases {
		got, st := MSISDN(c.in)
		if got != c.want || st != c.status {
			t.Errorf("MSISDN(%q) = %q/%s, want %q/%s", c.in, got, st, c.want, c.status)
		}
	}
}

func TestNormaliseKeepsLocalForm(t *testing.T) {
	for _, in := range []string{"0911223344", "+251911223344", "0911 22 33 44", "911223344"} {
		got, ok := Normalise(in)
		if !ok || got != "0911223344" {
			t.Errorf("Normalise(%q) = %q/%v, want 0911223344/true", in, got, ok)
		}
	}
}
