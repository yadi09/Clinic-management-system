# Testing and regression protection

The question this suite answers: **"I changed the code. Did I break anything that worked?"**

Run it before every commit you intend to deploy. CI runs it again on every push, and a red CI run means **do not deploy**.

## One command

```bash
scripts/test/regress.sh --db-up        # needs Docker: starts a throwaway Postgres for the run
# or, with your own throwaway database:
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/clinic_regress?sslmode=disable scripts/test/regress.sh
```

The end of the output tells you what to do:

```
════════ REGRESSION RESULT ════════
  static           ok
  backend          ok
  frontend-static  ok
  frontend-unit    ok
  ALL PASS — existing behaviour is intact.
```

| Command | What it runs | Time |
|---|---|---|
| `scripts/test/regress.sh --quick` | build, vet, module boundaries, backend and frontend unit tests, no database | under a minute |
| `scripts/test/regress.sh` | everything except the browser: unit, database integration, black-box API regression, frontend lint, typecheck and unit | a few minutes |
| `scripts/test/regress.sh --e2e` | also the browser journeys (Playwright) | plus 1–2 min |
| `scripts/test/regress.sh --only PAY` | one backend regression domain | seconds |

Inside `backend/` the same suites have make targets:

| Target | Scope |
|---|---|
| `make test-unit` | Go unit tests, no database |
| `make test` / `make test-integration` | every Go test against `TEST_DATABASE_URL` |
| `make test-api` | the black-box API suite only |
| `make test-tenancy` | clinic isolation (`REG_TENANT`) |
| `make test-auth` | sign-in and permissions (`REG_AUTH`, `REG_AUTHZ`) |
| `make test-patients` | patients (`REG_PATIENT`) |
| `make test-appointments` | appointments, queue, reception (`REG_APPT`) |
| `make test-dental` | dental API tests plus the service-level dental money rules |
| `make test-payments` | payments, finance, dashboard money (`REG_PAY`, `REG_FIN`, `REG_DASH`) |

Inside `frontend/`:

| Command | Scope |
|---|---|
| `npm test` | Vitest unit and component tests |
| `npm run test:watch` | the same, re-running on save |
| `npm run test:e2e` | Playwright browser journeys (starts its own API and Vite) |
| `npm run test:coverage` | unit tests plus coverage; **fails if dental or dashboard coverage drops below the thresholds in `vitest.config.ts`** (HTML report in `frontend/coverage/`) |

Run one test by its catalogue ID: `go test ./tests/regression/ -run REG_PAY_004 -v`, or `npx vitest run -t REG-FE-VISIT-002`.

## The test database (safety)

Database tests need `TEST_DATABASE_URL`: a Postgres **superuser** URL to a **throwaway** database. The suite migrates it to the latest version itself.

The suite **refuses to run** (it fails, it does not skip) unless:

- the host is `localhost`, `127.0.0.1` or `postgres`. `TESTKIT_ALLOW_REMOTE=1` lifts only this rule, for CI service containers; and
- the database name contains `test` or `regress`.

So a misconfigured environment cannot point the suite at a clinic's real data. The API under test starts with a clean environment (`testkit.cleanEnv`). No SMS key, storage key, AI key, Verify.ET or DHIS2 token from your shell can reach it. SMS goes to the log gateway, files to a no-op store, and nothing external is contacted.

Never run the old `scripts/demo-seed/e2e-*.sh` scripts against production. They predate this suite (audit TST-4).

## How the suite is built

```
Unit tests (Go: pure rules · Vitest: visit words, money, focus, calendar, links)
   ↓
Integration tests (Go service + real Postgres: dental money rules D1–D13, notifications,
                   provisioning, RLS)
   ↓
API regression (backend/tests/regression: the REAL api binary, connected as the RLS role
                clinic_app exactly like production, driven over HTTP; two clinics, every role)
   ↓
End-to-end journeys (frontend/e2e: Playwright in a real browser against a real API)
   ↓
regress.sh summary  →  CI (.github/workflows/ci.yml)  →  deploy only when green
```

Each layer has its own job:

- **API regression is the backbone.** Most behaviour that matters (isolation, permissions, money, state transitions) is visible at the HTTP boundary. Tests there survive refactoring, and they exercise routing, middleware, permission checks and row-level security together. The tests arrange data through the API too, so a broken "create patient" fails loudly everywhere instead of being papered over by direct inserts. The superuser pool (`super`) is used only to inspect what the database really holds, or to set up something the API cannot do, such as back-dating a payment.
- **Service-level integration tests** (for example `internal/dental/service/money_integration_test.go`) cover rules with many branches cheaply.
- **Unit tests** cover deterministic functions where many cases are cheap.
- **E2E** covers only the journeys a clinic lives on: sign in, register, find, open a dental patient, follow-ups. It runs in a real browser.

## Reading a failure

The summary groups results by domain:

```
Area                               pass  fail  known  skip
REG PAY                              11     1      2     0  ✗
...
--- 1 FAILED — these are regressions until shown otherwise ---
✗ TestREG_PAY_004_DoubleSettleRecordsOnePayment  (tests/regression)
  payments_test.go:212: second settle: want HTTP 409, got 200 ( )
--- 2 KNOWN BUGS still present (catalogued, not blocking) ---
  • FIN-1        TestREG_PAY_009_DayCloseUsesTheClinicDay: …
```

- **The test name** says which behaviour broke. Its doc comment gives the Given/When/Then.
- **The `file:line` and message** show the expected and actual values.
- **On an API test failure** the last 4 KB of the API's own log is printed after the run.
- **Full machine-readable results** are in `.regress/` (JUnit XML, plus the raw `go test -json`).

## Three kinds of red, and what to do

1. **A new regression.** A test that passed before your change now fails. Fix your change.
2. **A known bug.** A catalogued product bug the team has not fixed yet. Its test asserts the *correct* behaviour, wrapped in `testkit.KnownBug(t, "<ID>", bugPresent, "…")` (Go) or `test.fails(...)` (Vitest). It shows as `KNOWN BUG <ID> still present` and does not fail the run. When someone fixes the bug, the test **fails** with "now passes, remove the marker". That forces the marker to be removed, so from then on the test protects the fix. `REGRESSION_STRICT=1` makes every known bug fail, to list them all.
3. **A test infrastructure failure.** The database is unreachable, the API did not start, or a package does not build. The summary prints `PACKAGE FAILED` with the setup error.

The IDs (`FIN-1`, `SEC-2`, …) come from `docs/production-readiness-audit-2026-10-02.html`. New ones found by tests are `NEW-<AREA>-<n>`.

## Adding a test

Add a test when:

- you fix a bug (see the rule below);
- you add a business rule (money, status change, permission, isolation);
- you change behaviour that clinics rely on.

Backend API test, in `backend/tests/regression/<domain>_test.go`:

```go
// TestREG_PAY_012_RefundRestoresTheBalance: Given a settled 1,000 visit, When the
// manager refunds it, Then the visit is owed again and the receipt shows the refund.
func TestREG_PAY_012_RefundRestoresTheBalance(t *testing.T) {
    c := newClinic(t)                         // private clinic: exact totals
    p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Ref"), "Test")
    ...
    srv.As(t, c, "owner").Do("POST", "/billing/charges/"+id+"/refund", body).Expect(t, 200, "refund")
    var owed string
    one(t, `SELECT …`, &owed, c.TenantID)      // assert what the database holds
}
```

Rules:

- **Name it** `TestREG_<DOMAIN>_<NNN>_<Behaviour>`. Use the next free number in that domain.
- **Doc comment:** Given / When / Then in clinic words.
- **Data:** use `newClinic(t)` for anything with totals or counts. `clinicA`/`clinicB` are shared.
- **Assert behaviour:** status, response body, and the persisted row. Never "function was called".
- **Helpers** go in your test file with a domain prefix. Shared ones go in `helpers_test.go`.

Frontend test: `src/**/<name>.test.ts(x)`, titled with `REG-FE-<AREA>-<NNN>`.

## When behaviour changes on purpose

Change the test **in the same commit** as the behaviour, and say why in the commit message. A test that is edited to match a change nobody intended is a regression hidden, not fixed. If you cannot explain the new expectation in clinic terms, stop and ask.

## The rule for production bugs

1. Reproduce it.
2. Write a test that fails because of it, with the correct expectation.
3. Fix the bug.
4. Watch the test pass.
5. Keep the test forever.

If the fix has to wait, commit the test with `KnownBug("<ID>", …)` so the bug stays visible in every run until it is fixed.

## The dental coverage gate: what "fully tested" means here

No suite can prove a change broke nothing it never checks. So "fully tested" here is something a tool checks. `scripts/test/coverage.sh` (or `regress.sh --coverage`, and the CI job **Dental coverage gate**) fails when either of these is true:

1. **An API route a dental clinic can reach has no test calling it.** The scope is every registered route except the prefixes in `scripts/test/dental-scope.txt`, which lists modules a dental clinic cannot reach and the vendor console, each with its reason. A new endpoint without a test fails the gate the day it is added.
2. **Statement coverage of a gated package drops below its baseline** in `scripts/test/coverage-baseline.txt`. Coverage is measured from the **real running API**, built with `-cover`, merged with unit and integration tests. It only ratchets up: after adding tests, run `scripts/test/coverage.sh --update-baseline` and commit the new baseline.

It also writes the to-do list:

- `.regress/coverage.html`: every source line, green for covered and red for not.
- `.regress/uncovered-dental.txt`: every function in the gated packages that no test reaches.
- `.regress/coverage-gate.txt`: untested routes and per-package numbers.

When you add a business rule, a refusal or a route, a red line in `coverage.html` tells you exactly what still needs a test.

## Deployment gate

```
change → scripts/test/regress.sh (local) → commit/push → CI (all jobs green) → deploy.sh
```

`deploy.sh` does not yet check CI by itself. Until it does, the rule is: **no deploy from a commit whose CI is not green.**
