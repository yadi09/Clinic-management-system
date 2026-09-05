#!/usr/bin/env bash
# A finished visit is not an arrival. Reception must be able to send a seen patient
# back through — without charging them twice, and without lying about the state.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
E='seen@yclinic.test'; MRN="SEEN-$RANDOM"
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
WAS=$(P "SELECT status FROM tenants WHERE slug='y-clinic';")
drop(){
  X "DELETE FROM queue_entries q USING patients p WHERE q.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM dental_charts dc USING patients p WHERE dc.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM patients WHERE mrn='$MRN';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$E';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$E';"
  X "DELETE FROM users WHERE email='$E';"
  X "UPDATE tenants SET status='$WAS' WHERE slug='y-clinic';"
}
trap drop EXIT
drop
X "UPDATE tenants SET status='active' WHERE slug='y-clinic';"
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$E','Seen','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$E\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")
PID=$(C "${A[@]}" -X POST $B/patients -d "{\"first_name\":\"Seen\",\"last_name\":\"Again\",\"mrn\":\"$MRN\",\"gender\":\"male\",\"dob\":\"1979-03-03\",\"phone\":\"0911666555\"}" | py "print(d['data']['id'])")
RAW=$(P "SELECT id FROM patients WHERE mrn='$MRN';")
DEP=$(C "${A[@]}" "$B/org/departments" | py "print(d['data'][0]['id'])")
NDEF=$(P "SELECT count(*) FROM service_items WHERE tenant_id='$TID' AND is_default AND is_active;")
charges(){ P "SELECT count(*) FROM charges WHERE patient_id='$RAW' AND deleted_at IS NULL;"; }
live(){ P "SELECT count(*) FROM queue_entries WHERE patient_id='$RAW' AND deleted_at IS NULL AND state NOT IN ('done','no_show');"; }
recep(){ C "${A[@]}" "$B/reception/today" | py "
for k in ('expected','waiting','seen'):
  for r in d['data'][k]:
    if r['mrn']=='$MRN': print('%s|%s' % (k, r.get('finished', False)))"; }
receive(){ C "${A[@]}" -X POST $B/queue/walk-in -d "{\"patient_id\":\"$PID\",\"department_id\":\"$DEP\"}" >/dev/null; C "${A[@]}" -X POST $B/billing/checkout -d "{\"patient_id\":\"$PID\",\"method\":\"cash\"}" >/dev/null; }

echo "=== received, paid, at the chair ==="
receive
t "reception shows them waiting, not finished" "$(recep)" "waiting|False"
t "one live queue entry"                        "$(live)" "1"

echo "=== the doctor finishes the visit ==="
X "UPDATE queue_entries SET state='done', ended_at=now() WHERE patient_id='$RAW' AND state<>'done';"
t "reception now shows them as seen and finished" "$(recep)" "seen|True"
t "nothing live at the chair"                     "$(live)" "0"

echo "=== reception can send them back through ==="
BEFORE=$(charges)
receive
t "they are at the chair again"        "$(live)" "1"
t "and were not charged a second time" "$(charges)" "$BEFORE"
t "the fee raised once for the day"    "$BEFORE" "$NDEF"

echo; echo "$pass passed, $fail failed"
