#!/usr/bin/env bash
# Enkutatash: a clinic registers, learns something, spins once, and the draw can
# be checked afterwards by anyone who was in it.
set -u
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
ADM='promo-boss@clinicos.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }

CODE=$(P "SELECT code FROM campaigns WHERE code LIKE 'enkutatash-%';")
CID=$(P "SELECT id FROM campaigns WHERE code='$CODE';")
WAS=$(P "SELECT status FROM campaigns WHERE code='$CODE';")
drop(){
  X "DELETE FROM campaign_slots WHERE campaign_id='$CID';"
  X "DELETE FROM campaign_entries WHERE campaign_id='$CID';"
  X "UPDATE campaigns SET status='$WAS', seed=NULL, seed_hash=NULL, sealed_at=NULL, chances=20 WHERE id='$CID';"
  X "DELETE FROM platform_admins WHERE email='$ADM';"
}
trap drop EXIT
drop
X "INSERT INTO platform_admins (email, full_name, role, password_hash, status) VALUES ('$ADM','Promo Boss','admin','$HASH','active');"
TA=$(C -H "$CT" -X POST $B/platform/auth/login -d "{\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $TA")
PID=$(C "${A[@]}" $B/platform/campaigns | py "print(d['data'][0]['id'])")

echo "=== a draft campaign is not playable ==="
t "the page says draft"        "$(C $B/campaigns/$CODE | py "print(d['data']['status'])")" "draft"
t "registering is refused"     "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/enter -d '{"full_name":"A","phone":"0911000001","clinic_name":"B"}')" "400"
t "a wrong code is a 404"      "$(C -o /dev/null -w '%{http_code}' $B/campaigns/enkutatash-nope)" "404"

echo "=== sealing publishes a commitment and lays out the wheel ==="
t "open succeeds"              "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/campaigns/$PID/open)" "204"
t "20 positions exist"         "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID';")" "20"
t "exactly 3 hold a gift"      "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID' AND is_gift;")" "3"
t "every other one is an offer" "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID' AND NOT is_gift AND prize_id IS NULL;")" "0"
SEEDHASH=$(C $B/campaigns/$CODE | py "print(d['data']['seed_hash'])")
t "the hash is published"      "$([ ${#SEEDHASH} = 64 ] && echo yes || echo no)" "yes"
t "the seed is NOT published"  "$(C $B/campaigns/$CODE | py "print(d['data'].get('seed',''))")" ""

echo "=== the seed really produces the wheel that was laid out ==="
SEED=$(P "SELECT seed FROM campaigns WHERE id='$CID';")
t "the hash matches the seed" "$(printf '%s' "$SEED" | sha256sum | cut -d' ' -f1)" "$SEEDHASH"
CALC=$(python3 -c "
import hashlib
seed='$SEED'
r=sorted(range(20), key=lambda i: hashlib.sha256((seed+':'+str(i)).encode()).hexdigest())
print(','.join(str(x) for x in sorted(r[:3])))")
REAL=$(P "SELECT string_agg(idx::text, ',' ORDER BY idx) FROM campaign_slots WHERE campaign_id='$CID' AND is_gift;")
t "anyone can recompute the winners from the seed" "$CALC" "$REAL"

echo "=== a clinic registers, and cannot cheat the quiz ==="
TOK=$(C -H "$CT" -X POST $B/campaigns/$CODE/enter -d '{"full_name":"Dr Sara","phone":"0911223300","clinic_name":"Bole Dental"}' | py "print(d['data']['token'])")
t "a token comes back"          "$([ -n "$TOK" ] && echo yes || echo no)" "yes"
H=(-H "$CT" -H "X-Campaign-Token: $TOK")
t "the same number cannot enter twice" "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/enter -d '{"full_name":"Impostor","phone":"0911223300","clinic_name":"Other"}')" "409"
Q=$(C "${H[@]}" $B/campaigns/$CODE/questions)
t "7 questions are served"      "$(echo "$Q" | py "print(len(d['data']))")" "7"
t "the answers are NOT sent to the browser" "$(echo "$Q" | grep -c 'correct' | tr -d ' ')" "0"
t "no explanation leaks either" "$(echo "$Q" | grep -c 'explain' | tr -d ' ')" "0"
t "spinning before the quiz is refused" "$(C "${H[@]}" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/spin)" "400"

echo "=== a wrong answer teaches, and can be retried ==="
Q1=$(echo "$Q" | py "print(d['data'][0]['id'])")
WRONG=$(C "${H[@]}" -X POST $B/campaigns/$CODE/answer -d "{\"question\":\"$Q1\",\"choice\":1}")
t "it says wrong"               "$(echo "$WRONG" | py "print(d['data']['correct'])")" "False"
t "and explains why"            "$(echo "$WRONG" | py "print('yes' if len(d['data'].get('explain',''))>40 else 'no')")" "yes"
RIGHT=$(C "${H[@]}" -X POST $B/campaigns/$CODE/answer -d "{\"question\":\"$Q1\",\"choice\":0}")
t "the retry is accepted"       "$(echo "$RIGHT" | py "print(d['data']['correct'])")" "True"
t "and says what it teaches"    "$(echo "$RIGHT" | py "print('yes' if len(d['data'].get('teaches',''))>20 else 'no')")" "yes"
t "the quiz is not done yet"    "$(echo "$RIGHT" | py "print(d['data']['quiz_done'])")" "False"

# finish the rest, always picking the first choice (the seed data's correct one)
for i in 1 2 3 4 5 6; do
  QI=$(echo "$Q" | py "print(d['data'][$i]['id'])")
  LAST=$(C "${H[@]}" -X POST $B/campaigns/$CODE/answer -d "{\"question\":\"$QI\",\"choice\":0}")
done
t "finishing the last one completes it" "$(echo "$LAST" | py "print(d['data']['quiz_done'])")" "True"

echo "=== one spin, and only one ==="
S1=$(C "${H[@]}" -X POST $B/campaigns/$CODE/spin)
t "the spin returns a prize"    "$(echo "$S1" | py "print('yes' if d['data']['prize_label'] else 'no')")" "yes"
S2=$(C "${H[@]}" -X POST $B/campaigns/$CODE/spin)
t "spinning again gives the SAME answer" "$(echo "$S2" | py "print(d['data']['prize_label'],d['data']['slot_index'])")" "$(echo "$S1" | py "print(d['data']['prize_label'],d['data']['slot_index'])")"
t "only one position was taken" "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID' AND entry_id IS NOT NULL;")" "1"
t "they took position 0"        "$(echo "$S1" | py "print(d['data']['slot_index'])")" "0"
t "a stranger's token is refused" "$(C -H "$CT" -H "X-Campaign-Token: not-a-real-token" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/spin)" "401"

echo "=== everybody wins something, and exactly three win the gift ==="
# Paced: nineteen clinics is ~170 requests, and the public endpoints share the
# API's 20/sec per-IP limit. A real campaign is twenty clinics over nineteen days,
# not twenty in nineteen seconds — so the test waits rather than the limit moving.
for n in $(seq 1 19); do
  sleep 1
  TN=$(C -H "$CT" -X POST $B/campaigns/$CODE/enter -d "{\"full_name\":\"Clinic $n\",\"phone\":\"09112234$(printf '%02d' $n)\",\"clinic_name\":\"Clinic $n\"}" | py "print(d['data']['token'])")
  HN=(-H "$CT" -H "X-Campaign-Token: $TN")
  QN=$(C "${HN[@]}" $B/campaigns/$CODE/questions)
  for i in 0 1 2 3 4 5 6; do
    QI=$(echo "$QN" | py "print(d['data'][$i]['id'])")
    C "${HN[@]}" -X POST $B/campaigns/$CODE/answer -d "{\"question\":\"$QI\",\"choice\":0}" >/dev/null
  done
  C "${HN[@]}" -X POST $B/campaigns/$CODE/spin >/dev/null
done
t "all 20 chances are taken"    "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID' AND entry_id IS NOT NULL;")" "20"
t "exactly 3 clinics won the gift" "$(P "SELECT count(*) FROM campaign_entries WHERE campaign_id='$CID' AND won;")" "3"
t "nobody was left with nothing"   "$(P "SELECT count(*) FROM campaign_entries WHERE campaign_id='$CID' AND coalesce(prize_label,'')='';")" "0"
t "the winners sit on the sealed positions" "$(P "SELECT string_agg(slot_idx::text, ',' ORDER BY slot_idx) FROM campaign_entries WHERE campaign_id='$CID' AND won;")" "$CALC"

echo "=== a 21st clinic is kept, not lost ==="
T21=$(C -H "$CT" -X POST $B/campaigns/$CODE/enter -d '{"full_name":"Late Clinic","phone":"0911229999","clinic_name":"Late Dental"}' | py "print(d['data']['token'])")
H21=(-H "$CT" -H "X-Campaign-Token: $T21")
Q21=$(C "${H21[@]}" $B/campaigns/$CODE/questions)
for i in 0 1 2 3 4 5 6; do
  QI=$(echo "$Q21" | py "print(d['data'][$i]['id'])")
  C "${H21[@]}" -X POST $B/campaigns/$CODE/answer -d "{\"question\":\"$QI\",\"choice\":0}" >/dev/null
done
t "they are told the wheel is full, not turned away" "$(C "${H21[@]}" -X POST $B/campaigns/$CODE/spin | py "print(d['data']['waiting'])")" "True"
t "and they are still on the list" "$(P "SELECT count(*) FROM campaign_entries WHERE campaign_id='$CID' AND phone='0911229999';")" "1"
t "the console flags them as waiting" "$(C "${A[@]}" $B/platform/campaigns/$PID | py "print(d['data']['waiting'])")" "1"

echo "=== adding chances keeps the gifts already won, and gives the late clinic a turn ==="
C "${A[@]}" -X PUT $B/platform/campaigns/$PID -d '{"title":"መልካም አዲስ ዓመት","subtitle":"Three dental clinics start 2019 with the whole system installed, free.","chances":24,"gifts":3,"gift_label":"Complete dental clinic system — implemented free","gift_detail":"Installed at your clinic, your records brought across, your team trained. Yours to keep.","telegram":"clinicos","phone":"0911223344"}' >/dev/null
t "there are now 24 positions"  "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID';")" "24"
t "still exactly 3 gifts in all" "$(P "SELECT count(*) FROM campaign_slots WHERE campaign_id='$CID' AND is_gift;")" "3"
t "and the 3 winners keep theirs" "$(P "SELECT count(*) FROM campaign_entries WHERE campaign_id='$CID' AND won;")" "3"
t "the late clinic can now spin" "$(C "${H21[@]}" -X POST $B/campaigns/$CODE/spin | py "print(d['data']['waiting'])")" "False"
t "chances cannot be reduced"   "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X PUT $B/platform/campaigns/$PID -d '{"title":"x","chances":5,"gifts":3,"gift_label":"y"}')" "400"
# Save replaces every field, so anything the caller omits is cleared. The console
# always sends the whole form; this asserts the test above did not quietly wipe it.
t "the subtitle survived the edit" "$(C $B/campaigns/$CODE | py "print('yes' if d['data'].get('subtitle') else 'no')")" "yes"

echo "=== closing publishes the seed and keeps the promise of three ==="
t "close succeeds"              "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/campaigns/$PID/close)" "204"
t "the seed is now public"      "$(C $B/campaigns/$CODE | py "print(len(d['data'].get('seed','')))")" "64"
t "three clinics hold the gift" "$(P "SELECT count(*) FROM campaign_entries WHERE campaign_id='$CID' AND won;")" "3"
t "a closed campaign takes no more entries" "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/campaigns/$CODE/enter -d '{"full_name":"Z","phone":"0911220000","clinic_name":"Z"}')" "400"

echo; echo "  $pass passed, $fail failed"
[ "$fail" = 0 ]
