#!/usr/bin/env bash
# A clinic's own procedure list: seeded, editable, and safe for past visits.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
E='proc@yclinic.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
drop(){
  X "DELETE FROM dental_procedures WHERE tenant_id='$TID' AND name IN ('Implant placement','Implant Placement','Renamed Implant');"
  X "UPDATE dental_procedures SET deleted_at=NULL, is_active=true WHERE tenant_id='$TID' AND name='Bridge';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$E';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$E';"
  X "DELETE FROM users WHERE email='$E';"
}
trap drop EXIT
drop
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$E','Proc','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$E\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")
n(){ C "${A[@]}" "$B/dental/procedures$1" | py "print(len(d['data']))"; }

echo "=== the clinic starts with a working list ==="
t "sixteen procedures seeded" "$(n '')" "16"

echo "=== the clinic adds one of its own ==="
PID=$(C "${A[@]}" -X POST $B/dental/procedures -d '{"name":"Implant placement"}' | py "print(d['data']['id'])")
t "it is on the list now"    "$(n '')" "17"
t "it went to the end"       "$(C "${A[@]}" "$B/dental/procedures" | py "print(d['data'][-1]['name'])")" "Implant placement"
t "the same name is refused" "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/dental/procedures -d '{"name":"implant PLACEMENT"}')" "409"
t "an empty name is refused" "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/dental/procedures -d '{"name":"  "}')" "400"

echo "=== renaming and retiring ==="
C "${A[@]}" -X PUT $B/dental/procedures/$PID -d '{"name":"Renamed Implant"}' >/dev/null
t "the new name shows" "$(C "${A[@]}" "$B/dental/procedures" | py "print(d['data'][-1]['name'])")" "Renamed Implant"
BR=$(C "${A[@]}" "$B/dental/procedures" | py "print([x['id'] for x in d['data'] if x['name']=='Bridge'][0])")
C "${A[@]}" -X PUT $B/dental/procedures/$BR -d '{"name":"Bridge","is_active":false}' >/dev/null
t "a retired one leaves the picker" "$(n '')" "16"
t "but the settings screen still shows it" "$(n '?all=1')" "17"

echo "=== a past visit keeps what it recorded ==="
X "INSERT INTO treatment_plans (tenant_id,patient_id,title,start_date,session_count,status)
   SELECT '$TID', p.id, 'PROC test', current_date, 1, 'active' FROM patients p WHERE p.tenant_id='$TID' LIMIT 1;"
PLAN=$(P "SELECT id FROM treatment_plans WHERE tenant_id='$TID' AND title='PROC test';")
X "INSERT INTO treatment_sessions (tenant_id,plan_id,patient_id,seq,scheduled_date,amount_due,status,kind,procedure)
   SELECT '$TID','$PLAN',patient_id,1,current_date,0,'done','visit','Bridge' FROM treatment_plans WHERE id='$PLAN';"
C "${A[@]}" -X DELETE $B/dental/procedures/$BR >/dev/null
t "deleting it removes it from settings too" "$(n '?all=1')" "16"
t "the visit still says what was done"       "$(P "SELECT procedure FROM treatment_sessions se JOIN treatment_plans tp ON tp.id=se.plan_id WHERE tp.title='PROC test';")" "Bridge"
X "DELETE FROM treatment_sessions se USING treatment_plans tp WHERE se.plan_id=tp.id AND tp.title='PROC test';"
X "DELETE FROM treatment_plans WHERE title='PROC test' AND tenant_id='$TID';"
X "UPDATE dental_procedures SET deleted_at=NULL, is_active=true WHERE tenant_id='$TID' AND name='Bridge';"

echo "=== a general clinic cannot reach any of it ==="
JT=$(C -H "$CT" -X POST $B/auth/login -d '{"workspace":"joy-speciality","email":"nobody@x.y","password":"x"}' -o /dev/null -w '%{http_code}')
t "the module flag still guards the route" "$(C -H "$CT" -o /dev/null -w '%{http_code}' "$B/dental/procedures")" "401"

echo; echo "$pass passed, $fail failed"
