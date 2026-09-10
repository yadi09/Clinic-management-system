#!/usr/bin/env bash
# The wide net: a clinic puts its hand up, and the vendor works the list.
# Runs against a campaign of its own — never the live Enkutatash one.
set -u
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
ADM='signup-boss@clinicos.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }

CODE="e2e-signup-$$"
CID=$(P "INSERT INTO campaigns (code, title, chances, gifts, gift_label, status)
         VALUES ('$CODE','E2E Signup',10,3,'E2E gift','open') RETURNING id;")
LIVE_BEFORE=$(P "SELECT status||'/'||chances FROM campaigns WHERE code LIKE 'enkutatash-%';")
drop(){
  X "DELETE FROM campaign_signups WHERE campaign_id='$CID';"
  X "DELETE FROM campaign_entries WHERE campaign_id='$CID';"
  X "DELETE FROM campaigns WHERE id='$CID';"
  X "DELETE FROM platform_admins WHERE email='$ADM';"
}
trap drop EXIT
X "INSERT INTO platform_admins (email, full_name, role, password_hash, status) VALUES ('$ADM','Signup Boss','admin','$HASH','active');"
TA=$(C -H "$CT" -X POST $B/platform/auth/login -d "{\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $TA")
PID=$(C "${A[@]}" $B/platform/campaigns | py "print([c['id'] for c in d['data'] if c['code']=='$CODE'][0])")

echo "=== a clinic puts its hand up ==="
BODY='{"owner_name":"Dr Selam Bekele","phone":"+251911772211","clinic_name":"Adey Dental","location":"Bole, Addis Ababa — near Edna Mall","structure":"Two dentists, one chair, paper cards.","facilities":["Reception desk","One chair","We send lab work out"]}'
t "the form is accepted"        "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/signup -d "$BODY")" "201"
t "the clinic is stored"        "$(P "SELECT clinic_name FROM campaign_signups WHERE campaign_id='$CID';")" "Adey Dental"
t "the owner's name is stored"  "$(P "SELECT owner_name FROM campaign_signups WHERE campaign_id='$CID';")" "Dr Selam Bekele"
t "the number is normalised"    "$(P "SELECT phone FROM campaign_signups WHERE campaign_id='$CID';")" "0911772211"
t "the location is stored"      "$(P "SELECT left(location,4) FROM campaign_signups WHERE campaign_id='$CID';")" "Bole"
t "the structure is stored"     "$(P "SELECT left(structure,12) FROM campaign_signups WHERE campaign_id='$CID';")" "Two dentists"
t "the tick-boxes are countable" "$(P "SELECT array_length(facilities,1) FROM campaign_signups WHERE campaign_id='$CID';")" "3"
t "it starts as new"            "$(P "SELECT status FROM campaign_signups WHERE campaign_id='$CID';")" "new"

echo "=== the form is forgiving where it should be, strict where it matters ==="
t "no name is refused"     "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/signup -d '{"owner_name":"","phone":"0911000001","clinic_name":"X","location":"Y"}')" "400"
t "no location is refused" "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/signup -d '{"owner_name":"A","phone":"0911000001","clinic_name":"X","location":""}')" "400"
t "a junk number is refused" "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/signup -d '{"owner_name":"A","phone":"0565","clinic_name":"X","location":"Y"}')" "400"
t "nothing was created by those" "$(P "SELECT count(*) FROM campaign_signups WHERE campaign_id='$CID';")" "1"
# Re-sending is a correction, not a duplicate.
C -H "$CT" -X POST $B/campaigns/$CODE/signup -d '{"owner_name":"Dr Selam Bekele","phone":"0911772211","clinic_name":"Adey Dental Clinic","location":"Bole, Addis Ababa","structure":"Corrected.","facilities":["Reception desk"]}' >/dev/null
t "sending it again corrects, not duplicates" "$(P "SELECT count(*) FROM campaign_signups WHERE campaign_id='$CID';")" "1"
t "and the correction took"     "$(P "SELECT clinic_name FROM campaign_signups WHERE campaign_id='$CID';")" "Adey Dental Clinic"
t "a bot's submission is dropped" "$([ "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/signup -d '{"owner_name":"Bot","phone":"0911999111","clinic_name":"Bot","location":"Bot","website":"http://spam"}')" = "201" ] && [ "$(P "SELECT count(*) FROM campaign_signups WHERE campaign_id='$CID';")" = "1" ] && echo yes || echo no)" "yes"

echo "=== signing up claims nothing on the wheel ==="
t "no entry was created"   "$(P "SELECT count(*) FROM campaign_entries WHERE campaign_id='$CID';")" "0"
t "no position was taken"  "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID' AND entry_id IS NOT NULL;")" "0"

echo "=== the vendor works the list ==="
LIST=$(C "${A[@]}" $B/platform/campaigns/$PID/signups)
t "the console lists the clinic" "$(echo "$LIST" | py "print(d['data'][0]['clinic_name'])")" "Adey Dental Clinic"
t "with the structure they wrote" "$(echo "$LIST" | py "print(d['data'][0]['structure'])")" "Corrected."
t "and knows they have not played" "$(echo "$LIST" | py "print(d['data'][0]['played'])")" "False"
SID=$(echo "$LIST" | py "print(d['data'][0]['id'])")
t "the status can be moved on"  "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/campaigns/$PID/signups/$SID -d '{"status":"contacted","note":"called, interested"}')" "204"
t "and it stuck"                "$(P "SELECT status FROM campaign_signups WHERE id=(SELECT id FROM campaign_signups WHERE campaign_id='$CID' LIMIT 1);")" "contacted"
t "a made-up status is refused" "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/campaigns/$PID/signups/$SID -d '{"status":"whatever"}')" "400"
t "the list needs an admin"     "$(C -o /dev/null -w '%{http_code}' $B/platform/campaigns/$PID/signups)" "401"

echo "=== the two lists join up when the clinic plays ==="
TOK=$(C -H "$CT" -X POST $B/campaigns/$CODE/enter -d '{"full_name":"Dr Selam Bekele","phone":"0911772211","clinic_name":"Adey Dental Clinic"}' | py "print(d['data']['token'])")
t "the same number can still play" "$([ -n "$TOK" ] && echo yes || echo no)" "yes"
t "the console now says they played" "$(C "${A[@]}" $B/platform/campaigns/$PID/signups | py "print(d['data'][0]['played'])")" "True"

echo "=== the live campaign was never touched ==="
t "Enkutatash is exactly as it was" "$(P "SELECT status||'/'||chances FROM campaigns WHERE code LIKE 'enkutatash-%';")" "$LIVE_BEFORE"

echo; echo "  $pass passed, $fail failed"
[ "$fail" = 0 ]
