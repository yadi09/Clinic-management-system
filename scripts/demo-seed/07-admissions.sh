#!/usr/bin/env bash
set -u
TID=2345f765-62df-45de-9874-59bd55b4b6a1
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
drop(){
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='seeder@joy.internal';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='seeder@joy.internal';"
  X "DELETE FROM users WHERE email='seeder@joy.internal';"
}
trap drop EXIT
drop
U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','seeder@joy.internal','Seeder','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
T=$(C -H "$CT" -X POST $B/auth/login -d '{"workspace":"joy-speciality","email":"seeder@joy.internal","password":"BranchTest#2026"}' | py "print(d['data']['access_token'])")
[ -n "$T" ] || { echo "login failed"; exit 1; }
AUTH=(-H "$CT" -H "Authorization: Bearer $T")

bed(){ C "${AUTH[@]}" "$B/inpatient/beds" | py "print([b['id'] for b in d['data'] if b['label']=='$1'][0])"; }
pat(){ C "${AUTH[@]}" "$B/patients?q=$1" | py "print(d['data'][0]['id'])"; }
backdate(){ # admission-uuid, days-ago
  X "UPDATE bed_admissions SET admitted_at = now() - interval '$2 days' WHERE id='$1';"
  X "UPDATE bed_admission_stays SET from_at = now() - interval '$2 days' WHERE admission_id='$1' AND from_at = (SELECT min(from_at) FROM bed_admission_stays WHERE admission_id='$1');"
}
adm_uuid(){ P "SELECT a.id FROM bed_admissions a JOIN patients p ON p.id=a.patient_id WHERE p.mrn='$1' ORDER BY a.created_at DESC LIMIT 1;"; }

admit(){ # mrn, bed-label, deposit, days-ago, due-days
  local penc benc r aid
  penc=$(pat "$1"); benc=$(bed "$2")
  r=$(C "${AUTH[@]}" -X POST "$B/inpatient/admissions" \
      -d "{\"patient_id\":\"$penc\",\"bed_id\":\"$benc\",\"deposit_amount\":\"$3\",\"payment_due_at\":\"$(date -u -d "+$5 days" +%FT%TZ)\"}")
  aid=$(adm_uuid "$1")
  [ -n "$aid" ] && backdate "$aid" "$4"
  echo "$r" | py "print(d['data']['id'])"
}

echo "--- currently on the ward ---"
A1=$(admit JOY-0007 M-01 2000 6 -2)   ; echo "  M-01  Mulugeta Assefa, 6 nights, deposit overdue"
A2=$(admit JOY-0013 M-03 1500 3 4)    ; echo "  M-03  Tesfaye Abera, 3 nights"
A3=$(admit JOY-0020 M-05 3000 1 5)    ; echo "  M-05  Genet Worku, private room, 1 night"
A4=$(admit JOY-0032 ICU-1 5000 2 3)   ; echo "  ICU-1 Fitsum Habte, 2 nights in intensive care"
A5=$(admit JOY-0029 MAT-01 1500 1 6)  ; echo "  MAT-01 Tsion Legesse, maternity"

echo "--- one of them stepped down from ICU yesterday (proves the segment split) ---"
A6=$(admit JOY-0043 ICU-2 5000 5 4)
A6ID=$(adm_uuid JOY-0043)
C -o /dev/null "${AUTH[@]}" -X POST "$B/inpatient/admissions/$A6/transfer" -d "{\"bed_id\":\"$(bed M-02)\"}"
X "UPDATE bed_admission_stays SET to_at = now() - interval '1 day' WHERE admission_id='$A6ID' AND to_at IS NOT NULL;"
X "UPDATE bed_admission_stays SET from_at = now() - interval '1 day' WHERE admission_id='$A6ID' AND to_at IS NULL;"
echo "  Bereket Tola: 4 nights ICU then moved to M-02 yesterday"

echo "--- discharged earlier this month ---"
for row in "JOY-0002 M-04 1000 12 9" "JOY-0009 M-06 2000 20 16" "JOY-0027 MAT-02 1500 9 6" "JOY-0037 M-01 1000 30 27"; do
  set -- $row
  A=$(admit "$1" "$2" "$3" "$4" 3)
  AID=$(adm_uuid "$1")
  D=$(C "${AUTH[@]}" -X POST "$B/inpatient/admissions/$A/discharge" -d '{}')
  # the discharge really happened when they went home
  X "UPDATE bed_admissions SET discharged_at = now() - interval '$5 days' WHERE id='$AID';"
  echo "  $1 stayed $(( $4 - $5 )) nights — billed $(echo "$D" | py "print(d['data']['est_cost'])") ETB"
done

echo "--- two results that need a doctor to act ---"
X "UPDATE lab_results r SET value='4.2', flag='critical'
   FROM lab_analytes a WHERE a.id=r.analyte_id AND a.name='Haemoglobin'
     AND r.tenant_id='$TID' AND r.id IN (SELECT id FROM lab_results WHERE tenant_id='$TID' ORDER BY created_at DESC LIMIT 2);"
X "UPDATE lab_order_items i SET critical_flag=true FROM lab_results r
   WHERE r.order_item_id=i.id AND r.flag='critical' AND i.tenant_id='$TID';"

echo
echo "=== ward now ==="
docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "
SELECT w.name AS ward, b.label AS bed, b.daily_rate,
       coalesce(p.first_name||' '||p.last_name,'—') AS patient,
       CASE WHEN a.id IS NULL THEN 'free' ELSE a.status END AS state,
       CASE WHEN a.admitted_at IS NOT NULL
            THEN ((now() AT TIME ZONE 'Africa/Addis_Ababa')::date - (a.admitted_at AT TIME ZONE 'Africa/Addis_Ababa')::date) END AS nights
FROM beds b JOIN wards w ON w.id=b.ward_id
LEFT JOIN bed_admissions a ON a.bed_id=b.id AND a.status='active'
LEFT JOIN patients p ON p.id=a.patient_id
WHERE b.tenant_id='$TID' ORDER BY w.name, b.label;"
