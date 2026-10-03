package tenancy_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// Given a principal with no branch list, When asked about branch access, Then it is
// tenant-wide and may operate in any branch (including uuid.Nil).
func TestREG_KERNEL_TENANCY_001_EmptyBranchListIsTenantWide(t *testing.T) {
	for name, p := range map[string]*tenancy.Principal{
		"nil slice":   {},
		"empty slice": {BranchIDs: []uuid.UUID{}},
	} {
		t.Run(name, func(t *testing.T) {
			if !p.IsAllBranches() {
				t.Fatal("IsAllBranches = false, want true for an unrestricted principal")
			}
			for _, id := range []uuid.UUID{uuid.New(), uuid.New(), uuid.Nil} {
				if !p.CanAccessBranch(id) {
					t.Fatalf("CanAccessBranch(%s) = false for a tenant-wide principal", id)
				}
			}
		})
	}
}

// Given a principal restricted to two branches, When asked about branch access, Then
// only those branches are allowed and every other id (incl. uuid.Nil) is refused.
func TestREG_KERNEL_TENANCY_002_RestrictedBranchesOnly(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	p := &tenancy.Principal{BranchIDs: []uuid.UUID{a, b}}
	if p.IsAllBranches() {
		t.Fatal("IsAllBranches = true for a branch-restricted principal")
	}
	if !p.CanAccessBranch(a) || !p.CanAccessBranch(b) {
		t.Fatal("restricted principal refused its own branch")
	}
	if p.CanAccessBranch(uuid.New()) {
		t.Fatal("restricted principal allowed a foreign branch")
	}
	if p.CanAccessBranch(uuid.Nil) {
		t.Fatal("restricted principal allowed uuid.Nil (would be an all-branches bypass)")
	}
}

// Given roles on a principal, When HasRole/HasAnyRole are asked, Then matching is
// exact and case-sensitive, and an empty query/role list is never a match.
func TestREG_KERNEL_TENANCY_003_RoleMatchingIsExact(t *testing.T) {
	p := &tenancy.Principal{Roles: []string{"doctor", "cashier"}}
	cases := []struct {
		name string
		got  bool
		want bool
	}{
		{"exact hit", p.HasRole("doctor"), true},
		{"case differs", p.HasRole("Doctor"), false},
		{"prefix", p.HasRole("doc"), false},
		{"empty code", p.HasRole(""), false},
		{"any: one hits", p.HasAnyRole("owner", "cashier"), true},
		{"any: none hit", p.HasAnyRole("owner", "nurse"), false},
		{"any: no args", p.HasAnyRole(), false},
		{"no roles at all", (&tenancy.Principal{}).HasAnyRole("doctor"), false},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: got %v want %v", c.name, c.got, c.want)
		}
	}
}

// Given permissions on a principal, When HasPermission is asked, Then only exact codes
// match: there is no wildcard ("*"), prefix ("patient.*") or case-folding grant.
func TestREG_KERNEL_TENANCY_004_PermissionHasNoWildcard(t *testing.T) {
	p := &tenancy.Principal{Permissions: []string{"patient.read", "*", "billing.*"}}
	if !p.HasPermission("patient.read") {
		t.Fatal("exact permission refused")
	}
	for _, code := range []string{"patient.write", "billing.refund", "PATIENT.READ", "patient", ""} {
		if p.HasPermission(code) {
			t.Errorf("HasPermission(%q) = true; wildcard/prefix/case grants must not exist", code)
		}
	}
	if (&tenancy.Principal{}).HasPermission("patient.read") {
		t.Error("principal with no permissions was granted one")
	}
}

// Given flag maps (nil, false, true, missing), When FlagEnabled is asked, Then only an
// explicit true enables the module.
func TestREG_KERNEL_TENANCY_005_FlagEnabledOnlyWhenExplicitlyTrue(t *testing.T) {
	if (&tenancy.Principal{}).FlagEnabled("lab") {
		t.Error("nil flag map enabled a module")
	}
	p := &tenancy.Principal{Flags: map[string]bool{"lab": true, "pharmacy": false}}
	if !p.FlagEnabled("lab") {
		t.Error("lab=true not enabled")
	}
	if p.FlagEnabled("pharmacy") {
		t.Error("pharmacy=false enabled")
	}
	if p.FlagEnabled("dental") {
		t.Error("missing flag enabled")
	}
	if p.FlagEnabled("LAB") {
		t.Error("flag lookup is case-folded")
	}
}

// Given a principal stored in a context, When read back, Then the same principal and its
// tenant are returned.
func TestREG_KERNEL_TENANCY_006_PrincipalRoundTripsThroughContext(t *testing.T) {
	tid := uuid.New()
	p := &tenancy.Principal{UserID: uuid.New(), TenantID: tid}
	ctx := tenancy.WithPrincipal(context.Background(), p)
	got, ok := tenancy.PrincipalFromContext(ctx)
	if !ok || got != p {
		t.Fatalf("PrincipalFromContext = %v,%v want the stored principal", got, ok)
	}
	gotT, ok := tenancy.TenantIDFromContext(ctx)
	if !ok || gotT != tid {
		t.Fatalf("TenantIDFromContext = %s,%v want %s", gotT, ok, tid)
	}
}

// Given an empty context, a nil principal, or a principal with no tenant, When read back,
// Then no principal and no tenant are reported.
func TestREG_KERNEL_TENANCY_007_MissingOrNilPrincipalYieldsNothing(t *testing.T) {
	ctxs := map[string]context.Context{
		"empty":         context.Background(),
		"nil principal": tenancy.WithPrincipal(context.Background(), nil),
	}
	for name, ctx := range ctxs {
		if p, ok := tenancy.PrincipalFromContext(ctx); ok || p != nil {
			t.Errorf("%s: PrincipalFromContext = %v,%v want nil,false", name, p, ok)
		}
		if tid, ok := tenancy.TenantIDFromContext(ctx); ok || tid != uuid.Nil {
			t.Errorf("%s: TenantIDFromContext = %s,%v want Nil,false", name, tid, ok)
		}
	}
	// A principal with a Nil tenant is a principal, but never an active tenant.
	ctx := tenancy.WithPrincipal(context.Background(), &tenancy.Principal{UserID: uuid.New()})
	if _, ok := tenancy.PrincipalFromContext(ctx); !ok {
		t.Error("principal with Nil tenant not returned")
	}
	if tid, ok := tenancy.TenantIDFromContext(ctx); ok {
		t.Errorf("Nil-tenant principal produced an active tenant %s", tid)
	}
}

// Given an explicit tenant set before a principal (login flow), When resolved, Then the
// explicit tenant wins; a Nil explicit tenant falls back to the principal's tenant.
func TestREG_KERNEL_TENANCY_008_ExplicitTenantPrecedence(t *testing.T) {
	explicit, fromPrincipal := uuid.New(), uuid.New()

	ctx := tenancy.WithTenantID(context.Background(), explicit)
	if tid, ok := tenancy.TenantIDFromContext(ctx); !ok || tid != explicit {
		t.Fatalf("explicit tenant: got %s,%v want %s", tid, ok, explicit)
	}

	// Principal added later overrides the tenant key with its own tenant.
	ctx2 := tenancy.WithPrincipal(ctx, &tenancy.Principal{TenantID: fromPrincipal})
	if tid, _ := tenancy.TenantIDFromContext(ctx2); tid != fromPrincipal {
		t.Fatalf("after WithPrincipal: got %s want principal tenant %s", tid, fromPrincipal)
	}

	// Explicit Nil tenant set AFTER the principal: falls back to the principal's tenant.
	ctx3 := tenancy.WithTenantID(ctx2, uuid.Nil)
	if tid, ok := tenancy.TenantIDFromContext(ctx3); !ok || tid != fromPrincipal {
		t.Fatalf("Nil explicit tenant: got %s,%v want fallback %s", tid, ok, fromPrincipal)
	}

	// Explicit Nil tenant with no principal: nothing.
	if _, ok := tenancy.TenantIDFromContext(tenancy.WithTenantID(context.Background(), uuid.Nil)); ok {
		t.Fatal("Nil explicit tenant without principal reported a tenant")
	}
}
