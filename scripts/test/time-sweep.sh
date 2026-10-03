#!/usr/bin/env bash
# Run the frontend suite at moments that break date/time assumptions: just after
# midnight Addis (still "yesterday" in UTC), midday, late evening, the last minute
# of a month, a leap day, and a browser in another time zone. A test that passes
# at 3 pm and fails at 2 am is a false alarm waiting for someone's change.
set -uo pipefail
cd "$(dirname "$0")/../../frontend"
rc=0
run() { # TZ FAKE_NOW
  printf '▶ TZ=%-20s now=%s … ' "$1" "$2"
  if TZ="$1" FAKE_NOW="$2" npx vitest run --reporter=dot >/tmp/time-sweep.log 2>&1; then echo ok
  else echo FAIL; grep -E "FAIL|×" /tmp/time-sweep.log | head -10; rc=1; fi
}
run Africa/Addis_Ababa 2026-10-03T00:20:00+03:00
run Africa/Addis_Ababa 2026-10-03T02:45:00+03:00
run Africa/Addis_Ababa 2026-10-03T13:00:00+03:00
run Africa/Addis_Ababa 2026-10-03T23:50:00+03:00
run Africa/Addis_Ababa 2026-10-31T23:59:00+03:00
run Africa/Addis_Ababa 2028-02-29T10:00:00+03:00
run America/New_York   2026-10-03T23:30:00-04:00
run UTC                2026-12-31T22:30:00Z
exit $rc
