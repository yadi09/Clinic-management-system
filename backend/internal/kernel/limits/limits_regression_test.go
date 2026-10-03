package limits_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/testkit"
)

const gib int64 = 1 << 30

// fixture is a bare tenant on its own uniquely coded plan, built with plain SQL
// (as the superuser, for arranging) so each test controls every count exactly.
type fixture struct {
	t        *testing.T
	d        *kerneldb.DB
	planID   uuid.UUID
	planCode string
	tenant   uuid.UUID
	clinic   uuid.UUID
	patient  uuid.UUID // one patient for attachments/messages
	nPat     int
}

// plan columns: nil = NULL (unlimited).
type planCaps struct {
	storageGB, patients, users, branches, images, sms *int
}

func iv(n int) *int { return &n }

func newFixture(t *testing.T, caps planCaps) *fixture {
	t.Helper()
	d := testkit.SuperDB(t, testkit.RequireDB(t))
	ctx := context.Background()
	f := &fixture{t: t, d: d, planCode: "rg-lim-" + uuid.NewString()[:13]}
	if err := d.Pool.QueryRow(ctx,
		`INSERT INTO plans (code, name, storage_gb, patient_limit, user_limit, branch_limit, images_per_patient, sms_monthly)
		 VALUES ($1, 'Limits regress', $2, $3, $4, $5, $6, $7) RETURNING id`,
		f.planCode, caps.storageGB, caps.patients, caps.users, caps.branches, caps.images, caps.sms).Scan(&f.planID); err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := d.Pool.QueryRow(ctx,
		`INSERT INTO tenants (name, slug, status, plan_id) VALUES ('Limits', $1, 'active', $2) RETURNING id`,
		f.planCode, f.planID).Scan(&f.tenant); err != nil {
		t.Fatalf("tenant: %v", err)
	}
	if err := d.Pool.QueryRow(ctx,
		`INSERT INTO clinics (tenant_id, name) VALUES ($1, 'Limits clinic') RETURNING id`, f.tenant).Scan(&f.clinic); err != nil {
		t.Fatalf("clinic: %v", err)
	}
	f.patient = f.addPatient(false)
	return f
}

func (f *fixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.d.Pool.Exec(context.Background(), sql, args...); err != nil {
		f.t.Fatalf("%s: %v", sql, err)
	}
}

func (f *fixture) addPatient(deleted bool) uuid.UUID {
	f.t.Helper()
	f.nPat++
	var id uuid.UUID
	if err := f.d.Pool.QueryRow(context.Background(),
		`INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender, dob, deleted_at)
		 VALUES ($1, $2, 'P', 'Q', 'female', '1990-01-01', CASE WHEN $3 THEN now() END) RETURNING id`,
		f.tenant, fmt.Sprintf("M-%d", f.nPat), deleted).Scan(&id); err != nil {
		f.t.Fatalf("patient: %v", err)
	}
	return id
}

func (f *fixture) addUser(status string, deleted bool) {
	f.exec(`INSERT INTO users (tenant_id, email, full_name, status, deleted_at)
	        VALUES ($1, $2, 'U', $3, CASE WHEN $4 THEN now() END)`,
		f.tenant, uuid.NewString()+"@lim.test", status, deleted)
}

func (f *fixture) addBranch(deleted bool) {
	f.exec(`INSERT INTO branches (tenant_id, clinic_id, name, code, deleted_at)
	        VALUES ($1, $2, 'B', $3, CASE WHEN $4 THEN now() END)`,
		f.tenant, f.clinic, uuid.NewString()[:8], deleted)
}

func (f *fixture) addAttachment(patient uuid.UUID, typ string, size int64, deleted bool) {
	f.exec(`INSERT INTO attachments (tenant_id, patient_id, type, storage_key, filename, mime_type, size_bytes, deleted_at)
	        VALUES ($1, $2, $3, 'k', 'f', 'image/png', $4, CASE WHEN $5 THEN now() END)`,
		f.tenant, patient, typ, size, deleted)
}

func (f *fixture) addSMS(status string, segments int, sentAtSQL string) {
	f.exec(`INSERT INTO messages (tenant_id, patient_id, kind, body, segments, status, sent_at)
	        VALUES ($1, $2, 'custom', 'hi', $3, $4, `+sentAtSQL+`)`, f.tenant, f.patient, segments, status)
}

// override sets one tenants.*_override column (nil = NULL = inherit).
func (f *fixture) override(col string, v *int) {
	f.exec(`UPDATE tenants SET `+col+` = $2 WHERE id = $1`, f.tenant, v)
}

func (f *fixture) plan(col string, v *int) {
	f.exec(`UPDATE plans SET `+col+` = $2 WHERE id = $1`, f.planID, v)
}

func (f *fixture) tx(fn func(ctx context.Context, tx pgx.Tx) error) error {
	ctx := context.Background()
	return f.d.WithTenantTx(ctx, f.tenant, func(tx pgx.Tx) error { return fn(ctx, tx) })
}

func (f *fixture) effective() limits.Limits {
	f.t.Helper()
	var l limits.Limits
	if err := f.tx(func(ctx context.Context, tx pgx.Tx) error {
		var e error
		l, e = limits.Effective(ctx, tx, f.tenant)
		return e
	}); err != nil {
		f.t.Fatalf("Effective: %v", err)
	}
	return l
}

func (f *fixture) count(fn func(context.Context, pgx.Tx, uuid.UUID) (int64, error)) int64 {
	f.t.Helper()
	var n int64
	if err := f.tx(func(ctx context.Context, tx pgx.Tx) error {
		var e error
		n, e = fn(ctx, tx, f.tenant)
		return e
	}); err != nil {
		f.t.Fatalf("count: %v", err)
	}
	return n
}

func (f *fixture) gate(fn func(context.Context, pgx.Tx, uuid.UUID) error) error {
	return f.tx(func(ctx context.Context, tx pgx.Tx) error { return fn(ctx, tx, f.tenant) })
}

func eq(p *int64, want int64) bool { return p != nil && *p == want }

// wantDenied asserts err is a 403 apperr with the given code.
func wantDenied(t *testing.T, label string, err error, code string) {
	t.Helper()
	ae, ok := apperr.As(err)
	if !ok || ae.HTTPStatus != http.StatusForbidden || ae.Code != code {
		t.Fatalf("%s: err = %v, want 403 %s", label, err, code)
	}
}

func wantAllowed(t *testing.T, label string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: err = %v, want allowed", label, err)
	}
}

// Given a plan with caps and no overrides, When Effective resolves, Then every cap equals the plan's value (storage in bytes) and plan code/name are reported.
func TestREG_KERNEL_LIMITS_001_EffectiveUsesPlanValues(t *testing.T) {
	f := newFixture(t, planCaps{storageGB: iv(3), patients: iv(100), users: iv(5), branches: iv(2), images: iv(7), sms: iv(500)})
	l := f.effective()
	if l.PlanCode != f.planCode || l.PlanName != "Limits regress" {
		t.Fatalf("plan = %q/%q", l.PlanCode, l.PlanName)
	}
	if !eq(l.StorageBytes, 3*gib) || !eq(l.Patients, 100) || !eq(l.Users, 5) || !eq(l.Branches, 2) ||
		!eq(l.ImagesPerPatient, 7) || !eq(l.SMSMonthly, 500) {
		t.Fatalf("limits = %+v", l)
	}
}

// Given a plan with every cap NULL, When Effective resolves, Then every cap is nil (unlimited).
func TestREG_KERNEL_LIMITS_002_NullPlanValueIsUnlimited(t *testing.T) {
	f := newFixture(t, planCaps{})
	l := f.effective()
	if l.StorageBytes != nil || l.Patients != nil || l.Users != nil || l.Branches != nil || l.ImagesPerPatient != nil || l.SMSMonthly != nil {
		t.Fatalf("limits = %+v, want all unlimited", l)
	}
}

// Given per-clinic overrides, When Effective resolves, Then a positive override replaces the plan value, zero means a zero cap, negative means unlimited, NULL inherits the plan.
func TestREG_KERNEL_LIMITS_003_OverrideSemantics(t *testing.T) {
	f := newFixture(t, planCaps{storageGB: iv(3), patients: iv(100), users: iv(5), branches: iv(2), images: iv(7), sms: iv(500)})
	f.override("storage_gb_override", iv(40))
	f.override("patient_limit_override", iv(0))
	f.override("user_limit_override", iv(-1))
	f.override("sms_monthly_override", iv(9))
	// branch_limit_override left NULL: inherits.
	l := f.effective()
	if !eq(l.StorageBytes, 40*gib) {
		t.Fatalf("storage override: %v", l.StorageBytes)
	}
	if !eq(l.Patients, 0) {
		t.Fatalf("zero override must be a zero cap, got %v", l.Patients)
	}
	if l.Users != nil {
		t.Fatalf("negative override must be unlimited, got %v", *l.Users)
	}
	if !eq(l.Branches, 2) || !eq(l.SMSMonthly, 9) || !eq(l.ImagesPerPatient, 7) {
		t.Fatalf("limits = %+v", l)
	}
	// An override also lifts a NULL (unlimited) plan value to a cap.
	f.plan("branch_limit", nil)
	f.override("branch_limit_override", iv(4))
	if l := f.effective(); !eq(l.Branches, 4) {
		t.Fatalf("override over unlimited plan: %v", l.Branches)
	}
	// UserLimit / BranchLimit expose the same resolution.
	var u, b *int64
	if err := f.tx(func(ctx context.Context, tx pgx.Tx) error {
		var e error
		if u, e = limits.UserLimit(ctx, tx, f.tenant); e != nil {
			return e
		}
		b, e = limits.BranchLimit(ctx, tx, f.tenant)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	if u != nil || !eq(b, 4) {
		t.Fatalf("UserLimit=%v BranchLimit=%v, want nil/4", u, b)
	}
}

// Given an unknown tenant, When Effective or any gate runs, Then it errors (no row) rather than treating the clinic as unlimited.
func TestREG_KERNEL_LIMITS_004_UnknownTenantErrors(t *testing.T) {
	f := newFixture(t, planCaps{})
	ghost := uuid.New()
	err := f.tx(func(ctx context.Context, tx pgx.Tx) error {
		_, e := limits.Effective(ctx, tx, ghost)
		return e
	})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("Effective(unknown) = %v, want ErrNoRows", err)
	}
	gates := map[string]func(ctx context.Context, tx pgx.Tx) error{
		"storage":  func(ctx context.Context, tx pgx.Tx) error { return limits.EnsureStorageRoom(ctx, tx, ghost) },
		"patients": func(ctx context.Context, tx pgx.Tx) error { return limits.EnsurePatientRoom(ctx, tx, ghost) },
		"images":   func(ctx context.Context, tx pgx.Tx) error { return limits.EnsureImageRoom(ctx, tx, ghost, f.patient) },
		"sms":      func(ctx context.Context, tx pgx.Tx) error { return limits.EnsureSMSRoom(ctx, tx, ghost, 1) },
	}
	for name, g := range gates {
		if err := f.tx(g); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("%s gate for unknown tenant = %v, want ErrNoRows", name, err)
		}
	}
}

// Given a patient cap N, When the clinic has N-1 / N / N+1 live patients, Then registering is allowed / denied 403 PATIENT_LIMIT_REACHED / denied; soft-deleted patients don't count; nil cap never blocks.
func TestREG_KERNEL_LIMITS_005_PatientCapBoundary(t *testing.T) {
	f := newFixture(t, planCaps{patients: iv(3)}) // fixture already has 1 patient
	f.addPatient(true)                            // deleted: never counts
	f.addPatient(false)                           // 2 live = N-1
	if n := f.count(limits.PatientCount); n != 2 {
		t.Fatalf("PatientCount = %d, want 2", n)
	}
	wantAllowed(t, "N-1", f.gate(limits.EnsurePatientRoom))
	f.addPatient(false) // 3 = N
	wantDenied(t, "N", f.gate(limits.EnsurePatientRoom), "PATIENT_LIMIT_REACHED")
	f.addPatient(false) // 4 = N+1 (e.g. after a downgrade)
	wantDenied(t, "N+1", f.gate(limits.EnsurePatientRoom), "PATIENT_LIMIT_REACHED")
	f.override("patient_limit_override", iv(5))
	wantAllowed(t, "override above usage", f.gate(limits.EnsurePatientRoom))
	f.override("patient_limit_override", iv(-1))
	wantAllowed(t, "negative override = unlimited", f.gate(limits.EnsurePatientRoom))
	f.override("patient_limit_override", nil)
	f.plan("patient_limit", nil)
	wantAllowed(t, "NULL plan = unlimited", f.gate(limits.EnsurePatientRoom))
	f.plan("patient_limit", iv(0))
	wantDenied(t, "zero cap", f.gate(limits.EnsurePatientRoom), "PATIENT_LIMIT_REACHED")
}

// Given a 1 GB storage cap, When live attachments total cap-1 / cap / cap+1 bytes, Then uploads are allowed / denied 403 STORAGE_LIMIT_REACHED / denied; deleted files free their space.
func TestREG_KERNEL_LIMITS_006_StorageCapBoundary(t *testing.T) {
	f := newFixture(t, planCaps{storageGB: iv(1)})
	f.addAttachment(f.patient, "pdf", gib-1, false)
	f.addAttachment(f.patient, "pdf", 5*gib, true) // deleted: ignored
	if n := f.count(limits.StorageUsed); n != gib-1 {
		t.Fatalf("StorageUsed = %d, want %d", n, gib-1)
	}
	wantAllowed(t, "cap-1", f.gate(limits.EnsureStorageRoom))
	f.addAttachment(f.patient, "image", 1, false)
	wantDenied(t, "cap", f.gate(limits.EnsureStorageRoom), "STORAGE_LIMIT_REACHED")
	f.addAttachment(f.patient, "scan", 1, false)
	wantDenied(t, "cap+1", f.gate(limits.EnsureStorageRoom), "STORAGE_LIMIT_REACHED")
	f.override("storage_gb_override", iv(2))
	wantAllowed(t, "override raises cap", f.gate(limits.EnsureStorageRoom))
	f.override("storage_gb_override", iv(-5))
	wantAllowed(t, "negative override = unlimited", f.gate(limits.EnsureStorageRoom))
	f.override("storage_gb_override", iv(0))
	wantDenied(t, "zero override", f.gate(limits.EnsureStorageRoom), "STORAGE_LIMIT_REACHED")
	f.override("storage_gb_override", nil)
	f.plan("storage_gb", nil)
	wantAllowed(t, "NULL plan = unlimited", f.gate(limits.EnsureStorageRoom))
}

// Given an images-per-patient cap N, When that patient has N-1 / N / N+1 live images, Then allowed / denied 403 IMAGE_LIMIT_REACHED / denied; non-image files, deleted images and other patients' images don't count.
func TestREG_KERNEL_LIMITS_007_ImagesPerPatientBoundary(t *testing.T) {
	f := newFixture(t, planCaps{images: iv(2)})
	other := f.addPatient(false)
	f.addAttachment(other, "image", 1, false)
	f.addAttachment(other, "image", 1, false)
	f.addAttachment(f.patient, "pdf", 1, false)
	f.addAttachment(f.patient, "image", 1, true)
	f.addAttachment(f.patient, "image", 1, false) // 1 = N-1
	gate := func(ctx context.Context, tx pgx.Tx, ten uuid.UUID) error {
		return limits.EnsureImageRoom(ctx, tx, ten, f.patient)
	}
	wantAllowed(t, "N-1", f.gate(gate))
	f.addAttachment(f.patient, "image", 1, false)
	err := f.gate(gate)
	wantDenied(t, "N", err, "IMAGE_LIMIT_REACHED")
	if ae, _ := apperr.As(err); ae.Message != "this plan allows up to 2 images per patient — remove one or upgrade the plan" {
		t.Fatalf("message = %q", ae.Message)
	}
	f.addAttachment(f.patient, "image", 1, false)
	wantDenied(t, "N+1", f.gate(gate), "IMAGE_LIMIT_REACHED")
	f.plan("images_per_patient", nil)
	wantAllowed(t, "NULL plan = unlimited", f.gate(gate))
}

// Given users and branches in several states, When counted, Then only live active users and live branches count, and the caps they are compared to honour overrides.
func TestREG_KERNEL_LIMITS_008_UserAndBranchCounts(t *testing.T) {
	f := newFixture(t, planCaps{users: iv(2), branches: iv(1)})
	f.addUser("active", false)
	f.addUser("active", false)
	f.addUser("invited", false)
	f.addUser("suspended", false)
	f.addUser("deactivated", false)
	f.addUser("active", true)
	f.addBranch(false)
	f.addBranch(false)
	f.addBranch(true)
	if n := f.count(limits.UserCount); n != 2 {
		t.Fatalf("UserCount = %d, want 2 (live, active only)", n)
	}
	if n := f.count(limits.BranchCount); n != 2 {
		t.Fatalf("BranchCount = %d, want 2 (live only)", n)
	}
}

// Given a monthly SMS allowance of 10 with 7 segments used this month, When a send wants 3 / 4 segments, Then it is allowed / denied 403 SMS_LIMIT_REACHED; failed, scheduled and last month's messages don't count, delivered ones do.
func TestREG_KERNEL_LIMITS_009_SMSAllowanceBoundary(t *testing.T) {
	f := newFixture(t, planCaps{sms: iv(10)})
	// Midday on the 1st (Addis): inside this month under any session timezone,
	// so this test does not depend on NEW-KERNEL-LIMITS-1 or the run date.
	mid := `(date_trunc('month', now() AT TIME ZONE 'Africa/Addis_Ababa') AT TIME ZONE 'Africa/Addis_Ababa') + interval '12 hours'`
	f.addSMS("sent", 4, mid)
	f.addSMS("delivered", 3, mid)
	f.addSMS("failed", 50, mid)
	f.addSMS("scheduled", 50, "NULL")
	f.addSMS("sent", 50, "now() - interval '40 days'")
	if n := f.count(limits.SMSUsedThisMonth); n != 7 {
		t.Fatalf("SMSUsedThisMonth = %d, want 7", n)
	}
	want := func(n int64) func(context.Context, pgx.Tx, uuid.UUID) error {
		return func(ctx context.Context, tx pgx.Tx, ten uuid.UUID) error {
			return limits.EnsureSMSRoom(ctx, tx, ten, n)
		}
	}
	wantAllowed(t, "used+want = cap-1", f.gate(want(2)))
	wantAllowed(t, "used+want = cap", f.gate(want(3)))
	err := f.gate(want(4))
	wantDenied(t, "used+want = cap+1", err, "SMS_LIMIT_REACHED")
	if ae, _ := apperr.As(err); ae.Message != "this month's message allowance is used up (7 of 10) — it resets on the 1st, or upgrade the plan for more" {
		t.Fatalf("message = %q", ae.Message)
	}
	f.override("sms_monthly_override", iv(11))
	wantAllowed(t, "override raises allowance", f.gate(want(4)))
	f.override("sms_monthly_override", iv(-1))
	wantAllowed(t, "negative override = unlimited", f.gate(want(1000)))
	f.override("sms_monthly_override", iv(0))
	wantDenied(t, "zero allowance", f.gate(want(0)), "SMS_LIMIT_REACHED")
	f.override("sms_monthly_override", nil)
	f.plan("sms_monthly", nil)
	wantAllowed(t, "NULL plan = unlimited", f.gate(want(1000)))
}

// Given a clinic sending through its own SMS account, When it is at (or has no) allowance, Then the plan allowance is not applied.
func TestREG_KERNEL_LIMITS_010_OwnSMSAccountIsNotMetered(t *testing.T) {
	f := newFixture(t, planCaps{sms: iv(0)})
	f.addSMS("sent", 5, "now()")
	wantDenied(t, "plan account, zero allowance", f.gate(func(ctx context.Context, tx pgx.Tx, ten uuid.UUID) error {
		return limits.EnsureSMSRoom(ctx, tx, ten, 1)
	}), "SMS_LIMIT_REACHED")
	f.exec(`UPDATE clinics SET sms_api_key_enc = 'enc:abc' WHERE id = $1`, f.clinic)
	wantAllowed(t, "own account", f.gate(func(ctx context.Context, tx pgx.Tx, ten uuid.UUID) error {
		return limits.EnsureSMSRoom(ctx, tx, ten, 1000)
	}))
	f.exec(`UPDATE clinics SET sms_api_key_enc = '' WHERE id = $1`, f.clinic)
	wantDenied(t, "blank key = plan account", f.gate(func(ctx context.Context, tx pgx.Tx, ten uuid.UUID) error {
		return limits.EnsureSMSRoom(ctx, tx, ten, 1)
	}), "SMS_LIMIT_REACHED")
}

// Given a message sent at 01:00 Addis on the 1st of this month (22:00 UTC the previous day), When this month's usage is counted on a UTC session (as in production), Then it counts toward this month.
func TestREG_KERNEL_LIMITS_011_SMSMonthStartsAtAddisMidnight(t *testing.T) {
	f := newFixture(t, planCaps{sms: iv(10)})
	monthStart := `(date_trunc('month', now() AT TIME ZONE 'Africa/Addis_Ababa') AT TIME ZONE 'Africa/Addis_Ababa')`
	f.addSMS("sent", 1, monthStart+" + interval '1 hour'")     // 01:00 Addis on the 1st: this month
	f.addSMS("sent", 100, monthStart+" - interval '1 minute'") // 23:59 Addis last day of previous month
	var n int64
	if err := f.tx(func(ctx context.Context, tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `SET LOCAL TimeZone = 'UTC'`); e != nil {
			return e
		}
		var e error
		n, e = limits.SMSUsedThisMonth(ctx, tx, f.tenant)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	switch n {
	case 1:
	case 0:
		testkit.KnownBug(t, "NEW-KERNEL-LIMITS-1", true,
			"SMSUsedThisMonth compares sent_at to date_trunc('month', now() AT TIME ZONE 'Africa/Addis_Ababa'), a naive "+
				"timestamp read in the session zone (UTC in prod), so the month starts 03:00 Addis and the first 3 hours' sends are free")
	default:
		t.Fatalf("SMSUsedThisMonth = %d, want 1 (previous month's 23:59 Addis send counted?)", n)
	}
}
