#!/usr/bin/env bash
# The regression suite: one command that says whether existing behaviour still works.
#
#   scripts/test/regress.sh              # everything that needs no browser (default)
#   scripts/test/regress.sh --quick      # unit tests only, no database (seconds)
#   scripts/test/regress.sh --e2e        # also the browser journeys (Playwright, system Chrome)
#   scripts/test/regress.sh --db-up      # start a throwaway Postgres in Docker for this run
#   scripts/test/regress.sh --only PAY   # one regression domain (REG_PAY…), backend only
#   scripts/test/regress.sh --coverage   # also the dental coverage gate: every in-scope API
#                                        # route tested, no package below its coverage baseline
#
# Database: set TEST_DATABASE_URL to a THROWAWAY Postgres (superuser). The suite refuses
# any database that is not on localhost or whose name lacks "test"/"regress", so it
# cannot reach a clinic's real data. See TESTING.md.
#
# Exit code 0 only when nothing failed. Known, catalogued bugs are listed but do not fail
# the run; REGRESSION_STRICT=1 makes them fail too.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUM="python3 $ROOT/scripts/test/summarize.py"
MODE=full E2E=0 DBUP=0 ONLY="" COVER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) MODE=quick ;;
    --e2e) E2E=1 ;;
    --db-up) DBUP=1 ;;
    --coverage) COVER=1 ;;
    --only) ONLY="$2"; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

REPORT_DIR="$ROOT/.regress"; mkdir -p "$REPORT_DIR"
declare -A STATUS
step() { echo; echo "▶ $1"; }

if [[ $DBUP == 1 ]]; then
  step "Starting a throwaway Postgres (Docker, in-memory)"
  docker rm -f clinicos-regress-db >/dev/null 2>&1 || true
  docker run -d --rm --name clinicos-regress-db -p 127.0.0.1:55440:5432 \
    -e POSTGRES_PASSWORD=regress -e POSTGRES_DB=clinic_regress \
    --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null || { echo "docker failed"; exit 2; }
  for _ in $(seq 1 40); do docker exec clinicos-regress-db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done
  export TEST_DATABASE_URL="postgres://postgres:regress@127.0.0.1:55440/clinic_regress?sslmode=disable"
  trap 'docker rm -f clinicos-regress-db >/dev/null 2>&1' EXIT
fi

cd "$ROOT/backend"

if [[ -n "$ONLY" ]]; then
  step "Backend regression: REG_${ONLY}"
  go test ./tests/regression/ -run "REG_${ONLY}" -count=1 -json 2>&1 | $SUM --title "REG_${ONLY}"
  exit $?
fi

step "Backend: build, vet, module boundaries"
if go build ./... && go vet ./... && go run ./tools/importlint; then STATUS[static]=ok; else STATUS[static]=FAIL; fi

if [[ $MODE == quick ]]; then
  step "Backend unit tests"
  go test ./... -short -count=1 -json 2>&1 | $SUM --title "Backend unit" --junit "$REPORT_DIR/backend-unit.xml"; rc_b=$?
  STATUS[backend]=$([[ $rc_b == 0 ]] && echo ok || echo FAIL)
else
  if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
    echo "TEST_DATABASE_URL is not set: database and API tests would be skipped." >&2
    echo "Use --db-up (Docker) or point it at a throwaway Postgres. See TESTING.md." >&2
    exit 2
  fi
  step "Backend: unit + integration + API regression (database: ${TEST_DATABASE_URL%%\?*})"
  # -p 1: packages share one test database; serial packages keep failures readable.
  go test ./... -count=1 -p 1 -json 2>&1 | tee "$REPORT_DIR/backend.json" | $SUM --title "Backend" --junit "$REPORT_DIR/backend.xml"; rc_b=$?
  STATUS[backend]=$([[ $rc_b == 0 ]] && echo ok || echo FAIL)
fi

cd "$ROOT/frontend"
step "Frontend: lint, typecheck, unit tests"
if npx eslint src --quiet && npx tsc --noEmit -p .; then STATUS[frontend-static]=ok; else STATUS[frontend-static]=FAIL; fi
# --coverage enforces the per-area thresholds in vitest.config.ts (the frontend ratchet).
if npx vitest run --coverage --reporter=default --reporter=junit --outputFile.junit="$REPORT_DIR/frontend.xml"; then STATUS[frontend-unit]=ok; else STATUS[frontend-unit]=FAIL; fi

if [[ $COVER == 1 ]]; then
  step "Dental coverage gate (instrumented API + every Go test)"
  if "$ROOT/scripts/test/coverage.sh"; then STATUS[coverage]=ok; else STATUS[coverage]=FAIL; fi
fi

if [[ $E2E == 1 ]]; then
  step "End-to-end journeys (Playwright, system Chrome)"
  if npx playwright test; then STATUS[e2e]=ok; else STATUS[e2e]=FAIL; fi
fi

echo; echo "════════ REGRESSION RESULT ════════"
rc=0
for k in static backend frontend-static frontend-unit coverage e2e; do
  [[ -z "${STATUS[$k]:-}" ]] && continue
  printf "  %-16s %s\n" "$k" "${STATUS[$k]}"
  [[ "${STATUS[$k]}" != ok ]] && rc=1
done
echo "  reports: $REPORT_DIR/"
[[ $rc == 0 ]] && echo "  ALL PASS — existing behaviour is intact." || echo "  FAILED — do not deploy. Read the failures above."
exit $rc
