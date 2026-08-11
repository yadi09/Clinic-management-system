#!/usr/bin/env bash
# Every capability ReceptionDentalView had, exercised as a real receptionist against
# the SHARED page's API. Checked BEFORE the old file is deleted.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
PW='BranchTest#2026'; REC='par-rec@yclinic.test'; OWN='par-own@yclinic.test'; MRN='PARITY-1'
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
q(){ echo "$1" | $PSQL 2>/dev/null | head -1 | tr -d "\n" | sed -e "s/^ *//" -e "s/ *$//"; }
J(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
login(){ curl -k -sS -H "$HOST" -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$1\",\"password\":\"$PW\"}" | J "print(d['data']['access_token'])" 2>/dev/null; }
cleanup(){ local P; P=$(q "SELECT id FROM patients WHERE tenant_id='$TID' AND mrn='$MRN';")
 [ -n "$P" ] && $PSQL -c "DELETE FROM charges WHERE patient_id='$P'; DELETE FROM treatment_sessions WHERE patient_id='$P';
   DELETE FROM treatment_plans WHERE patient_id='$P'; DELETE FROM patients WHERE id='$P';" >/dev/null 2>&1
 $PSQL -c "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email IN ('$REC','$OWN');
   DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email IN ('$REC','$OWN');
   DELETE FROM users WHERE email IN ('$REC','$OWN');
   DELETE FROM feature_flags WHERE tenant_id='$TID' AND flag='dental';" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
$PSQL -c "INSERT INTO feature_flags (tenant_id,flag,enabled,source) VALUES ('$TID','dental',true,'plan')
  ON CONFLICT (tenant_id,flag) WHERE branch_id IS NULL DO UPDATE SET enabled=true;" >/dev/null
mk(){ local U R; R=$(q "SELECT id FROM roles WHERE tenant_id='$TID' AND code='$2';")
  U=$(q "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$1','$2 parity','$HASH','active') RETURNING id;")
  $PSQL -c "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) VALUES ('$TID','$U','$R');" >/dev/null; }
mk "$REC" receptionist; mk "$OWN" tenant_owner
RT=$(login "$REC"); OT=$(login "$OWN"); R="Authorization: Bearer $RT"; O="Authorization: Bearer $OT"
PID=$(curl -k -sS -H "$HOST" -H "$O" -H "$CT" -X POST $B/patients -d "{\"mrn\":\"$MRN\",\"first_name\":\"Parity\",\"last_name\":\"Desk\",\"dob\":\"1990-01-01\",\"gender\":\"male\",\"force\":true}" | J "print(d['data']['id'])" 2>/dev/null)
PLAN=$(curl -k -sS -H "$HOST" -H "$O" -H "$CT" -X POST $B/dental/patients/$PID/plans -d '{"title":"Parity course","total_amount":"6000","start_date":"2026-06-01","interval_unit":"month","interval_count":1,"session_count":2}')
S1=$(echo "$PLAN" | J "print(d['data']['sessions'][0]['id'])"); S2=$(echo "$PLAN" | J "print(d['data']['sessions'][1]['id'])")
curl -k -sS -H "$HOST" -H "$O" -H "$CT" -o /dev/null -X PUT $B/dental/patients/$PID/sessions/$S1 -d '{"status":"done"}'

echo "=== capability parity, as the receptionist ==="
# 1 read the patient + balance
BAL=$(curl -k -sS -H "$HOST" -H "$R" "$B/dental/patients/$PID/summary" | J "b=d['data']['balance'];print(b['due']+'|'+b['at_cashier'])")
[ "$BAL" = "3000.00|0.00" ] && ok "sees the balance (3,000 owed)" || no "balance: $BAL"
# 2 bulk collect (Take payment)
CO=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -X POST $B/dental/patients/$PID/collect-sessions -d "{\"session_ids\":[\"$S1\"]}" | J "print(str(d['data']['billed'])+'|'+d['data']['total'])" 2>/dev/null)
[ "$CO" = "1|3000.00" ] && ok "bulk Take payment works ($CO)" || no "collect-sessions: $CO"
# 3 undo / pull back from the cashier
UN=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/dental/patients/$PID/sessions/$S1/uncollect)
[ "$UN" = "204" ] && ok "can pull a charge back from the cashier ($UN)" || no "uncollect: $UN"
# 4 reschedule / rebook a missed visit
RS=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/dental/patients/$PID/sessions/$S2/reschedule -d '{"scheduled_date":"2026-12-01"}')
[ "$RS" = "204" ] && ok "can rebook a visit ($RS)" || no "reschedule: $RS"
# 5 statement / payment history
CH=$(curl -k -sS -H "$HOST" -H "$R" "$B/billing/charges?patient=$PID" | J "print(str(d['data']['total_count'])+'|'+d['data']['charged'])" 2>/dev/null)
[ -n "$CH" ] && ok "sees the payment history for a statement ($CH)" || no "charges: $CH"
# 6 edit patient details
ED=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -o /dev/null -w "%{http_code}" -X PUT $B/patients/$PID -d '{"first_name":"Parity","last_name":"Desk","dob":"1990-01-01","gender":"male","phone":"0911000000"}')
{ [ "$ED" = "200" ] || [ "$ED" = "204" ]; } && ok "can update patient details ($ED)" || no "patient update: $ED"
echo "=== and still cannot reach the clinical record ==="
for path in exams medical-history; do
  c=$(curl -k -sS -o /dev/null -w "%{http_code}" -H "$HOST" -H "$R" "$B/dental/patients/$PID/$path")
  [ "$c" = "403" ] && ok "$path refused" || no "$path -> $c"; done
W=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/dental/patients/$PID/sessions/$S1/write-off -d '{"reason":"x"}')
[ "$W" = "403" ] && ok "cannot write off a fee (403)" || no "write-off -> $W"
CH2=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -o /dev/null -w "%{http_code}" -X PUT $B/dental/patients/$PID/chart -d '{"teeth":{"UR6":"decayed"}}')
[ "$CH2" = "403" ] && ok "cannot edit the tooth chart (403)" || no "chart -> $CH2"
echo; echo "=== $pass passed, $fail failed ==="
[ "$fail" = "0" ]
