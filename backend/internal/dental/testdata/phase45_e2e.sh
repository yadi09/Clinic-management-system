#!/usr/bin/env bash
# Phases 4–5 (audit D10–D12), end to end on the y-clinic TEST tenant. Never cure-dental.
#
#   phase45_e2e.sh setup     create a dentist, a receptionist and a patient with a
#                            course (500 down payment + 2 × 1,000), record visit 1,
#                            check the API rules, print the ids for the browser check
#   phase45_e2e.sh cleanup   remove all of it, switch dental off, re-suspend y-clinic
#
# y-clinic is normally suspended; setup activates it and cleanup always restores it.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
PW='BranchTest#2026'; DOC='p45-doc@yclinic.test'; DESK='p45-desk@yclinic.test'; MRN='P45-E2E-1'
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
q(){ echo "$1" | $PSQL 2>/dev/null | head -1 | tr -d "\n"; }
J(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
login(){ curl -k -sS -H "$HOST" -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$1\",\"password\":\"$PW\"}" | J "print(d['data']['access_token'])" 2>/dev/null; }

cleanup(){
  local PID; PID=$(q "SELECT id FROM patients WHERE tenant_id='$TID' AND mrn='$MRN';")
  if [ -n "$PID" ]; then
    $PSQL -c "DELETE FROM charges WHERE patient_id='$PID';
              DELETE FROM treatment_sessions WHERE patient_id='$PID';
              DELETE FROM treatment_plans WHERE patient_id='$PID';
              DELETE FROM dental_charts WHERE patient_id='$PID';
              DELETE FROM patients WHERE id='$PID';" >/dev/null 2>&1
  fi
  $PSQL -c "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email IN ('$DOC','$DESK');
            DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email IN ('$DOC','$DESK');
            DELETE FROM users WHERE email IN ('$DOC','$DESK');
            DELETE FROM feature_flags WHERE tenant_id='$TID' AND flag='dental';
            UPDATE tenants SET status='suspended' WHERE id='$TID';" >/dev/null 2>&1
  echo "cleanup: y-clinic is $(q "SELECT status FROM tenants WHERE id='$TID';"), test patient $( [ -z "$(q "SELECT 1 FROM patients WHERE tenant_id='$TID' AND mrn='$MRN';")" ] && echo removed || echo STILL PRESENT)"
}

if [ "${1:-}" = "cleanup" ]; then cleanup; exit 0; fi

echo "=== setup ==="
cleanup >/dev/null
$PSQL -c "UPDATE tenants SET status='active' WHERE id='$TID';
          INSERT INTO feature_flags (tenant_id,flag,enabled,source) VALUES ('$TID','dental',true,'plan')
          ON CONFLICT (tenant_id,flag) WHERE branch_id IS NULL DO UPDATE SET enabled=true;" >/dev/null
for pair in "$DOC:doctor" "$DESK:receptionist"; do
  E=${pair%%:*}; R=${pair##*:}
  RID=$(q "SELECT id FROM roles WHERE tenant_id='$TID' AND code='$R';")
  U=$(q "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$E','P45 $R','$HASH','active') RETURNING id;")
  $PSQL -c "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) VALUES ('$TID','$U','$RID');" >/dev/null
done
TD=$(login "$DOC"); TR=$(login "$DESK")
{ [ -n "$TD" ] && [ -n "$TR" ]; } && ok "dentist and receptionist logged in" || { no "login"; cleanup; exit 1; }
AD="Authorization: Bearer $TD"; AR="Authorization: Bearer $TR"

PID=$(curl -k -sS -H "$HOST" -H "$AR" -H "$CT" -X POST $B/patients -d "{\"mrn\":\"$MRN\",\"first_name\":\"Phase\",\"last_name\":\"FortyFive\",\"dob\":\"1990-01-01\",\"gender\":\"female\",\"force\":true}" | J "print(d['data']['id'])" 2>/dev/null)
[ -n "$PID" ] && ok "patient created" || { no "patient"; cleanup; exit 1; }
TODAY=$(date -u +%F)
PLAN=$(curl -k -sS -H "$HOST" -H "$AD" -H "$CT" -X POST $B/dental/patients/$PID/plans \
  -d "{\"title\":\"P45 Root canal\",\"total_amount\":\"2500\",\"deposit\":\"500\",\"start_date\":\"$TODAY\",\"interval_unit\":\"week\",\"interval_count\":1,\"session_count\":2}")
PLANID=$(echo "$PLAN" | J "print(d['data']['id'])" 2>/dev/null)
S1=$(echo "$PLAN" | J "print(d['data']['sessions'][0]['id'])" 2>/dev/null)
DEP=$(echo "$PLAN" | J "print(d['data']['deposit']['amount_due'])" 2>/dev/null)
{ [ -n "$S1" ] && [ "$DEP" = "500.00" ]; } && ok "course with a 500 down payment" || { no "plan ($PLAN)"; cleanup; exit 1; }
curl -k -sS -H "$HOST" -H "$AD" -H "$CT" -o /dev/null -X PUT $B/dental/patients/$PID/sessions/$S1 -d '{"status":"done","notes":"p45"}'

echo "=== D11: cancel course is guarded; the edit back door is closed ==="
C=$(curl -k -sS -H "$HOST" -H "$AD" -H "$CT" -X POST $B/dental/patients/$PID/plans/$PLANID/cancel -d '{"reason":"e2e"}' | J "print(d['error']['code'])" 2>/dev/null)
[ "$C" = "PLAN_HAS_DEBT" ] && ok "cancel refused while visit 1 is owed ($C)" || no "cancel with debt: $C"
U=$(curl -k -sS -H "$HOST" -H "$AD" -H "$CT" -o /dev/null -w "%{http_code}" -X PUT $B/dental/patients/$PID/plans/$PLANID -d '{"status":"cancelled"}')
[ "$U" = "400" ] && ok "PUT /plans cannot change status ($U)" || no "PUT status: $U"
N=$(curl -k -sS -H "$HOST" -H "$AD" -H "$CT" -X POST $B/dental/patients/$PID/plans/$PLANID/cancel -d '{}' -o /dev/null -w "%{http_code}")
[ "$N" = "400" ] && ok "cancel without a reason refused ($N)" || no "cancel no reason: $N"

echo "=== D1: the front desk cannot correct a given visit ==="
F=$(curl -k -sS -H "$HOST" -H "$AR" -H "$CT" -o /dev/null -w "%{http_code}" -X PUT $B/dental/patients/$PID/sessions/$S1 -d '{"status":"planned","reason":"x"}')
[ "$F" = "403" ] && ok "receptionist cannot undo a visit ($F)" || no "desk undo: $F"

echo "=== D10: owed now = visit 1 + the down payment ==="
DUE=$(curl -k -sS -H "$HOST" -H "$AR" "$B/dental/patients/$PID/summary" | J "print(d['data']['balance']['due'])")
# 2,500 course − 500 deposit = 2,000 over 2 visits; visit 1 is given.
[ "$DUE" = "1500.00" ] && ok "due 1,500 = visit 1 (1,000) + down payment (500)" || no "due: $DUE"

echo "=== ${pass} passed, ${fail} failed ==="
echo "BROWSER_PATIENT=$PID"
