#!/usr/bin/env bash
# Measured coverage for the dental clinic system, and the gate that keeps it.
#
#   scripts/test/coverage.sh                    # measure + gate (fails on an untested route or a drop)
#   scripts/test/coverage.sh --update-baseline  # also raise the ratchet to today's numbers
#
# It runs every Go test twice-instrumented: unit + integration tests with -cover, and the
# black-box API suite against an API binary built with -cover (so coverage reflects real
# requests through routing, middleware and SQL). The two are merged. Outputs in .regress/:
#   coverage.html            every source line, green covered / red not — open it
#   coverage-func.txt        per-function coverage
#   uncovered-dental.txt     functions in gated packages that no test reaches
#   coverage-gate.txt        the gate result (routes + package ratchet)
# Needs TEST_DATABASE_URL (a throwaway Postgres; see TESTING.md).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/.regress"; mkdir -p "$OUT"
UPDATE=""; [[ "${1:-}" == "--update-baseline" ]] && UPDATE="--update-baseline"
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a throwaway Postgres (see TESTING.md)}"

U="$OUT/cov-unit"; A="$OUT/cov-api"; rm -rf "$U" "$A"; mkdir -p "$U" "$A"
cd "$ROOT/backend"

echo "▶ unit + integration tests (instrumented)"
go test ./internal/... -count=1 -p 1 -cover -coverpkg=./internal/... -args -test.gocoverdir="$U" >"$OUT/cov-unit.log" 2>&1
rc_unit=$?

echo "▶ API regression suite against an instrumented API binary"
REGRESS_COVER_DIR="$A" REGRESS_ROUTES_OUT="$OUT/routes-hit.txt" \
  go test ./tests/regression/ -count=1 >"$OUT/cov-api.log" 2>&1
rc_api=$?

echo "▶ merging"
go tool covdata percent -i="$U,$A" >"$OUT/coverage-percent.txt" 2>/dev/null
go tool covdata textfmt -i="$U,$A" -o "$OUT/coverage.out"
go tool cover -func="$OUT/coverage.out" >"$OUT/coverage-func.txt"
go tool cover -html="$OUT/coverage.out" -o "$OUT/coverage.html"

# Functions in gated packages that nothing reaches: the to-do list.
PKGS=$(grep -v '^#' "$ROOT/scripts/test/coverage-baseline.txt" | awk '{print $1}' | paste -sd'|')
grep -E "github.com/reicb/clinicsaas/($PKGS)/" "$OUT/coverage-func.txt" | awk '$NF=="0.0%"' \
  | sed 's#github.com/reicb/clinicsaas/##' >"$OUT/uncovered-dental.txt"

python3 "$ROOT/scripts/test/coverage_gate.py" \
  --routes-all "$OUT/routes-hit.txt.all" --routes-hit "$OUT/routes-hit.txt" \
  --scope "$ROOT/scripts/test/dental-scope.txt" --percent "$OUT/coverage-percent.txt" \
  --baseline "$ROOT/scripts/test/coverage-baseline.txt" --report "$OUT/coverage-gate.txt" $UPDATE
rc_gate=$?

echo
echo "  uncovered functions in gated packages: $(wc -l <"$OUT/uncovered-dental.txt")  (.regress/uncovered-dental.txt)"
echo "  line-by-line report: .regress/coverage.html"
[[ $rc_unit != 0 ]] && echo "  ✗ unit/integration tests failed — see .regress/cov-unit.log"
[[ $rc_api != 0 ]] && echo "  ✗ API regression tests failed — see .regress/cov-api.log"
exit $(( rc_unit != 0 || rc_api != 0 || rc_gate != 0 ))
