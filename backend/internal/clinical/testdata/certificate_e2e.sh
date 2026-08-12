#!/usr/bin/env bash
# Medical certificates end to end, on the y-clinic TEST tenant. Never cure-dental.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
PW='BranchTest#2026'; DOC='cert-doc@yclinic.test'; REC='cert-rec@yclinic.test'; OWN='cert-own@yclinic.test'; MRN='CERT-1'
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
q(){ echo "$1" | $PSQL 2>/dev/null | head -1 | tr -d "\n" | sed -e "s/^ *//" -e "s/ *$//"; }
J(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
login(){ curl -k -sS -H "$HOST" -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$1\",\"password\":\"$PW\"}" | J "print(d['data']['access_token'])" 2>/dev/null; }
cleanup(){ local P; P=$(q "SELECT id FROM patients WHERE tenant_id='$TID' AND mrn='$MRN';")
 [ -n "$P" ] && $PSQL -c "DELETE FROM medical_certificates WHERE patient_id='$P'; DELETE FROM patients WHERE id='$P';" >/dev/null 2>&1
 $PSQL -c "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email IN ('$DOC','$REC','$OWN');
   DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email IN ('$DOC','$REC','$OWN');
   DELETE FROM users WHERE email IN ('$DOC','$REC','$OWN');" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
mk(){ local U R; R=$(q "SELECT id FROM roles WHERE tenant_id='$TID' AND code='$2';")
  U=$(q "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$1','$3','$HASH','active') RETURNING id;")
  $PSQL -c "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) VALUES ('$TID','$U','$R');" >/dev/null; }
mk "$DOC" doctor "Dr Almaz Bekele"; mk "$REC" receptionist "Front Desk"; mk "$OWN" tenant_owner "Owner"
DT=$(login "$DOC"); RT=$(login "$REC"); OT=$(login "$OWN")
D="Authorization: Bearer $DT"; R="Authorization: Bearer $RT"; O="Authorization: Bearer $OT"
PID=$(curl -k -sS -H "$HOST" -H "$O" -H "$CT" -X POST $B/patients -d "{\"mrn\":\"$MRN\",\"first_name\":\"Cert\",\"last_name\":\"Probe\",\"dob\":\"1995-03-04\",\"gender\":\"female\",\"force\":true}" | J "print(d['data']['id'])" 2>/dev/null)
[ -n "$PID" ] && ok "patient created" || { no "patient"; exit 1; }

echo "=== a doctor issues a sick-leave certificate ==="
C1=$(curl -k -sS -H "$HOST" -H "$D" -H "$CT" -X POST $B/patients/$PID/certificates \
  -d '{"kind":"sick_leave","diagnosis":"Acute pulpitis","show_diagnosis":false,"rest_days":3,"rest_from":"2026-08-12","notes":"Review if pain persists"}')
REF=$(echo "$C1" | J "print(d['data']['ref'])" 2>/dev/null)
case "$REF" in MC-*) ok "issued with a reference ($REF)";; *) no "no reference: $C1"; exit 1;; esac
FROM=$(echo "$C1" | J "print(d['data']['rest_from'])"); TO=$(echo "$C1" | J "print(d['data']['rest_to'])")
[ "$FROM|$TO" = "2026-08-12|2026-08-14" ] && ok "3 days from 12 Aug ends 14 Aug (inclusive)" || no "period: $FROM..$TO"
BY=$(echo "$C1" | J "print(d['data']['issued_by'])")
[ "$BY" = "Dr Almaz Bekele" ] && ok "signed by the logged-in clinician, not a typed name" || no "issued_by: $BY"
SD=$(echo "$C1" | J "print(str(d['data']['show_diagnosis']))")
[ "$SD" = "False" ] && ok "diagnosis withheld from the paper by default" || no "show_diagnosis: $SD"

echo "=== the number is sequential and unique ==="
C2=$(curl -k -sS -H "$HOST" -H "$D" -H "$CT" -X POST $B/patients/$PID/certificates -d '{"kind":"attendance","show_diagnosis":false}')
REF2=$(echo "$C2" | J "print(d['data']['ref'])" 2>/dev/null)
[ "$REF" != "$REF2" ] && ok "second certificate got a different number ($REF2)" || no "duplicate reference"
N1=${REF##*-}; N2=${REF2##*-}
[ "$((10#$N2))" = "$((10#$N1 + 1))" ] && ok "numbers run in sequence" || no "$N1 then $N2"

echo "=== validation the sample form had none of ==="
BAD=$(curl -k -sS -H "$HOST" -H "$D" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/patients/$PID/certificates -d '{"kind":"sick_leave","rest_days":0,"rest_from":"2026-08-12","show_diagnosis":false}')
[ "$BAD" = "400" ] && ok "zero rest days refused ($BAD)" || no "zero days accepted ($BAD)"
BAD2=$(curl -k -sS -H "$HOST" -H "$D" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/patients/$PID/certificates -d '{"kind":"holiday","show_diagnosis":false}')
[ "$BAD2" = "400" ] && ok "an invented kind refused ($BAD2)" || no "bad kind accepted ($BAD2)"

echo "=== reception may reprint, but may not issue or void ==="
RL=$(curl -k -sS -H "$HOST" -H "$R" "$B/patients/$PID/certificates" | J "print(len(d['data']['items']))" 2>/dev/null)
[ "$RL" = "2" ] && ok "the desk can list them for a reprint ($RL)" || no "desk list: $RL"
RI=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/patients/$PID/certificates -d '{"kind":"attendance","show_diagnosis":false}')
[ "$RI" = "403" ] && ok "the desk cannot issue one ($RI)" || no "desk issued a certificate ($RI)"
CID=$(echo "$C1" | J "print(d['data']['id'])")
RV=$(curl -k -sS -H "$HOST" -H "$R" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/certificates/$CID/void -d '{"reason":"x"}')
[ "$RV" = "403" ] && ok "the desk cannot void one ($RV)" || no "desk voided a certificate ($RV)"

echo "=== voiding keeps the number and the record ==="
NR=$(curl -k -sS -H "$HOST" -H "$D" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/certificates/$CID/void -d '{"reason":""}')
[ "$NR" = "400" ] && ok "a void needs a reason ($NR)" || no "void without reason ($NR)"
V=$(curl -k -sS -H "$HOST" -H "$D" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/certificates/$CID/void -d '{"reason":"issued to the wrong patient"}')
[ "$V" = "204" ] && ok "voided ($V)" || no "void failed ($V)"
ST=$(curl -k -sS -H "$HOST" -H "$D" "$B/patients/$PID/certificates" | J "
c=[x for x in d['data']['items'] if x['ref']=='$REF'][0];print(c['status']+'|'+c['void_reason']+'|'+c['ref'])")
[ "$ST" = "void|issued to the wrong patient|$REF" ] && ok "kept, marked void, reason recorded" || no "after void: $ST"
AGAIN=$(curl -k -sS -H "$HOST" -H "$D" -H "$CT" -o /dev/null -w "%{http_code}" -X POST $B/certificates/$CID/void -d '{"reason":"again"}')
[ "$AGAIN" = "409" ] && ok "cannot void twice ($AGAIN)" || no "double void ($AGAIN)"

echo; echo "=== $pass passed, $fail failed ==="
[ "$fail" = "0" ]
