#!/usr/bin/env bash
# A thirty-day booking paid ten days at a time — the case the board could not show.
# Runs entirely on y-clinic and removes everything it makes.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
EMAIL='bedmoney@yclinic.test'; MRN="BEDM-$RANDOM"
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }

drop(){
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM bed_admission_stays s USING bed_admissions a, patients p WHERE s.admission_id=a.id AND a.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM bed_admissions a USING patients p WHERE a.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM patients WHERE mrn='$MRN';"
  X "DELETE FROM beds WHERE label='E2E-BED-1' AND tenant_id='$TID';"
  X "DELETE FROM wards WHERE name='E2E Money Ward' AND tenant_id='$TID';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$EMAIL';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$EMAIL';"
  X "DELETE FROM users WHERE email='$EMAIL';"
}
trap drop EXIT
drop

U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$EMAIL','Bed Money','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$EMAIL\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")

W=$(C "${A[@]}" -X POST $B/inpatient/wards -d '{"name":"E2E Money Ward"}' | py "print(d['data']['id'])")
BED=$(C "${A[@]}" -X POST $B/inpatient/beds -d "{\"ward_id\":\"$W\",\"label\":\"E2E-BED-1\",\"bed_type\":\"general\",\"daily_rate\":\"450\"}" | py "print(d['data']['id'])")
PID=$(C "${A[@]}" -X POST $B/patients -d "{\"first_name\":\"Bed\",\"last_name\":\"Money\",\"mrn\":\"$MRN\",\"gender\":\"male\",\"dob\":\"1985-04-04\",\"phone\":\"0911777333\"}" | py "print(d['data']['id'])")

card(){ C "${A[@]}" "$B/inpatient/board" | py "
r=[b for b in d['data'] if b['label']=='E2E-BED-1'][0]
print('%s|%s|%s|%s|%s|%s|%s' % (r.get('days'),r.get('est_cost'),r.get('paid','0'),r.get('unbilled','0'),r.get('outstanding','0'),r.get('covered_nights'),r.get('planned_nights',0)))"; }

echo "=== admit: booked 30 nights, family pays for 10 (4,500) ==="
EXP=$(TZ=Africa/Addis_Ababa date -d '+30 days' +%F)
ADM=$(C "${A[@]}" -X POST $B/inpatient/admissions -d "{\"patient_id\":\"$PID\",\"bed_id\":\"$BED\",\"deposit_amount\":\"4500.00\",\"expected_discharge\":\"$EXP\"}" | py "print(d['data']['id'])")
IFS='|' read -r days est paid unb owed cov plan <<<"$(card)"
t "booked length is on the card"            "$plan" "30"
t "nothing paid until the cashier takes it" "$paid" "0.00"
t "one night has accrued"                   "$days" "1"

echo "=== the family pays the 4,500 at the cashier ==="
C "${A[@]}" -X POST $B/billing/checkout -d "{\"patient_id\":\"$PID\",\"method\":\"cash\"}" >/dev/null
IFS='|' read -r days est paid unb owed cov plan <<<"$(card)"
t "paid shows the money received"     "$paid" "4500.00"
t "ten nights are covered in advance" "$cov"  "10"
t "nothing is owed yet"               "$owed" "0.00"

echo "=== twelve nights later (two past what they paid for) ==="
X "UPDATE bed_admissions SET admitted_at = admitted_at - interval '12 days' WHERE id='$(P "SELECT id FROM bed_admissions WHERE patient_id=(SELECT id FROM patients WHERE mrn='$MRN')")';"
X "UPDATE bed_admission_stays SET from_at = from_at - interval '12 days' WHERE admission_id=(SELECT id FROM bed_admissions WHERE patient_id=(SELECT id FROM patients WHERE mrn='$MRN'));"
IFS='|' read -r days est paid unb owed cov plan <<<"$(card)"
t "twelve nights slept"                       "$days" "12"
t "the stay has run up 5,400"                 "$est"  "5400.00"
t "two nights were never billed"              "$unb"  "900.00"
t "and two nights are owed"                   "$owed" "900.00"
t "still only ten nights covered"             "$cov"  "10"

echo "=== the ward asks for five more nights ==="
C "${A[@]}" -X POST $B/inpatient/admissions/$ADM/topup -d '{"nights":5}' >/dev/null
IFS='|' read -r days est paid unb owed cov plan <<<"$(card)"
t "nothing is left unbilled"        "$unb"  "0.00"
t "the money is not paid yet"       "$paid" "4500.00"
CH=$(C "${A[@]}" "$B/billing/charges/pending" | py "
rows=d['data']['rows'] if isinstance(d['data'],dict) else d['data']
b=[r for r in rows if '$MRN' in json.dumps(r) and r.get('description','').startswith('Bed')]
print('%s|%s' % (b[0]['amount'], b[0]['description']) if b else 'none|none')")
t "and it is waiting on the cashier worklist" "${CH%%|*}" "2250.00"
echo "  cashier line: ${CH##*|}"

echo "=== the family pays it ==="
C "${A[@]}" -X POST $B/billing/checkout -d "{\"patient_id\":\"$PID\",\"method\":\"cash\"}" >/dev/null
IFS='|' read -r days est paid unb owed cov plan <<<"$(card)"
t "paid is now 6,750"          "$paid" "6750.00"
t "fifteen nights covered"     "$cov"  "15"
t "nothing owed"               "$owed" "0.00"

echo "=== discharge does not bill the same nights twice ==="
BEFORE=$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='$MRN' AND c.source='bed';")
C "${A[@]}" -X POST $B/inpatient/admissions/$ADM/discharge >/dev/null
AFTER=$(P "SELECT count(*) FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='$MRN' AND c.source='bed';")
t "no extra charge at discharge" "$AFTER" "$BEFORE"
TOTAL=$(P "SELECT coalesce(sum(amount),0)::text FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='$MRN' AND c.source='bed' AND c.status='paid';")
t "the patient paid 6,750 in all, never more" "$TOTAL" "6750.00"

echo; echo "$pass passed, $fail failed"
