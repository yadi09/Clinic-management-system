#!/usr/bin/env bash
# Per-clinic "doctors can register patients" policy — end to end.
#
# Runs against the y-clinic TEST tenant only. Proves the four things that matter:
# the policy actually gates POST /patients, the platform toggle moves it in both
# directions, the token is what carries it, and provisioning's reconcile (a
# DELETE ... NOT IN over the canonical role set) does not silently revoke it.
set -u
H='Host: app.clinicos.cc'; B=https://localhost:8443/api/v1
J='Content-Type: application/json'
TEN_UUID='e4cfd85b-2fdb-46c8-98f7-04336a29ef0c'
PSQL="docker exec -i clinicos-postgres-1 psql -U clinic -d clinic -At"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; PASS=$((PASS+1));
      else echo "  FAIL $1: want $3 got $2"; FAIL=$((FAIL+1)); fi; }
jqf(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

doc_login(){ curl -sk -X POST "$B/auth/login" -H "$H" -H "$J" \
  -d '{"workspace":"y-clinic","email":"polcheck.doc@yclinic.test","password":"BranchTest#2026"}'; }
plat_login(){ curl -sk -X POST "$B/platform/auth/login" -H "$H" -H "$J" \
  -d '{"email":"polcheck.admin@clinicos.test","password":"BranchTest#2026"}' | jqf 'd["data"]["access_token"]'; }

perms_have_create(){ python3 - "$1" <<'PY'
import sys,base64,json
p=sys.argv[1].split('.')[1]; p+='='*(-len(p)%4)
c=json.loads(base64.urlsafe_b64decode(p))
print("yes" if "patient.create" in (c.get("perms") or c.get("permissions") or []) else "no")
PY
}
# register <token> <label>. The label must differ per call: an identical
# first+last+dob is rejected as a duplicate with 409, which would masquerade as a
# permission result. A counter does not work here — register runs inside $( ), so
# the increment happens in a subshell and never survives.
register(){ curl -sk -o /dev/null -w '%{http_code}' -X POST "$B/patients" -H "$H" -H "$J" \
  -H "Authorization: Bearer $1" -d "{\"first_name\":\"PolicyProbe$2\",\"last_name\":\"Delete\",\"gender\":\"male\",\"dob\":\"1990-01-01\"}"; }

PT=$(plat_login)
[ -n "$PT" ] || { echo "cannot log in as platform admin"; exit 1; }
TEN=$(curl -sk "$B/platform/clinics" -H "$H" -H "Authorization: Bearer $PT" \
      | jqf '[c["id"] for c in d["data"] if c["slug"]=="y-clinic"][0]')
echo "y-clinic = $TEN"
setpol(){ curl -sk -o /dev/null -w '%{http_code}' -X PUT "$B/platform/clinics/$TEN/policies" \
  -H "$H" -H "$J" -H "Authorization: Bearer $PT" -d "{\"policies\":{\"doctor_registers_patients\":$1}}"; }
readpol(){ curl -sk "$B/platform/clinics/$TEN/policies" -H "$H" -H "Authorization: Bearer $PT" \
  | jqf '[p["enabled"] for p in d["data"] if p["key"]=="doctor_registers_patients"][0]'; }

echo "== 1. policy ON =="
ok "toggle on"           "$(setpol true)" "204"
ok "reads back on"       "$(readpol)" "True"
T=$(doc_login | jqf 'd["data"]["access_token"]')
ok "token carries perm"  "$(perms_have_create "$T")" "yes"
ok "doctor can register" "$(register "$T" A)" "201"

echo "== 2. policy OFF =="
ok "toggle off"          "$(setpol false)" "204"
ok "reads back off"      "$(readpol)" "False"
ok "old token still works (perms ride in the token)" "$(register "$T" B)" "201"
T2=$(doc_login | jqf 'd["data"]["access_token"]')
ok "fresh token drops perm" "$(perms_have_create "$T2")" "no"
ok "doctor blocked"      "$(register "$T2" C)" "403"

echo "== 3. other roles untouched =="
ok "receptionist keeps it" "$($PSQL -c "SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.tenant_id='$TEN_UUID' AND r.code='receptionist' AND p.code='patient.create';")" "1"

echo "== 4. back ON, then survive a provisioning reconcile =="
ok "toggle on again"     "$(setpol true)" "204"
T3=$(doc_login | jqf 'd["data"]["access_token"]')
ok "perm returns"        "$(perms_have_create "$T3")" "yes"
PERMS="{patient.read,patient.search,encounter.manage,prescription.create,queue.manage,appointment.manage,lab.order,bed.assign,dental.manage,dental.read,patient.create}"
$PSQL -c "DELETE FROM role_permissions rp USING roles r WHERE rp.role_id=r.id AND r.tenant_id='$TEN_UUID' AND r.code='doctor' AND rp.permission_id NOT IN (SELECT id FROM permissions WHERE code = ANY('$PERMS'::text[]));" >/dev/null
ok "grant survives reconcile" "$($PSQL -c "SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.tenant_id='$TEN_UUID' AND r.code='doctor' AND p.code='patient.create';")" "1"

echo "== 5. no drift: column and grant agree for every clinic =="
ok "mismatches" "$($PSQL -c "SELECT count(*) FROM tenants t WHERE t.deleted_at IS NULL AND t.doctor_registers_patients <> EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id WHERE r.tenant_id=t.id AND r.code='doctor' AND p.code='patient.create');")" "0"

echo; echo "  $PASS passed, $FAIL failed"
$PSQL -c "DELETE FROM patients WHERE tenant_id='$TEN_UUID' AND first_name LIKE 'PolicyProbe%';" >/dev/null
echo "  (probe patients removed)"
[ "$FAIL" -eq 0 ]
