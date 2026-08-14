#!/usr/bin/env bash
# Down payment on a treatment plan — end to end, y-clinic TEST tenant only.
#
# The arithmetic is the point: the deposit comes off the top and the SESSIONS
# divide what is left, so total = deposit + Σ sessions and no session is inflated.
# The rest checks that a deposit behaves as money everywhere and as a visit nowhere.
set -u
H='Host: app.clinicos.cc'; B=https://localhost:8443/api/v1; J='Content-Type: application/json'
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; PASS=$((PASS+1));
      else echo "  FAIL $1: want $3 got $2"; FAIL=$((FAIL+1)); fi; }
jqf(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

T=$(curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"deposit.doc@yclinic.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]')
[ -n "$T" ] || { echo "cannot log in"; exit 1; }
A=(-H "$H" -H "$J" -H "Authorization: Bearer $T")

PID=$(curl -sk "${A[@]}" "$B/patients?q=DepositProbe" | jqf 'd["data"][0]["id"]')
[ -n "$PID" ] || { echo "no probe patient"; exit 1; }

# 72,000 course: 20,000 down, 4 monthly sessions of 13,000.
PLAN=$(curl -sk -X POST "${A[@]}" "$B/dental/patients/$PID/plans" -d '{
  "title":"Root canal","total_amount":"72000","deposit":"20000","start_date":"2026-08-14",
  "interval_unit":"month","interval_count":1,"session_count":4}')

echo "== 1. the split =="
ok "deposit recorded"     "$(echo "$PLAN" | jqf 'd["data"]["deposit"]["amount_due"]')" "20000.00"
ok "4 sessions, not 5"    "$(echo "$PLAN" | jqf 'len(d["data"]["sessions"])')" "4"
ok "each session 13,000"  "$(echo "$PLAN" | jqf 'sorted({s["amount_due"] for s in d["data"]["sessions"]})[0]')" "13000.00"
ok "sessions sum to 52k"  "$(echo "$PLAN" | jqf 'format(sum(float(s["amount_due"]) for s in d["data"]["sessions"]),".2f")')" "52000.00"
ok "total is the course"  "$(echo "$PLAN" | jqf 'd["data"]["total_amount"]')" "72000.00"
ok "deposit dated to start" "$(echo "$PLAN" | jqf 'd["data"]["deposit"]["scheduled_date"]')" "2026-08-14"
ok "deposit starts unpaid"  "$(echo "$PLAN" | jqf 'd["data"]["deposit"]["payment"]')" "unpaid"

DEP=$(echo "$PLAN" | jqf 'd["data"]["deposit"]["id"]')
S1=$(echo "$PLAN"  | jqf 'd["data"]["sessions"][0]["id"]')

echo "== 2. it is money: the balance counts it =="
ok "planned = whole course" "$(curl -sk "${A[@]}" "$B/dental/patients/$PID/summary" | jqf 'd["data"]["balance"]["owed"]')" "72000.00"

echo "== 3. it is not a visit =="
ok "cannot be marked done"  "$(curl -sk -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "$B/dental/patients/$PID/sessions/$DEP" -d '{"status":"done"}')" "400"
ok "cannot take notes"      "$(curl -sk -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "$B/dental/patients/$PID/sessions/$DEP" -d '{"notes":"x"}')" "400"
ok "cannot take a script"   "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$DEP/prescriptions" -d '{"items":[{"drug_name":"Amoxicillin"}]}')" "400"
ok "a real session still can" "$(curl -sk -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "$B/dental/patients/$PID/sessions/$S1" -d '{"notes":"ok"}')" "204"

echo "== 4. collecting it =="
ok "sent to cashier"        "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$DEP/collect")" "204"
ok "reads as billed"        "$(curl -sk "${A[@]}" "$B/dental/patients/$PID/summary" | jqf 'd["data"]["plans"][0]["deposit"]["payment"]')" "billed"
ok "receipt says down payment, not session 0/4" \
   "$($PSQL -c "SELECT description FROM charges WHERE tenant_id='e4cfd85b-2fdb-46c8-98f7-04336a29ef0c' AND source='dental' ORDER BY created_at DESC LIMIT 1;")" \
   "Root canal — down payment"

echo "== 5. it is not delivered treatment =="
ok "absent from Unbilled"   "$(curl -sk "${A[@]}" "$B/dental/unbilled" | jqf 'len([r for r in d["data"]["rows"] if r["patient_id"]=="'"$PID"'"])')" "0"

echo "== 6. a plan with no deposit is unchanged =="
P2=$(curl -sk -X POST "${A[@]}" "$B/dental/patients/$PID/plans" -d '{
  "title":"Cleaning","total_amount":"3000","start_date":"2026-08-14",
  "interval_unit":"month","interval_count":1,"session_count":3}')
ok "no deposit field"       "$(echo "$P2" | jqf '"deposit" in d["data"]')" "False"
ok "still splits the whole" "$(echo "$P2" | jqf 'format(sum(float(s["amount_due"]) for s in d["data"]["sessions"]),".2f")')" "3000.00"

echo; echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
