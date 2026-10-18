package regression

// The branch leak audit. Branches are separate workspaces; this proves, two ways, that
// nothing of one branch can be seen from the other:
//
//  1. In the database, as the application itself: a session in branch B reads ZERO rows of
//     branch A from EVERY table that holds clinic data — all of them, not a sample. A table
//     added later is covered automatically, and a new table holding clinic data without a
//     tenant_id fails the companion check.
//  2. Through the API, as the owner signed in to branch B: EVERY data endpoint the server
//     registers is called — lists as they are, and every record endpoint with A's own ids —
//     and nothing of A comes back.
//
// Then the same in the other direction.

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// leakSeed is one branch's real data: a patient, a treatment course with a delivered and
// billed and paid visit, an examination, a chart, an unpaid charge, an appointment and a
// queue entry — each carrying a word that appears nowhere else.
type leakSeed struct {
	marker string
	ids    map[string]string // what kind -> an encoded id of this branch's row
}

func seedBranchData(t *testing.T, owner *testkit.Client, branchID, deptID uuid.UUID, doctorID string) leakSeed {
	t.Helper()
	s := leakSeed{marker: "Leakmark" + strings.ToLower(uniq("")), ids: map[string]string{}}
	p := createPatient(t, owner, s.marker, "Patient")
	s.ids["patient"] = p.ID
	var plan planRef
	owner.Do("POST", "/dental/patients/"+p.ID+"/plans", map[string]any{
		"title": s.marker + " course", "total_amount": "3000", "start_date": payAddisToday(),
		"interval_unit": "week", "interval_count": 1, "session_count": 2,
	}).Expect(t, 201, "plan").Decode(t, &plan)
	s.ids["plan"] = plan.ID
	s.ids["session"] = plan.Sessions[0].ID
	payDone(t, owner, p.ID, plan.Sessions[0].ID)
	payCollect(t, owner, p.ID, plan.Sessions[0].ID)
	put(t, owner, p.ID, map[string][]it{"36": {{"kind": "root_canal", "status": "planned", "note": s.marker + " note"}}}).Expect(t, 200, "chart")
	owner.Do("POST", "/dental/patients/"+p.ID+"/exams", map[string]any{"visit_date": payAddisToday(), "chief_complaint": s.marker + " pain"}).Expect(t, 201, "exam")
	var ch struct {
		ID string `json:"id"`
	}
	owner.Do("POST", "/billing/charges", map[string]any{
		"patient_id": p.ID, "source": "service", "description": s.marker + " scaling", "amount": 250,
		"branch_id": id.Encode(id.PrefixBranch, branchID),
	}).Expect(t, 201, "charge").Decode(t, &ch)
	s.ids["charge"] = ch.ID
	for _, r := range payPendingFor(t, owner, p.ID) {
		paySettle(owner, r.ID).Expect(t, 204, "settle")
		s.ids["paid_charge"] = r.ID
		break
	}
	var appt struct {
		ID string `json:"id"`
	}
	owner.Do("POST", "/appointments", map[string]any{
		"branch_id": id.Encode(id.PrefixBranch, branchID), "patient_id": p.ID, "provider_id": doctorID,
		"department_id": id.Encode(id.PrefixDepartment, deptID),
		"starts_at":     time.Now().Add(26 * time.Hour).UTC().Format(time.RFC3339), "duration_min": 30, "reason": s.marker + " visit",
	}).Expect(t, 201, "appointment").Decode(t, &appt)
	s.ids["appointment"] = appt.ID
	return s
}

// noRowsOf proves at the database: as the application, in a session of `as`, not one row
// belonging to `of` is visible in any table that holds clinic data.
func noRowsOf(t *testing.T, as, of uuid.UUID) {
	t.Helper()
	app, err := pgx.Connect(t.Context(), testkit.AppDSNFrom(superDSN))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close(t.Context())
	var tables []string
	rows, err := super.Pool.Query(t.Context(), `
		SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
		 WHERE c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
		 ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var n string
		_ = rows.Scan(&n)
		tables = append(tables, n)
	}
	rows.Close()
	// The rows that exist for `of` (counted as the superuser) must be invisible to `as`.
	seen, checked := []string{}, 0
	for _, tbl := range tables {
		// The one table a clinic's branches share on purpose: who may move between them.
		// Ids only, and walled by organization — REG_BRWS_004 proves another clinic sees none.
		if tbl == "org_links" {
			continue
		}
		var total int
		one(t, fmt.Sprintf(`SELECT count(*) FROM %q WHERE tenant_id = $1`, tbl), &total, of)
		tx, err := app.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, as.String()); err != nil {
			t.Fatal(err)
		}
		var visible int
		err = tx.QueryRow(t.Context(), fmt.Sprintf(`SELECT count(*) FROM %q WHERE tenant_id = $1`, tbl), of).Scan(&visible)
		_ = tx.Rollback(t.Context())
		if err != nil {
			// Not readable by the application at all (the vendor's own tables): nothing to leak.
			if strings.Contains(err.Error(), "permission denied") {
				continue
			}
			t.Fatalf("%s: %v", tbl, err)
		}
		checked++
		if total > 0 && visible > 0 {
			seen = append(seen, fmt.Sprintf("%s (%d of %d rows)", tbl, visible, total))
		}
	}
	if checked < 60 {
		t.Fatalf("only %d tables checked — the catalogue query is wrong", checked)
	}
	if len(seen) > 0 {
		t.Fatalf("a session of one branch can read the other branch's rows in: %v", seen)
	}
}

var leakRoute = regexp.MustCompile(`\[GIN-debug\] GET\s+/api/v1(\S+)`)

// skipLeakRoute: routes that are not a clinic's data — the vendor's console, the public
// marketplace and campaign pages, the patient portal and paper checks (public, addressed by
// a clinic's own name), live streams, and the signed-in person's own account.
func skipLeakRoute(path string) bool {
	for _, p := range []string{"/platform", "/marketplace", "/campaigns", "/c/", "/partner", "/verify", "/portal/", "/healthz", "/readyz"} {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return strings.Contains(path, "/stream") || strings.Contains(path, "/events") || path == "/auth/sessions"
}

// noAPILeak calls every data endpoint as `cl` and fails if anything of `of` comes back.
func noAPILeak(t *testing.T, cl *testkit.Client, of leakSeed) {
	t.Helper()
	routes := map[string]bool{}
	for _, m := range leakRoute.FindAllStringSubmatch(srv.Logs(), -1) {
		if !skipLeakRoute(m[1]) {
			routes[m[1]] = true
		}
	}
	paths := make([]string, 0, len(routes))
	for p := range routes {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	if len(paths) < 100 {
		t.Fatalf("only %d GET routes found — the route list is wrong", len(paths))
	}
	param := regexp.MustCompile(`:[a-zA-Z_]+`)
	ownIDs := []string{}
	for _, v := range of.ids {
		ownIDs = append(ownIDs, v)
	}
	leaks, calls := []string{}, 0
	look := func(path string) {
		calls++
		r := cl.Do("GET", path, nil)
		if r.Status >= 300 {
			return
		}
		body := r.Raw
		if strings.Contains(strings.ToLower(body), strings.ToLower(of.marker)) {
			leaks = append(leaks, fmt.Sprintf("GET %s → contains the other branch's data", path))
			return
		}
		for _, x := range ownIDs {
			if strings.Contains(body, x) {
				leaks = append(leaks, fmt.Sprintf("GET %s → contains the other branch's id %s", path, x))
				return
			}
		}
	}
	for _, p := range paths {
		if !param.MatchString(p) {
			look(p)
			continue
		}
		// A record endpoint: ask it for each of the other branch's own records.
		for _, x := range ownIDs {
			look(param.ReplaceAllString(p, x))
		}
	}
	t.Logf("leak sweep: %d GET routes, %d calls", len(paths), calls)
	if len(leaks) > 0 {
		t.Fatalf("data of the other branch came back:\n  %s", strings.Join(leaks, "\n  "))
	}
}

// TestREG_BRWS_020_BranchLeakAudit is the full audit, in both directions.
func TestREG_BRWS_020_BranchLeakAudit(t *testing.T) {
	c := newClinic(t)
	exec(t, `UPDATE tenants SET branch_limit_override = 5 WHERE id = $1`, c.TenantID)
	owner := srv.As(t, c, "owner")
	doctor := id.Encode(id.PrefixUser, c.Staff["doctor"].ID)
	a := seedBranchData(t, owner, c.BranchID, c.DeptID, doctor)

	adm, _, _ := platAdmin(t)
	var br orgBranchResult
	adm.Do("POST", "/platform/clinics/"+id.Encode(id.PrefixTenant, c.TenantID)+"/branches", map[string]any{"name": "Audit branch", "slug": strings.ToLower(uniq("aud-"))}).
		Expect(t, 201, "add branch").Decode(t, &br)
	bTenant, _ := id.Decode(id.PrefixTenant, br.Branch.ID)

	// Into branch B, and give it data of its own, booked with its own branch and doctor.
	switchTo(t, owner, br.Branch.ID).Expect(t, 200, "switch to B")
	var bBranch, bDept uuid.UUID
	one(t, `SELECT id FROM branches WHERE tenant_id = $1`, &bBranch, bTenant)
	one(t, `SELECT id FROM departments WHERE tenant_id = $1`, &bDept, bTenant)
	var bOwner uuid.UUID
	one(t, `SELECT user_id FROM org_links WHERE tenant_id = $1`, &bOwner, bTenant)
	exec(t, `INSERT INTO user_role_scopes (tenant_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE tenant_id = $1 AND code = 'doctor'`, bTenant, bOwner)
	switchTo(t, owner, id.Encode(id.PrefixTenant, c.TenantID)).Expect(t, 200, "back to A, to pick up the new role in B")
	switchTo(t, owner, br.Branch.ID).Expect(t, 200, "switch to B again")
	b := seedBranchData(t, owner, bBranch, bDept, id.Encode(id.PrefixUser, bOwner))

	t.Run("database: B cannot read a single row of A", func(t *testing.T) { noRowsOf(t, bTenant, c.TenantID) })
	t.Run("database: A cannot read a single row of B", func(t *testing.T) { noRowsOf(t, c.TenantID, bTenant) })
	t.Run("API: nothing of A comes back to the owner in B", func(t *testing.T) { noAPILeak(t, owner, a) })
	switchTo(t, owner, id.Encode(id.PrefixTenant, c.TenantID)).Expect(t, 200, "back to A")
	t.Run("API: nothing of B comes back to the owner in A", func(t *testing.T) { noAPILeak(t, owner, b) })
}

// TestREG_BRWS_021_EveryTableWithClinicDataCarriesATenant: a public table WITHOUT tenant_id
// cannot be walled per clinic, so it must be one the vendor shares on purpose. A new table
// holding clinic data without a tenant_id fails here, before it can leak between branches.
func TestREG_BRWS_021_EveryTableWithClinicDataCarriesATenant(t *testing.T) {
	shared := map[string]bool{
		"goose_db_version": true, "tenants": true, "plans": true, "permissions": true, "features": true, "plan_features": true,
		"organizations": true, "platform_admins": true, "notification_watermarks": true, "platform_settings": true, "partner_leads": true,
		"crm_campaigns": true, "crm_phases": true, "crm_touches": true, "crm_prospect_phases": true,
		"campaigns": true, "campaign_signups": true, "campaign_spins": true, "campaign_prizes": true,
	}
	rows, err := super.Pool.Query(t.Context(), `
		SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
		 WHERE c.relkind = 'r'
		   AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
		 ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var unknown []string
	for rows.Next() {
		var n string
		_ = rows.Scan(&n)
		if !shared[n] && !strings.HasPrefix(n, "mp_") && !strings.HasPrefix(n, "campaign") && !strings.HasPrefix(n, "crm_") {
			unknown = append(unknown, n)
		}
	}
	if len(unknown) > 0 {
		t.Fatalf("tables with no tenant_id that are not on the vendor's shared list — if any holds a clinic's data, it is not separated between branches or clinics: %v", unknown)
	}
}

// TestREG_BRWS_022_EventQueueIsWalledButTheRelayStillSeesAll: the event queue (event_outbox)
// is read across clinics by the background relay, which runs with no clinic set; every
// request runs with one. A request's session sees only its own clinic's events; the
// relay's still sees every clinic's, or nothing would ever be dispatched.
func TestREG_BRWS_022_EventQueueIsWalledButTheRelayStillSeesAll(t *testing.T) {
	a, b := newClinic(t), newClinic(t)
	createPatient(t, srv.As(t, a, "receptionist"), uniq("Evt"), "A") // each registration queues an event
	createPatient(t, srv.As(t, b, "receptionist"), uniq("Evt"), "B")
	app, err := pgx.Connect(t.Context(), testkit.AppDSNFrom(superDSN))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close(t.Context())
	count := func(as *uuid.UUID, of uuid.UUID) int {
		tx, err := app.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(t.Context()) }()
		if as != nil {
			if _, err := tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, as.String()); err != nil {
				t.Fatal(err)
			}
		}
		var n int
		if err := tx.QueryRow(t.Context(), `SELECT count(*) FROM event_outbox WHERE tenant_id = $1`, of).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(nil, a.TenantID) == 0 || count(nil, b.TenantID) == 0 {
		t.Fatal("the relay (no clinic set) can no longer see every clinic's events — nothing would be dispatched")
	}
	if count(&a.TenantID, a.TenantID) == 0 {
		t.Fatal("a clinic's own session cannot see its own events")
	}
	if n := count(&a.TenantID, b.TenantID); n != 0 {
		t.Fatalf("a session of clinic A read %d of clinic B's events", n)
	}
	// And it cannot write an event in another clinic's name.
	tx, err := app.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	_, _ = tx.Exec(t.Context(), `SELECT set_config('app.tenant_id', $1, true)`, a.TenantID.String())
	if _, err := tx.Exec(t.Context(), `INSERT INTO event_outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1,'x',$2,'x','{}')`, b.TenantID, uuid.New()); err == nil {
		t.Fatal("a session of clinic A wrote an event in clinic B's name")
	}
}
