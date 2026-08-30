#!/usr/bin/env bash
# Priority, the next step, and the worklist that reads them.
set -u
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
ADM='pri-boss@clinicos.test'; REP='pri-rep@clinicos.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
drop(){
  X "DELETE FROM crm_touches h USING crm_prospects p WHERE h.prospect_id=p.id AND p.clinic_name LIKE 'PRI %';"
  X "DELETE FROM crm_phase_events v USING crm_enrollments e, crm_prospects p WHERE v.enrollment_id=e.id AND e.prospect_id=p.id AND p.clinic_name LIKE 'PRI %';"
  X "DELETE FROM crm_enrollments e USING crm_prospects p WHERE e.prospect_id=p.id AND p.clinic_name LIKE 'PRI %';"
  X "DELETE FROM crm_prospects WHERE clinic_name LIKE 'PRI %';"
  X "DELETE FROM crm_phases ph USING crm_campaigns c WHERE ph.campaign_id=c.id AND c.name LIKE 'PRI %';"
  X "DELETE FROM crm_campaigns WHERE name LIKE 'PRI %';"
  X "DELETE FROM platform_admins WHERE email IN ('$ADM','$REP');"
}
trap drop EXIT
drop
X "INSERT INTO platform_admins (email, full_name, role, password_hash, status) VALUES ('$ADM','Pri Boss','admin','$HASH','active');"
TA=$(C -H "$CT" -X POST $B/platform/auth/login -d "{\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $TA")
C "${A[@]}" -X POST $B/platform/crm/reps -d "{\"email\":\"$REP\",\"full_name\":\"Pri Rep\",\"role\":\"marketer\",\"password\":\"BranchTest#2026\"}" >/dev/null
TR=$(C -H "$CT" -X POST $B/platform/auth/login -d "{\"email\":\"$REP\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
R=(-H "$CT" -H "Authorization: Bearer $TR")
CID=$(C "${A[@]}" -X POST $B/platform/crm/campaigns -d '{"name":"PRI camp","phases":[{"name":"P1"},{"name":"P2"}]}' | py "print(d['data']['id'])")
mk(){ C "${R[@]}" -X POST $B/platform/crm/prospects -d "{\"clinic_name\":\"$1\",\"phone\":\"$2\",\"priority\":\"$3\",\"campaign_id\":\"$CID\"}" | py "print(d['data']['id'])"; }

echo "=== priority is set when the clinic is added ==="
HOT=$(mk "PRI Hot Clinic" 0911000001 hot)
COLD=$(mk "PRI Cold Clinic" 0911000002 cold)
WARM=$(mk "PRI Warm Clinic" 0911000003 warm)
one(){ C "${R[@]}" "$B/platform/crm/prospects/$1" | py "p=d['data']['prospect']; print('%s|%s|%s|%s' % (p['priority'], p.get('next_action',''), p.get('next_action_at',''), p.get('silent_days')))"; }
t "hot is recorded"            "$(one $HOT  | cut -d'|' -f1)" "hot"
t "cold is recorded"           "$(one $COLD | cut -d'|' -f1)" "cold"
t "nobody has touched it yet"  "$(one $HOT  | cut -d'|' -f4)" "-1"

echo "=== the list can be asked the questions a rep asks ==="
n(){ C "${R[@]}" "$B/platform/crm/prospects?$1" | py "print(len([x for x in d['data'] if x['clinic_name'].startswith('PRI ')]))"; }
t "only the hot ones"        "$(n 'priority=hot')" "1"
t "never contacted"          "$(n 'flag=never')"   "3"
t "nothing is overdue yet"   "$(n 'flag=overdue')" "0"

echo "=== hot and untouched is on the day's list; cold is not ==="
w(){ C "${R[@]}" "$B/platform/crm/worklist" | py "
rows=[x for x in d['data'] if x['clinic_name'].startswith('PRI ')]
print(';'.join(sorted('%s=%s' % (x['clinic_name'].replace('PRI ',''), x.get('reason','')) for x in rows)))"; }
t "the hot untouched clinic is raised" "$(w)" "Hot Clinic=hot_untouched"

echo "=== a next step with a date puts it on the day ==="
YDAY=$(date -d '-1 day' +%F); TODAY=$(date +%F)
C "${R[@]}" -X POST $B/platform/crm/prospects/$COLD/next-action -d "{\"note\":\"ring the owner\",\"on\":\"$YDAY\"}" >/dev/null
C "${R[@]}" -X POST $B/platform/crm/prospects/$WARM/next-action -d "{\"note\":\"drop the leaflet\",\"on\":\"$TODAY\"}" >/dev/null
t "yesterday's step is late"     "$(C "${R[@]}" "$B/platform/crm/worklist" | py "print([x['reason'] for x in d['data'] if x['clinic_name']=='PRI Cold Clinic'][0])")" "overdue"
t "today's step is due"          "$(C "${R[@]}" "$B/platform/crm/worklist" | py "print([x['reason'] for x in d['data'] if x['clinic_name']=='PRI Warm Clinic'][0])")" "today"
t "and overdue is filterable"    "$(n 'flag=overdue')" "1"
t "a bad date is refused"        "$(C "${R[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/crm/prospects/$WARM/next-action -d '{"note":"x","on":"not-a-date"}')" "400"

echo "=== contacting a clinic takes it off the untouched list ==="
C "${R[@]}" -X POST $B/platform/crm/prospects/$HOT/touches -d '{"kind":"call","note":"spoke to the owner"}' >/dev/null
t "the hot clinic drops off" "$(C "${R[@]}" "$B/platform/crm/worklist" | py "print(len([x for x in d['data'] if x['clinic_name']=='PRI Hot Clinic']))")" "0"
t "and reads as contacted today" "$(one $HOT | cut -d'|' -f4)" "0"

echo "=== priority can be changed from the card ==="
C "${R[@]}" -X POST $B/platform/crm/prospects/$COLD/priority -d '{"priority":"hot"}' >/dev/null
t "it is hot now"          "$(one $COLD | cut -d'|' -f1)" "hot"
t "a bad priority refused" "$(C "${R[@]}" -o /dev/null -w '%{http_code}' -X POST $B/platform/crm/prospects/$COLD/priority -d '{"priority":"lukewarm"}')" "400"

echo "=== the hottest, longest-ignored clinic leads the list ==="
t "hot first by default" "$(C "${R[@]}" "$B/platform/crm/prospects?q=PRI" | py "print(d['data'][0]['priority'])")" "hot"

echo; echo "$pass passed, $fail failed"
