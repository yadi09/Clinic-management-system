package allergy_test

import (
	"reflect"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/allergy"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Given drug/substance pairs, When matched, Then a ≥4-letter substance token inside the drug name matches, case-insensitively, and nothing else does.
func TestREG_KERNEL_ALLERGY_001_MatchesRules(t *testing.T) {
	cases := []struct {
		drug, sub string
		want      bool
	}{
		{"Penicillin V", "Penicillin", true},
		{"PENICILLIN G BENZATHINE", "penicillin", true},
		{"Amoxicillin/Clavulanate 625mg", "amoxicillin", true},
		{"Co-trimoxazole (Sulfamethoxazole)", "Sulfa drugs", true}, // "sulfa" token, "drugs" ignored as it's absent
		{"Ibuprofen", "Aspirin", false},
		{"Paracetamol", "", false},
		{"", "Penicillin", false},
		{"Castor oil", "oil", false},                // 3-letter token ignored: noise
		{"Enalapril (ACE inhibitor)", "ace", false}, // ditto
		{"Codeine phosphate", "Codeine; morphine", true},
		{"Metronidazole", "Iodine (contrast)", false},
		{"Amoxicillin", "Penicillin", false}, // cross-reactivity is a tag job, not a name job
		{"ሲፕሮ ciprofloxacin", "ሲፕሮፍሎክሳሲን", false},
		{"ሲፕሮፍሎክሳሲን 500", "ሲፕሮፍሎክሳሲን", true}, // non-Latin letters tokenise too
		{"Cefa", "Cefalexin", false},         // fuzzy in one direction only
		{"Vitamin B12", "B12", false},        // 3 runes: ignored
		{"Insulin 1234", "1234", true},       // digits count as token characters
	}
	for _, c := range cases {
		if got := allergy.Matches(c.drug, c.sub); got != c.want {
			t.Errorf("Matches(%q, %q) = %v, want %v", c.drug, c.sub, got, c.want)
		}
	}
}

// Given a drug, its library allergen tags and a patient's allergies, When conflicts are computed, Then the clashing substances are returned in patient order, once each.
func TestREG_KERNEL_ALLERGY_002_ConflictsByNameAndTag(t *testing.T) {
	got := allergy.Conflicts("Augmentin 625", []string{"Amoxicillin", " beta-lactam "},
		[]string{"Penicillin", "Latex", "BETA-LACTAM", "amoxicillin", "", "  ", "Penicillin"})
	// Penicillin: no name hit, no tag hit (tags do not contain "penicillin") → absent.
	// BETA-LACTAM: exact tag match ignoring case/space.  amoxicillin: tag fuzzy match.
	want := []string{"BETA-LACTAM", "amoxicillin"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Conflicts = %#v, want %#v", got, want)
	}
}

// Given a short (<4 letter) allergen recorded exactly as the drug's tag, When checked, Then the exact tag match still fires even though the fuzzy rule would ignore it.
func TestREG_KERNEL_ALLERGY_003_ShortTagExactMatch(t *testing.T) {
	if got := allergy.Conflicts("Cardiprin 100", []string{"ASA"}, []string{"asa"}); !reflect.DeepEqual(got, []string{"asa"}) {
		t.Errorf("exact tag ASA vs allergy asa = %#v, want [asa]", got)
	}
	if got := allergy.Conflicts("ASA 81", nil, []string{"asa"}); len(got) != 0 {
		t.Errorf("a 3-letter name match without a tag must not fire, got %#v", got)
	}
}

// Given a drug name that matches, When duplicate allergies are recorded, Then each distinct substance appears once.
func TestREG_KERNEL_ALLERGY_004_DedupesAndNeverNil(t *testing.T) {
	got := allergy.Conflicts("Penicillin V", nil, []string{"Penicillin", "Penicillin"})
	if !reflect.DeepEqual(got, []string{"Penicillin"}) {
		t.Errorf("got %#v, want one Penicillin", got)
	}
	none := allergy.Conflicts("Paracetamol", []string{"none"}, nil)
	if none == nil || len(none) != 0 {
		t.Errorf("no allergies must give an empty, non-nil slice (JSON []), got %#v", none)
	}
}

// Given an allergy recorded in the plural ("Penicillins") — common clinical wording, When a penicillin is prescribed, Then it should be flagged.
func TestREG_KERNEL_ALLERGY_005_PluralSubstanceStillMatches(t *testing.T) {
	got := allergy.Conflicts("Penicillin V 250mg", nil, []string{"Penicillins"})
	testkit.KnownBug(t, "NEW-KERNEL-ALLERGY-1", len(got) == 0,
		`allergy recorded as "Penicillins" does not flag "Penicillin V": the substance token must appear whole inside the drug name (allergy.go:31), so a plural/longer form silently passes`)
}
