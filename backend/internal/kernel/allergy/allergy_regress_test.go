package allergy_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/allergy"
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
		{"Ibuprofen", "Aspirin", true},                             // NSAID family (was false; owner chose family warnings, 2026-10-04)
		{"Paracetamol", "", false},
		{"", "Penicillin", false},
		{"Castor oil", "oil", false},                // 3-letter token ignored: noise
		{"Enalapril (ACE inhibitor)", "ace", false}, // ditto
		{"Codeine phosphate", "Codeine; morphine", true},
		{"Metronidazole", "Iodine (contrast)", false},
		{"Amoxicillin", "Penicillin", true}, // penicillin family (was a tag job, so an untagged library drug slipped through)
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
	// Penicillin: Augmentin and Amoxicillin are penicillins (family; was absent before families).
	// BETA-LACTAM: exact tag match ignoring case/space.  amoxicillin: tag fuzzy match.
	want := []string{"Penicillin", "BETA-LACTAM", "amoxicillin"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Conflicts = %#v, want %#v", got, want)
	}
}

// Given a short (<4 letter) allergen recorded exactly as the drug's tag, When checked, Then the exact tag match still fires even though the fuzzy rule would ignore it.
func TestREG_KERNEL_ALLERGY_003_ShortTagExactMatch(t *testing.T) {
	if got := allergy.Conflicts("Cardiprin 100", []string{"ASA"}, []string{"asa"}); !reflect.DeepEqual(got, []string{"asa"}) {
		t.Errorf("exact tag ASA vs allergy asa = %#v, want [asa]", got)
	}
	// ASA is the one short name in the aspirin family, so a drug written "ASA 81" is
	// caught by name too (was ignored as a 3-letter word); other 3-letter words are not.
	if got := allergy.Conflicts("ASA 81", nil, []string{"asa"}); !reflect.DeepEqual(got, []string{"asa"}) {
		t.Errorf("ASA 81 vs an ASA allergy = %#v, want [asa]", got)
	}
	if got := allergy.Conflicts("Asacol 400", nil, []string{"asa"}); len(got) != 0 {
		t.Errorf("a longer word that merely starts with asa must not fire, got %#v", got)
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

// Given an allergy recorded in the plural ("Penicillins") — common clinical wording, When a penicillin is prescribed, Then it is flagged.
// (NEW-KERNEL-ALLERGY-1, fixed 2026-10-10.)
func TestREG_KERNEL_ALLERGY_005_PluralSubstanceStillMatches(t *testing.T) {
	got := allergy.Conflicts("Penicillin V 250mg", nil, []string{"Penicillins"})
	if !reflect.DeepEqual(got, []string{"Penicillins"}) {
		t.Errorf(`"Penicillins" vs "Penicillin V 250mg" = %#v, want a warning`, got)
	}
}

// Given allergies named as a drug FAMILY, When any member of the family is prescribed — typed under its generic or brand name — Then it is flagged.
func TestREG_KERNEL_ALLERGY_006_FamiliesWarnOnEveryMember(t *testing.T) {
	cases := []struct{ allergy, drug string }{
		{"Penicillin", "Amoxicillin 500mg"}, {"Penicillin", "Augmentin 625"}, {"PCN", "Ampicillin"},
		{"Penicillins", "Flucloxacillin"}, {"Penicillin", "Co-amoxiclav"},
		{"Cephalosporins", "Ceftriaxone 1g"}, {"Cephalosporin", "Cefalexin"}, {"Cephalosporin", "Cephradine"},
		{"Beta-lactam", "Amoxicillin"}, {"beta lactams", "Cefixime"}, {"Beta-lactam", "Meropenem"},
		{"Sulfa", "Co-trimoxazole 480"}, {"Sulphonamides", "Septrin"}, {"Sulfa drugs", "Bactrim DS"}, {"Sulpha", "Sulfadiazine"},
		{"Co-trimoxazole", "Bactrim"},
		{"NSAIDs", "Ibuprofen 400"}, {"NSAID", "Diclofenac sodium"}, {"Aspirin", "Naproxen"}, {"ASA", "Mefenamic acid"},
		{"Anti-inflammatory", "Ketorolac"},
		{"Macrolides", "Azithromycin"}, {"Tetracyclines", "Doxycycline 100"}, {"Fluoroquinolones", "Ciprofloxacin"},
		{"Quinolone", "Levofloxacin"}, {"Metronidazole", "Tinidazole"}, {"Nitroimidazole", "Flagyl"},
		{"Local anaesthetics", "Lidocaine 2% with adrenaline"}, {"Anesthetic", "Articaine 4%"}, {"Local anaesthetic", "Mepivacaine"},
		{"Opioids", "Tramadol"}, {"Opiate", "Pethidine"}, {"Narcotic", "Morphine"},
	}
	for _, c := range cases {
		if !allergy.Matches(c.drug, c.allergy) {
			t.Errorf("an allergy to %q should warn on %q", c.allergy, c.drug)
		}
	}
}

// Given an allergy or drug written with another common spelling, When matched, Then they are the same substance.
func TestREG_KERNEL_ALLERGY_007_SpellingVariantsAreTheSameSubstance(t *testing.T) {
	cases := []struct{ allergy, drug string }{
		{"Amoxycillin", "Amoxicillin"}, {"Amoxicillin", "Amoxycillin 250"}, {"Penicilin", "Penicillin V"}, {"Pencillin", "Penicillin V"},
		{"Lignocaine", "Lidocaine 2%"}, {"Lidocaine", "Lignocaine gel"},
		{"Acetaminophen", "Paracetamol 500"}, {"Paracetamol", "Panadol Extra"}, {"Tylenol", "Paracetamol"},
		{"Epinephrine", "Lidocaine with Adrenaline"}, {"Adrenaline", "Epinephrine 1mg"},
		{"Albuterol", "Salbutamol inhaler"}, {"Indomethacin", "Indometacin"},
		{"Cephalexin", "Cefalexin 500"}, {"Aspirine", "Aspirin 75"}, {"Metronidazol", "Metronidazole 400"},
		{"Cotrimoxazol", "Co-trimoxazole"}, {"Sulphate", "Magnesium sulfate"},
	}
	for _, c := range cases {
		if !allergy.Matches(c.drug, c.allergy) {
			t.Errorf("%q and %q are the same substance and should warn", c.allergy, c.drug)
		}
	}
}

// Given things that look similar but are different, When matched, Then there is no warning: a warning that cries wolf is one a prescriber learns to click past.
func TestREG_KERNEL_ALLERGY_008_NoFalseAlarms(t *testing.T) {
	cases := []struct{ allergy, drug string }{
		{"Sulfa drugs", "Ferrous sulfate 200mg"}, // "sulfa" is inside "sulfate"; iron is not a sulfonamide
		{"Sulpha", "Sulphate of iron"},
		{"Penicillin", "Penicillamine"}, // different drug
		{"Penicillin", "Paracetamol"},
		{"ASA", "Asacol 400"}, // mesalazine, merely starts with the letters
		{"PCN", "Pcnext"},
		{"Penicillins - severe", "Ibuprofen"}, // "severe" is filler, not a drug
		{"Allergic to drugs", "Drug free toothpaste"},
		{"Latex", "Paracetamol"},
		{"Codeine", "Paracetamol"},  // codeine is a plain allergy; paracetamol is not an opioid
		{"Cefa", "Amoxicillin"},     // a fragment, not a cephalosporin allergy
		{"Penicillin", "Cefalexin"}, // cephalosporin is its own family (cross-reaction is rare)
		{"Lidocaine", "Articaine"},  // a named allergy does not widen to the class; "local anaesthetics" does
	}
	for _, c := range cases {
		if allergy.Matches(c.drug, c.allergy) {
			t.Errorf("an allergy to %q must NOT warn on %q", c.allergy, c.drug)
		}
	}
	for _, empty := range []string{"", "   ", "-", "Allergic", "severe rash"} {
		if allergy.Matches("Penicillin V", empty) {
			t.Errorf("an allergy of %q names nothing and must not warn", empty)
		}
	}
	if allergy.Matches("", "Penicillin") || allergy.Matches("  ", "Penicillin") {
		t.Errorf("a blank drug name must not warn")
	}
}

// Given the list every clinic starts its allergy picker with, Then names are non-empty, distinct ignoring case, and each warns on a drug of its own kind.
func TestREG_KERNEL_ALLERGY_009_StandardAllergenList(t *testing.T) {
	seen := map[string]bool{}
	for _, n := range allergy.StandardAllergens {
		key := strings.ToLower(strings.TrimSpace(n))
		if key == "" || seen[key] {
			t.Errorf("standard allergen %q is empty or repeated", n)
		}
		seen[key] = true
	}
	if len(allergy.StandardAllergens) < 20 {
		t.Errorf("only %d standard allergens", len(allergy.StandardAllergens))
	}
	for name, drug := range map[string]string{
		"Penicillins": "Amoxicillin", "Sulfa drugs": "Co-trimoxazole", "NSAIDs": "Ibuprofen", "Aspirin": "Aspirin 75",
		"Local anaesthetics": "Articaine", "Paracetamol": "Panadol", "Adrenaline": "Epinephrine", "Metronidazole": "Tinidazole",
	} {
		if !allergy.Matches(drug, name) {
			t.Errorf("the standard allergen %q should warn on %q", name, drug)
		}
	}
}
