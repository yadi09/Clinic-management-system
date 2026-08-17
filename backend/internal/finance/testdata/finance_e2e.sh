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

echo "== 9. cash: shifts, splits, and the variance total agree with the table =="
CA=$(curl -sk "${A[@]}" "$B/finance/cash?from=$FROM&to=$TO")
VAR=$($PSQL -c "SELECT coalesce(sum(abs(variance)),0)::text FROM cash_reconciliations
  WHERE tenant_id='$TEN' AND business_date >= '$FROM'::date AND business_date < ('$TO'::date + 1);")
ok "variance == ledger"  "$(echo "$CA" | jqf 'd["data"]["variance"]')" "$VAR"
ok "shift count"         "$(echo "$CA" | jqf 'len(d["data"]["shifts"])')" \
  "$($PSQL -c "SELECT count(*) FROM cash_reconciliations WHERE tenant_id='$TEN' AND business_date >= '$FROM'::date AND business_date < ('$TO'::date + 1);")"
ok "by_method sums to gross" "$(echo "$CA" | jqf 'format(sum(float(l["amount"]) for l in d["data"]["by_method"]),".2f")')" "$GROSS"
ok "by_cashier sums to gross" "$(echo "$CA" | jqf 'format(sum(float(l["amount"]) for l in d["data"]["by_cashier"]),".2f")')" "$GROSS"

echo "== 10. services: the lines add up to the same gross =="
SV=$(curl -sk "${A[@]}" "$B/finance/services?from=$FROM&to=$TO")
ok "services sum == gross" "$(echo "$SV" | jqf 'format(sum(float(l["revenue"]) for l in d["data"]),".2f")')" "$GROSS"
ok "average is revenue/count" "$(echo "$SV" | jqf '"yes" if all(abs(float(l["avg"]) - float(l["revenue"])/l["count"]) < 0.01 for l in d["data"] if l["count"]) else "no"')" "yes"

echo "== 11. treatment book is intent, and only counts unbilled future visits =="
BK=$(curl -sk "${A[@]}" "$B/finance/book")
BOOK=$($PSQL -c "SELECT coalesce(sum(se.amount_due),0)::text
  FROM treatment_sessions se JOIN treatment_plans pl ON pl.id=se.plan_id AND pl.tenant_id=se.tenant_id
  LEFT JOIN charges c ON c.id=se.charge_id AND c.tenant_id=se.tenant_id AND c.deleted_at IS NULL
  WHERE se.tenant_id='$TEN' AND se.kind='visit' AND se.status='planned' AND pl.status='active'
    AND se.scheduled_date >= (now() AT TIME ZONE 'Africa/Addis_Ababa')::date
    AND (c.id IS NULL OR c.status='void');")
ok "booked == ledger"   "$(echo "$BK" | jqf 'd["data"]["total"]')" "$BOOK"
# Compare as numbers: psql prints 0 where python formats 0.00.
ok "months sum to total" "$(echo "$BK" | jqf 'format(sum(float(m["amount"]) for m in d["data"]["by_month"]),".2f")')" "$(printf '%.2f' "$BOOK")"
ok "at-risk rows are late" "$(echo "$BK" | jqf '"yes" if all(r["days_idle"] > 0 for r in d["data"]["at_risk"]) else "no"')" "yes"

echo "== 12. every view refuses a bad period the same way =="
for V in cash services book; do
  ok "$V rejects bad date" "$(curl -sk -o /dev/null -w '%{http_code}' "${A[@]}" "$B/finance/$V?from=nope")" "400"
done

echo; echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
