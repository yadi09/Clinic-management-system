#!/usr/bin/env bash
# The pipeline end to end: an admin designs a campaign, a rep collects a clinic,
# walks it through the phases, and records what happened. Cleans up after itself.
set -u
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
ADM='crm-boss@clinicos.test'; REP='crm-rep@clinicos.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
drop(){
  X "DELETE FROM crm_touches h USING crm_prospects p WHERE h.prospect_id=p.id AND p.clinic_name LIKE 'E2E %';"
  X "DELETE FROM crm_phase_events v USING crm_enrollments e, crm_prospects p WHERE v.enrollment_id=e.id AND e.prospect_id=p.id AND p.clinic_name LIKE 'E2E %';"
  X "DELETE FROM crm_enrollments e USING crm_prospects p WHERE e.prospect_id=p.id AND p.clinic_name LIKE 'E2E %';"
  X "DELETE FROM crm_prospects WHERE clinic_name LIKE 'E2E %';"
  X "DELETE FROM crm_phases ph USING crm_campaigns c WHERE ph.campaign_id=c.id AND c.name LIKE 'E2E %';"
  X "DELETE FROM crm_campaigns WHERE name LIKE 'E2E %';"
  X "DELETE FROM platform_admins WHERE email IN ('$ADM','$REP');"
}
trap drop EXIT
drop
X "INSERT INTO platform_admins (email, full_name, role, password_hash, status) VALUES ('$ADM','E2E Boss','admin','$HASH','active');"
TA=$(C -H "$CT" -X POST $B/platform/auth/login -d "{\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $TA")

echo "=== the admin designs a campaign ==="
CID=$(C "${A[@]}" -X POST $B/platform/crm/campaigns -d '{"name":"E2E Addis dental","goal":"win 20 clinics","phases":[
 {"name":"First visit","intent":"walk in, get the manager name"},
 {"name":"Demo","intent":"show the chairside flow"},
 {"name":"Decision","intent":"ask for the yes"}]}' | py "print(d['data']['id'])")
t "the campaign has three phases" "$(C "${A[@]}" $B/platform/crm/campaigns | py "
c=[x for x in d['data'] if x['name']=='E2E Addis dental'][0]; print(len(c['phases']))")" "3"

echo "=== the admin creates a marketing account ==="
C "${A[@]}" -X POST $B/platform/crm/reps -d "{\"email\":\"$REP\",\"full_name\":\"E2E Rep\",\"role\":\"marketer\",\"password\":\"BranchTest#2026\"}" >/dev/null
TR=$(C -H "$CT" -X POST $B/platform/auth/login -d "{\"email\":\"$REP\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
R=(-H "$CT" -H "Authorization: Bearer $TR")
t "the rep can read the pipeline"          "$(C "${R[@]}" -o /dev/null -w '%{http_code}' $B/platform/crm/campaigns)" "200"
t "but cannot design a campaign"           "$(C "${R[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/crm/campaigns -d '{"name":"x","phases":[{"name":"y"}]}')" "403"
t "and cannot reach the tenant controls"   "$(C "${R[@]}" -o /dev/null -w '%{http_code}' $B/platform/clinics)" "403"
t "nor create another account"             "$(C "${R[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/crm/reps -d '{"email":"a@b.c","full_name":"x","password":"0123456789"}')" "403"

echo "=== the rep collects a clinic in the field ==="
PID=$(C "${R[@]}" -X POST $B/platform/crm/prospects -d "{\"clinic_name\":\"E2E Bethel Dental\",\"contact_name\":\"Sr. Almaz\",\"contact_role\":\"Owner\",\"phone\":\"0911234567\",\"address\":\"Bole, Addis Ababa\",\"map_url\":\"https://maps.google.com/?q=9.01,38.76\",\"campaign_id\":\"$CID\"}" | py "print(d['data']['id'])")
G(){ C "${R[@]}" "$B/platform/crm/prospects/$PID" | py "p=d['data']['prospect']; print('%s|%s|%s|%s|%s' % (p['status'], p.get('phase_name',''), p.get('phase_seq',0), p.get('owner_name',''), p.get('touches',0)))"; }
IFS='|' read -r st ph sq ow tc <<<"$(G)"
t "it starts on phase one"        "$ph" "First visit"
t "owned by whoever collected it" "$ow" "E2E Rep"
t "and it is open"                "$st" "open"

echo "=== a second rep would be warned before collecting it again ==="
t "the same number is flagged" "$(C "${R[@]}" "$B/platform/crm/prospects/duplicates?name=Bethel&phone=0911-234-567" | py "print(d['data'][0]['why'])")" "same phone number"

echo "=== the rep calls, then moves it forward ==="
C "${R[@]}" -X POST $B/platform/crm/prospects/$PID/touches -d '{"kind":"call","note":"spoke to Almaz, wants a demo"}' >/dev/null
C "${R[@]}" -X POST $B/platform/crm/prospects/$PID/complete-phase -d '{"note":"met the owner"}' >/dev/null
IFS='|' read -r st ph sq ow tc <<<"$(G)"
t "the call is on the record"  "$tc" "1"
t "and it moved to phase two"  "$ph" "Demo"

echo "=== the board shows it standing on Demo ==="
t "one clinic waiting on Demo" "$(C "${R[@]}" "$B/platform/crm/campaigns/$CID/board" | py "
col=[c for c in d['data']['columns'] if c['phase']['name']=='Demo'][0]; print(len(col['prospects']))")" "1"

echo "=== through the last phase, then the outcome ==="
C "${R[@]}" -X POST $B/platform/crm/prospects/$PID/complete-phase -d '{}' >/dev/null
C "${R[@]}" -X POST $B/platform/crm/prospects/$PID/complete-phase -d '{}' >/dev/null
t "the campaign is finished, nobody guessed the outcome" "$(G | cut -d'|' -f1)" "open"
t "and the steps are all recorded" "$(C "${R[@]}" "$B/platform/crm/prospects/$PID" | py "print(len(d['data']['steps']))")" "3"

echo "=== 'not yet' needs a date, or it is just a no ==="
t "no date is refused" "$(C "${R[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/crm/prospects/$PID/outcome -d '{"status":"not_yet"}')" "400"
C "${R[@]}" -X POST $B/platform/crm/prospects/$PID/outcome -d '{"status":"not_yet","ready_on":"2026-11-15","note":"after the rains"}' >/dev/null
t "with a date it sticks"     "$(G | cut -d'|' -f1)" "not_yet"
t "and the come-back date is kept" "$(P "SELECT to_char(ready_on,'YYYY-MM-DD') FROM crm_prospects WHERE clinic_name='E2E Bethel Dental';")" "2026-11-15"

echo "=== the tenant connection cannot read any of it ==="
t "clinic_app is refused the pipeline" "$(docker exec clinicos-postgres-1 psql -U clinic_app -d clinic -At -c 'SELECT count(*) FROM crm_prospects;' 2>&1 | grep -c 'permission denied')" "1"

echo; echo "$pass passed, $fail failed"
