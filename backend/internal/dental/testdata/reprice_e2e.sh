#!/usr/bin/env bash
# Repricing a visit and re-spreading the course — y-clinic TEST tenant only.
#
# The arithmetic is the whole point. "respread" must keep the course total exactly
# and move the difference onto the visits still to come; "total" must leave those
# alone and move the total instead. Neither may touch a visit whose price is already
# on a receipt.
set -u
H='Host: app.clinicos.cc'; B=https://localhost:8443/api/v1; J='Content-Type: application/json'
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; PASS=$((PASS+1));
      else echo "  FAIL $1: want $3 got $2"; FAIL=$((FAIL+1)); fi; }
jqf(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

T=$(curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"reprice.doc@yclinic.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]')
[ -n "$T" ] || { echo "cannot log in"; exit 1; }
A=(-H "$H" -H "$J" -H "Authorization: Bearer $T")
PID=$(curl -sk "${A[@]}" "$B/patients?q=RepriceProbe" | jqf 'd["data"][0]["id"]')

mkplan(){ curl -sk -X POST "${A[@]}" "$B/dental/patients/$PID/plans" -d "{
  \"title\":\"$1\",\"total_amount\":\"16000\",\"start_date\":\"2026-08-11\",
  \"interval_unit\":\"month\",\"interval_count\":1,\"session_count\":4}"; }
plan(){ curl -sk "${A[@]}" "$B/dental/patients/$PID/summary" \
  | jqf "[p for p in d['data']['plans'] if p['title']=='$1'][0]" ; }
amts(){ curl -sk "${A[@]}" "$B/dental/patients/$PID/summary" \
  | jqf "','.join(s['amount_due'] for s in [p for p in d['data']['plans'] if p['title']=='$1'][0]['sessions'])"; }
total(){ curl -sk "${A[@]}" "$B/dental/patients/$PID/summary" \
  | jqf "[p for p in d['data']['plans'] if p['title']=='$1'][0]['total_amount']"; }
sid(){ curl -sk "${A[@]}" "$B/dental/patients/$PID/summary" \
  | jqf "[p for p in d['data']['plans'] if p['title']=='$1'][0]['sessions'][$2]['id']"; }
reprice(){ curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" \
  "$B/dental/patients/$PID/sessions/$1/reprice" -d "{\"amount\":\"$2\",\"mode\":\"$3\"}"; }

echo "== 1. respread up: 16,000 over 4 stays 16,000 =="
mkplan A >/dev/null
ok "even split"        "$(amts A)" "4000.00,4000.00,4000.00,4000.00"
ok "reprice visit 1"   "$(reprice "$(sid A 0)" 6000 respread)" "204"
# splitAmount rounds to clean units — patients pay 3,300, not 3,333.33.
ok "later visits absorb" "$(amts A)" "6000.00,3300.00,3300.00,3400.00"
ok "total unchanged"   "$(total A)" "16000.00"

echo "== 2. respread down: the rest gets it back =="
mkplan B >/dev/null
ok "reprice visit 1 down" "$(reprice "$(sid B 0)" 1000 respread)" "204"
ok "later visits absorb"  "$(amts B)" "1000.00,5000.00,5000.00,5000.00"
ok "total unchanged"      "$(total B)" "16000.00"

echo "== 3. total mode: the others are left alone =="
mkplan C >/dev/null
ok "reprice on top"    "$(reprice "$(sid C 0)" 6000 total)" "204"
ok "later untouched"   "$(amts C)" "6000.00,4000.00,4000.00,4000.00"
ok "total moved"       "$(total C)" "18000.00"

echo "== 4. a billed visit is frozen, and never absorbs =="
mkplan D >/dev/null
S2=$(sid D 1)
curl -sk -o /dev/null -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$S2/collect"
ok "cannot reprice it"  "$(reprice "$S2" 9000 respread)" "409"
ok "reprice v1 skips it" "$(reprice "$(sid D 0)" 6000 respread)" "204"
ok "v2 held its price"  "$(amts D)" "6000.00,4000.00,3000.00,3000.00"
ok "total unchanged"    "$(total D)" "16000.00"

echo "== 5. last visit: nothing to re-spread onto =="
mkplan E >/dev/null
ok "respread refused"   "$(reprice "$(sid E 3)" 6000 respread)" "400"
ok "total mode works"   "$(reprice "$(sid E 3)" 6000 total)" "204"
ok "total moved"        "$(total E)" "18000.00"

echo "== 6. asking for more than the rest holds =="
mkplan F >/dev/null
ok "refused"            "$(reprice "$(sid F 0)" 20000 respread)" "400"
ok "nothing changed"    "$(amts F)" "4000.00,4000.00,4000.00,4000.00"

echo "== 7. guards =="
ok "bad mode refused"   "$(reprice "$(sid F 0)" 5000 sideways)" "400"
ok "negative refused"   "$(reprice "$(sid F 0)" -5 respread)" "400"

echo; echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
