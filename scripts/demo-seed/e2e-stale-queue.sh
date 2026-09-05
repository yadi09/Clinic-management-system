#!/usr/bin/env bash
# The bug that swallowed patients: an abandoned queue entry from a previous day made
# every later arrival invisible. Reception collected; the chair stayed empty.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
E='stale@yclinic.test'; MRN="STALE-$RANDOM"
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
WAS=$(P "SELECT status FROM tenants WHERE slug='y-clinic';")
restore(){ X "UPDATE tenants SET status='$WAS' WHERE slug='y-clinic';"; }
drop(){
  X "DELETE FROM queue_entries q USING patients p WHERE q.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM dental_charts dc USING patients p WHERE dc.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM patients WHERE mrn='$MRN';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$E';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$E';"
  X "DELETE FROM users WHERE email='$E';"
  restore
}
trap drop EXIT
drop
X "UPDATE tenants SET status='active' WHERE slug='y-clinic';"
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$E','Stale','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$E\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")
PID=$(C "${A[@]}" -X POST $B/patients -d "{\"first_name\":\"Stale\",\"last_name\":\"Queue\",\"mrn\":\"$MRN\",\"gender\":\"female\",\"dob\":\"1980-01-01\",\"phone\":\"0911777222\"}" | py "print(d['data']['id'])")
RAW=$(P "SELECT id FROM patients WHERE mrn='$MRN';")
DEP=$(P "SELECT id FROM departments WHERE tenant_id='$TID' LIMIT 1;")
BR=$(P "SELECT id FROM branches WHERE tenant_id='$TID' LIMIT 1;")
qn(){ P "SELECT count(*) FROM queue_entries q WHERE q.patient_id='$RAW' AND q.deleted_at IS NULL AND (q.enqueued_at AT TIME ZONE 'Africa/Addis_Ababa')::date = (now() AT TIME ZONE 'Africa/Addis_Ababa')::date AND q.state NOT IN ('done','no_show');"; }

echo "=== an entry nobody closed, eleven days ago ==="
X "INSERT INTO queue_entries (tenant_id,branch_id,department_id,patient_id,state,stage,enqueued_at)
   VALUES ('$TID','$BR','$DEP','$RAW','waiting','with_doctor', now() - interval '11 days');"
t "the patient has a stale open entry" "$(P "SELECT count(*) FROM queue_entries WHERE patient_id='$RAW' AND state='waiting';")" "1"
t "but nothing today"                  "$(qn)" "0"

echo "=== reception receives them and collects the fee ==="
DEPX=$(C "${A[@]}" "$B/org/departments" | py "print(d['data'][0]['id'])")
RESP=$(C "${A[@]}" -X POST $B/queue/walk-in -d "{\"patient_id\":\"$PID\",\"department_id\":\"$DEPX\"}")
IDS=$(echo "$RESP" | py "print(','.join(d['data']['charge_ids']))")
[ -n "$IDS" ] || echo "  walk-in said: $(echo "$RESP" | head -c 200)"
t "a fee was raised, so the visit is gated" "$([ -n "$IDS" ] && echo yes || echo no)" "yes"
t "still not queued — waiting on payment"   "$(qn)" "0"
C "${A[@]}" -X POST $B/billing/checkout -d "{\"patient_id\":\"$PID\",\"method\":\"cash\"}" >/dev/null

echo "=== paying must put them at the chair, stale row or not ==="
t "the patient is queued TODAY"        "$(qn)" "1"
t "and the fees are paid"               "$(P "SELECT count(*) FROM charges WHERE patient_id='$RAW' AND status='paid';")" "$(P "SELECT count(*) FROM service_items WHERE tenant_id='$TID' AND is_default AND is_active;")"
t "the stale row is untouched"         "$(P "SELECT count(*) FROM queue_entries WHERE patient_id='$RAW' AND state='waiting' AND (enqueued_at AT TIME ZONE 'Africa/Addis_Ababa')::date < (now() AT TIME ZONE 'Africa/Addis_Ababa')::date;")" "1"

echo "=== and paying twice does not queue them twice ==="
X "UPDATE charges SET status='pending', settled_at=NULL WHERE patient_id='$RAW';"
C "${A[@]}" -X POST $B/billing/checkout -d "{\"patient_id\":\"$PID\",\"method\":\"cash\"}" >/dev/null
t "still exactly one entry today" "$(qn)" "1"

echo; echo "$pass passed, $fail failed"
