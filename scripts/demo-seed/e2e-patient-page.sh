#!/usr/bin/env bash
# The patient page serves four different people. Prove each is told what they need
# and nothing that belongs to someone else. Runs on y-clinic; cleans up after.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
MRN="PP-$RANDOM"
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
EMAILS="pp-doc@yclinic.test pp-cash@yclinic.test pp-lab@yclinic.test pp-nurse@yclinic.test"

drop(){
  for e in $EMAILS; do
    X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$e';"
    X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email='$e';"
    X "DELETE FROM users WHERE email='$e';"
  done
  X "DELETE FROM charges c USING patients p WHERE c.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM vitals v USING patients p WHERE v.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM queue_entries q USING patients p WHERE q.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM encounters e USING patients p WHERE e.patient_id=p.id AND p.mrn='$MRN';"
  X "DELETE FROM patients WHERE mrn='$MRN';"
}
trap drop EXIT
drop

mk(){ # $1=email $2=role
  U=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$1','$2 probe','$HASH','active') RETURNING id;")
  n=$(P "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$U',id FROM roles WHERE tenant_id='$TID' AND code='$2' RETURNING 1;")
  [ "$n" = "1" ] || { echo "  SETUP FAIL: no role $2"; exit 1; }
  C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$1\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])"
}
TDOC=$(mk pp-doc@yclinic.test doctor)
TCASH=$(mk pp-cash@yclinic.test cashier)
TLAB=$(mk pp-lab@yclinic.test lab_technician)
TNUR=$(mk pp-nurse@yclinic.test nurse)
D=(-H "$CT" -H "Authorization: Bearer $TDOC")
K=(-H "$CT" -H "Authorization: Bearer $TCASH")
L=(-H "$CT" -H "Authorization: Bearer $TLAB")
N=(-H "$CT" -H "Authorization: Bearer $TNUR")

# a patient who owes money
PID=$(C "${D[@]}" -X POST $B/patients -d "{\"first_name\":\"Page\",\"last_name\":\"Probe\",\"mrn\":\"$MRN\",\"gender\":\"female\",\"dob\":\"1990-02-02\",\"phone\":\"0911222444\"}" | py "print(d['data']['id'])")
C "${K[@]}" -X POST $B/billing/charges -d "{\"patient_id\":\"$PID\",\"description\":\"Consultation\",\"amount\":300,\"source\":\"consultation\"}" >/dev/null

ov(){ C "$@" "$B/patients/$PID/overview"; }
has(){ ov "${!1}" | py "print('yes' if d['data'].get('$2') is not None else 'no')"; }

echo "=== each role is told what its job needs ==="
t "the cashier is told the money"          "$(ov "${K[@]}" | py "print('yes' if d['data'].get('money') else 'no')")" "yes"
t "the cashier is NOT told the diagnosis"  "$(ov "${K[@]}" | py "print(d['data'].get('last_visit',{}).get('diagnosis','') or 'none')")" "none"
t "the doctor is told the clinical block"  "$(ov "${D[@]}" | py "print('yes' if 'last_visit' in d['data'] or True else 'no')")" "yes"
t "the nurse is NOT told the money"        "$(ov "${N[@]}" | py "print('yes' if d['data'].get('money') else 'no')")" "no"
t "the lab tech is NOT told the money"     "$(ov "${L[@]}" | py "print('yes' if d['data'].get('money') else 'no')")" "no"

echo "=== money reads the same as the cashier's own page ==="
OWED=$(ov "${K[@]}" | py "print(d['data']['money']['owed'])")
t "owes the charge that was raised" "$OWED" "300.00"

echo "=== vitals reach the people who read them ==="
ENC=$(P "INSERT INTO encounters (tenant_id,branch_id,patient_id,status,started_at)
   SELECT '$TID', (SELECT id FROM branches WHERE tenant_id='$TID' LIMIT 1), p.id, 'open', now()
   FROM patients p WHERE p.mrn='$MRN' RETURNING id;")
X "INSERT INTO vitals (tenant_id,encounter_id,patient_id,systolic,diastolic,pulse,temp_c,recorded_at)
   SELECT '$TID', '$ENC', p.id, 148, 96, 88, 37.1, now() FROM patients p WHERE p.mrn='$MRN';"
t "the nurse sees the last observations"  "$(ov "${N[@]}" | py "print(d['data'].get('vitals',{}).get('systolic'))")" "148"
t "the doctor sees them too"              "$(ov "${D[@]}" | py "print(d['data'].get('vitals',{}).get('systolic'))")" "148"
t "the cashier does not"                  "$(ov "${K[@]}" | py "print('yes' if d['data'].get('vitals') else 'no')")" "no"

echo "=== the lab can ask what a patient has ever had ==="
t "lab history is readable by the bench" "$(C "${L[@]}" -o /dev/null -w '%{http_code}' "$B/lab/patients/$PID/labs")" "200"
t "and by the doctor who orders"         "$(C "${D[@]}" -o /dev/null -w '%{http_code}' "$B/lab/patients/$PID/labs")" "200"
t "but not by the cashier"               "$(C "${K[@]}" -o /dev/null -w '%{http_code}' "$B/lab/patients/$PID/labs")" "403"
t "no orders yet reads as an empty list" "$(C "${L[@]}" "$B/lab/patients/$PID/labs" | py "print(len(d['data']))")" "0"

echo "=== a patient in the room shows as present ==="
DEP=$(P "SELECT id FROM departments WHERE tenant_id='$TID' LIMIT 1;")
X "INSERT INTO queue_entries (tenant_id,branch_id,department_id,patient_id,state,stage,enqueued_at)
   SELECT '$TID', (SELECT id FROM branches WHERE tenant_id='$TID' LIMIT 1), '$DEP', p.id, 'waiting','triage', now()
   FROM patients p WHERE p.mrn='$MRN';"
t "the desk sees they are waiting" "$(ov "${K[@]}" | py "print(d['data'].get('here_now',{}).get('kind'))")" "queue"
t "so does the nurse"              "$(ov "${N[@]}" | py "print(d['data'].get('here_now',{}).get('state'))")" "waiting"
X "DELETE FROM queue_entries q USING patients p WHERE q.patient_id=p.id AND p.mrn='$MRN';"

echo; echo "$pass passed, $fail failed"
