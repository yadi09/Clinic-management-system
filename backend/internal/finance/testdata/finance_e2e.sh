#!/usr/bin/env bash
# Finance views must agree with the charge ledger — y-clinic TEST tenant.
#
# Every assertion compares the API against SQL run straight over `charges`. A
# finance page that disagrees with the ledger is worse than no finance page.
set -u
H='Host: app.clinicos.cc'; B=https://localhost:8443/api/v1; J='Content-Type: application/json'
TEN=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; PASS=$((PASS+1));
      else echo "  FAIL $1: want $3 got $2"; FAIL=$((FAIL+1)); fi; }
jqf(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

T=$(curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"fin.doc@yclinic.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]')
[ -n "$T" ] || { echo "cannot log in"; exit 1; }
A=(-H "$H" -H "$J" -H "Authorization: Bearer $T")

FROM=$($PSQL -c "SELECT ((now() AT TIME ZONE 'Africa/Addis_Ababa')::date - 365)::text;")
TO=$($PSQL -c "SELECT ((now() AT TIME ZONE 'Africa/Addis_Ababa')::date)::text;")
OV=$(curl -sk "${A[@]}" "$B/finance/overview?from=$FROM&to=$TO")

echo "== 1. collected nets refunds, and matches the ledger =="
LEDGER=$($PSQL -c "SELECT coalesce(sum(amount),0)::text FROM charges
  WHERE tenant_id='$TEN' AND status='paid' AND deleted_at IS NULL
    AND settled_at >= '$FROM'::date AND settled_at < ('$TO'::date + 1);")
ok "collected == ledger" "$(echo "$OV" | jqf 'd["data"]["collected"]')" "$LEDGER"

echo "== 2. refunded is reported separately, as a positive number =="
REF=$($PSQL -c "SELECT coalesce(-sum(amount),0)::text FROM charges
  WHERE tenant_id='$TEN' AND status='paid' AND deleted_at IS NULL AND amount < 0
    AND settled_at >= '$FROM'::date AND settled_at < ('$TO'::date + 1);")
ok "refunded == ledger" "$(echo "$OV" | jqf 'd["data"]["refunded"]')" "$REF"

echo "== 3. owed is NOT period-bound and matches pending charges =="
PEND=$($PSQL -c "SELECT coalesce(sum(amount),0)::text FROM charges
  WHERE tenant_id='$TEN' AND status='pending' AND deleted_at IS NULL;")
ok "outstanding == pending" "$(echo "$OV" | jqf 'd["data"]["outstanding"]')" "$PEND"

echo "== 4. the by-source split adds up to gross collected =="
GROSS=$($PSQL -c "SELECT coalesce(sum(amount),0)::text FROM charges
  WHERE tenant_id='$TEN' AND status='paid' AND deleted_at IS NULL AND amount > 0
    AND settled_at >= '$FROM'::date AND settled_at < ('$TO'::date + 1);")
ok "sum(by_source) == gross" "$(echo "$OV" | jqf 'format(sum(float(l["amount"]) for l in d["data"]["by_source"]),".2f")')" "$GROSS"

echo "== 5. the daily series covers the window and sums to collected =="
# from and to are both INCLUSIVE days, so the series covers the endpoints too.
DAYS=$(( ( $(date -d "$TO" +%s) - $(date -d "$FROM" +%s) ) / 86400 + 1 ))
ok "series length"    "$(echo "$OV" | jqf 'len(d["data"]["series"])')" "$DAYS"
ok "series sums"      "$(echo "$OV" | jqf 'format(sum(float(p["amount"]) for p in d["data"]["series"]),".2f")')" "$LEDGER"

echo "== 6. receivables agree with the same pending total =="
RC=$(curl -sk "${A[@]}" "$B/finance/receivables")
ok "rows sum == total"     "$(echo "$RC" | jqf 'format(sum(float(r["owed"]) for r in d["data"]["rows"]),".2f")')" "$(echo "$RC" | jqf 'd["data"]["total"]')"
ok "buckets sum == total"  "$(echo "$RC" | jqf 'format(sum(float(b["amount"]) for b in d["data"]["buckets"]),".2f")')" "$(echo "$RC" | jqf 'd["data"]["total"]')"
ok "every row bucketed"    "$(echo "$RC" | jqf 'all(r["bucket"] in ("0-30","31-60","61-90","90+") for r in d["data"]["rows"])')" "True"
ok "oldest first"          "$(echo "$RC" | jqf '"yes" if all(d["data"]["rows"][i]["oldest_days"] >= d["data"]["rows"][i+1]["oldest_days"] for i in range(len(d["data"]["rows"])-1)) else "no"')" "yes"

echo "== 7. a bad period is refused, not silently swapped =="
ok "to before from" "$(curl -sk -o /dev/null -w '%{http_code}' "${A[@]}" "$B/finance/overview?from=$TO&to=$FROM")" "400"
ok "bad date"       "$(curl -sk -o /dev/null -w '%{http_code}' "${A[@]}" "$B/finance/overview?from=nonsense")" "400"

echo "== 8. it is gated on billing.manage =="
T2=$(curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"fin.nurse@yclinic.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]')
ok "nurse blocked" "$(curl -sk -o /dev/null -w '%{http_code}' -H "$H" -H "Authorization: Bearer $T2" "$B/finance/overview")" "403"

echo; echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
