package payments_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/payments"
	"github.com/reicb/clinicsaas/internal/kernel/verifyet"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// env is one provisioned clinic, a superuser pool for inspection and an RLS pool
// (clinic_app) for exercising the code exactly as production does.
type env struct {
	super *kerneldb.DB
	app   *kerneldb.DB
	c     *testkit.Clinic
}

func setup(t *testing.T) *env {
	t.Helper()
	dsn := testkit.RequireDB(t)
	super := testkit.SuperDB(t, dsn)
	app, err := kerneldb.Connect(context.Background(), testkit.AppDSN(t, dsn))
	if err != nil {
		t.Fatalf("app pool: %v", err)
	}
	t.Cleanup(app.Pool.Close)
	return &env{super: super, app: app, c: testkit.NewClinic(t, super, testkit.ClinicOpts{ClinicType: "general"})}
}

func (e *env) tid() uuid.UUID { return e.c.TenantID }

// rail inserts a payment method for this clinic and returns its id.
func (e *env) rail(t *testing.T, tid uuid.UUID, kind, bankKey, account string, needsRef, active bool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	key := kind + "-" + uuid.NewString()[:8]
	err := e.super.Pool.QueryRow(context.Background(),
		`INSERT INTO payment_rails (tenant_id, key, label, kind, bank_key, account_number, needs_reference, active)
		 VALUES ($1,$2,$2,$3,nullif($4,''),nullif($5,''),$6,$7) RETURNING id`,
		tid, key, kind, bankKey, account, needsRef, active).Scan(&id)
	if err != nil {
		t.Fatalf("insert rail: %v", err)
	}
	return id
}

func (e *env) patient(t *testing.T, tid uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := e.super.Pool.QueryRow(context.Background(),
		`INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender)
		 VALUES ($1, $2, 'Test', 'Patient', 'female') RETURNING id`, tid, "MRN-"+uuid.NewString()[:8]).Scan(&id)
	if err != nil {
		t.Fatalf("insert patient: %v", err)
	}
	return id
}

// in runs fn in a committed, tenant-scoped (RLS) transaction.
func (e *env) in(t *testing.T, tid uuid.UUID, fn func(tx pgx.Tx) error) error {
	t.Helper()
	return e.app.WithTenantTx(context.Background(), tid, fn)
}

// aborted runs fn on a transaction already in the failed state, so every query errors.
func (e *env) aborted(t *testing.T, fn func(tx pgx.Tx)) {
	t.Helper()
	ctx := context.Background()
	tx, err := e.app.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	_, _ = tx.Exec(ctx, `SELECT 1/0`)
	fn(tx)
}

type refRow struct {
	Receipt                                     *int64
	State, Reason, Detail, ReqID, Trace, Amount *string
	Count                                       int
}

func (e *env) refRow(t *testing.T, tid, rail uuid.UUID, ref string) refRow {
	t.Helper()
	var r refRow
	err := e.super.Pool.QueryRow(context.Background(),
		`SELECT count(*) OVER (), receipt_no, verify_state, verify_reason, verify_detail, verify_request_id,
		        verify_trace_id, verified_amount::text
		   FROM payment_references WHERE tenant_id=$1 AND payment_rail_id=$2 AND reference_norm=upper(btrim($3))`,
		tid, rail, ref).Scan(&r.Count, &r.Receipt, &r.State, &r.Reason, &r.Detail, &r.ReqID, &r.Trace, &r.Amount)
	if err == pgx.ErrNoRows {
		return refRow{}
	}
	if err != nil {
		t.Fatalf("read ref: %v", err)
	}
	return r
}

func code(err error) string {
	if e, ok := apperr.As(err); ok {
		return e.Code
	}
	return ""
}

func i64(n int64) *int64 { return &n }

// fakeVerifier implements payments.Verifier without HTTP.
type fakeVerifier struct {
	mu    sync.Mutex
	live  bool
	res   *verifyet.Result
	err   error
	calls []verifyet.Request
}

func (f *fakeVerifier) Live() bool { return f.live }
func (f *fakeVerifier) Verify(_ context.Context, in verifyet.Request) (*verifyet.Result, error) {
	f.mu.Lock()
	f.calls = append(f.calls, in)
	f.mu.Unlock()
	return f.res, f.err
}
func (f *fakeVerifier) Status(context.Context, string) (*verifyet.Result, error) { return f.res, f.err }

func verified(amount string) *verifyet.Result {
	return &verifyet.Result{
		RequestID: "req-ok", VendorRequestID: "trace-ok", ProcessingStatus: "completed", Status: "success", Verified: true,
		Amount: amount, Currency: "ETB", SenderName: "Abebe Kebede", ReceiverAccount: "0911****41", Timestamp: "2026-10-01T09:00:00Z",
		Settlement:   &verifyet.Settlement{Matched: true, MatchConfidence: "high", Reason: "receiver_account_exact_match"},
		Confirmation: &verifyet.Confirmation{Scope: "platform", IsFirstConfirmation: true},
	}
}

// --- Resolve -----------------------------------------------------------------

// Given no rail chosen, When Resolve runs, Then the legacy free-text method is kept (blank becomes cash) and the reference is trimmed.
func TestREG_KERNEL_PAY_001_ResolveLegacyMethod(t *testing.T) {
	e := setup(t)
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		id, m, ref, err := payments.Resolve(context.Background(), tx, e.tid(), nil, "  ", "  REF1 ", false)
		if err != nil || id != nil || m != "cash" || ref != "REF1" {
			t.Fatalf("blank method: %v %q %q %v", id, m, ref, err)
		}
		_, m, _, _ = payments.Resolve(context.Background(), tx, e.tid(), nil, " mobile ", "", false)
		if m != "mobile" {
			t.Fatalf("method not trimmed: %q", m)
		}
		return nil
	})
}

// Given rails that are unknown, foreign, switched off, or need a reference, When Resolve runs, Then each is refused with a validation error.
func TestREG_KERNEL_PAY_002_ResolveRefusesUnusableRails(t *testing.T) {
	e := setup(t)
	other := testkit.NewClinic(t, e.super, testkit.ClinicOpts{ClinicType: "general"})
	foreign := e.rail(t, other.TenantID, "wallet", "telebirr", "0911", false, true)
	off := e.rail(t, e.tid(), "wallet", "telebirr", "0911", false, false)
	needs := e.rail(t, e.tid(), "bank", "cbe", "1000", true, true)
	unknown := uuid.New()
	cases := []struct {
		name string
		rail *uuid.UUID
		ref  string
		msg  string
	}{
		{"unknown", &unknown, "X", "unknown payment method"},
		{"another clinic's rail", &foreign, "X", "unknown payment method"},
		{"inactive", &off, "X", "switched off"},
		{"needs reference", &needs, "   ", "enter the transaction reference"},
	}
	for _, tc := range cases {
		err := e.in(t, e.tid(), func(tx pgx.Tx) error {
			_, _, _, err := payments.Resolve(context.Background(), tx, e.tid(), tc.rail, "", tc.ref, false)
			return err
		})
		if code(err) != "VALIDATION_FAILED" || !strings.Contains(err.Error(), tc.msg) {
			t.Errorf("%s: got %v", tc.name, err)
		}
	}
}

// Given a cash rail and a wallet rail, When Resolve runs with a reference, Then cash drops it (nothing to claim) and the wallet keeps it with the rail key.
func TestREG_KERNEL_PAY_003_ResolveCashDropsReference(t *testing.T) {
	e := setup(t)
	cash := e.rail(t, e.tid(), "cash", "", "", false, true)
	wallet := e.rail(t, e.tid(), "wallet", "telebirr", "0911", true, true)
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		id, key, ref, err := payments.Resolve(context.Background(), tx, e.tid(), &cash, "ignored", " R-9 ", false)
		if err != nil || id == nil || *id != cash || !strings.HasPrefix(key, "cash-") || ref != "" {
			t.Fatalf("cash: %v %q %q %v", id, key, ref, err)
		}
		id, key, ref, err = payments.Resolve(context.Background(), tx, e.tid(), &wallet, "ignored", " R-9 ", false)
		if err != nil || *id != wallet || !strings.HasPrefix(key, "wallet-") || ref != "R-9" {
			t.Fatalf("wallet: %v %q %q %v", id, key, ref, err)
		}
		return nil
	})
}

// Given the bank contradicted a reference (wrong receiver), When the desk settles with it, Then Resolve blocks with VERIFY_REJECTED unless forced; review/unchecked still settle.
func TestREG_KERNEL_PAY_004_ResolveBlocksARejectedReference(t *testing.T) {
	e := setup(t)
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911000041", false, true)
	r := verified("100")
	r.Settlement = &verifyet.Settlement{Matched: false, Reason: "candidate_account_mismatch", ReceiverAccount: "2519****4531"}
	v := &fakeVerifier{live: true, res: r}
	ctx := context.Background()
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		rl, err := payments.LoadRail(ctx, tx, e.tid(), rail)
		if err != nil || rl == nil {
			t.Fatalf("load rail: %v %v", rl, err)
		}
		chk, err := payments.RunCheck(ctx, tx, v, e.tid(), rl, "WRONG1", "100", nil, 0, &e.c.Owner.ID)
		if err != nil || chk.State != verifyet.Reject {
			t.Fatalf("check: %+v %v", chk, err)
		}
		return nil
	})
	err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		_, _, _, err := payments.Resolve(ctx, tx, e.tid(), &rail, "", " wrong1 ", false)
		return err
	})
	if ae, ok := apperr.As(err); !ok || ae.Code != "VERIFY_REJECTED" || ae.HTTPStatus != http.StatusConflict ||
		!strings.Contains(ae.Message, "different account") {
		t.Fatalf("a rejected reference must block the settle, got %v", err)
	}
	// Forced (payment.waive) settles.
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		_, _, ref, err := payments.Resolve(ctx, tx, e.tid(), &rail, "", "WRONG1", true)
		if ref != "WRONG1" {
			t.Errorf("ref %q", ref)
		}
		return err
	}); err != nil {
		t.Fatalf("force must settle: %v", err)
	}
	// A "review" verdict does not block (by design: a person decides at the desk).
	v.res = verified("90")
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
		chk, _ := payments.RunCheck(ctx, tx, v, e.tid(), rl, "REVIEW1", "100", nil, 0, nil)
		if chk.State != verifyet.Review {
			t.Fatalf("want review, got %+v", chk)
		}
		_, _, _, err := payments.Resolve(ctx, tx, e.tid(), &rail, "", "REVIEW1", false)
		if err != nil {
			t.Fatalf("review must not block: %v", err)
		}
		return nil
	})
}

// Given a broken transaction, When Resolve reads the rail, Then the DB error is returned (never a silent pass).
func TestREG_KERNEL_PAY_005_ResolvePropagatesDBErrors(t *testing.T) {
	e := setup(t)
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "1", false, true)
	e.aborted(t, func(tx pgx.Tx) {
		if _, _, _, err := payments.Resolve(context.Background(), tx, e.tid(), &rail, "", "R", false); err == nil || code(err) != "" {
			t.Fatalf("want raw DB error, got %v", err)
		}
		if _, _, err := payments.VerifyStateOf(context.Background(), tx, e.tid(), &rail, "R"); err == nil {
			t.Fatal("VerifyStateOf must surface DB errors")
		}
		if err := payments.ClaimReference(context.Background(), tx, e.tid(), &rail, "R", i64(1), nil, "1", nil); err == nil {
			t.Fatal("ClaimReference must surface DB errors")
		}
		if _, err := payments.LoadRail(context.Background(), tx, e.tid(), rail); err == nil {
			t.Fatal("LoadRail must surface DB errors")
		}
		r, _ := payments.LoadRail(context.Background(), e.mustTx(t), e.tid(), rail)
		if _, err := payments.RunCheck(context.Background(), tx, &fakeVerifier{live: true, res: verified("1")}, e.tid(), r, "R", "", nil, 0, nil); err == nil {
			t.Fatal("RunCheck must surface DB errors")
		}
		if err := payments.StampCharges(context.Background(), tx, e.tid(), []uuid.UUID{uuid.New()}, &rail, "R"); err == nil {
			t.Fatal("StampCharges must surface DB errors")
		}
	})
	// Resolve's own verify-state read failing after the rail read: rail found, state read errors.
	// Covered by the aborted tx above only at the first query; a rail that resolves but whose
	// state lookup fails cannot be produced without breaking the tx between two statements.
}

func (e *env) mustTx(t *testing.T) pgx.Tx {
	t.Helper()
	ctx := context.Background()
	tx, err := e.app.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", e.tid().String()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	return tx
}

// --- ClaimReference ----------------------------------------------------------

// Given a reference that paid receipt #41, When the same reference is claimed again (any case/spacing), Then REFERENCE_USED names receipt #41 and only one row exists.
func TestREG_KERNEL_PAY_010_ClaimReferenceOnceOnly(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911", true, true)
	pid := e.patient(t, e.tid())
	actor := e.c.Staff["cashier"].ID
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &rail, "AbC123", i64(41), &pid, "100.00", &actor)
	}); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	for _, again := range []string{"AbC123", " abc123 ", "ABC123"} {
		err := e.in(t, e.tid(), func(tx pgx.Tx) error {
			return payments.ClaimReference(ctx, tx, e.tid(), &rail, again, i64(42), &pid, "100.00", &actor)
		})
		if ae, ok := apperr.As(err); !ok || ae.Code != "REFERENCE_USED" || ae.HTTPStatus != http.StatusConflict ||
			!strings.Contains(ae.Message, "#41") {
			t.Fatalf("second claim %q must conflict naming #41, got %v", again, err)
		}
	}
	row := e.refRow(t, e.tid(), rail, "abc123")
	if row.Count != 1 || row.Receipt == nil || *row.Receipt != 41 {
		t.Fatalf("want exactly one row on receipt 41, got %+v", row)
	}
	// Receipt #0 is named, not blank.
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		_ = payments.ClaimReference(ctx, tx, e.tid(), &rail, "ZERO", i64(0), nil, "1", nil)
		err := payments.ClaimReference(ctx, tx, e.tid(), &rail, "zero", i64(1), nil, "1", nil)
		if !strings.Contains(err.Error(), "#0") {
			t.Errorf("want #0, got %v", err)
		}
		return nil
	})
}

// Given no rail or no reference, When claimed, Then nothing is recorded (cash and legacy settles never touch the table).
func TestREG_KERNEL_PAY_011_ClaimWithoutRailOrRefIsNoop(t *testing.T) {
	e := setup(t)
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911", false, true)
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		if err := payments.ClaimReference(context.Background(), tx, e.tid(), nil, "X", i64(1), nil, "1", nil); err != nil {
			t.Fatal(err)
		}
		if err := payments.ClaimReference(context.Background(), tx, e.tid(), &rail, "", i64(1), nil, "1", nil); err != nil {
			t.Fatal(err)
		}
		return nil
	})
	var n int
	_ = e.super.Pool.QueryRow(context.Background(), `SELECT count(*) FROM payment_references WHERE tenant_id=$1`, e.tid()).Scan(&n)
	if n != 0 {
		t.Fatalf("no row expected, got %d", n)
	}
}

// Given the desk checked a reference first (row, no receipt), When the money is taken, Then the same row is claimed (not a conflict) keeping its verdict; a later claim conflicts.
func TestREG_KERNEL_PAY_012_CheckThenClaimIsOnePayment(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911000041", true, true)
	pid := e.patient(t, e.tid())
	v := &fakeVerifier{live: true, res: verified("250")}
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
		chk, err := payments.RunCheck(ctx, tx, v, e.tid(), rl, "CHK-1", "250.00", &pid, 1500, nil)
		if err != nil || chk.State != verifyet.Accept || chk.Amount != "250.00" || chk.Sender != "Abebe Kebede" ||
			chk.Account != "0911****41" || chk.RequestID != "req-ok" || chk.When == "" || chk.Already {
			t.Fatalf("check: %+v %v", chk, err)
		}
		return nil
	})
	row := e.refRow(t, e.tid(), rail, "chk-1")
	if row.Count != 1 || row.Receipt != nil || *row.State != "verified" || *row.Amount != "250.00" ||
		*row.ReqID != "req-ok" || *row.Trace != "trace-ok" {
		t.Fatalf("checked row: %+v", row)
	}
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &rail, " chk-1", i64(7), nil, "250.00", nil)
	}); err != nil {
		t.Fatalf("claiming a checked reference is the same payment: %v", err)
	}
	row = e.refRow(t, e.tid(), rail, "CHK-1")
	if row.Count != 1 || row.Receipt == nil || *row.Receipt != 7 || *row.State != "verified" {
		t.Fatalf("claimed row: %+v", row)
	}
	var patient *uuid.UUID
	_ = e.super.Pool.QueryRow(ctx, `SELECT patient_id FROM payment_references WHERE tenant_id=$1 AND payment_rail_id=$2`, e.tid(), rail).Scan(&patient)
	if patient == nil || *patient != pid {
		t.Fatalf("a nil patient on claim must keep the checked patient, got %v", patient)
	}
	err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &rail, "CHK-1", i64(8), nil, "250.00", nil)
	})
	if code(err) != "REFERENCE_USED" || !strings.Contains(err.Error(), "#7") {
		t.Fatalf("second use must conflict naming #7: %v", err)
	}
	// A new check on a settled reference never reaches the vendor and says "already".
	before := len(v.calls)
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
		chk, err := payments.RunCheck(ctx, tx, v, e.tid(), rl, "chk-1", "250", nil, 0, nil)
		if err != nil || chk.State != verifyet.Reject || !chk.Already || !strings.Contains(chk.Reason, "#7") {
			t.Fatalf("re-check: %+v %v", chk, err)
		}
		return nil
	})
	if len(v.calls) != before {
		t.Fatal("a reference this clinic already collected must not spend a vendor credit")
	}
}

// Given a reference claimed by a settle that records no receipt number (the pharmacy OTC path passes nil),
// When the same reference is claimed again, Then it must conflict — one bank receipt pays once.
//
// NEW-KERNEL-PAY-1: ClaimReference treats ANY existing row with receipt_no IS NULL as "checked
// but not collected" and re-claims it (payments.go:101-110). pharmacy/service/service.go:636
// claims with receiptNo=nil, so a reference that paid an OTC sale can pay another sale, or a
// clinic bill, again. RunCheck's "already used" guard reads receipt_no too, so it is blind as well.
func TestREG_KERNEL_PAY_013_ReceiptlessClaimCannotBeReused(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911", true, true)
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &rail, "OTC-777", nil, nil, "300.00", nil)
	}); err != nil {
		t.Fatalf("first (OTC) claim: %v", err)
	}
	second := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &rail, "OTC-777", nil, nil, "300.00", nil)
	})
	third := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &rail, "OTC-777", i64(99), nil, "300.00", nil)
	})
	reused := code(second) != "REFERENCE_USED" || code(third) != "REFERENCE_USED"
	if reused {
		testkit.KnownBug(t, "NEW-KERNEL-PAY-1", true, "a reference claimed without a receipt number (pharmacy OTC) "+
			"can be claimed again: second="+errText(second)+" third="+errText(third))
		return
	}
	testkit.KnownBug(t, "NEW-KERNEL-PAY-1", false, "receiptless claims are now single-use")
}

func errText(err error) string {
	if err == nil {
		return "<nil — accepted>"
	}
	return err.Error()
}

// Given two rails of the same clinic pointing at the same provider (telebirr), When one Telebirr
// transaction reference is claimed on each, Then the second must conflict — it is one bank receipt —
// naming the receipt it paid, and nothing is recorded for the second method.
//
// NEW-KERNEL-PAY-2, fixed 2026-10-10: uniqueness used to be (tenant, rail, reference), so the same
// transfer settled twice by picking a different method in the picker.
func TestREG_KERNEL_PAY_014_SameReceiptOnTwoRailsOfOneProvider(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	a := e.rail(t, e.tid(), "wallet", "telebirr", "0911000041", true, true)
	b := e.rail(t, e.tid(), "wallet", "telebirr", "0911000042", true, true)
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &a, "TB-5551", i64(1), nil, "500.00", nil)
	}); err != nil {
		t.Fatal(err)
	}
	err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &b, "TB-5551", i64(2), nil, "500.00", nil)
	})
	if code(err) != "REFERENCE_USED" || !strings.Contains(errText(err), "receipt #1") {
		t.Fatalf("the same Telebirr reference on a second number: %s, want REFERENCE_USED naming receipt #1", errText(err))
	}
	if r := e.refRow(t, e.tid(), b, "TB-5551"); r.Count != 0 {
		t.Fatalf("a refused claim left %d row(s) under the second method", r.Count)
	}
}

// Given methods of different kinds and providers, When the same reference text is claimed under
// each pair, Then it conflicts exactly when they are the same SOURCE of money: two accounts of one
// provider, or a generic method (could be any provider of its kind) beside a named one; named
// providers that differ, or a wallet beside a bank, are different sources and both stand.
func TestREG_KERNEL_PAY_016_SameSourceOfMoneyIsOneSource(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	for i, c := range []struct {
		kindA, keyA, kindB, keyB string
		conflict                 bool
	}{
		{"wallet", "telebirr", "wallet", "telebirr", true},
		{"bank", "", "bank", "cbe", true},
		{"bank", "cbe", "bank", "", true},
		{"wallet", "", "wallet", "telebirr", true},
		{"bank", "", "bank", "", true},
		{"bank", "cbe", "bank", "zemen", false},
		{"wallet", "telebirr", "wallet", "mpesa", false},
		{"wallet", "telebirr", "bank", "cbe", false},
		{"bank", "", "wallet", "", false},
	} {
		a := e.rail(t, e.tid(), c.kindA, c.keyA, "acct-a", true, true)
		b := e.rail(t, e.tid(), c.kindB, c.keyB, "acct-b", true, true)
		ref := "SRC-" + uuid.NewString()[:10]
		if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
			return payments.ClaimReference(ctx, tx, e.tid(), &a, ref, i64(int64(100+i)), nil, "10.00", nil)
		}); err != nil {
			t.Fatalf("case %d: first claim: %v", i, err)
		}
		err := e.in(t, e.tid(), func(tx pgx.Tx) error {
			return payments.ClaimReference(ctx, tx, e.tid(), &b, ref, i64(int64(200+i)), nil, "10.00", nil)
		})
		got := code(err) == "REFERENCE_USED"
		if got != c.conflict || (!c.conflict && err != nil) {
			t.Errorf("case %d (%s/%s then %s/%s): %s; want conflict=%v", i, c.kindA, c.keyA, c.kindB, c.keyB, errText(err), c.conflict)
		}
	}
}

// Given a reference the desk only CHECKED with the bank under one method (no receipt), When it is
// claimed under another method of the same source, Then it stands: checking is not paying.
func TestREG_KERNEL_PAY_017_AReferenceOnlyCheckedIsNotUsed(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	a := e.rail(t, e.tid(), "wallet", "telebirr", "0911000051", true, true)
	b := e.rail(t, e.tid(), "wallet", "telebirr", "0911000052", true, true)
	if _, err := e.super.Pool.Exec(ctx,
		`INSERT INTO payment_references (tenant_id, payment_rail_id, reference, reference_norm, verify_state, verified_amount)
		 VALUES ($1, $2, 'CHK-1', 'CHK-1', 'verified', 200)`, e.tid(), a); err != nil {
		t.Fatal(err)
	}
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &b, "CHK-1", i64(7), nil, "200.00", nil)
	}); err != nil {
		t.Fatalf("a reference that was only checked was refused: %v", err)
	}
}

// Given an amount that is not a number or a context that has gone away, When a reference is
// claimed, Then the database's complaint is returned untouched and nothing is recorded: the
// claim fails whole instead of marking something paid on a half-understood amount.
func TestREG_KERNEL_PAY_019_ABrokenClaimRecordsNothing(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	r := e.rail(t, e.tid(), "wallet", "telebirr", "0911000061", true, true)
	err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &r, "BROKEN-1", i64(1), nil, "not-a-number", nil)
	})
	if err == nil || code(err) != "" {
		t.Fatalf("an unreadable amount: %s, want the raw database error", errText(err))
	}
	if row := e.refRow(t, e.tid(), r, "BROKEN-1"); row.Count != 0 {
		t.Fatalf("a failed claim left %d row(s)", row.Count)
	}
	gone, cancel := context.WithCancel(ctx)
	cancel()
	err = e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(gone, tx, e.tid(), &r, "BROKEN-2", i64(2), nil, "10.00", nil)
	})
	if err == nil {
		t.Fatalf("a claim with a cancelled context succeeded")
	}
}

// Given the same transfer entered by four desks at the same instant, each under a different
// method of one provider, When they all claim it, Then exactly one wins and the rest are told it
// is used: the methods are different rows, so only the lock on the reference can tell them apart.
func TestREG_KERNEL_PAY_018_SimultaneousClaimsOnDifferentMethodsTakeOnce(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	for round := 0; round < 5; round++ {
		rails := make([]uuid.UUID, 4)
		for i := range rails {
			rails[i] = e.rail(t, e.tid(), "wallet", "telebirr", "acct", true, true)
		}
		ref := "RACE-" + uuid.NewString()[:10]
		results := make([]error, len(rails))
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := range rails {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				results[i] = e.in(t, e.tid(), func(tx pgx.Tx) error {
					return payments.ClaimReference(ctx, tx, e.tid(), &rails[i], ref, i64(int64(900+i)), nil, "50.00", nil)
				})
			}(i)
		}
		close(start)
		wg.Wait()
		won, used := 0, 0
		for _, err := range results {
			switch {
			case err == nil:
				won++
			case code(err) == "REFERENCE_USED":
				used++
			default:
				t.Fatalf("round %d: unexpected error %v", round, err)
			}
		}
		if won != 1 || used != len(rails)-1 {
			t.Fatalf("round %d: %d claims succeeded and %d were refused; want 1 and %d", round, won, used, len(rails)-1)
		}
	}
}

// Given clinic A used a reference, When clinic B claims the same reference, Then B's claim stands
// on its own (the table is per clinic by design; the vendor's platform-wide confirmation history
// flags it for review), and neither clinic can see the other's row.
func TestREG_KERNEL_PAY_015_CrossClinicClaimsAreIsolated(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	other := testkit.NewClinic(t, e.super, testkit.ClinicOpts{ClinicType: "general"})
	ra := e.rail(t, e.tid(), "wallet", "telebirr", "0911", true, true)
	rb := e.rail(t, other.TenantID, "wallet", "telebirr", "0912", true, true)
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, e.tid(), &ra, "SHARED-1", i64(1), nil, "10", nil)
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.in(t, other.TenantID, func(tx pgx.Tx) error {
		return payments.ClaimReference(ctx, tx, other.TenantID, &rb, "SHARED-1", i64(1), nil, "10", nil)
	}); err != nil {
		t.Fatalf("another clinic's claim is independent by design: %v", err)
	}
	// B, asking about A's rail through RLS, sees nothing.
	_ = e.in(t, other.TenantID, func(tx pgx.Tx) error {
		st, _, err := payments.VerifyStateOf(ctx, tx, e.tid(), &ra, "SHARED-1")
		var n int
		_ = tx.QueryRow(ctx, `SELECT count(*) FROM payment_references WHERE tenant_id=$1`, e.tid()).Scan(&n)
		if err != nil || st != "" || n != 0 {
			t.Fatalf("cross-clinic leak: state=%q n=%d err=%v", st, n, err)
		}
		return nil
	})
	// And the vendor's "confirmed before" on B's check is a review, never an accept.
	r := verified("10")
	r.Confirmation = &verifyet.Confirmation{Scope: "platform", ConfirmedBefore: true, ConfirmationCount: 2}
	_ = e.in(t, other.TenantID, func(tx pgx.Tx) error {
		rl, _ := payments.LoadRail(ctx, tx, other.TenantID, rb)
		chk, err := payments.RunCheck(ctx, tx, &fakeVerifier{live: true, res: r}, other.TenantID, rl, "SHARED-2", "10", nil, 0, nil)
		if err != nil || chk.State != verifyet.Review {
			t.Fatalf("platform replay must review: %+v %v", chk, err)
		}
		return nil
	})
}

// Given concurrent settles racing on one reference, When both claim at once, Then exactly one wins.
func TestREG_KERNEL_PAY_016_ConcurrentClaimsOneWinner(t *testing.T) {
	e := setup(t)
	rail := e.rail(t, e.tid(), "bank", "cbe", "1000", true, true)
	var wg sync.WaitGroup
	errs := make([]error, 6)
	for i := range errs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			errs[i] = e.in(t, e.tid(), func(tx pgx.Tx) error {
				return payments.ClaimReference(context.Background(), tx, e.tid(), &rail, "RACE-1", i64(int64(100+i)), nil, "1", nil)
			})
		}(i)
	}
	wg.Wait()
	ok, used := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case code(err) == "REFERENCE_USED":
			used++
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	if ok != 1 || used != len(errs)-1 {
		t.Fatalf("want 1 winner, got ok=%d used=%d", ok, used)
	}
}

// --- RunCheck ----------------------------------------------------------------

// Given vendor failures of every kind, When the desk checks a reference, Then the answer is never "verified", nothing is recorded, and the settle is not blocked.
func TestREG_KERNEL_PAY_020_VendorFailuresNeverVerify(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911", true, true)
	cases := []struct {
		kind, state, reason string
	}{
		{verifyet.KindNoCredit, "unchecked", "credits have run out"},
		{verifyet.KindRateLimited, "unchecked", "Could not reach"},
		{verifyet.KindUnavailable, "unchecked", "Could not reach"},
		{verifyet.KindTransport, "unchecked", "Could not reach"},
		{verifyet.KindAuth, "unchecked", "misconfigured"},
		{verifyet.KindForbidden, "unchecked", "misconfigured"},
		{verifyet.KindInvalid, verifyet.Review, "could not read those details"},
		{verifyet.KindConflict, "unchecked", "did not complete"},
		{"", "unchecked", "did not complete"},
	}
	for i, tc := range cases {
		ref := "FAIL-" + string(rune('A'+i))
		var verr error = &verifyet.Error{Kind: tc.kind, Message: "x"}
		if tc.kind == "" {
			verr = errors.New("plain")
		}
		_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
			rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
			chk, err := payments.RunCheck(ctx, tx, &fakeVerifier{live: true, err: verr}, e.tid(), rl, ref, "100", nil, 0, nil)
			if err != nil || chk.State != tc.state || !strings.Contains(chk.Reason, tc.reason) {
				t.Errorf("%s: %+v %v", tc.kind, chk, err)
			}
			return nil
		})
		if row := e.refRow(t, e.tid(), rail, ref); row.Count != 0 {
			t.Errorf("%s: a failed check must not record a verdict: %+v", tc.kind, row)
		}
	}
}

// Given a real client against a fake Verify.ET, When the vendor is slow past the deadline, 5xx, or sends malformed JSON, Then RunCheck reports unchecked and records nothing.
func TestREG_KERNEL_PAY_021_RealClientFailuresThroughRunCheck(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	rail := e.rail(t, e.tid(), "bank", "cbe", "1000123", true, true)
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	handlers := map[string]http.HandlerFunc{
		"slow": func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-stop:
			case <-time.After(5 * time.Second):
			}
		},
		"5xx":       func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(503) },
		"malformed": func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, `{"verification":`) },
	}
	for name, h := range handlers {
		srv := httptest.NewServer(h)
		client := verifyet.New("test-key", srv.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
		ref := "RC-" + name
		cctx, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
		_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
			rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
			chk, err := payments.RunCheck(cctx, tx, client, e.tid(), rl, ref, "100", nil, 0, nil)
			if err != nil || chk.State != "unchecked" {
				t.Errorf("%s: want unchecked, got %+v %v", name, chk, err)
			}
			return nil
		})
		cancel()
		srv.Close()
		if row := e.refRow(t, e.tid(), rail, ref); row.Count != 0 {
			t.Errorf("%s: nothing may be recorded: %+v", name, row)
		}
	}
}

// Given a real client against a fake Verify.ET, When the vendor confirms, Then the request is idempotent per claim, explicit about OUR account, and a wrong-amount/wrong-receiver answer is recorded as review/rejected.
func TestREG_KERNEL_PAY_022_RealClientVerdictsAndIdempotency(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	rail := e.rail(t, e.tid(), "bank", "cbe", "1000123456", true, true)
	var mu sync.Mutex
	var idems, accounts, banks []string
	item := `{"status":"success","verified":true,"amount":"100.00","currency":"ETB","senderName":"S","receiverAccount":"1****3456",
	  "settlementAccountMatch":{"matched":true,"matchConfidence":"high","reason":"receiver_account_exact_match"}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		idems = append(idems, r.Header.Get("Idempotency-Key"))
		accounts = append(accounts, string(body))
		banks = append(banks, r.URL.RawQuery)
		mu.Unlock()
		w.Header().Set("x-request-id", "trace-xyz")
		_, _ = io.WriteString(w, `{"requestId":"vr-1","verification":{"processingStatus":"completed","status":"success","verified":true},"data":[`+item+`]}`)
	}))
	defer srv.Close()
	client := verifyet.New("test-key", srv.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	check := func(ref, expected string) *payments.Check {
		var out *payments.Check
		_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
			rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
			c, err := payments.RunCheck(ctx, tx, client, e.tid(), rl, ref, expected, nil, 2000, nil)
			if err != nil {
				t.Fatalf("check %s: %v", ref, err)
			}
			out = c
			return nil
		})
		return out
	}
	if c := check(" ft-1 ", "100"); c.State != verifyet.Accept {
		t.Fatalf("want verified, got %+v", c)
	}
	_ = check("FT-1", "100")
	_ = check("FT-2", "100")
	mu.Lock()
	if idems[0] != idems[1] || idems[0] == idems[2] || !strings.HasSuffix(idems[0], ":FT-1") {
		t.Fatalf("idempotency keys: %q", idems)
	}
	if !strings.Contains(accounts[0], `"settlementAccount":"1000123456"`) || !strings.Contains(accounts[0], `"bank":"cbe"`) ||
		banks[0] != "waitMs=2000" {
		t.Fatalf("request must name our account and bank explicitly: %s %s", accounts[0], banks[0])
	}
	mu.Unlock()
	row := e.refRow(t, e.tid(), rail, "FT-1")
	if row.Count != 1 || *row.State != "verified" || *row.Trace != "trace-xyz" || *row.ReqID != "vr-1" {
		t.Fatalf("recorded: %+v", row)
	}
	// Wrong amount: review, recorded, and the re-check overwrites the earlier verdict on an uncollected row.
	if c := check("FT-1", "150"); c.State != verifyet.Review || !strings.Contains(c.Reason, "150.00") {
		t.Fatalf("wrong amount must review: %+v", c)
	}
	if row := e.refRow(t, e.tid(), rail, "FT-1"); *row.State != "review" || *row.Detail != "amount_mismatch" {
		t.Fatalf("re-check must update the uncollected row: %+v", row)
	}
}

// Given a check with no reference, no verifiable rail, or verification switched off, When RunCheck runs, Then the desk is told so and nothing is accepted.
func TestREG_KERNEL_PAY_023_RunCheckPreconditions(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911", true, true)
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
		if _, err := payments.RunCheck(ctx, tx, nil, e.tid(), rl, "   ", "", nil, 0, nil); code(err) != "VALIDATION_FAILED" {
			t.Errorf("blank ref: %v", err)
		}
		if c, err := payments.RunCheck(ctx, tx, nil, e.tid(), nil, "R", "", nil, 0, nil); err != nil || c.State != "unchecked" {
			t.Errorf("no rail: %+v %v", c, err)
		}
		if c, err := payments.RunCheck(ctx, tx, nil, e.tid(), rl, "R", "", nil, 0, nil); err != nil || c.State != "unchecked" ||
			!strings.Contains(c.Reason, "not switched on") {
			t.Errorf("nil verifier: %+v %v", c, err)
		}
		off := &fakeVerifier{live: false, res: verified("1")}
		if c, _ := payments.RunCheck(ctx, tx, off, e.tid(), rl, "R", "", nil, 0, nil); c.State != "unchecked" || len(off.calls) != 0 {
			t.Errorf("not live: %+v calls=%d", c, len(off.calls))
		}
		// A pending vendor answer is recorded as pending, never verified.
		p := verified("1")
		p.ProcessingStatus = "queued"
		c, err := payments.RunCheck(ctx, tx, &fakeVerifier{live: true, res: p}, e.tid(), rl, "PEND", "1", nil, 0, nil)
		if err != nil || c.State != verifyet.Pending {
			t.Errorf("pending: %+v %v", c, err)
		}
		st, _, _ := payments.VerifyStateOf(ctx, tx, e.tid(), &rail, "pend")
		if st != "pending" {
			t.Errorf("pending state recorded as %q", st)
		}
		// A result with no settlement / confirmation / amount / sender still records.
		bare := &verifyet.Result{ProcessingStatus: "completed", Status: "not_found"}
		c, err = payments.RunCheck(ctx, tx, &fakeVerifier{live: true, res: bare}, e.tid(), rl, "BARE", "1", nil, 0, nil)
		if err != nil || c.State != verifyet.Reject {
			t.Errorf("bare: %+v %v", c, err)
		}
		return nil
	})
	// Recording against a patient that does not exist fails the check rather than storing a dangling row.
	ghost := uuid.New()
	err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		rl, _ := payments.LoadRail(ctx, tx, e.tid(), rail)
		_, err := payments.RunCheck(ctx, tx, &fakeVerifier{live: true, res: verified("1")}, e.tid(), rl, "GHOST", "1", &ghost, 0, nil)
		return err
	})
	if err == nil {
		t.Fatal("a failed record must surface as an error")
	}
}

// --- LoadRail / VerifyStateOf / StampCharges --------------------------------

// Given rails of each kind, When loaded for verification, Then only wallet/bank rails naming a provider are verifiable.
func TestREG_KERNEL_PAY_030_LoadRailOnlyVerifiableRails(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	cash := e.rail(t, e.tid(), "cash", "", "", false, true)
	card := e.rail(t, e.tid(), "card", "cbe", "", false, true)
	generic := e.rail(t, e.tid(), "wallet", "", "", false, true)
	bank := e.rail(t, e.tid(), "bank", "cbe", "1000999", false, true)
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		for name, id := range map[string]uuid.UUID{"cash": cash, "card": card, "generic": generic} {
			r, err := payments.LoadRail(ctx, tx, e.tid(), id)
			if err != nil || r != nil {
				t.Errorf("%s must not be verifiable: %+v %v", name, r, err)
			}
		}
		r, err := payments.LoadRail(ctx, tx, e.tid(), bank)
		if err != nil || r == nil || r.ID != bank || r.BankKey != "cbe" || r.Account != "1000999" || r.Kind != "bank" {
			t.Errorf("bank: %+v %v", r, err)
		}
		if _, err := payments.LoadRail(ctx, tx, e.tid(), uuid.New()); code(err) != "VALIDATION_FAILED" {
			t.Errorf("unknown: %v", err)
		}
		st, why, err := payments.VerifyStateOf(ctx, tx, e.tid(), nil, "X")
		if st != "" || why != "" || err != nil {
			t.Errorf("nil rail state: %q %q %v", st, why, err)
		}
		st, _, _ = payments.VerifyStateOf(ctx, tx, e.tid(), &bank, "  ")
		if st != "" {
			t.Errorf("blank ref state: %q", st)
		}
		// A claimed-but-never-checked row has a NULL verdict.
		_ = payments.ClaimReference(ctx, tx, e.tid(), &bank, "NOCHECK", i64(5), nil, "1", nil)
		st, why, err = payments.VerifyStateOf(ctx, tx, e.tid(), &bank, "nocheck")
		if st != "" || why != "" || err != nil {
			t.Errorf("unchecked row: %q %q %v", st, why, err)
		}
		return nil
	})
}

// Given pending charges, When the evidence is stamped, Then this clinic's charges carry the rail and reference; another clinic's are untouched; nothing-to-stamp is a no-op.
func TestREG_KERNEL_PAY_031_StampCharges(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	other := testkit.NewClinic(t, e.super, testkit.ClinicOpts{ClinicType: "general"})
	rail := e.rail(t, e.tid(), "wallet", "telebirr", "0911", true, true)
	charge := func(tid uuid.UUID) uuid.UUID {
		var id uuid.UUID
		if err := e.super.Pool.QueryRow(ctx,
			`INSERT INTO charges (tenant_id, patient_id, description, amount) VALUES ($1,$2,'Consult',100) RETURNING id`,
			tid, e.patient(t, tid)).Scan(&id); err != nil {
			t.Fatalf("charge: %v", err)
		}
		return id
	}
	mine1, mine2, theirs := charge(e.tid()), charge(e.tid()), charge(other.TenantID)
	if err := e.in(t, e.tid(), func(tx pgx.Tx) error {
		if err := payments.StampCharges(ctx, tx, e.tid(), []uuid.UUID{mine1}, nil, ""); err != nil {
			return err
		}
		return payments.StampCharges(ctx, tx, e.tid(), []uuid.UUID{mine1, mine2, theirs}, &rail, "TX-1")
	}); err != nil {
		t.Fatal(err)
	}
	read := func(id uuid.UUID) (*uuid.UUID, *string) {
		var r *uuid.UUID
		var ref *string
		_ = e.super.Pool.QueryRow(ctx, `SELECT payment_rail_id, payment_reference FROM charges WHERE id=$1`, id).Scan(&r, &ref)
		return r, ref
	}
	for _, id := range []uuid.UUID{mine1, mine2} {
		r, ref := read(id)
		if r == nil || *r != rail || ref == nil || *ref != "TX-1" {
			t.Errorf("charge %s not stamped: %v %v", id, r, ref)
		}
	}
	if r, ref := read(theirs); r != nil || ref != nil {
		t.Errorf("another clinic's charge was stamped: %v %v", r, ref)
	}
	// Rail without a reference (cash): rail stamped, reference NULL not "".
	cash := e.rail(t, e.tid(), "cash", "", "", false, true)
	_ = e.in(t, e.tid(), func(tx pgx.Tx) error {
		return payments.StampCharges(ctx, tx, e.tid(), []uuid.UUID{mine2}, &cash, "")
	})
	if r, ref := read(mine2); r == nil || *r != cash || ref != nil {
		t.Errorf("cash stamp: %v %v", r, ref)
	}
}
