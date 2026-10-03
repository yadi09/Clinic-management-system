package catalog_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/catalog"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/testkit"
)

type fixture struct {
	app                                *kerneldb.DB
	tenant, other                      uuid.UUID
	reception, clinician, either, gone uuid.UUID
	othersEither                       uuid.UUID
}

func setup(t *testing.T) fixture {
	t.Helper()
	dsn := testkit.RequireDB(t)
	super := testkit.SuperDB(t, dsn)
	a := testkit.NewClinic(t, super, testkit.ClinicOpts{})
	b := testkit.NewClinic(t, super, testkit.ClinicOpts{})
	ctx := context.Background()
	ins := func(tenant uuid.UUID, rule string, deleted bool) uuid.UUID {
		var id uuid.UUID
		q := `INSERT INTO service_items (tenant_id, code, name, assignable_by, deleted_at)
		      VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END) RETURNING id`
		if err := super.Pool.QueryRow(ctx, q, tenant, "c-"+uuid.NewString()[:8], "svc "+rule, rule, deleted).Scan(&id); err != nil {
			t.Fatalf("insert service: %v", err)
		}
		return id
	}
	app, err := kerneldb.Connect(ctx, testkit.AppDSN(t, dsn))
	if err != nil {
		t.Fatalf("connect app: %v", err)
	}
	t.Cleanup(app.Pool.Close)
	return fixture{
		app: app, tenant: a.TenantID, other: b.TenantID,
		reception: ins(a.TenantID, "reception", false), clinician: ins(a.TenantID, "clinician", false),
		either: ins(a.TenantID, "either", false), gone: ins(a.TenantID, "either", true),
		othersEither: ins(b.TenantID, "either", false),
	}
}

// check runs AssertMayAssign as the RLS-enforced app role, with the given permissions (nil = no principal).
func (f fixture) check(t *testing.T, tenant uuid.UUID, svc uuid.UUID, perms []string) error {
	t.Helper()
	ctx := context.Background()
	if perms != nil {
		ctx = tenancy.WithPrincipal(ctx, &tenancy.Principal{UserID: uuid.New(), TenantID: tenant, Permissions: perms})
	}
	var got error
	err := f.app.WithTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		got = catalog.AssertMayAssign(ctx, tx, tenant, &svc)
		return nil
	})
	if err != nil {
		t.Fatalf("tx: %v", err)
	}
	return got
}

func wantCode(t *testing.T, what string, err error, status int, code string) {
	t.Helper()
	ae, ok := apperr.As(err)
	if !ok {
		t.Errorf("%s: err = %v, want apperr %d/%s", what, err, status, code)
		return
	}
	if ae.HTTPStatus != status || ae.Code != code {
		t.Errorf("%s: got %d/%s (%s), want %d/%s", what, ae.HTTPStatus, ae.Code, ae.Message, status, code)
	}
}

// Given a free-hand charge (no service id), When checked, Then anyone may raise it — no DB access needed.
func TestREG_KERNEL_CATALOG_001_FreeHandChargeAllowed(t *testing.T) {
	if err := catalog.AssertMayAssign(context.Background(), nil, uuid.New(), nil); err != nil {
		t.Fatalf("nil service = %v, want nil", err)
	}
}

// Given an unknown, soft-deleted, or other clinic's service, When checked, Then it is a 400 "not in the catalogue" (no cross-tenant read).
func TestREG_KERNEL_CATALOG_002_ServiceMustBeInThisCatalogue(t *testing.T) {
	f := setup(t)
	owner := []string{"encounter.manage", "payment.charge"}
	wantCode(t, "unknown id", f.check(t, f.tenant, uuid.New(), owner), 400, "VALIDATION_FAILED")
	wantCode(t, "soft-deleted", f.check(t, f.tenant, f.gone, owner), 400, "VALIDATION_FAILED")
	wantCode(t, "other clinic's service", f.check(t, f.tenant, f.othersEither, owner), 400, "VALIDATION_FAILED")
	if err := f.check(t, f.other, f.othersEither, owner); err != nil {
		t.Errorf("the owning clinic may use its own service: %v", err)
	}
	if ae, _ := apperr.As(f.check(t, f.tenant, f.gone, owner)); ae == nil || ae.Message != "that service is not in the catalogue" {
		t.Errorf("message = %v", ae)
	}
}

// Given an "either" service, When anyone (even with no principal or no permissions) assigns it, Then it is allowed.
func TestREG_KERNEL_CATALOG_003_EitherIsOpen(t *testing.T) {
	f := setup(t)
	for name, perms := range map[string][]string{"no principal": nil, "no perms": {}, "cashier": {"payment.charge"}} {
		if err := f.check(t, f.tenant, f.either, perms); err != nil {
			t.Errorf("%s on either-service = %v, want allowed", name, err)
		}
	}
}

// Given a clinician-only service, When staff assign it, Then only encounter.manage/dental.manage holders pass; desk staff get 403 CLINICIAN_ONLY.
func TestREG_KERNEL_CATALOG_004_ClinicianOnly(t *testing.T) {
	f := setup(t)
	for name, perms := range map[string][]string{
		"doctor": {"encounter.manage"}, "dentist": {"dental.manage"}, "owner (both)": {"payment.charge", "encounter.manage"},
	} {
		if err := f.check(t, f.tenant, f.clinician, perms); err != nil {
			t.Errorf("%s = %v, want allowed", name, err)
		}
	}
	wantCode(t, "cashier", f.check(t, f.tenant, f.clinician, []string{"payment.charge"}), 403, "CLINICIAN_ONLY")
	wantCode(t, "receptionist", f.check(t, f.tenant, f.clinician, []string{"patient.create"}), 403, "CLINICIAN_ONLY")
	wantCode(t, "nurse (view only)", f.check(t, f.tenant, f.clinician, []string{"encounter.view"}), 403, "CLINICIAN_ONLY")
	wantCode(t, "no principal", f.check(t, f.tenant, f.clinician, nil), 403, "NOT_ALLOWED")
}

// Given a reception-only service, When staff assign it, Then only payment.charge/patient.create holders pass; clinicians get 403 RECEPTION_ONLY.
func TestREG_KERNEL_CATALOG_005_ReceptionOnly(t *testing.T) {
	f := setup(t)
	for name, perms := range map[string][]string{
		"cashier": {"payment.charge"}, "receptionist": {"patient.create"}, "owner (both)": {"dental.manage", "patient.create"},
	} {
		if err := f.check(t, f.tenant, f.reception, perms); err != nil {
			t.Errorf("%s = %v, want allowed", name, err)
		}
	}
	wantCode(t, "dentist", f.check(t, f.tenant, f.reception, []string{"dental.manage"}), 403, "RECEPTION_ONLY")
	wantCode(t, "doctor", f.check(t, f.tenant, f.reception, []string{"encounter.manage"}), 403, "RECEPTION_ONLY")
	wantCode(t, "no principal", f.check(t, f.tenant, f.reception, nil), 403, "NOT_ALLOWED")
}

// Given a broken transaction, When checked, Then the database error is returned as-is (not mistaken for "not in catalogue" or allowed).
func TestREG_KERNEL_CATALOG_006_DatabaseErrorPropagates(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	tx, err := f.app.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	got := catalog.AssertMayAssign(ctx, tx, f.tenant, &f.either)
	if got == nil {
		t.Fatal("a closed transaction must not be treated as permission granted")
	}
	if _, ok := apperr.As(got); ok {
		t.Errorf("db failure surfaced as a domain error: %v", got)
	}
}
