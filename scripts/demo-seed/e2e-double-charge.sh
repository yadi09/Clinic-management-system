#!/usr/bin/env bash
# Pressing Collect again must not charge again. One visit, one registration fee,
# one place in the queue — however many times the desk presses.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
E='dbl@yclinic.test'; MRN="DBL-$RANDOM"
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
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$E','Dbl','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$E\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")
PID=$(C "${A[@]}" -X POST $B/patients -d "{\"first_name\":\"Double\",\"last_name\":\"Charge\",\"mrn\":\"$MRN\",\"gender\":\"female\",\"dob\":\"1985-02-02\",\"phone\":\"0911888444\"}" | py "print(d['data']['id'])")
RAW=$(P "SELECT id FROM patients WHERE mrn='$MRN';")
DEP=$(C "${A[@]}" "$B/org/departments" | py "print(d['data'][0]['id'])")
NDEF=$(P "SELECT count(*) FROM service_items WHERE tenant_id='$TID' AND is_default AND is_active;")
charges(){ P "SELECT count(*) FROM charges WHERE patient_id='$RAW' AND deleted_at IS NULL;"; }
paidsum(){ P "SELECT coalesce(sum(amount),0)::int FROM charges WHERE patient_id='$RAW' AND status='paid';"; }
qtoday(){ P "SELECT count(*) FROM queue_entries WHERE patient_id='$RAW' AND deleted_at IS NULL AND state NOT IN ('done','no_show') AND (enqueued_at AT TIME ZONE 'Africa/Addis_Ababa')::date=(now() AT TIME ZONE 'Africa/Addis_Ababa')::date;"; }
receive(){ C "${A[@]}" -X POST $B/queue/walk-in -d "{\"patient_id\":\"$PID\",\"department_id\":\"$DEP\"}" >/dev/null; C "${A[@]}" -X POST $B/billing/checkout -d "{\"patient_id\":\"$PID\",\"method\":\"cash\"}" >/dev/null; }

echo "=== the desk receives her and collects ==="
receive
FIRST=$(paidsum)
t "the default fees were raised once" "$(charges)" "$NDEF"
t "she is at the chair"               "$(qtoday)" "1"

echo "=== the desk presses Collect five more times ==="
for i in 1 2 3 4 5; do receive; done
t "still the same charges"      "$(charges)" "$NDEF"
t "still the same money taken"  "$(paidsum)" "$FIRST"
t "still one place in the queue" "$(qtoday)" "1"

echo "=== a genuinely new visit tomorrow is not blocked ==="
X "UPDATE charges SET created_at = created_at - interval '1 day', settled_at = settled_at - interval '1 day' WHERE patient_id='$RAW';"
X "UPDATE queue_entries SET enqueued_at = enqueued_at - interval '1 day' WHERE patient_id='$RAW';"
receive
t "a fresh fee is raised for the new day" "$(charges)" "$((NDEF * 2))"
t "and she is queued again today"         "$(qtoday)" "1"

echo; echo "$pass passed, $fail failed"
