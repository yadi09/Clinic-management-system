// Package allergy decides whether a drug clashes with a patient's recorded
// allergies. It exists so that decision is made in exactly one place.
//
// The rule was written for the general encounter and lived unexported inside the
// clinical service. The dental prescription, written later, had no check at all —
// so the same clinic could stop a doctor prescribing amoxicillin to a penicillin-
// allergic patient and let the dentist next door write it without a word. A second
// copy of the matcher would have fixed that for a while and then drifted; a shared
// one cannot disagree with itself.
//
// What it recognises (NEW-KERNEL-ALLERGY-1, 2026-10-10):
//
//   - the substance as typed: "Penicillin" is found inside "Penicillin V";
//   - plurals and common spellings: "Penicillins", "Amoxycillin", "lignocaine",
//     "acetaminophen" are the same substances as their standard names;
//   - drug families: a penicillin allergy also warns on amoxicillin, ampicillin and
//     Augmentin; sulfa on co-trimoxazole; NSAIDs/aspirin on ibuprofen and
//     diclofenac; local anaesthetics on lidocaine and articaine;
//   - short names, but only the ones in the family list ("ASA", "PCN"): a stray
//     three-letter word is still noise.
//
// A missed warning can hurt a patient and a false alarm costs one click, so the
// families lean towards warning. What it must not do is cry wolf on things that are
// plainly different: a sulfa allergy is not an iron tablet ("ferrous sulfate").
package allergy

import (
	"strings"
	"unicode"
)

// variants maps a spelling to the one this package compares by.
var variants = map[string]string{
	"amoxycillin": "amoxicillin", "amoxycilin": "amoxicillin", "amoxicilin": "amoxicillin",
	"ampicilin": "ampicillin", "penicilin": "penicillin", "pencillin": "penicillin", "penicillen": "penicillin",
	"lignocaine": "lidocaine",
	"sulpha":     "sulfa", "sulphonamide": "sulfonamide", "sulphamethoxazole": "sulfamethoxazole",
	"sulphadiazine": "sulfadiazine", "sulphate": "sulfate",
	"cotrimoxazol":  "cotrimoxazole",
	"acetaminophen": "paracetamol", "panadol": "paracetamol", "tylenol": "paracetamol",
	"epinephrine": "adrenaline", "albuterol": "salbutamol", "indomethacin": "indometacin",
	"cephalexin": "cefalexin", "cefalosporin": "cephalosporin", "cephalosporine": "cephalosporin",
	"aspirine": "aspirin", "metronidazol": "metronidazole",
}

// families lists each drug family's members, matched against the words of a drug
// name: a plain member matches a word that STARTS with it ("penicillin" matches
// "penicillins"); "=name" matches only the whole word ("=asa" must not catch
// "asacol", "=sulfa" must not catch "sulfate"); "name*" is a deliberate short stem
// ("cef*" is every cephalosporin).
var families = map[string][]string{
	"penicillin": {"penicillin", "benzylpenicillin", "phenoxymethylpenicillin", "amoxicillin", "ampicillin",
		"cloxacillin", "flucloxacillin", "dicloxacillin", "oxacillin", "piperacillin", "ticarcillin",
		"augmentin", "amoxiclav", "coamoxiclav", "tazocin", "bicillin", "ampiclox", "unasyn", "=pcn"},
	"cephalosporin": {"cef*", "ceph*", "zinnat", "rocephin", "keflex"},
	"carbapenem":    {"meropenem", "imipenem", "ertapenem", "doripenem", "meronem", "tienam"},
	"sulfonamide": {"=sulfa", "sulfonamide", "sulfamethoxazole", "sulfadiazine", "sulfasalazine",
		"sulfacetamide", "sulfadoxine", "sulfanilamide", "cotrimoxazole", "trimoxazole", "bactrim", "septrin",
		"septra", "fansidar", "salazopyrin"},
	"nsaid": {"ibuprofen", "diclofenac", "naproxen", "ketoprofen", "dexketoprofen", "indometacin", "piroxicam",
		"meloxicam", "tenoxicam", "lornoxicam", "celecoxib", "etoricoxib", "mefenamic", "ketorolac",
		"nimesulide", "aceclofenac", "flurbiprofen", "aspirin", "acetylsalicylic", "=asa", "brufen",
		"voltaren", "cataflam"},
	"macrolide":      {"erythromycin", "azithromycin", "clarithromycin", "roxithromycin", "spiramycin", "josamycin", "zithromax", "klacid"},
	"tetracycline":   {"tetracycline", "doxycycline", "minocycline", "oxytetracycline", "demeclocycline"},
	"quinolone":      {"ciprofloxacin", "levofloxacin", "ofloxacin", "norfloxacin", "moxifloxacin", "gatifloxacin", "nalidixic", "ciprobay", "ciproxin", "tavanic"},
	"nitroimidazole": {"metronidazole", "tinidazole", "ornidazole", "secnidazole", "flagyl"},
	"anaesthetic": {"lidocaine", "articaine", "mepivacaine", "bupivacaine", "levobupivacaine", "prilocaine",
		"ropivacaine", "procaine", "benzocaine", "tetracaine", "chloroprocaine", "xylocaine", "septanest",
		"scandonest", "citanest", "marcaine", "ultracaine", "novocaine", "orabloc", "lignospan"},
	"opioid": {"codeine", "dihydrocodeine", "morphine", "tramadol", "pethidine", "meperidine", "fentanyl",
		"oxycodone", "tapentadol", "hydrocodone", "buprenorphine", "methadone", "nalbuphine"},
}

// aliases maps what a patient's allergy may be called to the families it names. A
// plain substance (an allergy to "ibuprofen") is NOT a family: it matches by name.
var aliases = map[string][]string{
	"penicillin": {"penicillin"}, "pcn": {"penicillin"},
	"betalactam": {"penicillin", "cephalosporin", "carbapenem"}, "lactam": {"penicillin", "cephalosporin", "carbapenem"},
	"cephalosporin": {"cephalosporin"}, "cephalosporins": {"cephalosporin"}, "carbapenem": {"carbapenem"},
	"sulfa": {"sulfonamide"}, "sulfonamide": {"sulfonamide"}, "sulfamethoxazole": {"sulfonamide"},
	"cotrimoxazole": {"sulfonamide"}, "trimoxazole": {"sulfonamide"}, "bactrim": {"sulfonamide"}, "septrin": {"sulfonamide"},
	"nsaid": {"nsaid"}, "aspirin": {"nsaid"}, "asa": {"nsaid"}, "acetylsalicylic": {"nsaid"}, "salicylate": {"nsaid"},
	"antiinflammatory": {"nsaid"},
	"macrolide":        {"macrolide"},
	"tetracycline":     {"tetracycline"}, "cycline": {"tetracycline"},
	"quinolone": {"quinolone"}, "fluoroquinolone": {"quinolone"},
	"nitroimidazole": {"nitroimidazole"}, "metronidazole": {"nitroimidazole"}, "flagyl": {"nitroimidazole"},
	"anaesthetic": {"anaesthetic"}, "anesthetic": {"anaesthetic"}, "anaesthesia": {"anaesthetic"}, "anesthesia": {"anaesthetic"},
	"opioid": {"opioid"}, "opiate": {"opioid"}, "narcotic": {"opioid"},
}

// plainBlocked are words that must NOT also be matched as plain text, because as a
// substring they name something else: "sulfa" is inside "sulfate", an iron tablet.
// They are matched through their family list only.
var plainBlocked = map[string]bool{"sulfa": true}

// filler is what people write around the substance ("Penicillin – severe",
// "allergic to sulfa drugs"); none of it names a drug.
var filler = map[string]bool{
	"allergy": true, "allergic": true, "allergie": true, "drug": true, "medicine": true, "medication": true,
	"tablet": true, "reaction": true, "severe": true, "mild": true, "moderate": true, "history": true,
	"known": true, "rash": true, "anaphylaxis": true,
}

// StandardAllergens is the list every clinic starts with in its allergy picker, so
// staff choose "Penicillins" instead of typing four spellings of it. Free typing
// stays for the unusual ones.
var StandardAllergens = []string{
	"Penicillins", "Cephalosporins", "Sulfa drugs", "NSAIDs", "Aspirin", "Ibuprofen", "Diclofenac",
	"Paracetamol", "Macrolides", "Tetracyclines", "Fluoroquinolones", "Metronidazole", "Codeine",
	"Local anaesthetics", "Lidocaine", "Articaine", "Adrenaline", "Latex", "Iodine", "Chlorhexidine",
	"Eugenol", "Acrylic (methacrylate)", "Nickel", "Egg", "Peanuts", "Shellfish",
}

// words lowercases, splits on anything that is not a letter or digit, and writes
// each word in its standard spelling.
func words(s string) []string {
	ws := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	for i, w := range ws {
		if v, ok := variants[w]; ok {
			ws[i] = v
		}
	}
	return ws
}

// singular drops one plural "s" ("penicillins" -> "penicillin"), leaving short
// words and "ss" words alone.
func singular(w string) string {
	if len(w) >= 5 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") {
		return w[:len(w)-1]
	}
	return w
}

// substance returns the allergy's content words (singular, no filler) and the
// words run together ("beta-lactam" -> "betalactam"), which is how some families
// are written.
func substance(s string) (ws []string, compact string) {
	for _, w := range words(s) {
		w = singular(w)
		if v, ok := variants[w]; ok { // "sulphonamides": plural off first, then the spelling
			w = v
		}
		if filler[w] {
			continue
		}
		ws = append(ws, w)
	}
	return ws, strings.Join(ws, "")
}

// hasMember reports whether any word of the drug is a member of the family.
func hasMember(drugWords []string, family string) bool {
	for _, w := range drugWords {
		for _, m := range families[family] {
			switch {
			case strings.HasPrefix(m, "="):
				if w == m[1:] {
					return true
				}
			case strings.HasSuffix(m, "*"):
				if strings.HasPrefix(w, strings.TrimSuffix(m, "*")) {
					return true
				}
			default:
				if strings.HasPrefix(w, m) {
					return true
				}
			}
		}
	}
	return false
}

// Matches reports whether a drug name looks like a recorded allergy substance: the
// substance itself, a spelling of it, or a member of the drug family it names.
//
// A plain substance word of four letters or more is looked for inside the drug name
// ("Penicillin" is caught by "Penicillin V", "amoxicillin" by "amoxicillin/
// clavulanate"). Words shorter than four letters are ignored — "oil" or "ace" inside
// a longer drug name is noise, and a warning that cries wolf is one a prescriber
// learns to click past — unless they are in the family list ("ASA", "PCN").
func Matches(drug, substanceText string) bool {
	dw := words(drug)
	sw, compact := substance(substanceText)
	if len(dw) == 0 || len(sw) == 0 {
		return false
	}
	named := map[string]bool{}
	for _, key := range append(append([]string{}, sw...), compact) {
		for _, f := range aliases[key] {
			named[f] = true
		}
	}
	for f := range named {
		if hasMember(dw, f) {
			return true
		}
	}
	text := strings.Join(dw, " ")
	for _, w := range sw {
		if len([]rune(w)) >= 4 && !plainBlocked[w] && strings.Contains(text, w) {
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
