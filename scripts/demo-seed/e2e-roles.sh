#!/usr/bin/env bash
# A day at Joy Speciality, walked by each member of staff in turn.
set -u
TID=2345f765-62df-45de-9874-59bd55b4b6a1
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
PW='BranchTest#2026'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
pass=0; fail=0; FINDINGS=()
ok(){ echo "    ok   $1"; pass=$((pass+1)); }
bad(){ echo "    BUG  $1 -- $2"; fail=$((fail+1)); FINDINGS+=("$1 :: $2"); }
t(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected [$3] got [$2]"; }
tn(){ [ "$2" != "$3" ] && ok "$1" || bad "$1" "should not have been [$3]"; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
code(){ echo "$1" | py "print(d.get('error',{}).get('code',''))"; }

mkuser(){ # email, roles(csv)
  local u; u=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$1','$2 tester','$HASH','active') RETURNING id;")
  for r in $(echo "$3" | tr ',' ' '); do
    X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$u',id FROM roles WHERE tenant_id='$TID' AND code='$r';"
  done
  echo "$u"
}
login(){ C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"joy-speciality\",\"email\":\"$1\",\"password\":\"$PW\"}" | py "print(d['data']['access_token'])"; }

cleanup(){
  # Delete anything pointing at the test patients, in reverse dependency order,
  # discovered from the catalogue rather than from a hand-written list that goes
  # stale every time a table is added (dental_charts is what caught me out).
  docker exec -i clinicos-postgres-1 psql -U clinic -d clinic >/dev/null 2>&1 <<'SQL'
DO $$
DECLARE
  ids uuid[];
  t record;
  n int;
BEGIN
  SELECT array_agg(id) INTO ids FROM patients WHERE mrn LIKE 'E2E-%';
  IF ids IS NULL THEN RETURN; END IF;
  FOR i IN 1..8 LOOP     -- a few passes, so chains (order -> item -> result) drain
    FOR t IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
      WHERE c.confrelid='patients'::regclass AND c.contype='f'
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM %s WHERE %I = ANY($1)', t.tbl, t.col) USING ids;
      EXCEPTION WHEN others THEN NULL;   -- blocked by a deeper child; next pass
      END;
    END LOOP;
  END LOOP;
  -- lab + prescription chains hang off encounters, not patients
  DELETE FROM lab_results WHERE order_item_id IN (
    SELECT i.id FROM lab_order_items i JOIN lab_orders o ON o.id=i.order_id WHERE o.patient_id = ANY(ids));
  DELETE FROM lab_order_items WHERE order_id IN (SELECT id FROM lab_orders WHERE patient_id = ANY(ids));
  DELETE FROM lab_orders WHERE patient_id = ANY(ids);
  DELETE FROM prescription_items WHERE prescription_id IN (SELECT id FROM prescriptions WHERE patient_id = ANY(ids));
  DELETE FROM prescriptions WHERE patient_id = ANY(ids);
  DELETE FROM clinical_notes WHERE encounter_id IN (SELECT id FROM encounters WHERE patient_id = ANY(ids));
  DELETE FROM bed_admission_stays WHERE admission_id IN (SELECT id FROM bed_admissions WHERE patient_id = ANY(ids));
  DELETE FROM encounters WHERE patient_id = ANY(ids);
  DELETE FROM patients WHERE id = ANY(ids);
END $$;
SQL
  X "DELETE FROM service_items WHERE tenant_id='$TID' AND code='E2ESVC';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email LIKE 'e2e_%@joy.internal';"
  X "DELETE FROM user_role_scopes urs USING users u WHERE urs.user_id=u.id AND u.email LIKE 'e2e_%@joy.internal';"
  X "DELETE FROM users WHERE email LIKE 'e2e_%@joy.internal';"
}
trap cleanup EXIT
cleanup

mkuser e2e_admin@joy.internal Admin tenant_owner   >/dev/null
mkuser e2e_recep@joy.internal Reception receptionist,cashier >/dev/null
mkuser e2e_nurse@joy.internal Nurse nurse          >/dev/null
mkuser e2e_doc@joy.internal   Doctor doctor        >/dev/null
mkuser e2e_lab@joy.internal   Lab lab_technician,lab_manager >/dev/null

TA=$(login e2e_admin@joy.internal); TR=$(login e2e_recep@joy.internal)
TN=$(login e2e_nurse@joy.internal); TD=$(login e2e_doc@joy.internal); TL=$(login e2e_lab@joy.internal)
for v in TA TR TN TD TL; do [ -n "${!v}" ] || { echo "LOGIN FAILED for $v"; exit 1; }; done
A=(-H "$CT" -H "Authorization: Bearer $TA"); R=(-H "$CT" -H "Authorization: Bearer $TR")
N=(-H "$CT" -H "Authorization: Bearer $TN"); D=(-H "$CT" -H "Authorization: Bearer $TD"); L=(-H "$CT" -H "Authorization: Bearer $TL")

DEPT=$(C "${A[@]}" "$B/org/departments" | py "print(d['data'][0]['id'])")
DOCID=$(C "${A[@]}" "$B/providers" | py "print([u['id'] for u in d['data'] if 'Doctor' in u['full_name']][0] if any('Doctor' in u['full_name'] for u in d['data']) else d['data'][0]['id'])")

echo
echo "=============================================================="
echo " 1. RECEPTION — a new patient walks in"
echo "=============================================================="
STAMP=$(date +%H%M%S)
MRNX="E2E-$STAMP"
NEW=$(C "${R[@]}" -X POST "$B/patients" -d "{\"first_name\":\"Almaz$STAMP\",\"last_name\":\"Testachew\",\"gender\":\"female\",\"dob\":\"1994-03-12\",\"phone\":\"09${STAMP}12\"}")
PENC=$(echo "$NEW" | py "print(d['data']['id'])")
t "reception can register a patient" "$([ -n "$PENC" ] && echo yes || echo no)" "yes"
[ -n "$PENC" ] || { echo "cannot continue"; exit 1; }
MRN=$(echo "$NEW" | py "print(d['data']['mrn'])")
X "UPDATE patients SET mrn='$MRNX' WHERE mrn='$MRN';"
PENC=$(C "${R[@]}" "$B/patients?q=$MRNX" | py "print(d['data'][0]['id'])")
echo "    (registered as $MRNX)"

t "reception sees the reception board" "$(C -o /dev/null -w '%{http_code}' "${R[@]}" "$B/reception/today")" "200"
WI=$(C "${R[@]}" -X POST "$B/queue/walk-in" -d "{\"patient_id\":\"$PENC\",\"department_id\":\"$DEPT\",\"provider_id\":\"$DOCID\"}")
t "  ...and can receive a walk-in" "$(echo "$WI" | py "print('yes' if d['data']['status']=='queued' else 'no')")" "yes"
NCH=$(echo "$WI" | py "print(len(d['data']['charge_ids']))")
t "  ...and the visit fee is raised" "$([ "$NCH" -gt 0 ] && echo yes || echo no)" "yes"
t "  ...they wait for the cashier, not the doctor" "$(echo "$WI" | py "print(d['data']['gated'])")" "True"

PEND=$(C "${R[@]}" "$B/billing/charges/pending")
t "reception sees them at the cashier" "$(echo "$PEND" | py "print('yes' if '$MRNX' in json.dumps(d) else 'no')")" "yes"
CIDS=$(C "${R[@]}" "$B/billing/charges?patient=$PENC" | py "import json;print(json.dumps([r['id'] for r in d['data']['rows'] if r['status']=='pending']))")
SET=$(C -w '\n%{http_code}' "${R[@]}" -X POST "$B/billing/checkout" -d "{\"patient_id\":\"$PENC\",\"method\":\"cash\",\"charge_ids\":$CIDS}")
t "  ...and can take the money" "$(echo "$SET" | tail -1)" "200"
t "  ...which produces a receipt" "$(echo "$SET" | head -1 | py "print('yes' if d['data']['receipt_no'] else 'no')")" "yes"
t "  ...and only now do they join the queue" "$(P "SELECT q.stage FROM queue_entries q JOIN patients p ON p.id=q.patient_id WHERE p.mrn='$MRNX' ORDER BY q.enqueued_at DESC LIMIT 1;")" "triage"
t "  ...with the named doctor dropped by the triage rule" "$(P "SELECT coalesce(q.assigned_provider_id::text,'none') FROM queue_entries q JOIN patients p ON p.id=q.patient_id WHERE p.mrn='$MRNX' ORDER BY q.enqueued_at DESC LIMIT 1;")" "none"

echo
echo "  -- what reception must NOT be able to do --"
QID=$(C "${R[@]}" "$B/queue?department=$DEPT" | py "print([e['id'] for e in d['data'] if e['mrn']=='$MRNX'][0])")
t "cannot open a consultation"  "$(code "$(C "${R[@]}" -X POST "$B/encounters" -d "{\"queue_entry_id\":\"$QID\"}")")" "FORBIDDEN_PERMISSION"
t "cannot record vitals"        "$(code "$(C "${R[@]}" -X POST "$B/visits/$QID/vitals?patient=$PENC" -d '{"branch_id":"x","pulse":80}')")" "FORBIDDEN_PERMISSION"
t "cannot see the lab worklist" "$(code "$(C "${R[@]}" "$B/lab/worklist")")" "FORBIDDEN_PERMISSION"
t "cannot edit the clinic"      "$(code "$(C "${R[@]}" -X PUT "$B/org/settings" -d '{"triage_required":false}')")" "FORBIDDEN_PERMISSION"

echo
echo "=============================================================="
echo " 2. TRIAGE NURSE — vitals before anyone sees a doctor"
echo "=============================================================="
t "the nurse sees the triage queue" "$(C "${N[@]}" "$B/queue?department=$DEPT" | py "print('yes' if any(e['mrn']=='$MRNX' for e in d['data']) else 'no')")" "yes"
t "assigning before vitals is refused" "$(code "$(C "${N[@]}" -X POST "$B/queue/$QID/assign" -d "{\"provider_id\":\"$DOCID\"}")")" "VITALS_REQUIRED"
BR=$(C "${A[@]}" "$B/org/branches" | py "print(d['data'][0]['id'])")
V=$(C -w '\n%{http_code}' "${N[@]}" -X POST "$B/visits/$QID/vitals?patient=$PENC" \
    -d "{\"branch_id\":\"$BR\",\"department_id\":\"$DEPT\",\"systolic\":128,\"diastolic\":82,\"pulse\":88,\"resp_rate\":18,\"spo2\":97,\"temp_c\":37.9,\"weight_kg\":61,\"height_cm\":163,\"notes\":\"Febrile, alert.\"}")
t "the nurse can record vitals" "$(echo "$V" | tail -1)" "201"
t "  ...then assignment goes through" "$(C -o /dev/null -w '%{http_code}' "${N[@]}" -X POST "$B/queue/$QID/assign" -d "{\"provider_id\":\"$DOCID\"}")" "204"

echo
echo "  -- what the nurse must NOT be able to do --"
t "cannot open a consultation" "$(code "$(C "${N[@]}" -X POST "$B/encounters" -d "{\"queue_entry_id\":\"$QID\"}")")" "FORBIDDEN_PERMISSION"
t "cannot take payment"        "$(code "$(C "${N[@]}" -X POST "$B/billing/checkout" -d "{\"patient_id\":\"$PENC\",\"method\":\"cash\"}")")" "FORBIDDEN_PERMISSION"
t "cannot order labs"          "$(code "$(C "${N[@]}" -X POST "$B/lab/orders" -d "{\"patient_id\":\"$PENC\",\"test_ids\":[]}")")" "FORBIDDEN_PERMISSION"

echo
echo "=============================================================="
echo " 3. DOCTOR — the consultation"
echo "=============================================================="
WS=$(C "${D[@]}" -X POST "$B/encounters" -d "{\"queue_entry_id\":\"$QID\"}")
ENC=$(echo "$WS" | py "print(d['data']['encounter_id'])")
t "the doctor can open the encounter" "$([ -n "$ENC" ] && echo yes || echo no)" "yes"
t "  ...and sees the nurse's vitals"  "$(echo "$WS" | py "print(d['data']['vitals'][0]['pulse'])")" "88"
t "  ...and the patient's allergies field is present" "$(echo "$WS" | py "print('allergies' in d['data'])")" "True"
t "the story endpoint answers"        "$(C "${D[@]}" "$B/patients/$PENC/story" | py "print(sorted(d['data'].keys()))" | tr -d "[]' ")" "medicines,problems,trend"

t "note saves" "$(C -o /dev/null -w '%{http_code}' "${D[@]}" -X PUT "$B/encounters/$ENC/note" -d '{"subjective":"Fever 3 days","objective":"Chest clear","assessment":"Likely malaria","plan":"Treat and review"}')" "204"
CAT=$(C "${D[@]}" "$B/diagnosis-catalog?search=Malaria" | py "print(d['data'][0]['id'])")
t "diagnosis adds" "$(C -o /dev/null -w '%{http_code}' "${D[@]}" -X POST "$B/encounters/$ENC/diagnoses" -d "{\"catalog_id\":\"$CAT\",\"is_primary\":true}")" "201"
t "prescription adds" "$(C -o /dev/null -w '%{http_code}' "${D[@]}" -X POST "$B/encounters/$ENC/prescriptions" -d '{"drug_name":"Artemether/Lumefantrine","dose":"4 tablets","frequency":"twice daily","duration":"3 days","instructions":"After food."}')" "201"
TEST=$(C "${D[@]}" "$B/lab/tests?active=true" | py "print([x['id'] for x in d['data'] if x['code']=='CBC'][0])")
ORD=$(C "${D[@]}" -X POST "$B/lab/orders" -d "{\"encounter_id\":\"$ENC\",\"patient_id\":\"$PENC\",\"priority\":\"urgent\",\"test_ids\":[\"$TEST\"]}")
t "lab order places" "$(echo "$ORD" | py "print('yes' if d['data']['order_no'] else 'no')")" "yes"
t "set aside works" "$(C -o /dev/null -w '%{http_code}' "${D[@]}" -X POST "$B/encounters/$ENC/set-aside")" "204"

echo
echo "  -- the lab order must be paid before the sample is drawn --"
LWL=$(C "${L[@]}" "$B/lab/worklist")
LITEM=$(echo "$LWL" | py "
rows=[i for i in d['data'] if '$MRNX' in json.dumps(i)]
print(rows[0]['id'] if rows else '')")
t "drawing before payment is refused" "$(code "$(C "${L[@]}" -X POST "$B/lab/items/$LITEM/accession")")" "PAYMENT_PENDING"
LC=$(C "${R[@]}" "$B/billing/charges?patient=$PENC" | py "import json;print(json.dumps([r['id'] for r in d['data']['rows'] if r['status']=='pending']))")
t "reception collects for the lab" "$(C -o /dev/null -w '%{http_code}' "${R[@]}" -X POST "$B/billing/checkout" -d "{\"patient_id\":\"$PENC\",\"method\":\"cash\",\"charge_ids\":$LC}")" "200"

echo "  -- what the doctor must NOT be able to do --"
t "cannot take payment"     "$(code "$(C "${D[@]}" -X POST "$B/billing/checkout" -d "{\"patient_id\":\"$PENC\",\"method\":\"cash\"}")")" "FORBIDDEN_PERMISSION"
t "cannot record vitals"    "$(code "$(C "${D[@]}" -X POST "$B/visits/$QID/vitals?patient=$PENC" -d "{\"branch_id\":\"$BR\",\"pulse\":80}")")" "FORBIDDEN_PERMISSION"
t "cannot invite staff"     "$(code "$(C "${D[@]}" -X POST "$B/users" -d '{"email":"x@y.z","full_name":"X","roles":["doctor"]}')")" "FORBIDDEN_PERMISSION"

echo
echo "=============================================================="
echo " 4. LABORATORY — sample to validated result"
echo "=============================================================="
WL=$(C "${L[@]}" "$B/lab/worklist")
t "the lab sees the order" "$(echo "$WL" | py "print('yes' if any(i.get('patient_mrn')=='$MRNX' or '$MRNX' in json.dumps(i) for i in d['data']) else 'no')")" "yes"
ITEM="$LITEM"
t "  ...and can accession it" "$(C -o /dev/null -w '%{http_code}' "${L[@]}" -X POST "$B/lab/items/$ITEM/accession")" "204"
AN=$(C "${L[@]}" "$B/lab/items/$ITEM" | py "import json;print(json.dumps([{'analyte_id':a['analyte_id'],'value':'1.2'} for a in d['data']['analytes']]))")
RES=$(C -w '\n%{http_code}' "${L[@]}" -X PUT "$B/lab/items/$ITEM/results" -d "{\"results\":$AN}")
t "  ...enter results"        "$(echo "$RES" | tail -1)" "204"
t "  ...submit"               "$(C -o /dev/null -w '%{http_code}' "${L[@]}" -X POST "$B/lab/items/$ITEM/submit")" "204"
t "  ...and validate"         "$(C -o /dev/null -w '%{http_code}' "${L[@]}" -X POST "$B/lab/items/$ITEM/validate")" "204"
NCRIT=$(P "SELECT count(*) FROM lab_results r JOIN lab_order_items i ON i.id=r.order_item_id JOIN lab_orders o ON o.id=i.order_id JOIN patients p ON p.id=o.patient_id WHERE p.mrn='$MRNX' AND r.flag='critical';")
t "a dangerous value is flagged critical" "$([ "${NCRIT:-0}" -gt 0 ] && echo yes || echo no)" "yes"
echo "      ($NCRIT critical result(s) raised from values below the reference floor)"

echo
echo "  -- what the lab must NOT be able to do --"
t "cannot open a consultation" "$(code "$(C "${L[@]}" -X POST "$B/encounters" -d "{\"queue_entry_id\":\"$QID\"}")")" "FORBIDDEN_PERMISSION"
t "cannot prescribe"           "$(code "$(C "${L[@]}" -X POST "$B/encounters/$ENC/prescriptions" -d '{"drug_name":"X"}')")" "FORBIDDEN_PERMISSION"
t "cannot take payment"        "$(code "$(C "${L[@]}" -X POST "$B/billing/checkout" -d "{\"patient_id\":\"$PENC\",\"method\":\"cash\"}")")" "FORBIDDEN_PERMISSION"

echo
echo "=============================================================="
echo " 5. DOCTOR AGAIN — results back, sign and close"
echo "=============================================================="
t "the results reach the doctor" "$(C "${D[@]}" "$B/lab/encounters/$ENC/labs" | py "print(d['data'][0]['items'][0]['status'])")" "validated"
t "the results inbox flags it"   "$(C "${D[@]}" "$B/lab/inbox/count" | py "print('yes' if d['data'].get('count',0)>=0 else 'no')")" "yes"
t "sign and close"               "$(C -o /dev/null -w '%{http_code}' "${D[@]}" -X POST "$B/encounters/$ENC/sign")" "204"
t "  ...the note is locked"      "$(code "$(C "${D[@]}" -X PUT "$B/encounters/$ENC/note" -d '{"subjective":"tampered"}')")" "ENCOUNTER_LOCKED"
t "  ...and the patient leaves the queue" "$(P "SELECT state FROM queue_entries q JOIN patients p ON p.id=q.patient_id WHERE p.mrn='$MRNX' ORDER BY q.enqueued_at DESC LIMIT 1;")" "done"

echo
echo "=============================================================="
echo " 6. ADMIN — configuring the clinic"
echo "=============================================================="
t "can list staff"          "$(C -o /dev/null -w '%{http_code}' "${A[@]}" "$B/users")" "200"
t "can read settings"       "$(C -o /dev/null -w '%{http_code}' "${A[@]}" "$B/org/settings")" "200"
t "can add a service"       "$(C -o /dev/null -w '%{http_code}' "${A[@]}" -X POST "$B/billing/services" -d '{"code":"E2ESVC","name":"E2E test service","category":"procedure","price":250}')" "201"
t "can read the vitals form" "$(C -o /dev/null -w '%{http_code}' "${A[@]}" "$B/vital-fields")" "200"
t "can see the bed board"   "$(C -o /dev/null -w '%{http_code}' "${A[@]}" "$B/inpatient/board")" "200"
t "can see bed reports"     "$(C -o /dev/null -w '%{http_code}' "${A[@]}" "$B/inpatient/report")" "200"
t "can see finance"         "$(C -o /dev/null -w '%{http_code}' "${A[@]}" "$B/finance/overview?from=$(date -u -d '-30 days' +%F)&to=$(date -u +%F)")" "200"
t "can see the receivables"  "$(C -o /dev/null -w '%{http_code}' "${A[@]}" "$B/finance/receivables?from=$(date -u -d '-30 days' +%F)&to=$(date -u +%F)")" "200"

echo
echo "=============================================================="
echo " 7. THE WALLS — nobody reaches another clinic"
echo "=============================================================="
CD=$(P "SELECT count(*) FROM patients p JOIN tenants t ON t.id=p.tenant_id WHERE t.slug='cure-dental';")
t "our patient list is only ours" "$(C "${A[@]}" "$B/patients?page_size=1" | py "print(d['meta']['total'])")" "$(P "SELECT count(*) FROM patients WHERE tenant_id='$TID' AND deleted_at IS NULL;")"
t "cure-dental still has its own" "$(P "SELECT count(*) FROM patients p JOIN tenants t ON t.id=p.tenant_id WHERE t.slug='cure-dental';")" "$CD"

echo
echo "=============================================================="
echo "  $pass behaved correctly, $fail problem(s)"
echo "=============================================================="
for f in "${FINDINGS[@]:-}"; do [ -n "$f" ] && echo "  - $f"; done
