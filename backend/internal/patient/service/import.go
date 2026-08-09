// Legacy register import: bulk-load patient master data from a clinic's old
// paper/Excel sheet. Those sheets are one row per VISIT (so the same patient
// recurs), store an age rather than a birthdate, and mix date formats freely —
// including raw Excel serial numbers. Everything here exists to absorb that mess
// without letting it into the database, and without one bad row stopping the run.
package service

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/ethiopian"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/patient"
)

// maxImportRows caps a single request so a runaway file can't exhaust memory.
// The client sends larger files in batches and merges the reports.
const maxImportRows = 2000

// Calendars a source sheet may be written in. Local registers keep dates in the
// Ethiopian calendar, so that is the default; the stored value is always Gregorian.
const (
	calEthiopian = "ethiopian"
	calGregorian = "gregorian"
)

// nameSimilarity is the pg_trgm threshold for the fuzzy name rule. 0.75 catches a
// realistic single-letter misspelling ("Kebede" vs "Kebedde" scores ~0.79) while
// staying well clear of merely-related names. It is only ever applied together
// with a close birth year (see findExisting) — on its own a name this loose would
// happily merge two different people, which is far worse than a duplicate row.
const nameSimilarity = 0.75

// fuzzyYearSlack bounds how far apart two birth years may be for the fuzzy name
// rule to still call it the same person. Register ages are rounded, hence > 0.
const fuzzyYearSlack = 2

var (
	spaces   = regexp.MustCompile(`\s+`)
	nonDigit = regexp.MustCompile(`\D`)
)

// --- cleaning ---

func cleanSpace(s string) string { return spaces.ReplaceAllString(strings.TrimSpace(s), " ") }

// titleName normalises SHOUTED or lower-case register entries to "Abebe Kebede".
// A letter is capitalised when it opens a word, so hyphenated and apostrophe
// names come out right too: "mary-jane o'brien" → "Mary-Jane O'Brien". Scripts
// without case (Ge'ez) pass through untouched.
func titleName(s string) string {
	s = cleanSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	atWordStart := true
	for _, r := range strings.ToLower(s) {
		if atWordStart && unicode.IsLetter(r) {
			b.WriteRune(unicode.ToUpper(r))
			atWordStart = false
			continue
		}
		b.WriteRune(r)
		atWordStart = r == ' ' || r == '-' || r == '\''
	}
	return b.String()
}

// splitFullName maps the sheet's single Name column onto first/middle/last.
// Ethiopian names are given-name + father's name (+ grandfather's), so the first
// token is the given name and the last token is the family/grandfather name;
// anything between becomes the middle name.
func splitFullName(full string) (first, middle, last string) {
	parts := strings.Fields(titleName(full))
	switch len(parts) {
	case 0:
		return "", "", ""
	case 1:
		return parts[0], "", "" // mononym — keep it honest rather than inventing a surname
	case 2:
		return parts[0], "", parts[1]
	default:
		return parts[0], strings.Join(parts[1:len(parts)-1], " "), parts[len(parts)-1]
	}
}

// normalizePhone reduces a phone to comparable digits so duplicate matching works
// across "0911 22 33 44", "+251911223344" and "251911223344". Ethiopian numbers
// are normalised to local 0-prefixed form; anything else keeps its + country code.
func normalizePhone(raw string) (string, error) {
	s := cleanSpace(raw)
	if s == "" {
		return "", nil
	}
	plus := strings.HasPrefix(s, "+") || strings.HasPrefix(s, "00")
	d := nonDigit.ReplaceAllString(s, "")
	if d == "" {
		return "", fmt.Errorf("phone %q has no digits", raw)
	}
	d = strings.TrimPrefix(d, "00")
	switch {
	case strings.HasPrefix(d, "251") && len(d) == 12: // +251 9xx xxx xxx → 09xx xxx xxx
		return "0" + d[3:], nil
	case len(d) == 9 && (strings.HasPrefix(d, "9") || strings.HasPrefix(d, "7")): // missing trunk 0
		return "0" + d, nil
	case len(d) == 10 && strings.HasPrefix(d, "0"):
		return d, nil
	}
	if len(d) < 7 || len(d) > 15 { // ITU E.164 bounds — anything outside is a typo
		return "", fmt.Errorf("phone %q is not a valid number", raw)
	}
	if plus {
		return "+" + d, nil
	}
	return d, nil
}

// normalizeGender maps the register's free text onto the schema's enum.
func normalizeGender(raw string) (string, bool) {
	switch strings.ToLower(cleanSpace(raw)) {
	case "m", "male", "man", "boy", "ወ": // ወንድ
		return "male", true
	case "f", "female", "woman", "girl", "fe", "ሴ": // ሴት
		return "female", true
	case "o", "other":
		return "other", true
	case "":
		return "unknown", false // absent, not invalid — imported as unknown and counted
	}
	return "", false
}

func parseAge(raw string) (int, bool) {
	s := cleanSpace(raw)
	if s == "" {
		return 0, false
	}
	// Tolerate "34 yrs", "34y", "6 months".
	if m := regexp.MustCompile(`(?i)^(\d+)\s*(m|mo|month|months)$`).FindStringSubmatch(s); m != nil {
		return 0, true // under a year → age 0
	}
	digits := regexp.MustCompile(`\d+`).FindString(s)
	if digits == "" {
		return 0, false
	}
	n, err := strconv.Atoi(digits)
	if err != nil || n < 0 || n > 130 {
		return 0, false
	}
	return n, true
}

// --- dates ---

// excelEpoch is Excel's day 0. Excel wrongly treats 1900 as a leap year, so serial
// 1 is 1900-01-01 when counted from 1899-12-30 — the conventional correction.
var excelEpoch = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)

var dateSeps = regexp.MustCompile(`[/\\.\-\s]+`)

// parseFlexibleDate accepts every shape a clinic spreadsheet throws at us:
// 13/06/2017, 13-06-2017, 13\06\2017, 2017-06-13, 13.06.2017 and Excel serials
// (42922). Day-first is assumed for ambiguous dd/mm vs mm/dd, matching Ethiopian
// and European convention; an unambiguous component confirms it.
//
// cal says which calendar the SHEET is written in. Ethiopian registers are the
// norm here, so the numbers are read as Ethiopian and converted to the Gregorian
// date we store. Note an Excel serial is always a Gregorian serial internally —
// but the operator typed Ethiopian numbers into that cell, so we take the
// serial's y/m/d back apart and reinterpret them in the sheet's calendar.
func parseFlexibleDate(raw, cal string) (time.Time, error) {
	s := cleanSpace(raw)
	if s == "" {
		return time.Time{}, fmt.Errorf("empty date")
	}
	// Excel serial: a bare number. 20000 ≈ 1954, 60000 ≈ 2064 — outside that it's
	// not a date, it's a stray figure from another column.
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		if n < 20000 || n > 60000 {
			return time.Time{}, fmt.Errorf("%q is not a recognisable date", raw)
		}
		g := excelEpoch.AddDate(0, 0, int(n))
		return finishDate(g.Year(), int(g.Month()), g.Day(), cal, raw)
	}
	parts := dateSeps.Split(s, -1)
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("%q is not a recognisable date", raw)
	}
	a, e1 := strconv.Atoi(parts[0])
	b, e2 := strconv.Atoi(parts[1])
	c, e3 := strconv.Atoi(parts[2])
	if e1 != nil || e2 != nil || e3 != nil {
		return time.Time{}, fmt.Errorf("%q is not a recognisable date", raw)
	}
	// Highest month number that can't be a day: 12 Gregorian, 13 Ethiopian.
	maxMonth := 12
	if cal == calEthiopian {
		maxMonth = 13
	}
	var y, m, d int
	if a > 31 { // 2017-06-13 — only a year can exceed 31, so it leads
		y, m, d = a, b, c
	} else {
		// Year last: 13/06/2017, and the very common short form 13/6/17 where the
		// year is two digits and no component gives itself away by being > 31.
		y = c
		switch {
		case a > maxMonth: // 13/06 → day first, unambiguous
			d, m = a, b
		case b > maxMonth: // 06/13 → month first
			m, d = a, b
		default: // ambiguous → day-first by convention
			d, m = a, b
		}
	}
	if y < 100 { // 2-digit year: 17 → 2017, 98 → 1998
		if y > 50 {
			y += 1900
		} else {
			y += 2000
		}
	}
	return finishDate(y, m, d, cal, raw)
}

// finishDate validates y/m/d in the sheet's calendar and returns the Gregorian
// date to store.
func finishDate(y, m, d int, cal, raw string) (time.Time, error) {
	if cal == calEthiopian {
		if y < 1800 || y > 2200 {
			return time.Time{}, fmt.Errorf("%q is not a valid Ethiopian date", raw)
		}
		t, err := ethiopian.ToGregorian(y, m, d)
		if err != nil {
			return time.Time{}, fmt.Errorf("%q is not a valid Ethiopian date: %w", raw, err)
		}
		return t, nil
	}
	if m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200 {
		return time.Time{}, fmt.Errorf("%q is not a valid date", raw)
	}
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
	if t.Day() != d || int(t.Month()) != m { // rejects 31/02
		return time.Time{}, fmt.Errorf("%q is not a real calendar date", raw)
	}
	return t, nil
}

// --- the import ---

// prepared is one row that passed validation, ready to write.
type prepared struct {
	first, middle, last string
	fullName            string
	phone               string
	gender              string
	dob                 time.Time
	dobEstimated        bool
	firstVisit          *time.Time
	mrn                 string
	warning             string
}

// validateRow cleans and checks a raw row, returning either a prepared record or
// a human-readable reason the clinic's staff can act on. cal is the calendar the
// sheet's dates are written in (Ethiopian by default for local registers).
func validateRow(r patient.ImportRow, cal string) (*prepared, string) {
	p := &prepared{}
	p.fullName = titleName(r.Name)
	if p.fullName == "" {
		return nil, "Missing patient name"
	}
	p.first, p.middle, p.last = splitFullName(r.Name)

	phone, err := normalizePhone(r.Phone)
	if err != nil {
		return nil, "Invalid phone number format"
	}
	p.phone = phone

	gender, ok := normalizeGender(r.Gender)
	if !ok && cleanSpace(r.Gender) != "" {
		return nil, fmt.Sprintf("Invalid gender value %q", cleanSpace(r.Gender))
	}
	if gender == "" {
		gender = "unknown"
	}
	p.gender = gender

	// Visit date is optional, but when present it both back-dates the registration
	// and anchors the age → birth-year maths.
	if cleanSpace(r.VisitDate) != "" {
		v, err := parseFlexibleDate(r.VisitDate, cal)
		if err != nil {
			return nil, "Invalid date format in Date of Visit"
		}
		if v.After(time.Now().AddDate(0, 0, 1)) {
			return nil, "Date of Visit is in the future"
		}
		p.firstVisit = &v
	}

	// The schema requires a birthdate; legacy sheets carry an age. Derive the birth
	// year from the age AS AT THE VISIT (not today), which is materially more
	// accurate for a register that is years old.
	age, hasAge := parseAge(r.Age)
	if !hasAge {
		if cleanSpace(r.Age) != "" {
			return nil, fmt.Sprintf("Invalid age %q", cleanSpace(r.Age))
		}
		return nil, "Missing age (a birth year is required to create a patient)"
	}
	base := time.Now().UTC()
	if p.firstVisit != nil {
		base = *p.firstVisit
	}
	p.dob = time.Date(base.Year()-age, 1, 1, 0, 0, 0, 0, time.UTC)
	p.dobEstimated = true
	p.warning = fmt.Sprintf("Birthdate estimated from age %d", age)
	p.mrn = cleanSpace(r.MRN)
	return p, ""
}

// ImportPatients loads a legacy register. Each row runs in its own transaction so
// a failure is isolated: the row is reported and the run continues.
func (s *Service) ImportPatients(ctx context.Context, rows []patient.ImportRow, opts patient.ImportOptions) (*patient.ImportReport, error) {
	if len(rows) == 0 {
		return nil, apperr.Validation("no rows to import")
	}
	if len(rows) > maxImportRows {
		return nil, apperr.Validation(fmt.Sprintf("send at most %d rows per request", maxImportRows))
	}
	if opts.OnDuplicate != patient.DuplicateUpdate {
		opts.OnDuplicate = patient.DuplicateSkip
	}
	if opts.Calendar != calGregorian {
		opts.Calendar = calEthiopian // local registers are Ethiopian unless stated otherwise
	}
	rep := &patient.ImportReport{Total: len(rows), DryRun: opts.DryRun, Rows: make([]patient.ImportRowResult, 0, len(rows))}

	// A dry run writes nothing, so rows can't see each other through the database.
	// Track identities in memory instead, otherwise a register that repeats a
	// patient once per visit would report every copy as importable.
	seenPhone := map[string]int{}
	seenName := map[string]int{}

	for _, r := range rows {
		res := patient.ImportRowResult{
			RowNumber: r.RowNumber, Name: cleanSpace(r.Name), Phone: cleanSpace(r.Phone),
			Gender: cleanSpace(r.Gender), Age: cleanSpace(r.Age), VisitDate: cleanSpace(r.VisitDate),
		}
		if cleanSpace(r.Phone) == "" {
			rep.MissingPhone++
		}
		if _, ok := normalizeGender(r.Gender); !ok && cleanSpace(r.Gender) == "" {
			rep.MissingGender++
		}

		p, reason := validateRow(r, opts.Calendar)
		if p == nil {
			res.Outcome = patient.OutcomeFailed
			res.Reason = reason
			rep.Failed++
			rep.Rows = append(rep.Rows, res)
			continue
		}
		res.Warning = p.warning

		// Within-request duplicate (dry run only — a real run sees committed rows).
		if opts.DryRun {
			key := strings.ToLower(p.fullName)
			if p.phone != "" {
				if prev, dup := seenPhone[p.phone]; dup {
					res.Outcome, res.Reason = patient.OutcomeDuplicate, fmt.Sprintf("Same phone as row %d in this file", prev)
					rep.Duplicates++
					rep.Rows = append(rep.Rows, res)
					continue
				}
				seenPhone[p.phone] = r.RowNumber
			}
			if prev, dup := seenName[key]; dup && p.phone == "" {
				res.Outcome, res.Reason = patient.OutcomeDuplicate, fmt.Sprintf("Same name as row %d in this file", prev)
				rep.Duplicates++
				rep.Rows = append(rep.Rows, res)
				continue
			}
			seenName[key] = r.RowNumber
		}

		outcome, mrn, reason, err := s.importOne(ctx, p, opts)
		if err != nil {
			res.Outcome = patient.OutcomeFailed
			if ae, ok := apperr.As(err); ok {
				res.Reason = ae.Message
			} else {
				res.Reason = "Unexpected processing error"
			}
			rep.Failed++
			rep.Rows = append(rep.Rows, res)
			continue
		}
		res.Outcome, res.MRN, res.Reason = outcome, mrn, reason
		switch outcome {
		case patient.OutcomeImported:
			rep.Imported++
			if p.dobEstimated {
				rep.EstimatedDOB++
			}
		case patient.OutcomeUpdated:
			rep.Updated++
		case patient.OutcomeDuplicate:
			rep.Duplicates++
		}
		rep.Rows = append(rep.Rows, res)
	}
	return rep, nil
}

// importOne handles a single validated row inside its own transaction.
func (s *Service) importOne(ctx context.Context, p *prepared, opts patient.ImportOptions) (outcome, mrn, reason string, err error) {
	tenantID, createdBy := actor(ctx)
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		existingID, existingMRN, how, e := findExisting(ctx, tx, tenantID, p)
		if e != nil {
			return e
		}
		if existingID != uuid.Nil {
			if opts.OnDuplicate == patient.DuplicateSkip {
				outcome, mrn, reason = patient.OutcomeDuplicate, existingMRN, "Already on file — matched by "+how
				return nil
			}
			if opts.DryRun {
				outcome, mrn, reason = patient.OutcomeUpdated, existingMRN, "Would update the patient matched by "+how
				return nil
			}
			// Update only the columns this import owns; never blank a field the
			// clinic has since filled in from a better source.
			if _, e := tx.Exec(ctx,
				`UPDATE patients SET
				   first_name = $3, middle_name = NULLIF($4,''), last_name = $5,
				   gender = CASE WHEN $6 = 'unknown' THEN gender ELSE $6 END,
				   phone = CASE WHEN $7 = '' THEN phone ELSE $7 END,
				   first_visit_date = LEAST(coalesce(first_visit_date, $8::date), $8::date),
				   updated_at = now()
				 WHERE tenant_id = $1 AND id = $2`,
				tenantID, existingID, p.first, p.middle, p.last, p.gender, p.phone, dateOrNil(p.firstVisit)); e != nil {
				return e
			}
			outcome, mrn, reason = patient.OutcomeUpdated, existingMRN, "Updated the patient matched by "+how
			return nil
		}

		if e := limits.EnsurePatientRoom(ctx, tx, tenantID); e != nil {
			return e
		}
		if opts.DryRun {
			outcome, mrn = patient.OutcomeImported, p.mrn
			return nil
		}

		newMRN := p.mrn
		if newMRN == "" {
			var seq int64
			if e := tx.QueryRow(ctx,
				`INSERT INTO mrn_counters (tenant_id, last_value) VALUES ($1, 1)
				 ON CONFLICT (tenant_id) DO UPDATE SET last_value = mrn_counters.last_value + 1
				 RETURNING last_value`, tenantID).Scan(&seq); e != nil {
				return e
			}
			newMRN = fmt.Sprintf("P%06d", seq)
		}
		var newID uuid.UUID
		if e := tx.QueryRow(ctx,
			`INSERT INTO patients (tenant_id, mrn, first_name, middle_name, last_name, gender, dob,
			                       phone, first_visit_date, dob_estimated, created_by)
			 VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,NULLIF($8,''),$9,$10,$11) RETURNING id`,
			tenantID, newMRN, p.first, p.middle, p.last, p.gender, p.dob,
			p.phone, dateOrNil(p.firstVisit), p.dobEstimated, createdBy).Scan(&newID); e != nil {
			return e
		}
		outcome, mrn = patient.OutcomeImported, newMRN
		return s.publisher.Publish(ctx, tx, &tenantID, "patient", newID, "patient.patient.registered",
			map[string]any{"patient_id": newID, "mrn": newMRN, "source": "legacy_import"})
	})
	if err != nil {
		if ae, ok := apperr.As(err); ok {
			return "", "", "", ae
		}
		// A reused legacy card ID is the one collision worth naming precisely.
		if strings.Contains(err.Error(), "idx_patients_mrn") {
			return "", "", "", apperr.Conflict("MRN_TAKEN", "Card ID "+p.mrn+" is already used by another patient")
		}
		return "", "", "", apperr.Internal(err)
	}
	return outcome, mrn, reason, nil
}

func dateOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

// findExisting applies the three duplicate rules in priority order: phone, then
// name + age, then a strict fuzzy name match. Returns the matched patient and a
// plain-English description of which rule fired, for the report.
func findExisting(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID, p *prepared) (uuid.UUID, string, string, error) {
	var id uuid.UUID
	var mrn string

	// 1 — phone is the strongest signal a clinic register carries.
	if p.phone != "" {
		e := tx.QueryRow(ctx,
			`SELECT id, mrn FROM patients
			 WHERE tenant_id = $1 AND deleted_at IS NULL AND phone = $2 LIMIT 1`,
			tenantID, p.phone).Scan(&id, &mrn)
		if e == nil {
			return id, mrn, "phone number", nil
		}
		if e != pgx.ErrNoRows {
			return uuid.Nil, "", "", e
		}
	}

	// 2 — same name and a birth year within a year (ages in registers are rounded).
	e := tx.QueryRow(ctx,
		`SELECT id, mrn FROM patients
		 WHERE tenant_id = $1 AND deleted_at IS NULL
		   AND lower(first_name) = lower($2) AND lower(coalesce(last_name,'')) = lower($3)
		   AND abs(extract(year FROM dob) - $4::int) <= 1
		 LIMIT 1`,
		tenantID, p.first, p.last, p.dob.Year()).Scan(&id, &mrn)
	if e == nil {
		return id, mrn, "name and age", nil
	}
	if e != pgx.ErrNoRows {
		return uuid.Nil, "", "", e
	}

	// 3 — fuzzy name (typos, transposed spellings), but only when the age agrees
	// too. Name alone at this threshold would merge distinct people; requiring a
	// close birth year makes a false positive very unlikely. Uses the trigram index.
	e = tx.QueryRow(ctx,
		`SELECT id, mrn FROM patients
		 WHERE tenant_id = $1 AND deleted_at IS NULL
		   AND abs(extract(year FROM dob) - $4::int) <= $5
		   AND similarity(lower(first_name || ' ' || coalesce(last_name,'')), lower($2)) >= $3
		 ORDER BY similarity(lower(first_name || ' ' || coalesce(last_name,'')), lower($2)) DESC
		 LIMIT 1`,
		tenantID, p.fullName, nameSimilarity, p.dob.Year(), fuzzyYearSlack).Scan(&id, &mrn)
	if e == nil {
		return id, mrn, "a very similar name and a matching age", nil
	}
	if e != pgx.ErrNoRows {
		return uuid.Nil, "", "", e
	}
	return uuid.Nil, "", "", nil
}
