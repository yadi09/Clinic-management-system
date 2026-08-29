#!/usr/bin/env bash
# Can a general clinic treat someone who cannot pay today — and is the money still owed?
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
code(){ echo "$1" | py "print(d.get('error',{}).get('code',''))"; }
clean(){
  X "DELETE FROM queue_entries q USING patients p WHERE q.patient_id=p.id AND p.mrn LIKE 'DEF-%';"
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn LIKE 'DEF-%';"
  X "DELETE FROM dental_charts c USING patients p WHERE c.patient_id=p.id AND p.mrn LIKE 'DEF-%';"
  X "DELETE FROM patients WHERE mrn LIKE 'DEF-%';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email LIKE 'def_%@joy.internal';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email LIKE 'def_%@joy.internal';"
  X "DELETE FROM users WHERE email LIKE 'def_%@joy.internal';"
}
trap clean EXIT
clean
mk(){ local u; u=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$1','T','$HASH','active') RETURNING id;")
  for r in $(echo "$2" | tr ',' ' '); do X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$u',id FROM roles WHERE tenant_id='$TID' AND code='$r';"; done; }
mk def_mgr@joy.internal tenant_owner
mk def_recep@joy.internal receptionist
TM=$(C -H "$CT" -X POST $B/auth/login -d '{"workspace":"joy-speciality","email":"def_mgr@joy.internal","password":"BranchTest#2026"}' | py "print(d['data']['access_token'])")
TR=$(C -H "$CT" -X POST $B/auth/login -d '{"workspace":"joy-speciality","email":"def_recep@joy.internal","password":"BranchTest#2026"}' | py "print(d['data']['access_token'])")
M=(-H "$CT" -H "Authorization: Bearer $TM"); R=(-H "$CT" -H "Authorization: Bearer $TR")
DEPT=$(C "${M[@]}" "$B/org/departments" | py "print(d['data'][0]['id'])")
X "INSERT INTO patients (tenant_id,mrn,first_name,last_name,gender,dob) VALUES ('$TID','DEF-1','Cannot','Paytoday','female','1992-02-02');"
PENC=$(C "${M[@]}" "$B/patients?q=DEF-1" | py "print(d['data'][0]['id'])")

echo "=== a patient arrives who cannot pay ==="
WI=$(C "${R[@]}" -X POST "$B/queue/walk-in" -d "{\"patient_id\":\"$PENC\",\"department_id\":\"$DEPT\"}")
t "the fee is raised and holds them"  "$(echo "$WI" | py "print(d['data']['gated'])")" "True"
t "  ...so they are not in the queue" "$(P "SELECT count(*) FROM queue_entries q JOIN patients p ON p.id=q.patient_id WHERE p.mrn='DEF-1';")" "0"
OWED=$(P "SELECT sum(amount)::text FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1' AND c.status='pending';")
echo "    (they owe $OWED and cannot be seen)"

echo "=== the desk alone cannot decide this ==="
t "reception is refused" "$(code "$(C "${R[@]}" -X POST "$B/billing/patients/$PENC/defer" -d '{"reason":"Cannot pay today"}')")" "FORBIDDEN_PERMISSION"
t "a reason is required" "$(code "$(C "${M[@]}" -X POST "$B/billing/patients/$PENC/defer" -d '{"reason":"  "}')")" "VALIDATION_FAILED"

echo "=== the manager agrees to bill later ==="
DF=$(C "${M[@]}" -X POST "$B/billing/patients/$PENC/defer" -d '{"reason":"Emergency — treat first"}')
t "the visit is deferred"            "$(echo "$DF" | py "print('yes' if d['data']['deferred']>0 else 'no')")" "yes"
t "  ...and they join the queue now" "$(P "SELECT q.stage FROM queue_entries q JOIN patients p ON p.id=q.patient_id WHERE p.mrn='DEF-1' ORDER BY q.enqueued_at DESC LIMIT 1;")" "triage"

echo "=== but the money is NOT written off ==="
t "the charges are still pending"    "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1' AND c.status='pending';")" "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1';")"
t "  ...the amount is unchanged"     "$(P "SELECT sum(amount)::text FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1' AND c.status='pending';")" "$OWED"
t "  ...nothing was waived"          "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1' AND c.status='waived';")" "0"
t "  ...they are still at the cashier" "$(C "${M[@]}" "$B/billing/charges/pending" | py "print('yes' if 'DEF-1' in json.dumps(d) else 'no')")" "yes"
t "the decision is on the record"    "$(P "SELECT DISTINCT defer_reason FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1' AND c.deferred_at IS NOT NULL;")" "Emergency — treat first"
t "  ...with who decided it"         "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1' AND c.deferred_by IS NOT NULL;")" "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1';")"

echo "=== the desk can tell agreed credit from a forgotten charge ==="
t "reception shows it as agreed" "$(C "${R[@]}" "$B/reception/today" | py "
rows=[r for lens in ('expected','waiting','seen') for r in d['data'].get(lens) or []]
m=[r for r in rows if r.get('mrn')=='DEF-1']
print(m[0].get('owed_agreed') if m else 'not on the board')")" "True"

echo "=== and it can still be collected later ==="
CIDS=$(C "${R[@]}" "$B/billing/charges?patient=$PENC" | py "import json;print(json.dumps([r['id'] for r in d['data']['rows'] if r['status']=='pending']))")
t "the cashier takes it when they come back" "$(C -o /dev/null -w '%{http_code}' "${M[@]}" -X POST "$B/billing/checkout" -d "{\"patient_id\":\"$PENC\",\"method\":\"cash\",\"charge_ids\":$CIDS}")" "200"
t "  ...and now it is paid" "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1' AND c.status='paid';")" "$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='DEF-1';")"
t "  ...nothing left to defer"       "$(code "$(C "${M[@]}" -X POST "$B/billing/patients/$PENC/defer" -d '{"reason":"again"}')")" "NOTHING_TO_DEFER"

echo "=== $pass passed, $fail failed ==="
