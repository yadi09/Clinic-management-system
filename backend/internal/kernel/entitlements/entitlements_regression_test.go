package entitlements_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/entitlements"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// catalogue reads the features table — every resolved Set must list all of them.
func catalogue(t *testing.T, d *kerneldb.DB) []string {
	t.Helper()
	rows, err := d.Pool.Query(context.Background(), `SELECT code FROM features`)
	if err != nil {
		t.Fatal(err)
	}
	codes, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return codes
}

type fixture struct {
	t      *testing.T
	d      *kerneldb.DB
	planID uuid.UUID
	tenant uuid.UUID
}

// newFixture creates a uniquely coded plan with no plan_features (unconfigured) and a tenant on it.
func newFixture(t *testing.T) *fixture {
	t.Helper()
	d := testkit.SuperDB(t, testkit.RequireDB(t))
	ctx := context.Background()
	f := &fixture{t: t, d: d}
	code := "rg-ent-" + uuid.NewString()[:13]
	if err := d.Pool.QueryRow(ctx, `INSERT INTO plans (code, name) VALUES ($1, 'Ent regress') RETURNING id`, code).Scan(&f.planID); err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := d.Pool.QueryRow(ctx,
		`INSERT INTO tenants (name, slug, status, plan_id) VALUES ('Ent', $1, 'active', $2) RETURNING id`, code, f.planID).Scan(&f.tenant); err != nil {
		t.Fatalf("tenant: %v", err)
	}
	return f
}

func (f *fixture) planFeature(code string, enabled bool) {
	f.t.Helper()
	if _, err := f.d.Pool.Exec(context.Background(),
		`INSERT INTO plan_features (plan_id, feature, enabled) VALUES ($1, $2, $3)`, f.planID, code, enabled); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) tenantOverride(tenant uuid.UUID, code string, enabled bool) {
	f.t.Helper()
	if _, err := f.d.Pool.Exec(context.Background(),
		`INSERT INTO tenant_entitlements (tenant_id, feature, enabled, note) VALUES ($1, $2, $3, 'regress')`, tenant, code, enabled); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) effective(tenant uuid.UUID) entitlements.Set {
	f.t.Helper()
	var s entitlements.Set
	if err := f.d.WithTenantTx(context.Background(), tenant, func(tx pgx.Tx) error {
		var e error
		s, e = entitlements.Effective(context.Background(), tx, tenant)
		return e
	}); err != nil {
		f.t.Fatalf("Effective: %v", err)
	}
	return s
}

// Given a plan nobody has configured, When entitlements resolve, Then Configured is false and every feature (and unknown codes) is allowed — gating takes nothing away.
func TestREG_KERNEL_ENT_001_UnconfiguredPlanGatesNothing(t *testing.T) {
	f := newFixture(t)
	s := f.effective(f.tenant)
	if s.Configured {
		t.Fatal("a plan with no plan_features rows reported Configured")
	}
	for _, c := range append(catalogue(t, f.d), "not_a_feature") {
		if !s.Allows(c) {
			t.Fatalf("unconfigured plan denied %q", c)
		}
	}
	flags := map[string]bool{"messaging": false, "lab": true}
	out := entitlements.Apply(flags, s)
	if len(out) != 2 || out["messaging"] || !out["lab"] {
		t.Fatalf("Apply on an unconfigured plan changed the flags: %v", out)
	}
}

// Given a configured plan, When entitlements resolve, Then listed-enabled features are allowed and listed-disabled, unlisted and unknown features are denied.
func TestREG_KERNEL_ENT_002_ConfiguredPlanAllowsOnlyWhatItIncludes(t *testing.T) {
	f := newFixture(t)
	f.planFeature("messaging", true)
	f.planFeature("recalls", true)
	f.planFeature("dhis2", false)
	s := f.effective(f.tenant)
	if !s.Configured {
		t.Fatal("plan with plan_features rows not Configured")
	}
	cat := catalogue(t, f.d)
	if len(s.Features) != len(cat) {
		t.Fatalf("Features lists %d codes, want the whole catalogue (%d): %v", len(s.Features), len(cat), s.Features)
	}
	for _, c := range cat {
		if _, ok := s.Features[c]; !ok {
			t.Fatalf("catalogue feature %q missing from the resolved set", c)
		}
	}
	want := map[string]bool{"messaging": true, "recalls": true, "dhis2": false, "ai_assist": false,
		"finance_advanced": false, "payment_verification": false, "debt_ageing": false, "unknown_x": false}
	for c, w := range want {
		if s.Allows(c) != w {
			t.Fatalf("Allows(%q) = %v, want %v", c, !w, w)
		}
	}
}

// Given a configured plan where every row is disabled (an entry tier), When resolved, Then it is Configured and allows nothing.
func TestREG_KERNEL_ENT_003_AllDisabledPlanIsConfiguredAndDeniesAll(t *testing.T) {
	f := newFixture(t)
	f.planFeature("messaging", false)
	s := f.effective(f.tenant)
	if !s.Configured {
		t.Fatal("a plan whose only row is disabled must still count as configured")
	}
	for _, c := range catalogue(t, f.d) {
		if s.Allows(c) {
			t.Fatalf("all-disabled plan allowed %q", c)
		}
	}
}

// Given tenant_entitlements exceptions, When resolved, Then a grant overrides a plan denial, a revoke overrides a plan grant, and another tenant on the same plan is unaffected.
func TestREG_KERNEL_ENT_004_TenantOverrideWinsBothWays(t *testing.T) {
	f := newFixture(t)
	f.planFeature("messaging", true)
	f.planFeature("ai_assist", false)
	f.tenantOverride(f.tenant, "ai_assist", true)  // add-on sold
	f.tenantOverride(f.tenant, "messaging", false) // revoked for this clinic
	f.tenantOverride(f.tenant, "dhis2", true)      // unlisted on plan, granted

	s := f.effective(f.tenant)
	if !s.Allows("ai_assist") || s.Allows("messaging") || !s.Allows("dhis2") {
		t.Fatalf("overrides not applied: %v", s.Features)
	}
	var sibling uuid.UUID
	if err := f.d.Pool.QueryRow(context.Background(),
		`INSERT INTO tenants (name, slug, status, plan_id) VALUES ('Sib', $1, 'active', $2) RETURNING id`,
		"rg-ent-sib-"+uuid.NewString()[:8], f.planID).Scan(&sibling); err != nil {
		t.Fatal(err)
	}
	s2 := f.effective(sibling)
	if s2.Allows("ai_assist") || !s2.Allows("messaging") || s2.Allows("dhis2") {
		t.Fatalf("another clinic's exceptions leaked onto a sibling on the same plan: %v", s2.Features)
	}
}

// Given an unconfigured plan with a tenant-level revoke, When resolved, Then (by the documented rule) the plan still gates nothing and the revoke has no effect.
func TestREG_KERNEL_ENT_005_RevokeOnUnconfiguredPlanIsIgnored(t *testing.T) {
	f := newFixture(t)
	f.tenantOverride(f.tenant, "messaging", false)
	s := f.effective(f.tenant)
	if s.Configured || !s.Allows("messaging") {
		t.Fatalf("Configured=%v Allows(messaging)=%v; documented rule is 'unconfigured plan gates nothing'", s.Configured, s.Allows("messaging"))
	}
}

// Given a transaction that is no longer usable, When Effective runs, Then the error is returned.
func TestREG_KERNEL_ENT_006_QueryErrorIsReturned(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	tx, err := f.d.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	if _, err := entitlements.Effective(ctx, tx, f.tenant); err == nil {
		t.Fatal("Effective on a closed transaction returned no error")
	}
}

// Given a configured Set, When folded into feature flags, Then not-entitled features are forced off, entitled ones default on unless switched off, and non-catalogue flags are untouched.
func TestREG_KERNEL_ENT_007_ApplyFoldsEntitlementsIntoFlags(t *testing.T) {
	s := entitlements.Set{Configured: true, Features: map[string]bool{
		"messaging": true, "recalls": true, "dhis2": false, "ai_assist": false,
	}}
	flags := map[string]bool{"recalls": false, "dhis2": true, "lab": true}
	out := entitlements.Apply(flags, s)
	want := map[string]bool{"messaging": true, "recalls": false, "dhis2": false, "ai_assist": false, "lab": true}
	if len(out) != len(want) {
		t.Fatalf("Apply = %v, want %v", out, want)
	}
	for k, v := range want {
		if out[k] != v {
			t.Fatalf("Apply[%q] = %v, want %v (full: %v)", k, out[k], v, out)
		}
	}
	// A nil flag map is allocated, not dereferenced.
	out = entitlements.Apply(nil, s)
	if !out["messaging"] || out["dhis2"] {
		t.Fatalf("Apply(nil) = %v", out)
	}
	// Unconfigured: nil stays nil.
	if got := entitlements.Apply(nil, entitlements.Set{}); got != nil {
		t.Fatalf("Apply(nil, unconfigured) = %v, want nil", got)
	}
}
