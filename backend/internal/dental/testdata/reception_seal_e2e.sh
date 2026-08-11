#!/usr/bin/env bash
# Does the SERVER withhold the clinical record from the front desk?
# Asks as a real receptionist, on the y-clinic TEST tenant. Never cure-dental.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
PW='BranchTest#2026'; DOC='seal-doc@yclinic.test'; REC='seal-rec@yclinic.test'; OWN='seal-own@yclinic.test'; MRN='SEAL-E2E-1'
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
q(){ echo "$1" | $PSQL 2>/dev/null | head -1 | tr -d "\n" | sed -e "s/^ *//" -e "s/ *$//"; }
jq_py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
login(){ curl -k -sS -H "$HOST" -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$1\",\"password\":\"$PW\"}" | jq_py "print(d['data']['access_token'])" 2>/dev/null; }
cleanup(){
  local P; P=$(q "SELECT id FROM patients WHERE tenant_id='$TID' AND mrn='$MRN';")
  [ -n "$P" ] && $PSQL -c "DELETE FROM charges WHERE patient_id='$P';
      DELETE FROM treatment_sessions WHERE patient_id='$P';
      DELETE FROM treatment_plans WHERE patient_id='$P';
      DELETE FROM patients WHERE id='$P';" >/dev/null 2>&1
  $PSQL -c "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email IN ('$DOC','$REC','$OWN');
            DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email IN ('$DOC','$REC','$OWN');
            DELETE FROM users WHERE email IN ('$DOC','$REC','$OWN');
            DELETE FROM feature_flags WHERE tenant_id='$TID' AND flag='dental';" >/dev/null 2>&1
}
trap cleanup EXIT
echo "=== setup: one dentist, one receptionist ==="; cleanup
$PSQL -c "INSERT INTO feature_flags (tenant_id,flag,enabled,source) VALUES ('$TID','dental',true,'plan')
          ON CONFLICT (tenant_id,flag) WHERE branch_id IS NULL DO UPDATE SET enabled=true;" >/dev/null
mk(){ # email, role code
  local U R; R=$(q "SELECT id FROM roles WHERE tenant_id='$TID' AND code='$2';")
  U=$(q "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$1','$2 seal','$HASH','active') RETURNING id;")
  $PSQL -c "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) VALUES ('$TID','$U','$R');" >/dev/null
}
mk "$DOC" doctor; mk "$REC" receptionist; mk "$OWN" tenant_owner
OT=$(login "$OWN")
DT=$(login "$DOC"); RT=$(login "$REC")
[ -n "$DT" ] && ok "dentist logged in" || { no "dentist login"; exit 1; }
[ -n "$RT" ] && ok "receptionist logged in" || { no "receptionist login"; exit 1; }

echo "=== the receptionist's actual permissions ==="
PERMS=$(curl -k -sS -H "$HOST" -H "Authorization: Bearer $RT" "$B/auth/me" | jq_py "print(','.join(sorted(d['data'].get('permissions',[]))))" 2>/dev/null)
case "$PERMS" in *dental.read*) ok "has dental.read (so it CAN call the summary)";; *) no "no dental.read: $PERMS";; esac
case "$PERMS" in *dental.manage*) no "unexpectedly has dental.manage";; *) ok "does NOT have dental.manage";; esac

echo "=== the dentist creates a patient with a real clinical record ==="
# created by the owner: the doctor role deliberately cannot register patients
PID=$(curl -k -sS -H "$HOST" -H "Authorization: Bearer $OT" -H "$CT" -X POST $B/patients \
  -d "{\"mrn\":\"$MRN\",\"first_name\":\"Seal\",\"last_name\":\"Probe\",\"dob\":\"1990-01-01\",\"gender\":\"female\",\"force\":true}" \
  | jq_py "print(d['data']['id'])" 2>/dev/null)
[ -n "$PID" ] && ok "patient created" || { no "patient"; exit 1; }
PLAN=$(curl -k -sS -H "$HOST" -H "Authorization: Bearer $DT" -H "$CT" -X POST $B/dental/patients/$PID/plans \
  -d '{"title":"Root canal","total_amount":"6000","start_date":"2026-08-01","interval_unit":"month","interval_count":1,"session_count":2}')
S1=$(echo "$PLAN" | jq_py "print(d['data']['sessions'][0]['id'])" 2>/dev/null)
SECRET="PULPITIS-46-SECRET-NOTE"
curl -k -sS -H "$HOST" -H "Authorization: Bearer $DT" -H "$CT" -o /dev/null -X PUT $B/dental/patients/$PID/sessions/$S1 \
  -d "{\"status\":\"done\",\"notes\":\"$SECRET\",\"procedure\":\"Root Canal Treatment\",\"tooth\":\"UR6\"}"
DOCSEES=$(curl -k -sS -H "$HOST" -H "Authorization: Bearer $DT" "$B/dental/patients/$PID/summary" | grep -c "$SECRET")
[ "$DOCSEES" = "1" ] && ok "the dentist sees the clinical note" || no "dentist cannot see the note ($DOCSEES)"

echo "=== THE TEST: what does the receptionist receive on the wire? ==="
RAW=$(curl -k -sS -H "$HOST" -H "Authorization: Bearer $RT" "$B/dental/patients/$PID/summary")
for probe in "$SECRET" "Root Canal Treatment" "UR6"; do
  n=$(printf "%s" "$RAW" | grep -c "$probe")
  [ "$n" = "0" ] && ok "withheld: $probe" || no "LEAKED to the desk: $probe"
done
MONEY=$(printf "%s" "$RAW" | jq_py "b=d['data']['balance'];print(b['due']+'|'+b['at_cashier'])" 2>/dev/null)
[ -n "$MONEY" ] && ok "the desk still gets the money it needs ($MONEY)" || no "money missing for the desk"
SCHED=$(printf "%s" "$RAW" | jq_py "s=d['data']['plans'][0]['sessions'][0];print(s['scheduled_date']+'|'+s['payment']+'|'+s['amount_due'])" 2>/dev/null)
[ -n "$SCHED" ] && ok "and the schedule it needs ($SCHED)" || no "schedule missing for the desk"
TITLE=$(printf "%s" "$RAW" | jq_py "print(d['data']['plans'][0]['title'])" 2>/dev/null)
[ "$TITLE" = "Root canal" ] && ok "plan title still visible (needed to say what the money is for)" || no "plan title: $TITLE"

echo "=== and the clinician-only endpoints stay closed ==="
for path in "exams" "medical-history"; do
  code=$(curl -k -sS -o /dev/null -w "%{http_code}" -H "$HOST" -H "Authorization: Bearer $RT" "$B/dental/patients/$PID/$path")
  [ "$code" = "403" ] && ok "$path refused ($code)" || no "$path returned $code, expected 403"
done

echo; echo "=== $pass passed, $fail failed ==="
[ "$fail" = "0" ]
