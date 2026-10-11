// Package service answers "is this paper genuine?" for a prescription.
//
// Two halves with different trust. Issuing is signed in: the clinic's screen names a
// prescription, and the server builds the snapshot from ITS OWN records, never from
// what the browser says is on the page. Checking is public: whoever holds the paper
// (a pharmacist, an employer) opens a link, with no account. The public half learns
// the clinic from the slug in the link, then reads everything through that clinic's
// ordinary row-level security, so the isolation between clinics is not loosened.
package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/verification"
)

const (
	addisTZ = "Africa/Addis_Ababa"
	// Without 0 O 1 I L: a code is read off paper and typed by a person in a hurry.
	codeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
	maxValidDays = 365
)

var (
	slugRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	tokenRe   = regexp.MustCompile(`^[a-z2-7]{26}$`)
	b32       = base32.StdEncoding.WithPadding(base32.NoPadding)
	errAbsent = apperr.NotFound("PAPER_NOT_FOUND", "this paper could not be found")
)

// Service implements verification.Service.
type Service struct {
	db     *kerneldb.DB
	secret []byte
}

var _ verification.Service = (*Service)(nil)

// New builds the service. secret keys the derivation of tokens: the same
// prescription must give the same QR every time it is printed.
func New(db *kerneldb.DB, secret []byte) *Service { return &Service{db: db, secret: secret} }

func actor(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

// derive gives the token and the short code for one paper. attempt is only ever
// above zero when two papers of one clinic drew the same short code.
func (s *Service) derive(tenant uuid.UUID, kind string, subject uuid.UUID, content string, attempt int) (token, code string) {
	mac := hmac.New(sha256.New, s.secret)
	fmt.Fprintf(mac, "paper-verification/v1|%s|%s|%s|%s|%d", tenant, kind, subject, content, attempt)
	sum := mac.Sum(nil)
	token = strings.ToLower(b32.EncodeToString(sum[:16]))
	var cb strings.Builder
	for _, b := range sum[16:24] {
		cb.WriteByte(codeAlphabet[int(b)%len(codeAlphabet)])
	}
	return token, cb.String()
}

func hashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// --- what was printed ---------------------------------------------------------------

type source struct {
	cancelled   bool
	writtenAt   time.Time
	patientID   uuid.UUID
	first, last string
	gender      string
	age         int
	prescriber  string
	branch      string
	note        string
	ref         string
	meds        []verification.Medicine
	dispensedAt *time.Time
}

// hash is what "the same prescription" means: the same patient and the same lines.
// Anything else (a note, the date) may be touched without making the paper wrong.
func (s *source) hash() string {
	b, _ := json.Marshal(struct {
		P string                  `json:"p"`
		M []verification.Medicine `json:"m"`
	}{s.patientID.String(), s.meds})
	sum := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func loadDental(ctx context.Context, tx pgx.Tx, tid, rxID uuid.UUID) (*source, error) {
	src := &source{}
	var voided *time.Time
	err := tx.QueryRow(ctx, `
		SELECT rx.created_at, rx.voided_at, coalesce(rx.note,''), rx.patient_id,
		       p.first_name, p.last_name, p.gender, date_part('year', age(current_date, p.dob))::int,
		       coalesce(u.full_name,''), coalesce(b.name,'')
		  FROM dental_prescriptions rx
		  JOIN patients p ON p.id = rx.patient_id AND p.tenant_id = rx.tenant_id
		  JOIN treatment_sessions se ON se.id = rx.session_id AND se.tenant_id = rx.tenant_id
		  LEFT JOIN users u ON u.id = rx.created_by AND u.tenant_id = rx.tenant_id
		  LEFT JOIN branches b ON b.id = se.branch_id AND b.tenant_id = rx.tenant_id
		 WHERE rx.tenant_id = $1 AND rx.id = $2`, tid, rxID).
		Scan(&src.writtenAt, &voided, &src.note, &src.patientID, &src.first, &src.last, &src.gender, &src.age, &src.prescriber, &src.branch)
	if err != nil {
		return nil, err
	}
	src.cancelled = voided != nil
	src.ref = "Rx " + tail(id.Encode(id.PrefixDentalRx, rxID), 6)
	rows, err := tx.Query(ctx, `
		SELECT drug_name, coalesce(dose,''), coalesce(frequency,''), coalesce(duration,''), coalesce(instructions,'')
		  FROM dental_prescription_items WHERE tenant_id = $1 AND prescription_id = $2 ORDER BY seq, id`, tid, rxID)
	if err != nil {
		return nil, err
	}
	src.meds, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (m verification.Medicine, e error) {
		e = r.Scan(&m.Name, &m.Dose, &m.Frequency, &m.Duration, &m.Instructions)
		return
	})
	return src, err
}

func loadEncounter(ctx context.Context, tx pgx.Tx, tid, encID uuid.UUID) (*source, error) {
	src := &source{}
	var deleted *time.Time
	err := tx.QueryRow(ctx, `
		SELECT coalesce(e.started_at, e.created_at), e.deleted_at, e.patient_id,
		       p.first_name, p.last_name, p.gender, date_part('year', age(current_date, p.dob))::int,
		       coalesce(u.full_name,''), coalesce(b.name,'')
		  FROM encounters e
		  JOIN patients p ON p.id = e.patient_id AND p.tenant_id = e.tenant_id
		  LEFT JOIN users u ON u.id = e.provider_id AND u.tenant_id = e.tenant_id
		  LEFT JOIN branches b ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
		 WHERE e.tenant_id = $1 AND e.id = $2`, tid, encID).
		Scan(&src.writtenAt, &deleted, &src.patientID, &src.first, &src.last, &src.gender, &src.age, &src.prescriber, &src.branch)
	if err != nil {
		return nil, err
	}
	src.ref = "Rx " + tail(id.Encode(id.PrefixEncounter, encID), 6)
	rows, err := tx.Query(ctx, `
		SELECT i.drug_name, coalesce(i.dose,''), coalesce(i.frequency,''), coalesce(i.duration,''), coalesce(i.instructions,'')
		  FROM prescription_items i
		  JOIN prescriptions p ON p.id = i.prescription_id AND p.tenant_id = i.tenant_id
		 WHERE p.tenant_id = $1 AND p.encounter_id = $2 AND p.deleted_at IS NULL AND p.status = 'active'
		 ORDER BY i.created_at, i.id`, tid, encID)
	if err != nil {
		return nil, err
	}
	if src.meds, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (m verification.Medicine, e error) {
		e = r.Scan(&m.Name, &m.Dose, &m.Frequency, &m.Duration, &m.Instructions)
		return
	}); err != nil {
		return nil, err
	}
	// Withdrawn means the whole consultation went, or every line was taken off.
	src.cancelled = deleted != nil || len(src.meds) == 0
	err = tx.QueryRow(ctx, `
		SELECT CASE WHEN count(*) > 0 AND bool_and(dispensed_at IS NOT NULL) THEN max(dispensed_at) END
		  FROM prescriptions WHERE tenant_id = $1 AND encounter_id = $2 AND deleted_at IS NULL AND status = 'active'`,
		tid, encID).Scan(&src.dispensedAt)
	return src, err
}

func load(ctx context.Context, tx pgx.Tx, tid uuid.UUID, kind string, subject uuid.UUID) (*source, error) {
	if kind == verification.KindDentalRx {
		return loadDental(ctx, tx, tid, subject)
	}
	return loadEncounter(ctx, tx, tid, subject)
}

// --- the clinic's printing choices ---------------------------------------------------

type prefs struct {
	clinicName string
	showDoctor bool
	validDays  int
	hasLogo    bool
}

// readPrefs reads the two choices the clinic made in Settings > Printing that decide
// what the check page may say: whether a doctor's name goes on this paper, and how
// many days a prescription stays valid. The shape is owned by the front end; this
// reads only the keys it needs and falls back to the safe default for the rest.
func readPrefs(ctx context.Context, tx pgx.Tx, tid uuid.UUID) (prefs, error) {
	p := prefs{showDoctor: true}
	var raw []byte
	var logo *string
	err := tx.QueryRow(ctx, `
		SELECT coalesce(ps.settings, '{}'::jsonb), nullif(ps.logo, ''),
		       coalesce((SELECT name FROM clinics WHERE tenant_id = $1 AND deleted_at IS NULL LIMIT 1),
		                (SELECT name FROM tenants WHERE id = $1))
		  FROM (SELECT 1) one LEFT JOIN print_settings ps ON ps.tenant_id = $1`, tid).Scan(&raw, &logo, &p.clinicName)
	if err != nil {
		return p, err
	}
	p.hasLogo = logo != nil
	var doc struct {
		Identity struct {
			NameEn string `json:"nameEn"`
		} `json:"identity"`
		Signature struct {
			ShowName *bool `json:"showName"`
		} `json:"signature"`
		Docs map[string]struct {
			Show map[string]bool   `json:"show"`
			Text map[string]string `json:"text"`
		} `json:"docs"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return p, nil
	}
	if n := strings.TrimSpace(doc.Identity.NameEn); n != "" {
		p.clinicName = n
	}
	if doc.Signature.ShowName != nil {
		p.showDoctor = *doc.Signature.ShowName
	}
	rx := doc.Docs["prescription"]
	if v, ok := rx.Show["signerName"]; ok {
		p.showDoctor = v
	}
	var n int
	if _, e := fmt.Sscanf(strings.TrimSpace(rx.Text["validDays"]), "%d", &n); e == nil && n > 0 {
		p.validDays = min(n, maxValidDays)
	}
	return p, nil
}

// --- issue ---------------------------------------------------------------------------

type snapshot struct {
	Clinic     string                  `json:"clinic"`
	Branch     string                  `json:"branch,omitempty"`
	WrittenAt  time.Time               `json:"written_at"`
	Patient    verification.Patient    `json:"patient"`
	Prescriber string                  `json:"prescriber,omitempty"`
	Medicines  []verification.Medicine `json:"medicines"`
	Note       string                  `json:"note,omitempty"`
}

func (s *Service) Issue(ctx context.Context, kind string, subjectID uuid.UUID) (*verification.Issued, error) {
	if kind != verification.KindDentalRx && kind != verification.KindEncounterRx {
		return nil, apperr.Validation("this kind of paper cannot be verified")
	}
	tid, user := actor(ctx)
	var out *verification.Issued
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		src, e := load(ctx, tx, tid, kind, subjectID)
		if e != nil {
			return e
		}
		if len(src.meds) == 0 {
			return apperr.Validation("there is nothing on this prescription to verify yet")
		}
		pr, e := readPrefs(ctx, tx, tid)
		if e != nil {
			return e
		}
		snap := snapshot{
			Clinic: pr.clinicName, Branch: src.branch, WrittenAt: src.writtenAt,
			Patient:   verification.Patient{Name: displayName(src.first, src.last), Age: src.age, Gender: src.gender},
			Medicines: src.meds, Note: src.note,
		}
		if pr.showDoctor {
			snap.Prescriber = src.prescriber
		}
		body, _ := json.Marshal(snap)
		var validDays *int
		if pr.validDays > 0 {
			validDays = &pr.validDays
		}
		var slug string
		if e := tx.QueryRow(ctx, `SELECT slug FROM tenants WHERE id = $1`, tid).Scan(&slug); e != nil {
			return e
		}
		content := src.hash()
		for attempt := 0; attempt < 4; attempt++ {
			token, code := s.derive(tid, kind, subjectID, content, attempt)
			th := hashToken(token)
			// Printing the same paper again finds its own row: a copy, not a new paper.
			// The snapshot is refreshed so a changed printing choice (the doctor's name,
			// the validity) reaches the page the paper opens.
			var haveCode, haveRef string
			e := tx.QueryRow(ctx, `
				UPDATE paper_verifications SET snapshot = $2, valid_days = $3
				 WHERE token_hash = $1 RETURNING code, ref`, th, body, validDays).Scan(&haveCode, &haveRef)
			if e == nil {
				out = issued(slug, token, haveCode, haveRef)
				return nil
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			ct, e := tx.Exec(ctx, `
				INSERT INTO paper_verifications (tenant_id, kind, subject_id, token_hash, code, ref, content_hash, snapshot, valid_days, issued_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
				tid, kind, subjectID, th, code, src.ref, content, body, validDays, user)
			if e != nil {
				return e
			}
			if ct.RowsAffected() == 1 {
				out = issued(slug, token, code, src.ref)
				return nil
			}
			// Another paper of this clinic already holds that short code: draw again.
		}
		return errors.New("could not find a free verification code")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("PRESCRIPTION_NOT_FOUND", "prescription not found")
	}
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func issued(slug, token, code, ref string) *verification.Issued {
	return &verification.Issued{Token: token, Slug: slug, Path: "/v/" + slug + "/" + token, Code: pretty(code), Ref: ref}
}

// pretty prints a code in two halves, which is how it is read aloud and typed.
func pretty(code string) string {
	if len(code) == 8 {
		return code[:4] + "-" + code[4:]
	}
	return code
}

func displayName(first, last string) string {
	first, last = strings.TrimSpace(first), strings.TrimSpace(last)
	if last == "" {
		return first
	}
	return first + " " + strings.ToUpper(string([]rune(last)[:1])) + "."
}

// --- check ---------------------------------------------------------------------------

type row struct {
	id        uuid.UUID
	kind      string
	subject   uuid.UUID
	content   string
	ref       string
	snap      []byte
	validDays *int
	issuedAt  time.Time
	prevScans int
	firstScan *time.Time
	lastScan  *time.Time
}

func (s *Service) Check(ctx context.Context, slug, token string) (*verification.Result, error) {
	token = strings.ToLower(strings.TrimSpace(token))
	if !slugRe.MatchString(slug) || !tokenRe.MatchString(token) {
		return nil, errAbsent
	}
	return s.look(ctx, slug, `v.token_hash = $1`, hashToken(token))
}

func (s *Service) ByCode(ctx context.Context, slug, code string) (*verification.Result, error) {
	code = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
	if !slugRe.MatchString(slug) || len(code) != 8 || strings.Trim(code, codeAlphabet) != "" {
		return nil, errAbsent
	}
	return s.look(ctx, slug, `v.code = $1`, code)
}

// look finds the paper, counts the look, and answers from the live record.
func (s *Service) look(ctx context.Context, slug, where string, arg any) (*verification.Result, error) {
	var tid uuid.UUID
	err := s.db.Pool.QueryRow(ctx, `SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL`, slug).Scan(&tid)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errAbsent
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	var res *verification.Result
	err = s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		var r row
		e := tx.QueryRow(ctx, `
			WITH old AS (SELECT * FROM paper_verifications v WHERE `+where+` FOR UPDATE)
			UPDATE paper_verifications v
			   SET scans = v.scans + 1, first_scan_at = coalesce(v.first_scan_at, now()), last_scan_at = now()
			  FROM old WHERE v.id = old.id
			RETURNING v.id, v.kind, v.subject_id, v.content_hash, v.ref, v.snapshot, v.valid_days, v.issued_at,
			          old.scans, old.first_scan_at, old.last_scan_at`, arg).
			Scan(&r.id, &r.kind, &r.subject, &r.content, &r.ref, &r.snap, &r.validDays, &r.issuedAt,
				&r.prevScans, &r.firstScan, &r.lastScan)
		if e != nil {
			return e
		}
		res, e = s.answer(ctx, tx, tid, slug, r)
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errAbsent
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return res, nil
}

func (s *Service) answer(ctx context.Context, tx pgx.Tx, tid uuid.UUID, slug string, r row) (*verification.Result, error) {
	var snap snapshot
	if err := json.Unmarshal(r.snap, &snap); err != nil {
		return nil, err
	}
	src, err := load(ctx, tx, tid, r.kind, r.subject)
	gone := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !gone {
		return nil, err
	}
	pr, err := readPrefs(ctx, tx, tid)
	if err != nil {
		return nil, err
	}
	loc, lerr := time.LoadLocation(addisTZ)
	if lerr != nil {
		loc = time.FixedZone("EAT", 3*60*60)
	}
	now := time.Now().In(loc)
	written := snap.WrittenAt.In(loc)
	res := &verification.Result{
		Kind: r.kind, Ref: r.ref, Clinic: snap.Clinic, Branch: snap.Branch, Slug: slug, HasLogo: pr.hasLogo,
		WrittenAt: written.Format("2006-01-02"), DaysAgo: calendarDays(written, now),
		Checks: verification.Checks{Before: r.prevScans, FirstAt: ts(r.firstScan), LastAt: ts(r.lastScan)},
	}
	switch {
	case gone || src.cancelled:
		res.Status = verification.StatusCancelled
	case src.hash() != r.content:
		res.Status = verification.StatusSuperseded
	default:
		res.Status = verification.StatusGenuine
		if r.validDays != nil {
			until := written.AddDate(0, 0, *r.validDays)
			u := until.Format("2006-01-02")
			res.ValidUntil = &u
			if midnight(now).After(midnight(until)) {
				res.Status = verification.StatusExpired
			}
		}
	}
	// A paper that was withdrawn or replaced shows no medicines: nobody should
	// dispense from it, and the screen must not be a second copy of a dead prescription.
	if res.Status == verification.StatusGenuine || res.Status == verification.StatusExpired {
		p := snap.Patient
		res.Patient, res.Prescriber, res.Medicines, res.Note = &p, snap.Prescriber, snap.Medicines, snap.Note
		if src != nil && src.dispensedAt != nil {
			d := src.dispensedAt.In(loc).Format(time.RFC3339)
			res.DispensedAt = &d
		}
	}
	return res, nil
}

func ts(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func midnight(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

func calendarDays(from, to time.Time) int {
	d := int(midnight(to).Sub(midnight(from)).Hours() / 24)
	if d < 0 {
		return 0
	}
	return d
}

// --- logo ----------------------------------------------------------------------------

func (s *Service) Logo(ctx context.Context, slug string) (string, []byte, error) {
	if !slugRe.MatchString(slug) {
		return "", nil, errAbsent
	}
	var tid uuid.UUID
	if err := s.db.Pool.QueryRow(ctx, `SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL`, slug).Scan(&tid); err != nil {
		return "", nil, errAbsent
	}
	var logo *string
	err := s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT nullif(logo, '') FROM print_settings WHERE tenant_id = $1`, tid).Scan(&logo)
	})
	if err != nil || logo == nil {
		return "", nil, errAbsent
	}
	// A data URL: data:image/png;base64,....
	head, b64, ok := strings.Cut(*logo, ",")
	if !ok || !strings.HasPrefix(head, "data:image/") || !strings.HasSuffix(head, ";base64") {
		return "", nil, errAbsent
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", nil, errAbsent
	}
	return strings.TrimSuffix(strings.TrimPrefix(head, "data:"), ";base64"), data, nil
}
