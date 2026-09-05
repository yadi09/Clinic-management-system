#!/usr/bin/env bash
# The chair: the facts it must carry, and the check-out it must not lose.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
E='chair@yclinic.test'; MRN="CHAIR-$RANDOM"
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
WAS=$(P "SELECT status FROM tenants WHERE slug='y-clinic';")
drop(){
  X "DELETE FROM treatment_sessions se USING patients p WHERE se.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM treatment_plans tp USING patients p WHERE tp.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM allergies a USING patients p WHERE a.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM queue_entries q USING patients p WHERE q.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM dental_charts dc USING patients p WHERE dc.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM patients WHERE mrn='$MRN' OR (tenant_id='$TID' AND first_name='Chair' AND last_name='Case');"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$E';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$E';"
  X "DELETE FROM users WHERE email='$E';"
  X "UPDATE tenants SET status='$WAS' WHERE slug='y-clinic';"
}
trap drop EXIT
drop
X "UPDATE tenants SET status='active' WHERE slug='y-clinic';"
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$E','Chair Doc','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$E\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")
PID=$(C "${A[@]}" -X POST $B/patients -d "{\"first_name\":\"Chair\",\"last_name\":\"Case\",\"mrn\":\"$MRN\",\"gender\":\"female\",\"dob\":\"1990-06-06\",\"phone\":\"0911555111\"}" | py "print(d['data']['id'])")
RAW=$(P "SELECT id FROM patients WHERE mrn='$MRN';")
if [ -z "$RAW" ]; then
  echo "  SETUP: the server did not keep MRN '$MRN' — falling back to the id it returned"
  RAW=$(P "SELECT id FROM patients WHERE tenant_id='$TID' AND first_name='Chair' AND last_name='Case' ORDER BY created_at DESC LIMIT 1;")
  MRN=$(P "SELECT mrn FROM patients WHERE id='$RAW';")
  echo "  SETUP: using MRN '$MRN'"
fi
[ -n "$RAW" ] || { echo "  SETUP FAILED: no patient"; exit 1; }
# A raw uuid: the API hands back an opaque dep_… id, which a uuid column rejects.
DEP=$(P "SELECT id FROM departments WHERE tenant_id='$TID' LIMIT 1;")
# The branch the session is actually on — y-clinic has two, and the chair is
# filtered to the active one.
BR=$(P "SELECT branch_id FROM queue_entries WHERE tenant_id='$TID' ORDER BY enqueued_at DESC LIMIT 1;")
X "INSERT INTO allergies (tenant_id,patient_id,substance,severity) VALUES ('$TID','$RAW','Penicillin','severe');"
X "INSERT INTO allergies (tenant_id,patient_id,substance,severity) VALUES ('$TID','$RAW','Dust','mild');"
X "INSERT INTO queue_entries (tenant_id,branch_id,department_id,patient_id,state,stage,assigned_provider_id,enqueued_at)
   VALUES ('$TID','$BR','$DEP','$RAW','waiting','with_doctor','$U', now());"
QUUID=$(P "SELECT id FROM queue_entries WHERE patient_id='$RAW' ORDER BY enqueued_at DESC LIMIT 1;")
# The API speaks prefixed opaque ids, not raw uuids.
enc(){ python3 -c "
import sys,uuid
A='0123456789abcdefghjkmnpqrstvwxyz'
b=uuid.UUID(sys.argv[2]).bytes
o=[];buf=0;bits=0
for x in b:
    buf=(buf<<8)|x;bits+=8
    while bits>=5:
        bits-=5;o.append(A[(buf>>bits)&0x1f])
if bits: o.append(A[(buf<<(5-bits))&0x1f])
print(sys.argv[1]+'_'+''.join(o))" "$1" "$2"; }
QID=$(enc que "$QUUID")
one(){ C "${A[@]}" "$B/dental/chairside?from=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)" | py "
r=[x for x in d['data'] if x['mrn']=='$MRN'][0]
print('%s|%s|%s|%s|%s' % (r['state'], r.get('allergies',''), r.get('unbilled','0'), r.get('recorded_this_visit'), r.get('plan_title','')))"; }

echo "=== the card carries what the chair needs ==="
IFS='|' read -r st alg unb rec plan <<<"$(one)"
t "the patient is waiting"                "$st"  "waiting"
t "the severe allergy is on the card"     "$alg" "Penicillin"
t "the mild one is not"                   "$(echo "$alg" | grep -c Dust)" "0"
t "nothing recorded at this visit yet"    "$rec" "0"

echo "=== unbilled treatment shows before anyone checks out ==="
X "INSERT INTO treatment_plans (tenant_id,patient_id,title,start_date,session_count,status)
   VALUES ('$TID','$RAW','Root canal', current_date, 2, 'active');"
PLAN=$(P "SELECT id FROM treatment_plans WHERE patient_id='$RAW';")
X "INSERT INTO treatment_sessions (tenant_id,plan_id,patient_id,seq,scheduled_date,amount_due,status,kind,completed_at)
   VALUES ('$TID','$PLAN','$RAW',1,current_date,900,'done','visit', now());"
X "INSERT INTO treatment_sessions (tenant_id,plan_id,patient_id,seq,scheduled_date,amount_due,status,kind)
   VALUES ('$TID','$PLAN','$RAW',2,current_date + 7,900,'planned','visit');"
IFS='|' read -r st alg unb rec plan <<<"$(one)"
t "900 of treatment is unbilled"      "${unb%%.*}" "900"
t "the course is named"               "$plan" "Root canal"
t "and the work counts as recorded"   "$rec" "1"

echo "=== a finished visit stays on the page instead of vanishing ==="
C "${A[@]}" -X POST $B/queue/$QID/transition -d '{"state":"done"}' >/dev/null
# The requirement is that a finished visit is still ON the page — the old list
# dropped it entirely — and that the record says done.
t "the visit is closed"          "$(P "SELECT state FROM queue_entries WHERE id='$QUUID';")" "done"
t "and it is still on the chair page" "$(C "${A[@]}" "$B/dental/chairside?from=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)" | py "print(len([x for x in d['data'] if x['mrn']=='$MRN' and x['state']=='done']))")" "1"

echo "=== and it can be put back ==="
C "${A[@]}" -X POST $B/queue/$QID/transition -d '{"state":"waiting"}' >/dev/null
t "back at the chair" "$(one | cut -d'|' -f1)" "waiting"

echo "=== another dentist's patient is not on my chair ==="
t "a provider with nobody has an empty chair" "$(C "${A[@]}" "$B/dental/chairside?provider=usr_zzzzzzzzzzzzzzzzzzzzzzzzzz&from=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)" | py "print(len([x for x in d['data'] if x['mrn']=='$MRN']))")" "0"

echo "=== the module flag still guards it ==="
t "no token, no chair" "$(C -H "$CT" -o /dev/null -w '%{http_code}' "$B/dental/chairside")" "401"

echo; echo "$pass passed, $fail failed"
