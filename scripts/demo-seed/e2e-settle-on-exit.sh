#!/usr/bin/env bash
# The whole point of pay-later: they get treated, then they settle before leaving.
set -u
TID=2345f765-62df-45de-9874-59bd55b4b6a1
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
clean(){
  X "DELETE FROM queue_entries q USING patients p WHERE q.patient_id=p.id AND p.mrn LIKE 'SET-%';"
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn LIKE 'SET-%';"
  X "DELETE FROM dental_charts c USING patients p WHERE c.patient_id=p.id AND p.mrn LIKE 'SET-%';"
  X "DELETE FROM patients WHERE mrn LIKE 'SET-%';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='set@joy.internal';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='set@joy.internal';"
  X "DELETE FROM users WHERE email='set@joy.internal';"
}
trap clean EXIT
clean
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','set@joy.internal','Desk','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d '{"workspace":"joy-speciality","email":"set@joy.internal","password":"BranchTest#2026"}' | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")
DEPT=$(C "${A[@]}" "$B/org/departments" | py "print(d['data'][0]['id'])")
X "INSERT INTO patients (tenant_id,mrn,first_name,last_name,gender,dob) VALUES ('$TID','SET-1','Emergency','Case','male','1980-01-01');"
PENC=$(C "${A[@]}" "$B/patients?q=SET-1" | py "print(d['data'][0]['id'])")

echo "=== an emergency: treat first, pay before leaving ==="
C -o /dev/null "${A[@]}" -X POST "$B/queue/walk-in" -d "{\"patient_id\":\"$PENC\",\"department_id\":\"$DEPT\"}"
OWED=$(P "SELECT sum(amount)::text FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='SET-1' AND c.status='pending';")
C -o /dev/null "${A[@]}" -X POST "$B/billing/patients/$PENC/defer" -d '{"reason":"Emergency — treat first"}'
t "they are treated without paying" "$(P "SELECT count(*) FROM queue_entries q JOIN patients p ON p.id=q.patient_id WHERE p.mrn='SET-1';")" "1"
QID=$(P "SELECT q.id FROM queue_entries q JOIN patients p ON p.id=q.patient_id WHERE p.mrn='SET-1';")
X "UPDATE queue_entries SET state='done', ended_at=now() WHERE id='$QID';"
echo "    (consultation finished; they owe $OWED and are about to walk out)"

echo "=== the desk's 'to settle' list catches them ==="
RT=$(C "${A[@]}" "$B/reception/today")
t "they appear under Seen"        "$(echo "$RT" | py "print('yes' if any(r.get('mrn')=='SET-1' for r in d['data'].get('seen') or []) else 'no')")" "yes"
t "  ...still owing"              "$(echo "$RT" | py "
m=[r for r in (d['data'].get('seen') or []) if r.get('mrn')=='SET-1']
print('yes' if m and float(m[0].get('owed') or 0) > 0 else 'no')")" "yes"
t "  ...marked as agreed credit"  "$(echo "$RT" | py "
m=[r for r in (d['data'].get('seen') or []) if r.get('mrn')=='SET-1']
print(m[0].get('owed_agreed') if m else 'missing')")" "True"
t "  ...for exactly what they owe" "$(echo "$RT" | py "
m=[r for r in (d['data'].get('seen') or []) if r.get('mrn')=='SET-1']
print(m[0]['owed'])")" "$OWED"

echo "=== and the desk takes it on the way out ==="
t "payment goes through" "$(C -o /dev/null -w '%{http_code}' "${A[@]}" -X POST "$B/billing/checkout" -d "{\"patient_id\":\"$PENC\",\"method\":\"cash\"}")" "200"
t "  ...nothing is left owing" "$(P "SELECT coalesce(sum(amount),0)::text FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='SET-1' AND c.status='pending';")" "0"
t "  ...and they drop off the settle list" "$(C "${A[@]}" "$B/reception/today" | py "
m=[r for r in (d['data'].get('seen') or []) if r.get('mrn')=='SET-1']
print('gone' if not m or float(m[0].get('owed') or 0)==0 else 'still there')")" "gone"
t "  ...the deferral is still on the record" "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='SET-1' AND c.deferred_at IS NOT NULL;")" "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='SET-1';")"

echo "=== $pass passed, $fail failed ==="
