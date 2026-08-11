#!/usr/bin/env bash
# Phase-4 money loop, end to end, on the y-clinic TEST tenant. Never cure-dental.
# Proves: collect -> settle -> refund -> RE-BILL, and write-off -> undo -> bill.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
PW='BranchTest#2026'; EMAIL='money-e2e@yclinic.test'; MRN='MONEY-E2E-1'
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
q(){ echo "$1" | $PSQL 2>/dev/null | head -1 | tr -d "\n" | sed -e "s/^ *//" -e "s/ *$//"; }
jq_py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
login(){ curl -k -sS -H "$HOST" -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$EMAIL\",\"password\":\"$PW\"}" | jq_py "print(d['data']['access_token'])" 2>/dev/null; }
cleanup(){
  local PID; PID=$(q "SELECT id FROM patients WHERE tenant_id='$TID' AND mrn='$MRN';")
  if [ -n "$PID" ]; then
    $PSQL -c "DELETE FROM charges WHERE patient_id='$PID';
              DELETE FROM treatment_sessions WHERE patient_id='$PID';
              DELETE FROM treatment_plans WHERE patient_id='$PID';
              DELETE FROM patients WHERE id='$PID';" >/dev/null 2>&1
  fi
  $PSQL -c "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$EMAIL';
            DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$EMAIL';
            DELETE FROM users WHERE email='$EMAIL';
            DELETE FROM feature_flags WHERE tenant_id='$TID' AND flag='dental';" >/dev/null 2>&1
}
trap cleanup EXIT
echo "=== setup ==="; cleanup
$PSQL -c "INSERT INTO feature_flags (tenant_id,flag,enabled,source) VALUES ('$TID','dental',true,'plan') ON CONFLICT (tenant_id,flag) WHERE branch_id IS NULL DO UPDATE SET enabled=true;" >/dev/null
OWNER=$(q "SELECT id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';")
U=$(q "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$EMAIL','Money E2E','$HASH','active') RETURNING id;")
$PSQL -c "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) VALUES ('$TID','$U','$OWNER');" >/dev/null
T=$(login); A="Authorization: Bearer $T"
[ -n "$T" ] && ok "logged in" || { no "login"; exit 1; }

PID=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -X POST $B/patients -d "{\"mrn\":\"$MRN\",\"first_name\":\"Money\",\"last_name\":\"E2E\",\"dob\":\"1990-01-01\",\"gender\":\"male\",\"force\":true}" | jq_py "print(d['data']['id'])" 2>/dev/null)
RAW=$(q "SELECT id FROM patients WHERE tenant_id='$TID' AND mrn='$MRN';")
[ -n "$PID" ] && ok "patient created" || { no "patient"; exit 1; }

PLAN=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -X POST $B/dental/patients/$PID/plans \
  -d '{"title":"RCT E2E","total_amount":"6000","start_date":"2026-08-01","interval_unit":"month","interval_count":1,"session_count":2}')
S1=$(echo "$PLAN" | jq_py "print(d['data']['sessions'][0]['id'])" 2>/dev/null)
S2=$(echo "$PLAN" | jq_py "print(d['data']['sessions'][1]['id'])" 2>/dev/null)
PLANID=$(echo "$PLAN" | jq_py "print(d['data']['id'])" 2>/dev/null)
{ [ -n "$S1" ] && [ -n "$S2" ]; } && ok "plan with 2 sessions (3,000 each)" || { no "plan ($PLAN)"; exit 1; }

bal(){ curl -k -sS -H "$HOST" -H "$A" "$B/dental/patients/$PID/summary" | jq_py "b=d['data']['balance'];print(b['due']+'|'+b['paid']+'|'+b['at_cashier']+'|'+b['waived'])"; }
pay_state(){ curl -k -sS -H "$HOST" -H "$A" "$B/dental/patients/$PID/summary" | jq_py "print([s for p in d['data']['plans'] for s in p['sessions'] if s['id']=='$1'][0]['payment'])"; }

echo "=== 1. deliver session 1, then collect ==="
curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -X PUT $B/dental/patients/$PID/sessions/$S1 -d '{"status":"done","notes":"canals dressed"}'
[ "$(bal)" = "3000.00|0.00|0.00|0.00" ] && ok "delivered+unbilled -> due 3,000" || no "after deliver: $(bal)"
curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -X POST $B/dental/patients/$PID/sessions/$S1/collect
[ "$(bal)" = "0.00|0.00|3000.00|0.00" ] && ok "queued -> at cashier 3,000, due 0 (no double-chase)" || no "after collect: $(bal)"

echo "=== 2. cashier settles ==="
# Take the encoded id from the API rather than re-implementing the id codec in bash.
CID=$(q "SELECT charge_id FROM treatment_sessions WHERE patient_id='$RAW' AND seq=1;")
# NOTE: /billing/charges returns { rows, charged, paid, ... } — the totals cover the
# whole account while rows are a page. TypeScript caught the frontend consumers of
# this shape change; this script was not type-checked and silently 404'd instead.
ENC=$(curl -k -sS -H "$HOST" -H "$A" "$B/billing/charges?patient=$PID" | jq_py "print([c['id'] for c in d['data']['rows'] if c['status']=='pending'][0])" 2>/dev/null)
[ -n "$ENC" ] && ok "found the pending charge ($ENC)" || no "no pending charge to settle"
SC=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -w "%{http_code}" -X POST "$B/billing/charges/$ENC/settle" -d '{"method":"cash"}')
[ "$SC" = "204" ] || [ "$SC" = "200" ] && ok "settled ($SC)" || no "settle failed ($SC)"
[ "$(bal)" = "0.00|3000.00|0.00|0.00" ] && ok "settled -> paid 3,000" || no "after settle: $(bal)"
[ "$(pay_state $S1)" = "paid" ] && ok "session reads paid" || no "state: $(pay_state $S1)"

echo "=== 3. refund it — the case that used to be a permanent dead end ==="
$PSQL -c "INSERT INTO charges (tenant_id,patient_id,source,description,amount,currency,status,reverses_charge_id,settled_at)
          SELECT tenant_id,patient_id,'refund','Refund: E2E',-amount,currency,'paid','$CID',now() FROM charges WHERE id='$CID';" >/dev/null
[ "$(pay_state $S1)" = "refunded" ] && ok "session reads refunded" || no "state: $(pay_state $S1)"
[ "$(bal)" = "3000.00|0.00|0.00|0.00" ] && ok "refunded -> owed again 3,000, paid back to 0" || no "after refund: $(bal)"

echo "=== 4. RE-BILL the refunded session (this returned 409 before today) ==="
RC=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/dental/patients/$PID/sessions/$S1/collect)
{ [ "$RC" = "204" ] || [ "$RC" = "200" ]; } && ok "re-bill accepted ($RC)" || no "re-bill rejected ($RC)"
[ "$(bal)" = "0.00|0.00|3000.00|0.00" ] && ok "re-billed -> back at the cashier, not owed twice" || no "after re-bill: $(bal)"

echo "=== 5. write off session 2, then undo it ==="
curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -X PUT $B/dental/patients/$PID/sessions/$S2 -d '{"status":"done"}'
WC=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/dental/patients/$PID/sessions/$S2/write-off -d '{"reason":"goodwill — long-standing patient"}')
[ "$(pay_state $S2)" = "waived" ] && ok "written off ($WC) -> waived" || no "write-off ($WC) state=$(pay_state $S2)"
echo "  balance now: $(bal)"
[ "$(bal | cut -d'|' -f4)" = "3000.00" ] && ok "waived total reported separately" || no "waived total: $(bal)"
NOB=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/dental/patients/$PID/sessions/$S2/collect)
[ "$NOB" = "409" ] && ok "a written-off fee cannot be billed again ($NOB)" || no "waived was billable ($NOB)"
REASON=$(q "SELECT waive_reason FROM charges WHERE patient_id='$RAW' AND status='waived';")
[ -n "$REASON" ] && ok "the reason is recorded: $REASON" || no "no waive reason stored"
UC=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/dental/patients/$PID/sessions/$S2/undo-write-off)
[ "$(pay_state $S2)" = "unpaid" ] && ok "write-off undone ($UC) -> billable again" || no "undo ($UC) state=$(pay_state $S2)"

echo "=== 6. add a visit to the running course, then finish it early ==="
S3=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -X POST $B/dental/patients/$PID/plans/$PLANID/sessions \
  -d '{"scheduled_date":"2026-12-01","amount_due":"1500"}' | jq_py "print(d['data']['id'])" 2>/dev/null)
[ -n "$S3" ] && ok "third visit added" || no "add-session failed"
PC=$(curl -k -sS -H "$HOST" -H "$A" "$B/dental/patients/$PID/summary" | jq_py "p=d['data']['plans'][0];print(str(p['session_count'])+'|'+p['total_amount'])")
[ "$PC" = "3|7500.00" ] && ok "plan total and count moved with it (3 visits, 7,500)" || no "plan header stale: $PC"
FC=$(curl -k -sS -H "$HOST" -H "$A" -H "$CT" -X POST $B/dental/patients/$PID/plans/$PLANID/finish | jq_py "print(str(d['data']['sessions_cancelled']))" 2>/dev/null)
[ "$FC" = "1" ] && ok "finished early — 1 unused visit cancelled" || no "finish cancelled $FC (expected 1)"
DLV=$(curl -k -sS -H "$HOST" -H "$A" "$B/dental/patients/$PID/summary" | jq_py "
ss=[s for p in d['data']['plans'] for s in p['sessions']]
print(str(len([s for s in ss if s['status']=='cancelled']))+'|'+str(len([s for s in ss if s['status']=='done'])))")
[ "$DLV" = "1|2" ] && ok "delivered visits untouched (2 done, only the unused one cancelled)" || no "after finish: $DLV"

echo "=== 7. per-plan money comes from the ledger, not the planned fees ==="
PM=$(curl -k -sS -H "$HOST" -H "$A" "$B/dental/patients/$PID/summary" | jq_py "
m=d['data']['plans'][0]['money']
print(m['planned']+'|'+m['collected']+'|'+m['at_cashier']+'|'+m['due']+'|'+m['waived'])")
# S1 was paid then refunded then re-billed (now at the cashier); S2 is delivered+unpaid
# after the write-off was undone; the added visit was cancelled by finishing the course.
[ "$PM" = "6000.00|0.00|3000.00|3000.00|0.00" ] && ok "plan money: collected 0 after refund, 3,000 queued, 3,000 owed" || no "plan money: $PM"

echo "=== 8. the unbilled report sees what is actually owed ==="
REP=$(curl -k -sS -H "$HOST" -H "$A" "$B/dental/unbilled" | jq_py "print(d['data']['total']+'|'+str(d['data']['count']))")
[ "$REP" = "3000.00|1" ] && ok "report: 3,000 across 1 visit (session 2 only)" || no "report: $REP"

echo; echo "=== $pass passed, $fail failed ==="
[ "$fail" = "0" ]
