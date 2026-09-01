#!/usr/bin/env bash
# Conditions a clinic defines, and the chart that keeps its marks regardless.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
E='tst@yclinic.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
drop(){
  X "DELETE FROM dental_tooth_statuses WHERE tenant_id='$TID' AND code IN ('root_treated','implant');"
  X "UPDATE dental_tooth_statuses SET deleted_at=NULL, is_active=true, label='Crown', color='#f0c040' WHERE tenant_id='$TID' AND code='crown';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$E';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$E';"
  X "DELETE FROM users WHERE email='$E';"
}
trap drop EXIT
drop
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$E','TSt','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$E\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")
n(){ C "${A[@]}" "$B/dental/tooth-statuses$1" | py "print(len(d['data']))"; }
get(){ C "${A[@]}" "$B/dental/tooth-statuses?all=1" | py "print([x['$2'] for x in d['data'] if x['code']=='$1'][0])"; }

echo "=== the clinic starts with the five it was already using ==="
t "five conditions"    "$(n '')" "5"
t "decayed is still red" "$(get decayed color)" "#c0392b"

echo "=== the clinic adds one of its own ==="
NID=$(C "${A[@]}" -X POST $B/dental/tooth-statuses -d '{"label":"Root treated","color":"#7c3aed"}' | py "print(d['data']['id'])")
t "six now"                     "$(n '')" "6"
t "the code is derived and stable" "$(C "${A[@]}" "$B/dental/tooth-statuses" | py "print([x['code'] for x in d['data'] if x['label']=='Root treated'][0])")" "root_treated"
t "a duplicate name is refused"    "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/dental/tooth-statuses -d '{"label":"root TREATED","color":"#111111"}')" "409"
t "a bad colour is refused"        "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/dental/tooth-statuses -d '{"label":"Implant","color":"red"}')" "400"

echo "=== renaming leaves the code, and therefore every chart, alone ==="
C "${A[@]}" -X PUT $B/dental/tooth-statuses/$NID -d '{"label":"Endodontically treated","color":"#7c3aed"}' >/dev/null
t "the label changed" "$(get root_treated label)" "Endodontically treated"
t "the code did not"  "$(C "${A[@]}" "$B/dental/tooth-statuses" | py "print(len([x for x in d['data'] if x['code']=='root_treated']))")" "1"

echo "=== a charted tooth survives its condition being retired and removed ==="
PID=$(P "SELECT id FROM patients WHERE tenant_id='$TID' LIMIT 1;")
X "INSERT INTO dental_charts (tenant_id, patient_id, teeth) VALUES ('$TID','$PID','{\"UR6\":\"crown\"}'::jsonb)
   ON CONFLICT (tenant_id, patient_id) DO UPDATE SET teeth = '{\"UR6\":\"crown\"}'::jsonb;"
CR=$(C "${A[@]}" "$B/dental/tooth-statuses" | py "print([x['id'] for x in d['data'] if x['code']=='crown'][0])")
C "${A[@]}" -X PUT $B/dental/tooth-statuses/$CR -d '{"label":"Crown","color":"#f0c040","is_active":false}' >/dev/null
t "retired leaves the palette"          "$(n '')" "5"
t "but stays in settings"               "$(n '?all=1')" "6"
C "${A[@]}" -X DELETE $B/dental/tooth-statuses/$CR >/dev/null
t "removed leaves settings too"         "$(n '?all=1')" "5"
t "the tooth is still marked crown"     "$(P "SELECT teeth->>'UR6' FROM dental_charts WHERE tenant_id='$TID' AND patient_id='$PID';")" "crown"

echo "=== the module flag still guards it ==="
t "no token, no list" "$(C -H "$CT" -o /dev/null -w '%{http_code}' "$B/dental/tooth-statuses")" "401"

echo; echo "$pass passed, $fail failed"
