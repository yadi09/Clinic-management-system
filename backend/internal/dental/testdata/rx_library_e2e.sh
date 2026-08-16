#!/usr/bin/env bash
# The dental prescription against the clinic's drug library — y-clinic TEST tenant.
#
# The point of the suite is the allergy guard: a dentist writing amoxicillin for a
# penicillin-allergic patient must be stopped and made to say why, exactly as the
# doctor down the corridor is, and the reason must end up on the item.
set -u
H='Host: app.clinicos.cc'; B=https://localhost:8443/api/v1; J='Content-Type: application/json'
TEN=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; PASS=$((PASS+1));
      else echo "  FAIL $1: want $3 got $2"; FAIL=$((FAIL+1)); fi; }
jqf(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

T=$(curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"rx.doc@yclinic.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]')
[ -n "$T" ] || { echo "cannot log in"; exit 1; }
A=(-H "$H" -H "$J" -H "Authorization: Bearer $T")
PID=$(curl -sk "${A[@]}" "$B/patients?q=RxProbe" | jqf 'd["data"][0]["id"]')
SID=$(curl -sk "${A[@]}" "$B/dental/patients/$PID/summary" | jqf 'd["data"]["plans"][0]["sessions"][0]["id"]')

echo "== 1. the library remembers a drug's sig =="
# The allergen may already be in the clinic's library from a previous run or from
# real use; reuse it rather than treating "already exists" as a failure.
ALG=$(curl -sk -X POST "${A[@]}" "$B/allergens" -d '{"name":"Penicillin"}' | jqf 'd["data"]["id"]')
if [ -z "$ALG" ]; then
  ALG=$(curl -sk "${A[@]}" "$B/allergens?search=Penicillin" \
    | jqf '[a["id"] for a in d["data"] if a["name"].lower()=="penicillin"][0]')
fi
[ -n "$ALG" ] || { echo "  cannot resolve the Penicillin allergen"; exit 1; }
DRUG=$(curl -sk -X POST "${A[@]}" "$B/drugs" -d "{\"name\":\"ZZTest Amoxicillin 500mg\",\"default_dose\":\"1 cap\",\"default_frequency\":\"three times a day\",\"default_duration\":\"5 days\",\"default_instructions\":\"Complete the full course\",\"allergen_ids\":[\"$ALG\"]}")
DID=$(echo "$DRUG" | jqf 'd["data"]["id"]')
ok "drug saved"        "$(echo "$DRUG" | jqf 'd["data"]["name"]')" "ZZTest Amoxicillin 500mg"
ok "defaults kept"     "$(echo "$DRUG" | jqf 'd["data"]["default_frequency"]')" "three times a day"
# Read the tag back from the library rather than from the create response, which
# does not echo it.
ok "allergen tagged"   "$(curl -sk "${A[@]}" "$B/drugs?search=zztest" | jqf '",".join(d["data"][0]["allergens"])')" "Penicillin"
ok "search finds it"   "$(curl -sk "${A[@]}" "$B/drugs?search=zztest" | jqf 'd["data"][0]["default_dose"]')" "1 cap"

echo "== 2. no allergy recorded → prescribes cleanly =="
ok "accepted" "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$SID/prescriptions" \
  -d "{\"items\":[{\"drug_name\":\"ZZTest Amoxicillin 500mg\",\"dose\":\"1 cap\",\"drug_id\":\"$DID\"}]}")" "201"

echo "== 3. record the allergy → the same drug is now stopped =="
curl -sk -o /dev/null -X POST "${A[@]}" "$B/patients/$PID/allergies" -d '{"substance":"Penicillin","severity":"severe"}'
RESP=$(curl -sk -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$SID/prescriptions" \
  -d "{\"items\":[{\"drug_name\":\"ZZTest Amoxicillin 500mg\",\"drug_id\":\"$DID\"}]}")
ok "blocked"        "$(echo "$RESP" | jqf 'd["error"]["code"]')" "ALLERGY_CONFLICT"
ok "names it"       "$(echo "$RESP" | jqf '"Penicillin" in d["error"]["message"]')" "True"

echo "== 4. free-typed drug is checked too (name match, no library id) =="
ok "blocked by name" "$(curl -sk -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$SID/prescriptions" \
  -d '{"items":[{"drug_name":"Penicillin V"}]}' | jqf 'd["error"]["code"]')" "ALLERGY_CONFLICT"

echo "== 5. an unrelated drug still goes through =="
ok "accepted" "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$SID/prescriptions" \
  -d '{"items":[{"drug_name":"Paracetamol 500mg","dose":"2 tab"}]}')" "201"

echo "== 6. override: allowed, and the reason is kept on the item =="
ok "accepted with reason" "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$B/dental/patients/$PID/sessions/$SID/prescriptions" \
  -d "{\"items\":[{\"drug_name\":\"ZZTest Amoxicillin 500mg\",\"drug_id\":\"$DID\"}],\"override_reason\":\"Mild childhood rash only; patient consented\"}")" "201"
ok "reason stored" "$($PSQL -c "SELECT allergy_override FROM dental_prescription_items WHERE tenant_id='$TEN' AND allergy_override IS NOT NULL ORDER BY id DESC LIMIT 1;")" \
  "Mild childhood rash only; patient consented"
# $DID is a prefixed opaque id; the column is a UUID. Count the links instead of
# trying to compare the two.
# Two: the clean one in §2 and the overridden one in §6. The blocked attempt in §3
# created no row at all, which is the point of blocking it.
ok "drug linked"   "$($PSQL -c "SELECT count(*) FROM dental_prescription_items WHERE tenant_id='$TEN' AND drug_id IS NOT NULL;")" "2"

echo "== 7. it reads back with the warning attached =="
SUM=$(curl -sk "${A[@]}" "$B/dental/patients/$PID/summary")
ok "override on read" "$(echo "$SUM" | jqf '"yes" if any(i.get("allergy_override") for p in d["data"]["plans"] for s in p["sessions"] for rx in s["prescriptions"] for i in rx["items"]) else "no"')" "yes"
ok "allergens on read" "$(echo "$SUM" | jqf '"yes" if any(i.get("allergens") for p in d["data"]["plans"] for s in p["sessions"] for rx in s["prescriptions"] for i in rx["items"]) else "no"')" "yes"

echo; echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
