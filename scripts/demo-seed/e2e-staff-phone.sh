#!/usr/bin/env bash
# A staff record now holds a phone number. Written down when the account is
# created, correctable afterwards, stored in the one form the SMS gateway and the
# patient register already use — and never quietly lost by a client that only
# meant to fix a spelling.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
ADM='tel-admin@yclinic.test'; S1='tel-one@yclinic.test'; S2='tel-two@yclinic.test'; S3='tel-three@yclinic.test'; S4='tel-four@yclinic.test'
PADM='tel-boss@clinicos.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }

# y-clinic is left suspended between tests; put it back exactly as found.
WAS=$(P "SELECT status FROM tenants WHERE slug='y-clinic';")
# Cure Dental is a real customer. Take its baseline and assert it at the end.
CURE_BEFORE=$(P "SELECT count(*)||'/'||count(phone) FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.slug='cure-dental' AND u.deleted_at IS NULL;")
drop(){
  for e in "$ADM" "$S1" "$S2" "$S3" "$S4"; do
    X "DELETE FROM user_invitations i USING users u WHERE i.user_id=u.id AND u.email='$e';"
    X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$e';"
    X "DELETE FROM user_role_scopes r USING users u WHERE r.user_id=u.id AND u.email='$e';"
    X "DELETE FROM users WHERE email='$e';"
  done
  X "DELETE FROM platform_admins WHERE email='$PADM';"
  X "UPDATE tenants SET status='$WAS' WHERE slug='y-clinic';"
}
trap drop EXIT
drop
X "UPDATE tenants SET status='active' WHERE slug='y-clinic';"
A1=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$ADM','Phone Admin','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$A1',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
TA=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $TA")
tel(){ P "SELECT coalesce(phone,'<null>') FROM users WHERE email='$1';"; }

echo "=== the number is stored when the account is created ==="
I1=$(C "${A[@]}" -X POST $B/users -d "{\"email\":\"$S1\",\"full_name\":\"Tel One\",\"phone\":\"+251911223344\",\"roles\":[\"receptionist\"]}" | py "print(d['data']['id'])")
t "an invite with a phone is created"        "$([ -n "$I1" ] && echo yes || echo no)" "yes"
t "written the way patients.phone is"        "$(tel "$S1")" "0911223344"
t "and it comes back on the staff list"      "$(C "${A[@]}" $B/users | py "print([u['phone'] for u in d['data'] if u['email']=='$S1'][0])")" "0911223344"

echo "=== spaces, a missing trunk zero, a Safaricom number ==="
I2=$(C "${A[@]}" -X POST $B/users -d "{\"email\":\"$S2\",\"full_name\":\"Tel Two\",\"phone\":\"0922 33 44 55\",\"roles\":[\"nurse\"]}" | py "print(d['data']['id'])")
t "spacing is dropped"                       "$(tel "$S2")" "0922334455"
I3=$(C "${A[@]}" -X POST $B/users -d "{\"email\":\"$S3\",\"full_name\":\"Tel Three\",\"phone\":\"911998877\",\"roles\":[\"nurse\"]}" | py "print(d['data']['id'])")
t "a missing leading zero is added"          "$(tel "$S3")" "0911998877"
# 07… is a real mobile the gateway will not carry. The record is still correct, so
# it is stored; refusing it would be inventing a rule the clinic does not have.
I4=$(C "${A[@]}" -X POST $B/users -d "{\"email\":\"$S4\",\"full_name\":\"Tel Four\",\"phone\":\"0711223344\",\"roles\":[\"nurse\"]}" | py "print(d['data']['id'])")
t "a Safaricom number is kept, not refused"  "$(tel "$S4")" "0711223344"

echo "=== a number that cannot be dialled is refused, and nothing is created ==="
t "a stub is a 400"                          "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users -d "{\"email\":\"junk-$S1\",\"full_name\":\"Junk\",\"phone\":\"0565\",\"roles\":[\"nurse\"]}")" "400"
t "no half-made account is left behind"      "$(P "SELECT count(*) FROM users WHERE email='junk-$S1';")" "0"
t "letters are a 400 too"                    "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users -d "{\"email\":\"junk2-$S1\",\"full_name\":\"Junk\",\"phone\":\"call me\",\"roles\":[\"nurse\"]}")" "400"

echo "=== the field is optional: no number is not an error ==="
I5=$(C "${A[@]}" -X POST $B/users -d "{\"email\":\"none-$S1\",\"full_name\":\"No Phone\",\"roles\":[\"nurse\"]}" | py "print(d['data']['id'])")
t "an account with no phone is allowed"      "$([ -n "$I5" ] && echo yes || echo no)" "yes"
t "and it is stored as nothing, not ''"      "$(P "SELECT coalesce(phone,'<null>') FROM users WHERE email='none-$S1';")" "<null>"
t "the list reports it as an empty string"   "$(C "${A[@]}" $B/users | py "print(repr([u['phone'] for u in d['data'] if u['email']=='none-$S1'][0]))")" "''"
X "DELETE FROM user_role_scopes r USING users u WHERE r.user_id=u.id AND u.email='none-$S1';"
X "DELETE FROM user_invitations i USING users u WHERE i.user_id=u.id AND u.email='none-$S1';"
X "DELETE FROM users WHERE email='none-$S1';"

echo "=== correcting it later ==="
t "a new number replaces the old"            "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users/$I1/profile -d '{"full_name":"Tel One","phone":"251933445566"}')" "204"
t "and is normalised on the way in"          "$(tel "$S1")" "0933445566"
t "an unusable number is refused"            "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users/$I1/profile -d '{"full_name":"Tel One","phone":"12"}')" "400"
t "and the stored one is untouched"          "$(tel "$S1")" "0933445566"
t "sending an empty phone clears it"         "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users/$I1/profile -d '{"full_name":"Tel One","phone":""}')" "204"
t "the column goes back to nothing"          "$(tel "$S1")" "<null>"

echo "=== a client that only means to fix a name must not wipe the number ==="
C "${A[@]}" -X POST $B/users/$I1/profile -d '{"full_name":"Tel One","phone":"0911223344"}' >/dev/null
t "omitting the field keeps the number"      "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users/$I1/profile -d '{"full_name":"Tel Uno"}')" "204"
t "the number survived"                      "$(tel "$S1")" "0911223344"
t "the name did change"                      "$(P "SELECT full_name FROM users WHERE email='$S1';")" "Tel Uno"
# A console left open across the deploy still posts to /name. It must keep working
# and must not take the phone with it.
t "the old /name path still saves"           "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users/$I1/name -d '{"full_name":"Tel One"}')" "204"
t "and left the number alone"                "$(tel "$S1")" "0911223344"

echo "=== who may change it ==="
X "UPDATE users SET password_hash='$HASH', status='active' WHERE email='$S2';"
T2=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$S2\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
t "a nurse cannot edit a colleague's record" "$(C -H "$CT" -H "Authorization: Bearer $T2" -o /dev/null -w '%{http_code}' -X POST $B/users/$I1/profile -d '{"full_name":"Hijack","phone":"0900000000"}')" "403"
t "nor read the staff list"                  "$(C -H "$CT" -H "Authorization: Bearer $T2" -o /dev/null -w '%{http_code}' $B/users)" "403"
t "the record is as the admin left it"       "$(tel "$S1")" "0911223344"

echo "=== the vendor's roster shows who to call ==="
X "INSERT INTO platform_admins (email, full_name, role, password_hash, status) VALUES ('$PADM','E2E Phone Boss','admin','$HASH','active');"
TP=$(C -H "$CT" -X POST $B/platform/auth/login -d "{\"email\":\"$PADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
ROW=$(C -H "$CT" -H "Authorization: Bearer $TP" $B/platform/clinics | py "print([c.get('owner_email','') for c in d['data'] if c['slug']=='y-clinic'][0])")
t "the owner email is no longer blank"       "$([ -n "$ROW" ] && echo yes || echo no)" "yes"
t "it is the tenant_owner's own address"     "$ROW" "$(P "SELECT u.email FROM users u JOIN user_role_scopes s ON s.user_id=u.id JOIN roles r ON r.id=s.role_id AND r.code='tenant_owner' WHERE u.tenant_id='$TID' AND u.deleted_at IS NULL ORDER BY u.created_at LIMIT 1;")"

echo "=== the other clinics were not touched ==="
t "Cure Dental's users are as they were"     "$(P "SELECT count(*)||'/'||count(phone) FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.slug='cure-dental' AND u.deleted_at IS NULL;")" "$CURE_BEFORE"
t "no phone leaked across the tenant line"   "$(P "SELECT count(*) FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.slug<>'y-clinic' AND u.phone IN ('0911223344','0922334455','0911998877','0711223344');")" "0"

echo; echo "  $pass passed, $fail failed"
[ "$fail" = 0 ]
