// Package allergy decides whether a drug clashes with a patient's recorded
// allergies. It exists so that decision is made in exactly one place.
//
// The rule was written for the general encounter and lived unexported inside the
// clinical service. The dental prescription, written later, had no check at all —
// so the same clinic could stop a doctor prescribing amoxicillin to a penicillin-
// allergic patient and let the dentist next door write it without a word. A second
// copy of the matcher would have fixed that for a while and then drifted; a shared
// one cannot disagree with itself.
package allergy

import (
	"strings"
	"unicode"
)

// Matches reports whether a drug name looks like a recorded allergy substance.
//
// Deliberately fuzzy in one direction only: it splits the substance into word
// tokens and looks for one inside the drug name. "Penicillin" therefore catches
// "Penicillin V", and "amoxicillin/clavulanate" is caught by an "amoxicillin"
// allergy. Tokens shorter than four letters are ignored, because "oil" or "ace"
// inside a longer drug name is noise, and a warning that cries wolf is one a
// prescriber learns to click past.
func Matches(drug, substance string) bool {
	d := strings.ToLower(drug)
	tokens := strings.FieldsFunc(strings.ToLower(substance), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, tok := range tokens {
		if len([]rune(tok)) >= 4 && strings.Contains(d, tok) {
			return true
		}
	}
	return false
}

// Conflicts returns the patient-allergy substances that clash with the drug being
// prescribed. A drug is checked by its library allergen tags first (an exact tag
// match is the reliable signal) and by its typed name as a fallback, so a drug that
// was never added to the library is still checked.
//
// The result is the substances to show the prescriber, not a boolean: "allergic to
// Penicillin" is actionable and "this drug is not allowed" is not.
func Conflicts(drugName string, drugAllergens, patientAllergies []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, sub := range patientAllergies {
		if strings.TrimSpace(sub) == "" {
			continue
		}
		hit := Matches(drugName, sub)
		for _, tag := range drugAllergens {
			if hit {
				break
			}
			if strings.EqualFold(strings.TrimSpace(tag), strings.TrimSpace(sub)) || Matches(tag, sub) {
				hit = true
			}
		}
		if hit && !seen[sub] {
			seen[sub] = true
			out = append(out, sub)
		}
	}
	return out
}
