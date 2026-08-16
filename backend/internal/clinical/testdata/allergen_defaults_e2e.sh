#!/usr/bin/env bash
# The allergen library remembers what a substance does — y-clinic TEST tenant.
#
# The loop: describe an allergen once (reaction + severity), and every patient it is
# later recorded against inherits the description instead of someone retyping it.
set -u
H='Host: app.clinicos.cc'; B=https://localhost:8443/api/v1; J='Content-Type: application/json'
TEN=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; PASS=$((PASS+1));
      else echo "  FAIL $1: want $3 got $2"; FAIL=$((FAIL+1)); fi; }
jqf(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

T=$(curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"alg.doc@yclinic.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]')
[ -n "$T" ] || { echo "cannot log in"; exit 1; }
A=(-H "$H" -H "$J" -H "Authorization: Bearer $T")
PID=$(curl -sk "${A[@]}" "$B/patients?q=AlgProbe" | jqf 'd["data"][0]["id"]')

echo "== 1. describe an allergen once =="
NEW=$(curl -sk -X POST "${A[@]}" "$B/allergens" \
  -d '{"name":"ZZTest Latex","default_reaction":"Contact dermatitis","default_severity":"moderate"}')
AID=$(echo "$NEW" | jqf 'd["data"]["id"]')
ok "created"           "$(echo "$NEW" | jqf 'd["data"]["name"]')" "ZZTest Latex"
ok "reaction kept"     "$(echo "$NEW" | jqf 'd["data"]["default_reaction"]')" "Contact dermatitis"
ok "severity kept"     "$(echo "$NEW" | jqf 'd["data"]["default_severity"]')" "moderate"

echo "== 2. the list carries them, so the form can pre-fill =="
LIST=$(curl -sk "${A[@]}" "$B/allergens?search=zztest")
ok "reaction listed"   "$(echo "$LIST" | jqf 'd["data"][0]["default_reaction"]')" "Contact dermatitis"
ok "severity listed"   "$(echo "$LIST" | jqf 'd["data"][0]["default_severity"]')" "moderate"

echo "== 3. an allergen with no description is still fine =="
BARE=$(curl -sk -X POST "${A[@]}" "$B/allergens" -d '{"name":"ZZTest Iodine"}')
ok "created bare"      "$(echo "$BARE" | jqf 'd["data"]["name"]')" "ZZTest Iodine"
ok "no reaction"       "$(echo "$BARE" | jqf 'd["data"].get("default_reaction","")')" ""

echo "== 4. severity is held to the three the patient record uses =="
ok "nonsense refused"  "$(curl -sk -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "$B/allergens" \
  -d '{"name":"ZZTest Bad","default_severity":"catastrophic"}')" "400"

echo "== 5. editing the library updates the default =="
ok "updated"           "$(curl -sk -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "$B/allergens/$AID" \
  -d '{"name":"ZZTest Latex","default_reaction":"Contact dermatitis and hives","default_severity":"severe"}')" "204"
ok "reads back"        "$(curl -sk "${A[@]}" "$B/allergens?search=zztest%20latex" | jqf 'd["data"][0]["default_severity"]')" "severe"

echo "== 6. recording it on a patient still stores the patient's own answer =="
curl -sk -o /dev/null -X POST "${A[@]}" "$B/patients/$PID/allergies" \
  -d '{"substance":"ZZTest Latex","reaction":"Only mild itching for this patient","severity":"mild"}'
ok "patient's reaction" "$($PSQL -c "SELECT reaction FROM allergies WHERE substance='ZZTest Latex' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;")" \
  "Only mild itching for this patient"
ok "patient's severity" "$($PSQL -c "SELECT severity FROM allergies WHERE substance='ZZTest Latex' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;")" "mild"
ok "library unchanged"  "$(curl -sk "${A[@]}" "$B/allergens?search=zztest%20latex" | jqf 'd["data"][0]["default_severity"]')" "severe"

echo "== 7. the drug library still tags with these allergens =="
DRUG=$(curl -sk -X POST "${A[@]}" "$B/drugs" -d "{\"name\":\"ZZTest Gloves\",\"allergen_ids\":[\"$AID\"]}")
ok "tagged" "$(curl -sk "${A[@]}" "$B/drugs?search=zztest%20gloves" | jqf '",".join(d["data"][0]["allergens"])')" "ZZTest Latex"

echo; echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
