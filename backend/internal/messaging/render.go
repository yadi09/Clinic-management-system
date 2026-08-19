package messaging

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/reicb/clinicsaas/internal/kernel/ethiocal"
)

// Vars are the placeholders a template may use.
//
// A closed list, on purpose. An open one means a typo — {{patinet}} — survives
// review, reaches a patient as literal text, and is paid for. Every name here is
// short because the name is not what costs money, but the value it expands to is,
// and a clinic composing near the 70-character Amharic limit needs the preview to
// be honest about the real length.
var Vars = map[string]string{
	"clinic":  "the clinic's name",
	"name":    "the patient's first name",
	"card":    "the patient's card number (MRN)",
	"date":    "the date, e.g. 25 Aug",
	"date_ec": "the date in the Ethiopian calendar, e.g. Nehase 19",
	"time":    "the time, e.g. 3:00 PM",
	"amount":  "the amount owed, e.g. 1,200",
	"days":    "how many days overdue",
}

var placeholder = regexp.MustCompile(`\{\{\s*([a-z_]+)\s*\}\}`)

// danglingWord matches a short connecting word left with nothing after it, at the
// end of a sentence or the whole message. Deliberately a closed list — stripping
// any trailing word would eat real content.
var danglingWord = regexp.MustCompile(`(?i)\s+(at|on|for|to|of|by)\s*([.,;!?]|$)`)

// VarNames lists the placeholders in a stable order, for the UI's insert buttons.
func VarNames() []string {
	out := make([]string, 0, len(Vars))
	for k := range Vars {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ValidateTemplate refuses a body that uses a placeholder we cannot fill.
//
// Checked when the template is saved rather than when a message is built, because
// by send time the mistake is already on six hundred phones — and an unfilled
// placeholder is not a rendering glitch, it is a patient reading "{{amuont}} ETB"
// and phoning the clinic about it.
func ValidateTemplate(body string) error {
	body = strings.TrimSpace(body)
	if body == "" {
		return fmt.Errorf("the message cannot be empty")
	}
	var unknown []string
	for _, m := range placeholder.FindAllStringSubmatch(body, -1) {
		if _, ok := Vars[m[1]]; !ok {
			unknown = append(unknown, m[1])
		}
	}
	if len(unknown) > 0 {
		return fmt.Errorf("unknown placeholder %s — available: %s",
			strings.Join(uniq(unknown), ", "), strings.Join(VarNames(), ", "))
	}
	// A stray brace usually means a half-typed placeholder, which would otherwise
	// go out verbatim.
	if strings.Contains(placeholder.ReplaceAllString(body, ""), "{{") {
		return fmt.Errorf("there is an unfinished {{placeholder}} in the message")
	}
	return nil
}

func uniq(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// Render substitutes the values that are known and leaves nothing behind.
//
// A placeholder with no value collapses to empty rather than staying as literal
// braces: a bill reminder built for a patient with no name should read a little
// awkwardly, not ship "{{name}}" to their phone.
func Render(body string, vals map[string]string) string {
	out := placeholder.ReplaceAllStringFunc(body, func(m string) string {
		g := placeholder.FindStringSubmatch(m)
		return vals[g[1]]
	})
	// Substituting an empty value can leave doubled spaces or a space before a
	// full stop, which reads as a bug to the person holding the phone.
	out = regexp.MustCompile(`\s{2,}`).ReplaceAllString(out, " ")
	// It can also strand the word that introduced the value. A dental visit has a
	// date but no clock time, so "on {{date}} at {{time}}." would otherwise reach
	// the patient as "on 21 Aug at." — the same template has to read correctly
	// whether or not the appointment has a time, because a clinic should not be
	// made to keep two versions of one sentence.
	out = danglingWord.ReplaceAllString(out, "$2")
	out = strings.ReplaceAll(out, " .", ".")
	out = strings.ReplaceAll(out, " ,", ",")
	return strings.TrimSpace(out)
}

// SampleVars are stand-ins for previewing a template before it has real data.
// Realistic on purpose: a preview using "X" would understate the length of every
// message the clinic actually sends, and length is money here.
func SampleVars(clinic string) map[string]string {
	tomorrow := time.Now().AddDate(0, 0, 1)
	_, em, ed := ethiocal.ToEthiopian(tomorrow)
	return map[string]string{
		"clinic":  defaultIfEmpty(clinic, "The Clinic"),
		"name":    "Almaz",
		"card":    "CD-0412",
		"date":    tomorrow.Format("2 Jan"),
		"date_ec": fmt.Sprintf("%s %d", ethiocal.Months[em-1], ed),
		"time":    "3:00 PM",
		"amount":  "1,200",
		"days":    "7",
	}
}

func defaultIfEmpty(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}
