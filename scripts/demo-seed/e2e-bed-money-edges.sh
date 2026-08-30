#!/usr/bin/env bash
# The awkward cases the bed ledger has to survive: a deposit that is not a whole
# number of nights, a waiver, a voided charge, and a transfer between rates.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
EMAIL='bedge@yclinic.test'; MRN="BEDGE-$RANDOM"
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
drop(){
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn LIKE '${MRN}%';"
  X "DELETE FROM bed_admission_stays s USING bed_admissions a, patients p WHERE s.admission_id=a.id AND a.patient_id=p.id AND p.mrn LIKE '${MRN}%';"
  X "DELETE FROM bed_admissions a USING patients p WHERE a.patient_id=p.id AND p.mrn LIKE '${MRN}%';"
  X "DELETE FROM patients WHERE mrn LIKE '${MRN}%';"
  X "DELETE FROM beds WHERE label IN ('EDGE-A','EDGE-B','EDGE-C') AND tenant_id='$TID';"
  X "DELETE FROM wards WHERE name='Edge Ward' AND tenant_id='$TID';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$EMAIL';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$EMAIL';"
  X "DELETE FROM users WHERE email='$EMAIL';"
}
trap drop EXIT
drop
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$EMAIL','Edge','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$EMAIL\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $T")

W=$(C "${A[@]}" -X POST $B/inpatient/wards -d '{"name":"Edge Ward"}' | py "print(d['data']['id'])")
BA=$(C "${A[@]}" -X POST $B/inpatient/beds -d "{\"ward_id\":\"$W\",\"label\":\"EDGE-A\",\"bed_type\":\"general\",\"daily_rate\":\"450\"}" | py "print(d['data']['id'])")
BB=$(C "${A[@]}" -X POST $B/inpatient/beds -d "{\"ward_id\":\"$W\",\"label\":\"EDGE-B\",\"bed_type\":\"icu\",\"daily_rate\":\"2000\"}" | py "print(d['data']['id'])")
BC=$(C "${A[@]}" -X POST $B/inpatient/beds -d "{\"ward_id\":\"$W\",\"label\":\"EDGE-C\",\"bed_type\":\"general\",\"daily_rate\":\"450\"}" | py "print(d['data']['id'])")

card(){ C "${A[@]}" "$B/inpatient/board" | py "
r=[b for b in d['data'] if b['label']=='$1'][0]
print('%s|%s|%s|%s|%s|%s' % (r.get('days'),r.get('est_cost'),r.get('paid','0'),r.get('unbilled','0'),r.get('outstanding','0'),r.get('covered_nights')))"; }

echo "=== a deposit that is not a whole number of nights (1,500 on a 450 bed) ==="
PID=$(C "${A[@]}" -X POST $B/patients -d "{\"first_name\":\"Edge\",\"last_name\":\"One\",\"mrn\":\"$MRN\",\"gender\":\"male\",\"dob\":\"1980-01-01\",\"phone\":\"0911000111\"}" | py "print(d['data']['id'])")
ADM=$(C "${A[@]}" -X POST $B/inpatient/admissions -d "{\"patient_id\":\"$PID\",\"bed_id\":\"$BA\",\"deposit_amount\":\"1500.00\"}" | py "print(d['data']['id'])")
AID=$(P "SELECT a.id FROM bed_admissions a JOIN patients p ON p.id=a.patient_id WHERE p.mrn='$MRN';")
X "UPDATE bed_admissions SET admitted_at = now() - interval '4 days' WHERE id='$AID';"
X "UPDATE bed_admission_stays SET from_at = from_at - interval '4 days' WHERE admission_id='$AID';"
IFS='|' read -r days est paid unb owed cov <<<"$(card EDGE-A)"
t "four nights slept"                  "$days" "4"
t "the stay has run up 1,800"          "$est"  "1800.00"
t "1,500 is billed, so 300 is not"     "$unb"  "300.00"
t "nothing paid, so all 1,800 is owed" "$owed" "1800.00"
t "and no night is covered yet"        "$cov"  "0"

echo "=== the family pays the 1,500 — it buys three whole nights, not 3.33 ==="
C "${A[@]}" -X POST $B/billing/checkout -d "{\"patient_id\":\"$PID\",\"method\":\"cash\"}" >/dev/null
IFS='|' read -r days est paid unb owed cov <<<"$(card EDGE-A)"
t "paid is 1,500"                       "$paid" "1500.00"
t "three whole nights are covered"      "$cov"  "3"
t "300 is still owed for the fourth"    "$owed" "300.00"

echo "=== waiving the rest clears the debt without pretending it was paid ==="
C "${A[@]}" -X POST $B/inpatient/admissions/$ADM/topup -d '{}' >/dev/null
CID=$(P "SELECT c.id FROM charges c JOIN patients p ON p.id=c.patient_id WHERE p.mrn='$MRN' AND c.status='pending' ORDER BY c.created_at DESC LIMIT 1;")
CENC=$(C "${A[@]}" "$B/billing/charges?patient=$PID" | py "
rows=d['data']['rows'] if isinstance(d['data'],dict) else d['data']
print([r['id'] for r in rows if r['status']=='pending'][0])")
C "${A[@]}" -X POST $B/billing/charges/$CENC/waive -d '{"reason":"Staff dependent"}' >/dev/null
IFS='|' read -r days est paid unb owed cov <<<"$(card EDGE-A)"
t "nothing is owed after the waiver"   "$owed" "0.00"
t "but paid still reads 1,500"         "$paid" "1500.00"
t "and all four nights are covered"    "$cov"  "4"

echo "=== a voided charge is not money and is not billed ==="
PID2=$(C "${A[@]}" -X POST $B/patients -d "{\"first_name\":\"Edge\",\"last_name\":\"Two\",\"mrn\":\"${MRN}B\",\"gender\":\"female\",\"dob\":\"1990-01-01\",\"phone\":\"0911000222\"}" | py "print(d['data']['id'])")
ADM2=$(C "${A[@]}" -X POST $B/inpatient/admissions -d "{\"patient_id\":\"$PID2\",\"bed_id\":\"$BB\",\"deposit_amount\":\"2000.00\"}" | py "print(d['data']['id'])")
V=$(C "${A[@]}" "$B/billing/charges?patient=$PID2" | py "
rows=d['data']['rows'] if isinstance(d['data'],dict) else d['data']
print([r['id'] for r in rows if r['status']=='pending'][0])")
C "${A[@]}" -X POST $B/billing/charges/$V/void -d '{"reason":"raised in error"}' >/dev/null
IFS='|' read -r days est paid unb owed cov <<<"$(card EDGE-B)"
t "one night on the ICU bed"              "$est"  "2000.00"
t "the voided deposit is not billed"      "$unb"  "2000.00"
t "and is not money"                      "$paid" "0.00"

echo "=== a transfer prices each night at the bed actually slept in ==="
AID2=$(P "SELECT a.id FROM bed_admissions a JOIN patients p ON p.id=a.patient_id WHERE p.mrn='${MRN}B';")
X "UPDATE bed_admissions SET admitted_at = now() - interval '2 days' WHERE id='$AID2';"
X "UPDATE bed_admission_stays SET from_at = from_at - interval '2 days' WHERE admission_id='$AID2';"
IFS='|' read -r days est paid unb owed cov <<<"$(card EDGE-B)"
t "two nights on the ICU bed = 4,000" "$est" "4000.00"
# a bed someone else is in is not a destination
CODE=$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/inpatient/admissions/$ADM2/transfer -d "{\"bed_id\":\"$BA\"}")
t "a transfer into an occupied bed is refused" "$CODE" "409"
t "and the first patient is undisturbed"       "$(card EDGE-A | cut -d'|' -f2)" "1800.00"
# move to a free bed; tonight onwards costs 450, the two ICU nights stay at 2,000
C "${A[@]}" -X POST $B/inpatient/admissions/$ADM2/transfer -d "{\"bed_id\":\"$BC\"}" >/dev/null
IFS='|' read -r days est paid unb owed cov <<<"$(card EDGE-C)"
t "the two ICU nights are still billed at ICU" "$est"  "4000.00"
t "the patient now shows in the general bed"   "$days" "2"

echo; echo "$pass passed, $fail failed"
