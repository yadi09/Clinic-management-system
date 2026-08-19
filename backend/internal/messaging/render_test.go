package messaging

import "testing"

// The dental case: a treatment session has a date and no clock time, and the same
// template has to read correctly either way.
func TestRenderDropsDanglingPreposition(t *testing.T) {
	tpl := "Reminder: you have an appointment at {{clinic}} on {{date}} at {{time}}."
	withTime := Render(tpl, map[string]string{"clinic": "Cure Dental", "date": "21 Aug", "time": "3:00 PM"})
	if withTime != "Reminder: you have an appointment at Cure Dental on 21 Aug at 3:00 PM." {
		t.Fatalf("with a time: %q", withTime)
	}
	noTime := Render(tpl, map[string]string{"clinic": "Cure Dental", "date": "21 Aug", "time": ""})
	if noTime != "Reminder: you have an appointment at Cure Dental on 21 Aug." {
		t.Fatalf("without a time: %q", noTime)
	}
}

// The stripping must not eat real content — only a connecting word left with
// nothing after it.
func TestRenderKeepsRealWords(t *testing.T) {
	cases := map[string]string{
		"Come to {{clinic}} at 9.":                   "Come to Cure Dental at 9.",
		"Ask for {{name}} on arrival.":               "Ask for Almaz on arrival.",
		"Your visit is on {{date}}, bring {{card}}.": "Your visit is on 21 Aug, bring CD-1.",
	}
	vals := map[string]string{"clinic": "Cure Dental", "name": "Almaz", "date": "21 Aug", "card": "CD-1"}
	for in, want := range cases {
		if got := Render(in, vals); got != want {
			t.Errorf("Render(%q) = %q, want %q", in, got, want)
		}
	}
}

// An empty value mid-sentence should not leave a double space or a stray comma.
func TestRenderTidiesEmptyValues(t *testing.T) {
	got := Render("Dear {{name}}, you owe {{amount}} ETB.", map[string]string{"name": "", "amount": "1,200"})
	if got != "Dear, you owe 1,200 ETB." {
		t.Fatalf("got %q", got)
	}
}
