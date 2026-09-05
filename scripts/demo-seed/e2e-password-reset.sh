#!/usr/bin/env bash
# A forgotten password: the admin issues a link, the staff member sets a new one,
# and nothing about it lets anybody past a second factor.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
ADM='rst-admin@yclinic.test'; STF='rst-staff@yclinic.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }
WAS=$(P "SELECT status FROM tenants WHERE slug='y-clinic';")
drop(){
  for e in "$ADM" "$STF"; do
    X "DELETE FROM user_invitations i USING users u WHERE i.user_id=u.id AND u.email='$e';"
    X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$e';"
    X "DELETE FROM user_role_scopes r USING users u WHERE r.user_id=u.id AND u.email='$e';"
    X "DELETE FROM users WHERE email='$e';"
  done
  X "UPDATE tenants SET status='$WAS' WHERE slug='y-clinic';"
}
trap drop EXIT
drop
X "UPDATE tenants SET status='active' WHERE slug='y-clinic';"
A1=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$ADM','Reset Admin','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$A1',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"
TA=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
A=(-H "$CT" -H "Authorization: Bearer $TA")

echo "=== the admin invites somebody, who sets a password ==="
SID=$(C "${A[@]}" -X POST $B/users -d "{\"email\":\"$STF\",\"full_name\":\"Forgetful Staff\",\"roles\":[\"receptionist\"]}" | py "print(d['data']['id'])")
LINK=$(C "${A[@]}" -X POST $B/users/$SID/reset-link | py "print(d['data']['invite_link'])")
TOK=$(echo "$LINK" | sed 's/.*token=//')
t "a reset link is issued" "$([ -n "$TOK" ] && echo yes || echo no)" "yes"

echo "=== accepting a reset sets the password and does NOT sign them in ==="
RESP=$(C -H "$CT" -X POST $B/auth/accept-invite -d "{\"token\":\"$TOK\",\"password\":\"BrandNew#2026\"}")
t "no access token is handed back" "$(echo "$RESP" | py "print('yes' if d['data'].get('access_token') else 'no')")" "no"
t "it says to sign in"             "$(echo "$RESP" | py "print(d['data'].get('sign_in_required'))")" "True"
t "the new password works"         "$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$STF\",\"password\":\"BrandNew#2026\"}" | py "print('yes' if d['data'].get('access_token') else 'no')")" "yes"

echo "=== the link is single use, and a new one retires the old ==="
t "the used link is refused" "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/auth/accept-invite -d "{\"token\":\"$TOK\",\"password\":\"Another#2026\"}")" "409"
L1=$(C "${A[@]}" -X POST $B/users/$SID/reset-link | py "print(d['data']['invite_link'])" | sed 's/.*token=//')
L2=$(C "${A[@]}" -X POST $B/users/$SID/reset-link | py "print(d['data']['invite_link'])" | sed 's/.*token=//')
t "the first of the two no longer works" "$(C -H "$CT" -o /dev/null -w '%{http_code}' -X POST $B/auth/accept-invite -d "{\"token\":\"$L1\",\"password\":\"Nope#2026\"}")" "401"
t "the newest one does"                  "$(C -H "$CT" -X POST $B/auth/accept-invite -d "{\"token\":\"$L2\",\"password\":\"Latest#2026\"}" | py "print(d['data'].get('sign_in_required'))")" "True"

echo "=== a reset signs every device out ==="
T1=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$STF\",\"password\":\"Latest#2026\"}" | py "print(d['data']['access_token'])")
t "they are signed in"        "$(C -H "$CT" -H "Authorization: Bearer $T1" -o /dev/null -w '%{http_code}' $B/auth/me)" "200"
L3=$(C "${A[@]}" -X POST $B/users/$SID/reset-link | py "print(d['data']['invite_link'])" | sed 's/.*token=//')
C -H "$CT" -X POST $B/auth/accept-invite -d "{\"token\":\"$L3\",\"password\":\"Final#2026\"}" >/dev/null
t "every session was revoked" "$(P "SELECT count(*) FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email='$STF' AND s.revoked_at IS NULL;")" "0"

echo "=== a suspended account is refused, not quietly reactivated ==="
C "${A[@]}" -X POST $B/users/$SID/status -d '{"status":"suspended"}' >/dev/null
t "refused for a suspended account" "$(C "${A[@]}" -o /dev/null -w '%{http_code}' -X POST $B/users/$SID/reset-link)" "400"
t "and they are still suspended"    "$(P "SELECT status FROM users WHERE email='$STF';")" "suspended"

echo "=== only somebody who may create staff may reset one ==="
X "DELETE FROM user_role_scopes r USING users u WHERE r.user_id=u.id AND u.email='$ADM';"
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$A1',id FROM roles WHERE tenant_id='$TID' AND code='doctor';"
TD=$(C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])")
t "a doctor cannot issue one" "$(C -H "$CT" -H "Authorization: Bearer $TD" -o /dev/null -w '%{http_code}' -X POST $B/users/$SID/reset-link)" "403"

echo; echo "$pass passed, $fail failed"
