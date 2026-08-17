#!/usr/bin/env bash
# The down payment, from creating a course to the cashier — y-clinic TEST tenant.
#
# The bug this pins: a course could be created with 20,000 ETB owed up front and
# the chairside panel said nothing at all about it.
set -u
H='Host: app.clinicos.cc'; B=https://localhost:8443/api/v1; J='Content-Type: application/json'
TEN=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; PASS=$((PASS+1));
      else echo "  FAIL $1: want $3 got $2"; FAIL=$((FAIL+1)); fi; }
jqf(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

T=$(curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"dep.doc@yclinic.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]')
[ -n "$T" ] || { echo "cannot log in"; exit 1; }
A=(-H "$H" -H "$J" -H "Authorization: Bearer $T")
PID=$(curl -sk "${A[@]}" "$B/patients?q=DepFlowProbe" | jqf 'd["data"][0]["id"]')

echo "== 1. an exact division is not rounded away =="
# 35,000 with 20,000 down leaves 15,000 over 20 visits = exactly 750 each.
P=$(curl -sk -X POST "${A[@]}" "$B/dental/patients/$PID/plans" -d "{
  \"title\":\"treatment 4\",\"total_amount\":\"35000\",\"deposit\":\"20000\",
  \"start_date\":\"$(date +%F)\",\"interval_unit\":\"week\",\"interval_count\":1,\"session_count\":20}")
ok "every visit 750"   "$(echo "$P" | jqf 'len({s["amount_due"] for s in d["data"]["sessions"]})')" "1"
ok "the amount"        "$(echo "$P" | jqf 'd["data"]["sessions"][0]["amount_due"]')" "750.00"
ok "last is not lumpy" "$(echo "$P" | jqf 'd["data"]["sessions"][-1]["amount_due"]')" "750.00"
ok "total holds"       "$(echo "$P" | jqf 'd["data"]["total_amount"]')" "35000.00"
ok "deposit kept"      "$(echo "$P" | jqf 'd["data"]["deposit"]["amount_due"]')" "20000.00"

echo "== 2. the deposit is owed, and the API says so on the plan =="
ok "unpaid on create"  "$(echo "$P" | jqf 'd["data"]["deposit"]["payment"]')" "unpaid"
DEP=$(echo "$P" | jqf 'd["data"]["deposit"]["id"]')

echo "== 3. sending it to the cashier =="
ok "accepted"          "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$DEP/collect")" "204"
SUM=$(curl -sk "${A[@]}" "$B/dental/patients/$PID/summary")
ok "now at cashier"    "$(echo "$SUM" | jqf '[p for p in d["data"]["plans"] if p["title"]=="treatment 4"][0]["deposit"]["payment"]')" "billed"
ok "receipt wording"   "$($PSQL -c "SELECT description FROM charges WHERE tenant_id='$TEN' AND source='dental' ORDER BY created_at DESC LIMIT 1;")" \
  "treatment 4 — down payment"

echo "== 4. and it lands in the money the patient owes =="
ok "at_cashier on plan" "$(echo "$SUM" | jqf '[p for p in d["data"]["plans"] if p["title"]=="treatment 4"][0]["money"]["at_cashier"]')" "20000.00"

echo; echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
