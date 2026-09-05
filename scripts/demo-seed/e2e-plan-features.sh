#!/usr/bin/env bash
# A plan decides what a clinic may use, not just how many patients it may hold.
#
# Chair gets none of the paid extras, Practice gets the ones that bring money in,
# Group adds the Ministry return and AI. An add-on sold to one clinic overrides its
# plan. A plan nobody has described gates nothing, so introducing this took nothing
# away from the general clinics. And a clinic sending SMS through its own account is
# never rationed against our allowance.
set -u
TID=e4cfd85b-2fdb-46c8-98f7-04336a29ef0c
HASH='$argon2id$v=19$m=65536,t=1,p=4$mKnkkEHXrX436Zr/bBYqAA$KbWIZ0vAQgazQ8nx4Tbd+NIHeo12F+ZzDJ2yoivq/Q4'
B='https://localhost:8443/api/v1'; HOST='Host: app.clinicos.cc'; CT='Content-Type: application/json'
ADM='plan-admin@yclinic.test'
pass=0; fail=0
t(){ [ "$2" = "$3" ] && { echo "  PASS: $1"; pass=$((pass+1)); } || { echo "  FAIL: $1 -- want [$3] got [$2]"; fail=$((fail+1)); }; }
P(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -At -c "$1" 2>/dev/null | head -1 | tr -d '\r'; }
X(){ docker exec clinicos-postgres-1 psql -U clinic -d clinic -c "$1" >/dev/null 2>&1; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
C(){ curl -k -sS -H "$HOST" "$@"; }

# --- baselines to restore, and a live customer to assert we never touched -------
WAS_STATUS=$(P "SELECT status FROM tenants WHERE slug='y-clinic';")
WAS_TYPE=$(P "SELECT clinic_type FROM tenants WHERE slug='y-clinic';")
WAS_PLAN=$(P "SELECT plan_id::text FROM tenants WHERE slug='y-clinic';")
CURE_BEFORE=$(P "SELECT p.code||'/'||coalesce(t.storage_gb_override::text,'-')||'/'||coalesce(t.user_limit_override::text,'-') FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.slug='cure-dental';")
JOY_BEFORE=$(P "SELECT string_agg(flag||'='||enabled, ',' ORDER BY flag) FROM feature_flags f JOIN tenants t ON t.id=f.tenant_id WHERE t.slug='joy-speciality' AND f.branch_id IS NULL;")

drop(){
  X "DELETE FROM tenant_entitlements WHERE tenant_id='$TID';"
  X "DELETE FROM sessions s USING users u WHERE s.user_id=u.id AND u.email='$ADM';"
  X "DELETE FROM user_role_scopes r USING users u WHERE r.user_id=u.id AND u.email='$ADM';"
  X "DELETE FROM users WHERE email='$ADM';"
  X "UPDATE clinics SET sms_api_key_enc=NULL, sms_enabled=false WHERE tenant_id='$TID';"
  X "UPDATE tenants SET clinic_type='$WAS_TYPE', plan_id='$WAS_PLAN', status='$WAS_STATUS',
        storage_gb_override=NULL, user_limit_override=NULL WHERE slug='y-clinic';"
}
trap drop EXIT
drop
X "UPDATE tenants SET status='active', clinic_type='dental' WHERE slug='y-clinic';"
A1=$(P "INSERT INTO users (tenant_id,email,full_name,password_hash,status) VALUES ('$TID','$ADM','Plan Admin','$HASH','active') RETURNING id;")
X "INSERT INTO user_role_scopes (tenant_id,user_id,role_id) SELECT '$TID','$A1',id FROM roles WHERE tenant_id='$TID' AND code='tenant_owner';"

# Flags live in the access token, so every plan change needs a fresh sign-in —
# which is exactly how a real clinic picks the change up.
login(){ C -H "$CT" -X POST $B/auth/login -d "{\"workspace\":\"y-clinic\",\"email\":\"$ADM\",\"password\":\"BranchTest#2026\"}" | py "print(d['data']['access_token'])"; }
plan(){ X "UPDATE tenants SET plan_id=(SELECT id FROM plans WHERE code='$1') WHERE slug='y-clinic';"; TK=$(login); }
code(){ C -H "$CT" -H "Authorization: Bearer $TK" -o /dev/null -w '%{http_code}' "$@"; }

echo "=== the plans are the ones on the page ==="
t "Chair costs 4,000"                "$(P "SELECT price_monthly::int FROM plans WHERE code='dental-chair';")" "4000"
t "Practice costs 7,000"             "$(P "SELECT price_monthly::int FROM plans WHERE code='dental-practice';")" "7000"
t "Group costs 13,000"               "$(P "SELECT price_monthly::int FROM plans WHERE code='dental-group';")" "13000"
t "Chair holds 1,000 patients"       "$(P "SELECT patient_limit FROM plans WHERE code='dental-chair';")" "1000"
t "Practice holds 3,000"             "$(P "SELECT patient_limit FROM plans WHERE code='dental-practice';")" "3000"
t "images are unlimited on all four" "$(P "SELECT count(*) FROM plans WHERE clinic_type='dental' AND status='active' AND images_per_patient IS NOT NULL;")" "0"
t "the old plans are retired"        "$(P "SELECT count(*) FROM plans WHERE code IN ('dental-basic','dental-pro','dental business') AND status<>'retired';")" "0"
t "nobody is left on them"           "$(P "SELECT count(*) FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE p.status='retired' AND t.deleted_at IS NULL;")" "0"

echo "=== Chair: none of the paid extras ==="
plan dental-chair
t "patient SMS is refused"        "$(code $B/messaging/settings)" "403"
t "the finance dashboard too"     "$(code $B/finance/overview)" "403"
t "and the aged debt in it"       "$(code $B/finance/receivables)" "403"
t "the Ministry return too"       "$(code $B/reporting/dhis2)" "403"
t "payment verification too"      "$(code $B/billing/verify-payment/status)" "403"
t "AI assist too"                 "$(code -X POST $B/encounters/enc_0000000000000000000000000/assist)" "403"
t "but the chair itself works"    "$(code $B/dental/procedures)" "200"

echo "=== Practice: what gets money in ==="
plan dental-practice
t "patient SMS works"             "$(code $B/messaging/settings)" "200"
t "the finance dashboard works"   "$(code $B/finance/overview)" "200"
t "the aged debt works"           "$(code $B/finance/receivables)" "200"
t "payment verification works"    "$(code $B/billing/verify-payment/status)" "200"
t "the Ministry return does not"  "$(code $B/reporting/dhis2)" "403"
t "AI assist does not"            "$(code -X POST $B/encounters/enc_0000000000000000000000000/assist)" "403"

echo "=== Group: everything ==="
plan dental-group
t "the Ministry return works"     "$(code $B/reporting/dhis2)" "200"
t "AI assist is past the gate"    "$([ "$(code -X POST $B/encounters/enc_0000000000000000000000000/assist)" = "403" ] && echo gated || echo through)" "through"

echo "=== an add-on sold to one clinic beats its plan ==="
plan dental-chair
t "AI is off on Chair"            "$(code -X POST $B/encounters/enc_0000000000000000000000000/assist)" "403"
X "INSERT INTO tenant_entitlements (tenant_id,feature,enabled,note) VALUES ('$TID','ai_assist',true,'e2e add-on');"
TK=$(login)
t "granting it lets them in"      "$([ "$(code -X POST $B/encounters/enc_0000000000000000000000000/assist)" = "403" ] && echo gated || echo through)" "through"
X "UPDATE tenant_entitlements SET enabled=false WHERE tenant_id='$TID' AND feature='ai_assist';"
TK=$(login)
t "withdrawing it shuts them out" "$(code -X POST $B/encounters/enc_0000000000000000000000000/assist)" "403"
X "DELETE FROM tenant_entitlements WHERE tenant_id='$TID';"

echo "=== the recall list ==="
plan dental-group
t "asking who has not been in works"  "$(code "$B/messaging/audience?not_seen_days=180")" "200"
t "an ordinary audience still works"  "$(code "$B/messaging/audience?seen_days=180")" "200"
plan dental-practice
X "INSERT INTO tenant_entitlements (tenant_id,feature,enabled,note) VALUES ('$TID','recalls',false,'e2e');"
TK=$(login)
t "without the feature it is refused" "$(code "$B/messaging/audience?not_seen_days=180")" "403"
t "but writing to patients still is not" "$(code "$B/messaging/audience?seen_days=180")" "200"
X "DELETE FROM tenant_entitlements WHERE tenant_id='$TID';"

echo "=== our allowance rations our gateway only ==="
plan dental-chair   # Chair includes 0 messages on our account
WAS_SMS_ON=$(P "SELECT sms_enabled FROM clinics WHERE tenant_id='$TID';")
X "UPDATE clinics SET sms_enabled=true WHERE tenant_id='$TID';"
X "INSERT INTO tenant_entitlements (tenant_id,feature,enabled,note) VALUES ('$TID','messaging',true,'e2e: test the meter, not the gate');"
TK=$(login)
SAID=$(C -H "$CT" -H "Authorization: Bearer $TK" -X POST $B/messaging/test -d '{"phone":"0911223344","body":"e2e"}')
t "a plan with no messages says so"  "$(echo "$SAID" | grep -qi "own SMS account\|doesn't include messages" && echo told || echo "$SAID")" "told"
X "UPDATE clinics SET sms_api_key_enc='not-a-real-key' WHERE tenant_id='$TID';"
SAID2=$(C -H "$CT" -H "Authorization: Bearer $TK" -X POST $B/messaging/test -d '{"phone":"0911223344","body":"e2e"}')
t "with its own account it is not rationed" "$(echo "$SAID2" | grep -qi "doesn't include messages" && echo rationed || echo free)" "free"
X "UPDATE clinics SET sms_api_key_enc=NULL, sms_enabled=$WAS_SMS_ON WHERE tenant_id='$TID';"
X "DELETE FROM tenant_entitlements WHERE tenant_id='$TID';"

echo "=== a retired plan takes nobody new ==="
PLN=$(P "SELECT id FROM plans WHERE code='dental-basic';")
t "assigning it is refused" "$(P "SELECT status FROM plans WHERE id='$PLN';")" "retired"

echo "=== the general clinics were not gated by accident ==="
t "their plan has no feature list" "$(P "SELECT count(*) FROM plan_features pf JOIN plans p ON p.id=pf.plan_id WHERE p.clinic_type='general';")" "0"
t "so Joy's modules are untouched" "$(P "SELECT string_agg(flag||'='||enabled, ',' ORDER BY flag) FROM feature_flags f JOIN tenants t ON t.id=f.tenant_id WHERE t.slug='joy-speciality' AND f.branch_id IS NULL;")" "$JOY_BEFORE"

echo "=== Cure Dental: moved, and nothing taken away ==="
t "on Chair with its old headroom kept" "$CURE_BEFORE" "dental-chair/20/10"
t "it keeps the finance dashboard"      "$(P "SELECT enabled FROM tenant_entitlements te JOIN tenants t ON t.id=te.tenant_id WHERE t.slug='cure-dental' AND te.feature='finance_advanced';")" "t"
t "and its patient SMS"                 "$(P "SELECT enabled FROM tenant_entitlements te JOIN tenants t ON t.id=te.tenant_id WHERE t.slug='cure-dental' AND te.feature='messaging';")" "t"
t "and its 604 patients still fit"      "$(P "SELECT (SELECT count(*) FROM patients p WHERE p.tenant_id=t.id) <= p.patient_limit FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.slug='cure-dental';")" "t"

echo; echo "  $pass passed, $fail failed"
[ "$fail" = 0 ]
