package regression

import (
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The dental module, second part: the clinic's own lists (procedures and tooth
// conditions), the medical history, changing a course after it was agreed (editing
// it, adding a visit, finishing it early, repricing a visit) and the money actions
// on a visit (bulk collect, pulling a bill back, write-off and its undo, pay-later).
// Every refusal the service can return on these routes is triggered at least once,
// with its HTTP status and error code, and every write is checked in the database.

// ---- helpers (prefixed dn2: other files share this package) ------------------

// dn2Code fails unless the response has the given status and error code.
func dn2Code(t *testing.T, r testkit.Resp, status int, code, what string) {
	t.Helper()
	r.Expect(t, status, what)
	if code != "" && r.Code != code {
		t.Fatalf("%s: refused with code %q (%s), want %s", what, r.Code, r.Message, code)
	}
}

func dn2SessUUID(t *testing.T, sid string) uuid.UUID {
	return denUUID(t, id.PrefixTreatmentSession, sid)
}

func dn2PlanUUID(t *testing.T, pid string) uuid.UUID {
	return denUUID(t, id.PrefixTreatmentPlan, pid)
}

// dn2Sess reads a session's status and fee straight from the database.
func dn2Sess(t *testing.T, sid string) (status string, amount float64) {
	t.Helper()
	var amt string
	one(t, `SELECT status FROM treatment_sessions WHERE id = $1`, &status, dn2SessUUID(t, sid))
	one(t, `SELECT amount_due::text FROM treatment_sessions WHERE id = $1`, &amt, dn2SessUUID(t, sid))
	return status, denMoney(t, amt)
}

// dn2Plan reads a course's status and stored total from the database.
func dn2Plan(t *testing.T, pid string) (status string, total float64) {
	t.Helper()
	var tot string
	one(t, `SELECT status FROM treatment_plans WHERE id = $1`, &status, dn2PlanUUID(t, pid))
	one(t, `SELECT total_amount::text FROM treatment_plans WHERE id = $1`, &tot, dn2PlanUUID(t, pid))
	return status, denMoney(t, tot)
}

// dn2Charge is the session's linked charge status ("" when it has none).
func dn2Charge(t *testing.T, sid string) string {
	t.Helper()
	var st string
	one(t, `SELECT coalesce((SELECT c.status FROM charges c WHERE c.id = se.charge_id), '')
	          FROM treatment_sessions se WHERE se.id = $1`, &st, dn2SessUUID(t, sid))
	return st
}

// dn2Events counts outbox events of a type for a tenant whose payload mentions s.
func dn2Events(t *testing.T, tenant uuid.UUID, eventType, s string) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM event_outbox WHERE tenant_id = $1 AND event_type = $2 AND payload::text LIKE '%' || $3 || '%'`,
		&n, tenant, eventType, s)
	return n
}

// dn2Course is a private clinic, its dentist, a patient and a course of `visits`
// visits of 1,000 ETB each (plus an optional deposit).
type dn2Course struct {
	c    *testkit.Clinic
	doc  *testkit.Client
	p    patientRef
	plan planRef
}

func dn2NewCourse(t *testing.T, visits int, deposit string) dn2Course {
	t.Helper()
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	total := 1000*visits + int(dn2Num(deposit))
	plan := createPlan(t, doc, p.ID, itoa(total), visits, deposit)
	return dn2Course{c: c, doc: doc, p: p, plan: plan}
}

func dn2Num(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func (k dn2Course) sid(i int) string { return k.plan.Sessions[i].ID }

func (k dn2Course) path(rest string) string { return "/dental/patients/" + k.p.ID + rest }

// dn2PendingCharge is the id of the one pending charge the patient has at the cashier.
func dn2PendingCharge(t *testing.T, c *testkit.Clinic, patientID string) string {
	t.Helper()
	rows := payPendingFor(t, srv.As(t, c, "cashier"), patientID)
	if len(rows) != 1 {
		t.Fatalf("want one pending charge for the patient, got %+v", rows)
	}
	return rows[0].ID
}

type dn2Proc struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsActive  bool   `json:"is_active"`
	SortOrder int    `json:"sort_order"`
}

func dn2Procs(t *testing.T, cl *testkit.Client, all bool) []dn2Proc {
	t.Helper()
	path := "/dental/procedures"
	if all {
		path += "?all=1"
	}
	var out []dn2Proc
	cl.Do("GET", path, nil).Expect(t, 200, "list procedures").Decode(t, &out)
	return out
}

func dn2FindProc(list []dn2Proc, idOrName string) *dn2Proc {
	for i := range list {
		if list[i].ID == idOrName || list[i].Name == idOrName {
			return &list[i]
		}
	}
	return nil
}

type dn2Status struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Label     string `json:"label"`
	Color     string `json:"color"`
	SortOrder int    `json:"sort_order"`
	IsActive  bool   `json:"is_active"`
}

func dn2Statuses(t *testing.T, cl *testkit.Client, all bool) []dn2Status {
	t.Helper()
	path := "/dental/tooth-statuses"
	if all {
		path += "?all=1"
	}
	var out []dn2Status
	cl.Do("GET", path, nil).Expect(t, 200, "list tooth statuses").Decode(t, &out)
	return out
}

func dn2FindStatus(list []dn2Status, idOrCode string) *dn2Status {
	for i := range list {
		if list[i].ID == idOrCode || list[i].Code == idOrCode {
			return &list[i]
		}
	}
	return nil
}

// ---- the clinic's procedure list ------------------------------------------------

// TestREG_DENTAL_110_ProcedureListSeedsDefaultsOnce: Given a clinic that has never
// opened its procedure list, When the dentist lists it twice, Then the 16 starting
// procedures are there, in order, and stored once (the second read does not seed
// them again).
func TestREG_DENTAL_110_ProcedureListSeedsDefaultsOnce(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	first := dn2Procs(t, doc, false)
	second := dn2Procs(t, srv.As(t, c, "receptionist"), false) // the desk reads the picker too
	if len(first) != 16 || len(second) != 16 {
		t.Fatalf("seeded procedures: first read %d, second read %d, want 16", len(first), len(second))
	}
	if first[0].Name != "Consultation" || first[0].SortOrder != 1 || !first[0].IsActive {
		t.Fatalf("first default procedure = %+v, want active Consultation at 1", first[0])
	}
	var rows int
	one(t, `SELECT count(*) FROM dental_procedures WHERE tenant_id = $1`, &rows, c.TenantID)
	if rows != 16 {
		t.Fatalf("database holds %d procedure rows after two reads, want 16", rows)
	}
	srv.As(t, c, "nurse").Do("GET", "/dental/procedures", nil).Expect(t, 403, "nurse (no dental permission) lists procedures")
}

// TestREG_DENTAL_111_CreateProcedureRules: When a procedure is added it goes to the
// END of the list; a blank name is 400, the same name again (any case) is 409
// PROCEDURE_EXISTS, and the front desk may not edit the list (403). The owner
// (clinic.manage, not a dentist) may.
func TestREG_DENTAL_111_CreateProcedureRules(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	before := dn2Procs(t, doc, false)
	name := uniq("Pulpotomy ")

	var p dn2Proc
	doc.Do("POST", "/dental/procedures", map[string]any{"name": "  " + name + "  "}).Expect(t, 201, "create procedure").Decode(t, &p)
	if p.Name != name || p.SortOrder != len(before)+1 || !p.IsActive {
		t.Fatalf("created procedure %+v, want %q trimmed, active, at %d", p, name, len(before)+1)
	}
	after := dn2Procs(t, doc, false)
	if last := after[len(after)-1]; last.ID != p.ID {
		t.Fatalf("new procedure is not last on the list: last is %+v", last)
	}

	dn2Code(t, doc.Do("POST", "/dental/procedures", map[string]any{"name": "   "}), 400, "VALIDATION_FAILED", "blank name")
	doc.Do("POST", "/dental/procedures", "not an object").Expect(t, 400, "malformed body")
	dn2Code(t, doc.Do("POST", "/dental/procedures", map[string]any{"name": strings.ToUpper(name)}), 409, "PROCEDURE_EXISTS", "same name, other case")
	srv.As(t, c, "receptionist").Do("POST", "/dental/procedures", map[string]any{"name": uniq("Desk ")}).Expect(t, 403, "desk edits the list")

	srv.As(t, c, "owner").Do("POST", "/dental/procedures", map[string]any{"name": uniq("Owner ")}).Expect(t, 201, "owner (clinic.manage) adds")
	var rows int
	one(t, `SELECT count(*) FROM dental_procedures WHERE tenant_id = $1 AND lower(name) = lower($2)`, &rows, c.TenantID, name)
	if rows != 1 {
		t.Fatalf("database holds %d rows named %q, want 1", rows, name)
	}
}

// TestREG_DENTAL_112_UpdateProcedureRenamesAndRetires: a procedure can be renamed
// and retired; a retired one leaves the picker but stays in the settings list
// (?all=1). A blank name is 400, a name another procedure has is 409, an unknown
// or malformed id is 404/400.
func TestREG_DENTAL_112_UpdateProcedureRenamesAndRetires(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	list := dn2Procs(t, doc, false)
	target, other := list[2], list[3]
	newName := uniq("Scale ")
	path := "/dental/procedures/" + target.ID

	doc.Do("PUT", path, map[string]any{"name": newName, "is_active": false}).Expect(t, 204, "rename and retire")
	if dn2FindProc(dn2Procs(t, doc, false), target.ID) != nil {
		t.Fatalf("a retired procedure is still offered in the picker")
	}
	got := dn2FindProc(dn2Procs(t, doc, true), target.ID)
	if got == nil || got.Name != newName || got.IsActive {
		t.Fatalf("settings list shows %+v, want %q retired", got, newName)
	}
	// is_active omitted keeps it as it is (still retired).
	doc.Do("PUT", path, map[string]any{"name": newName + "x"}).Expect(t, 204, "rename only")
	if got := dn2FindProc(dn2Procs(t, doc, true), target.ID); got == nil || got.IsActive {
		t.Fatalf("renaming without is_active re-activated it: %+v", got)
	}

	dn2Code(t, doc.Do("PUT", path, map[string]any{"name": " "}), 400, "VALIDATION_FAILED", "blank name")
	doc.Do("PUT", path, "x").Expect(t, 400, "malformed body")
	dn2Code(t, doc.Do("PUT", path, map[string]any{"name": other.Name}), 409, "PROCEDURE_EXISTS", "name of another procedure")
	dn2Code(t, doc.Do("PUT", "/dental/procedures/"+id.Encode(id.PrefixProcedure, uuid.New()), map[string]any{"name": "Ghost"}),
		404, "PROCEDURE_NOT_FOUND", "unknown procedure")
	doc.Do("PUT", "/dental/procedures/not-an-id", map[string]any{"name": "x"}).Expect(t, 400, "malformed id")
}

// TestREG_DENTAL_113_RenamingOrDeletingAProcedureLeavesPastVisits: Given a visit
// recorded with procedure "X", When the clinic renames X and then deletes it from
// its list, Then the visit still says X — a settings screen does not rewrite care
// already given. The deleted procedure leaves the picker and the settings list, its
// row is soft-deleted, and the name can be used again for a new procedure.
func TestREG_DENTAL_113_RenamingOrDeletingAProcedureLeavesPastVisits(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	name := uniq("Apicectomy ")
	var p dn2Proc
	k.doc.Do("POST", "/dental/procedures", map[string]any{"name": name}).Expect(t, 201, "create").Decode(t, &p)
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(0)), map[string]any{"status": "done", "procedure": name}).Expect(t, 204, "record with it")

	k.doc.Do("PUT", "/dental/procedures/"+p.ID, map[string]any{"name": name + " (old)"}).Expect(t, 204, "rename")
	k.doc.Do("DELETE", "/dental/procedures/"+p.ID, nil).Expect(t, 204, "delete in use")

	if s := denSessionByID(t, denPlanByID(t, k.doc, k.p.ID, k.plan.ID), k.sid(0)); s.Procedure != name {
		t.Fatalf("the visit now says %q, want %q", s.Procedure, name)
	}
	if dn2FindProc(dn2Procs(t, k.doc, true), p.ID) != nil {
		t.Fatalf("deleted procedure still in the settings list")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM dental_procedures WHERE id = $1`, &deleted, denUUID(t, id.PrefixProcedure, p.ID))
	if !deleted {
		t.Fatalf("deleted procedure's row was not soft-deleted")
	}
	k.doc.Do("POST", "/dental/procedures", map[string]any{"name": name + " (old)"}).Expect(t, 201, "reuse a deleted name")
	k.doc.Do("DELETE", "/dental/procedures/bogus", nil).Expect(t, 400, "malformed id")
	srv.As(t, k.c, "receptionist").Do("DELETE", "/dental/procedures/"+p.ID, nil).Expect(t, 403, "desk deletes")
}

// TestREG_DENTAL_114_ReorderProcedures: When the clinic drags three procedures into
// a new order, Then the list reads back in exactly that order (1, 2, 3); a malformed
// id or body is 400 and changes nothing.
func TestREG_DENTAL_114_ReorderProcedures(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	list := dn2Procs(t, doc, false)
	// The settings screen sends the whole list in its new order.
	order := make([]string, 0, len(list))
	for i := len(list) - 1; i >= 0; i-- {
		order = append(order, list[i].ID)
	}
	doc.Do("POST", "/dental/procedures/reorder", map[string]any{"ids": order}).Expect(t, 204, "reorder")
	after := dn2Procs(t, doc, false)
	for i, want := range order {
		got := dn2FindProc(after, want)
		if got == nil || got.SortOrder != i+1 {
			t.Fatalf("procedure %s sort_order = %+v, want %d", want, got, i+1)
		}
		if after[i].ID != want {
			t.Fatalf("position %d is %s, want %s", i, after[i].Name, want)
		}
	}
	doc.Do("POST", "/dental/procedures/reorder", map[string]any{"ids": []string{order[2], "nope"}}).Expect(t, 400, "bad id")
	doc.Do("POST", "/dental/procedures/reorder", "x").Expect(t, 400, "malformed body")
	if again := dn2Procs(t, doc, false); again[0].ID != order[0] {
		t.Fatalf("a refused reorder changed the order")
	}
}

// TestREG_DENTAL_115_OtherClinicCannotEditProcedures: clinic B's dentist cannot
// rename, delete or reorder clinic A's procedures (update is 404; delete and reorder
// leave A's rows untouched).
func TestREG_DENTAL_115_OtherClinicCannotEditProcedures(t *testing.T) {
	c := newClinic(t)
	a := dn2Procs(t, srv.As(t, c, "doctor"), false)
	target := a[1]
	docB := srv.As(t, clinicB, "doctor")
	dn2Code(t, docB.Do("PUT", "/dental/procedures/"+target.ID, map[string]any{"name": "hijacked"}), 404, "PROCEDURE_NOT_FOUND", "B renames A's")
	docB.Do("DELETE", "/dental/procedures/"+target.ID, nil)
	docB.Do("POST", "/dental/procedures/reorder", map[string]any{"ids": []string{target.ID}})
	var name string
	var deleted bool
	var sort int
	pu := denUUID(t, id.PrefixProcedure, target.ID)
	one(t, `SELECT name FROM dental_procedures WHERE id = $1`, &name, pu)
	one(t, `SELECT deleted_at IS NOT NULL FROM dental_procedures WHERE id = $1`, &deleted, pu)
	one(t, `SELECT sort_order FROM dental_procedures WHERE id = $1`, &sort, pu)
	if name != target.Name || deleted || sort != target.SortOrder {
		t.Fatalf("clinic B changed clinic A's procedure: name=%q deleted=%v sort=%d", name, deleted, sort)
	}
}

// ---- the conditions on the chart --------------------------------------------------

// TestREG_DENTAL_120_CreateToothStatusRules: When the clinic adds "Root-canal
// treated" in #7a3cc2, Then it is stored with the stable code root_canal_treated,
// goes to the end of the palette, and can be charted. Blank labels, labels with no
// letters or digits, colours that are not #rrggbb and a second condition with the
// same code are refused.
func TestREG_DENTAL_120_CreateToothStatusRules(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	before := dn2Statuses(t, doc, false)
	var st dn2Status
	doc.Do("POST", "/dental/tooth-statuses", map[string]any{"label": " Root-canal  treated ", "color": "#7a3cc2"}).
		Expect(t, 201, "create condition").Decode(t, &st)
	if st.Code != "root_canal_treated" || st.Label != "Root-canal  treated" || st.Color != "#7a3cc2" || st.SortOrder != len(before)+1 {
		t.Fatalf("created condition %+v", st)
	}
	p := denPatient(t, c)
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"LL6": "root_canal_treated"}}).
		Expect(t, 200, "chart the new condition")
	if denChart(t, doc, p.ID)["LL6"] != "root_canal_treated" {
		t.Fatalf("new condition not on the chart")
	}

	path := "/dental/tooth-statuses"
	dn2Code(t, doc.Do("POST", path, map[string]any{"label": "", "color": "#000000"}), 400, "VALIDATION_FAILED", "blank label")
	dn2Code(t, doc.Do("POST", path, map[string]any{"label": "!!! ---", "color": "#000000"}), 400, "VALIDATION_FAILED", "label without letters")
	for _, bad := range []string{"", "red", "#12345", "#12345g", "123456#", "#1234567"} {
		dn2Code(t, doc.Do("POST", path, map[string]any{"label": uniq("Cond "), "color": bad}), 400, "VALIDATION_FAILED", "colour "+bad)
	}
	doc.Do("POST", path, "x").Expect(t, 400, "malformed body")
	dn2Code(t, doc.Do("POST", path, map[string]any{"label": "root canal treated", "color": "#ABCDEF"}), 409, "STATUS_EXISTS", "same code again")
	srv.As(t, c, "receptionist").Do("POST", path, map[string]any{"label": "Desk", "color": "#000000"}).Expect(t, 403, "desk edits palette")
}

// TestREG_DENTAL_121_UpdateToothStatusKeepsTheCode: Given teeth charted "decayed",
// When the clinic relabels it "Caries", recolours it and retires it, Then the code a
// chart stores is unchanged, the tooth still reads decayed, the condition leaves the
// palette (but not the settings list), and a retired condition may still be re-saved
// on a chart. Bad label/colour are 400, an unknown condition is 404 STATUS_NOT_FOUND.
func TestREG_DENTAL_121_UpdateToothStatusKeepsTheCode(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	decayed := dn2FindStatus(dn2Statuses(t, doc, false), "decayed")
	if decayed == nil {
		t.Fatalf("default 'decayed' missing")
	}
	p := denPatient(t, c)
	chart := "/dental/patients/" + p.ID + "/chart"
	doc.Do("PUT", chart, map[string]any{"changes": map[string]string{"UR6": "decayed"}}).Expect(t, 200, "chart decayed")

	path := "/dental/tooth-statuses/" + decayed.ID
	doc.Do("PUT", path, map[string]any{"label": "Caries", "color": "#AA0000", "is_active": false}).Expect(t, 204, "relabel + retire")
	if dn2FindStatus(dn2Statuses(t, doc, false), decayed.ID) != nil {
		t.Fatalf("retired condition still in the palette")
	}
	got := dn2FindStatus(dn2Statuses(t, doc, true), decayed.ID)
	if got == nil || got.Code != "decayed" || got.Label != "Caries" || got.Color != "#AA0000" || got.IsActive {
		t.Fatalf("after update: %+v", got)
	}
	if denChart(t, doc, p.ID)["UR6"] != "decayed" {
		t.Fatalf("relabelling changed what the chart reads")
	}
	doc.Do("PUT", chart, map[string]any{"changes": map[string]string{"UR7": "decayed"}}).Expect(t, 200, "re-save a retired condition")

	dn2Code(t, doc.Do("PUT", path, map[string]any{"label": " ", "color": "#000000"}), 400, "VALIDATION_FAILED", "blank label")
	dn2Code(t, doc.Do("PUT", path, map[string]any{"label": "Caries", "color": "maroon"}), 400, "VALIDATION_FAILED", "bad colour")
	doc.Do("PUT", path, "x").Expect(t, 400, "malformed body")
	dn2Code(t, doc.Do("PUT", "/dental/tooth-statuses/"+id.Encode(id.PrefixToothStatus, uuid.New()), map[string]any{"label": "x", "color": "#000000"}),
		404, "STATUS_NOT_FOUND", "unknown condition")
	doc.Do("PUT", "/dental/tooth-statuses/zzz", map[string]any{"label": "x", "color": "#000000"}).Expect(t, 400, "malformed id")
}

// TestREG_DENTAL_122_DeleteToothStatusInUseKeepsTheMarks: Given LL1 charted with a
// clinic's own condition, When the clinic deletes that condition, Then it leaves the
// palette and the settings list, but LL1 still reads it (the chart stores the code).
// The front desk cannot delete; a malformed id is 400.
func TestREG_DENTAL_122_DeleteToothStatusInUseKeepsTheMarks(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	denSeedConditions(t, doc)
	var st dn2Status
	doc.Do("POST", "/dental/tooth-statuses", map[string]any{"label": "Veneer", "color": "#eeeeee"}).Expect(t, 201, "create").Decode(t, &st)
	p := denPatient(t, c)
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"LL1": "veneer"}}).Expect(t, 200, "chart it")

	srv.As(t, c, "receptionist").Do("DELETE", "/dental/tooth-statuses/"+st.ID, nil).Expect(t, 403, "desk deletes")
	doc.Do("DELETE", "/dental/tooth-statuses/"+st.ID, nil).Expect(t, 204, "delete in use")
	if dn2FindStatus(dn2Statuses(t, doc, true), st.ID) != nil {
		t.Fatalf("deleted condition still listed")
	}
	if denChart(t, doc, p.ID)["LL1"] != "veneer" {
		t.Fatalf("deleting the condition erased the tooth's mark")
	}
	var deleted bool
	one(t, `SELECT deleted_at IS NOT NULL FROM dental_tooth_statuses WHERE id = $1`, &deleted, denUUID(t, id.PrefixToothStatus, st.ID))
	if !deleted {
		t.Fatalf("condition row not soft-deleted")
	}
	doc.Do("DELETE", "/dental/tooth-statuses/zzz", nil).Expect(t, 400, "malformed id")
}

// TestREG_DENTAL_123_ReorderToothStatuses: the palette reads back in the order the
// clinic dragged it into; a malformed id or body is 400.
func TestREG_DENTAL_123_ReorderToothStatuses(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	list := dn2Statuses(t, doc, false)
	order := []string{list[4].ID, list[2].ID, list[0].ID, list[1].ID, list[3].ID}
	doc.Do("POST", "/dental/tooth-statuses/reorder", map[string]any{"ids": order}).Expect(t, 204, "reorder")
	after := dn2Statuses(t, doc, false)
	for i, want := range order {
		if after[i].ID != want || after[i].SortOrder != i+1 {
			t.Fatalf("position %d = %+v, want %s at %d", i, after[i], want, i+1)
		}
	}
	doc.Do("POST", "/dental/tooth-statuses/reorder", map[string]any{"ids": []string{"x"}}).Expect(t, 400, "bad id")
	doc.Do("POST", "/dental/tooth-statuses/reorder", 7).Expect(t, 400, "malformed body")
}

// TestREG_DENTAL_124_OtherClinicCannotEditToothStatuses: clinic B cannot relabel
// (404), delete or reorder clinic A's conditions.
func TestREG_DENTAL_124_OtherClinicCannotEditToothStatuses(t *testing.T) {
	c := newClinic(t)
	target := dn2Statuses(t, srv.As(t, c, "doctor"), false)[0]
	docB := srv.As(t, clinicB, "doctor")
	dn2Code(t, docB.Do("PUT", "/dental/tooth-statuses/"+target.ID, map[string]any{"label": "hijack", "color": "#000000"}),
		404, "STATUS_NOT_FOUND", "B relabels A's")
	docB.Do("DELETE", "/dental/tooth-statuses/"+target.ID, nil)
	docB.Do("POST", "/dental/tooth-statuses/reorder", map[string]any{"ids": []string{target.ID}})
	var label string
	var deleted bool
	tu := denUUID(t, id.PrefixToothStatus, target.ID)
	one(t, `SELECT label FROM dental_tooth_statuses WHERE id = $1`, &label, tu)
	one(t, `SELECT deleted_at IS NOT NULL FROM dental_tooth_statuses WHERE id = $1`, &deleted, tu)
	if label != target.Label || deleted {
		t.Fatalf("clinic B changed clinic A's condition: label=%q deleted=%v", label, deleted)
	}
}

// ---- medical history -------------------------------------------------------------

type dn2History struct {
	Answers    map[string]string `json:"answers"`
	Notes      string            `json:"notes"`
	Recorded   bool              `json:"recorded"`
	ReviewedAt string            `json:"reviewed_at"`
	ReviewedBy string            `json:"reviewed_by"`
}

// TestREG_DENTAL_130_MedicalHistorySaveAndRead: Given a patient never asked, When
// the dentist reads the history, Then it is "not recorded" with no answers; When
// they save answers and notes, Then the response and a fresh read show them, stamped
// with the dentist and a time; a re-save REPLACES the answers (the form is the
// whole questionnaire) and each save is an audit event.
func TestREG_DENTAL_130_MedicalHistorySaveAndRead(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	path := "/dental/patients/" + p.ID + "/medical-history"

	var h dn2History
	doc.Do("GET", path, nil).Expect(t, 200, "read before recorded").Decode(t, &h)
	if h.Recorded || len(h.Answers) != 0 || h.ReviewedAt != "" {
		t.Fatalf("unrecorded history reads %+v", h)
	}

	notes := uniq("On warfarin since ")
	doc.Do("PUT", path, map[string]any{"answers": map[string]string{"bleeding": "yes", "diabetes": "no"}, "notes": notes}).
		Expect(t, 200, "save").Decode(t, &h)
	if !h.Recorded || h.Answers["bleeding"] != "yes" || h.Notes != notes || h.ReviewedAt == "" ||
		!strings.HasPrefix(h.ReviewedBy, "Doctor ") {
		t.Fatalf("saved history reads %+v", h)
	}
	var again dn2History
	srv.As(t, c, "doctor").Do("GET", path, nil).Expect(t, 200, "fresh read").Decode(t, &again)
	if !again.Recorded || again.Answers["diabetes"] != "no" || again.Notes != notes {
		t.Fatalf("fresh read %+v", again)
	}

	var re dn2History
	doc.Do("PUT", path, map[string]any{"answers": map[string]string{"pregnant": "no"}}).Expect(t, 200, "re-save").Decode(t, &re)
	if _, still := re.Answers["bleeding"]; still || re.Answers["pregnant"] != "no" || re.Notes != "" {
		t.Fatalf("re-save should replace the form, got %+v", re)
	}
	doc.Do("PUT", path, map[string]any{}).Expect(t, 200, "save an empty form") // "asked again, nothing to note"
	var by uuid.UUID
	pu := denUUID(t, id.PrefixPatient, p.ID)
	one(t, `SELECT reviewed_by FROM medical_histories WHERE patient_id = $1`, &by, pu)
	if by != c.Staff["doctor"].ID {
		t.Fatalf("reviewed_by = %s, want the dentist", by)
	}
	if n := dn2Events(t, c.TenantID, "dental.medical_history.recorded", pu.String()); n != 3 {
		t.Fatalf("medical history events = %d, want 3 (one per save)", n)
	}
	doc.Do("PUT", path, "x").Expect(t, 400, "malformed body")
	doc.Do("GET", "/dental/patients/nope/medical-history", nil).Expect(t, 400, "malformed patient id")
}

// TestREG_DENTAL_131_MedicalHistoryIsClinicianOnly: the front desk and the cashier
// can neither read nor write the history (403), and it is not in the summary they
// read — not even for the dentist (it is deliberately kept out of Summary).
func TestREG_DENTAL_131_MedicalHistoryIsClinicianOnly(t *testing.T) {
	c := newClinic(t)
	doc := srv.As(t, c, "doctor")
	p := denPatient(t, c)
	path := "/dental/patients/" + p.ID + "/medical-history"
	secret := uniq("HIV-positive-")
	doc.Do("PUT", path, map[string]any{"answers": map[string]string{"hiv": "yes"}, "notes": secret}).Expect(t, 200, "save")
	for _, role := range []string{"receptionist", "cashier"} {
		cl := srv.As(t, c, role)
		cl.Do("GET", path, nil).Expect(t, 403, role+" reads history")
		cl.Do("PUT", path, map[string]any{"notes": "x"}).Expect(t, 403, role+" writes history")
		if r := cl.Do("GET", "/dental/patients/"+p.ID+"/summary", nil); strings.Contains(r.Raw, secret) {
			t.Fatalf("%s's summary carries the medical history", role)
		}
	}
	if r := doc.Do("GET", "/dental/patients/"+p.ID+"/summary", nil); strings.Contains(r.Raw, secret) {
		t.Fatalf("summary carries the medical history")
	}
}

// TestREG_DENTAL_132_OtherClinicCannotReadOrWriteMedicalHistory: clinic B's dentist
// reads nothing of clinic A's patient's history, and a save naming A's patient must
// be refused as not found and store nothing (NEW-DEN-2: the dental tables reference
// patients(id) alone, so the FK check passes across tenants).
func TestREG_DENTAL_132_OtherClinicCannotReadOrWriteMedicalHistory(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	secret := uniq("Allergic-to-latex-")
	srv.As(t, c, "doctor").Do("PUT", "/dental/patients/"+p.ID+"/medical-history", map[string]any{"notes": secret}).Expect(t, 200, "A saves")

	docB := srv.As(t, clinicB, "doctor")
	r := docB.Do("GET", "/dental/patients/"+p.ID+"/medical-history", nil)
	if strings.Contains(r.Raw, secret) {
		t.Fatalf("clinic B read clinic A's medical history: %s", trimBody(r.Raw))
	}
	w := docB.Do("PUT", "/dental/patients/"+p.ID+"/medical-history", map[string]any{"notes": "B wrote this"})
	var mine string
	one(t, `SELECT coalesce(notes,'') FROM medical_histories WHERE tenant_id = $1 AND patient_id = $2`, &mine, c.TenantID, denUUID(t, id.PrefixPatient, p.ID))
	if mine != secret {
		t.Fatalf("clinic B overwrote clinic A's medical history (now %q)", mine)
	}
	var stray int
	one(t, `SELECT count(*) FROM medical_histories WHERE tenant_id = $1 AND patient_id = $2`, &stray, clinicB.TenantID, denUUID(t, id.PrefixPatient, p.ID))
	if w.Status != 404 || stray != 0 {
		testkit.KnownBug(t, "NEW-DEN-2", true,
			"clinic B saved a medical history against clinic A's patient (HTTP "+itoa(w.Status)+", "+itoa(stray)+" row in B)")
	}
}

// ---- changing a course ------------------------------------------------------------

// TestREG_DENTAL_140_UpdatePlanEditsTitleToothNote: When the dentist renames a
// course, sets its tooth and note, Then they persist, a field left out of the
// request is untouched, and the front desk sees the title but not the clinical
// tooth or note (D19 seal).
func TestREG_DENTAL_140_UpdatePlanEditsTitleToothNote(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	path := k.path("/plans/" + k.plan.ID)
	note := uniq("Fractured cusp, ")
	k.doc.Do("PUT", path, map[string]any{"title": "Crown LL6", "tooth": "LL6", "note": note}).Expect(t, 204, "edit plan")
	k.doc.Do("PUT", path, map[string]any{"note": note + "!"}).Expect(t, 204, "edit note only")

	var title, tooth, gotNote string
	pu := dn2PlanUUID(t, k.plan.ID)
	one(t, `SELECT title FROM treatment_plans WHERE id = $1`, &title, pu)
	one(t, `SELECT coalesce(tooth,'') FROM treatment_plans WHERE id = $1`, &tooth, pu)
	one(t, `SELECT coalesce(note,'') FROM treatment_plans WHERE id = $1`, &gotNote, pu)
	if title != "Crown LL6" || tooth != "LL6" || gotNote != note+"!" {
		t.Fatalf("plan after edits: title=%q tooth=%q note=%q", title, tooth, gotNote)
	}
	var desk []struct {
		Title string `json:"title"`
		Tooth string `json:"tooth"`
		Note  string `json:"note"`
	}
	srv.As(t, k.c, "receptionist").Do("GET", k.path("/plans"), nil).Expect(t, 200, "desk lists plans").Decode(t, &desk)
	if len(desk) != 1 || desk[0].Title != "Crown LL6" || desk[0].Tooth != "" || desk[0].Note != "" {
		t.Fatalf("desk sees plan %+v, want the title only", desk)
	}
}

// TestREG_DENTAL_141_UpdatePlanCannotChangeStatus: a course is finished or
// cancelled through its own actions; a status in the edit is 400 and the course
// stays active. An unknown course is 404 PLAN_NOT_FOUND, malformed ids/body 400,
// and the front desk cannot edit a course (403).
func TestREG_DENTAL_141_UpdatePlanCannotChangeStatus(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	path := k.path("/plans/" + k.plan.ID)
	for _, st := range []string{"cancelled", "completed", "active"} {
		dn2Code(t, k.doc.Do("PUT", path, map[string]any{"status": st, "title": "x"}), 400, "VALIDATION_FAILED", "status "+st)
	}
	if st, _ := dn2Plan(t, k.plan.ID); st != "active" {
		t.Fatalf("a refused status edit left the plan %s", st)
	}
	var title string
	one(t, `SELECT title FROM treatment_plans WHERE id = $1`, &title, dn2PlanUUID(t, k.plan.ID))
	if title == "x" {
		t.Fatalf("a refused edit still changed the title")
	}
	dn2Code(t, k.doc.Do("PUT", k.path("/plans/"+id.Encode(id.PrefixTreatmentPlan, uuid.New())), map[string]any{"title": "x"}),
		404, "PLAN_NOT_FOUND", "unknown plan")
	k.doc.Do("PUT", k.path("/plans/nope"), map[string]any{"title": "x"}).Expect(t, 400, "malformed plan id")
	k.doc.Do("PUT", "/dental/patients/nope/plans/"+k.plan.ID, map[string]any{"title": "x"}).Expect(t, 400, "malformed patient id")
	k.doc.Do("PUT", path, "x").Expect(t, 400, "malformed body")
	srv.As(t, k.c, "receptionist").Do("PUT", path, map[string]any{"title": "desk"}).Expect(t, 403, "desk edits plan")
}

// TestREG_DENTAL_142_UpdatePlanRefusesAnEmptyTitle: a course must have a name when
// created ("a treatment name is required"); editing it to "" must be refused the
// same way, or the course turns nameless on every receipt and list.
func TestREG_DENTAL_142_UpdatePlanRefusesAnEmptyTitle(t *testing.T) {
	k := dn2NewCourse(t, 1, "")
	r := k.doc.Do("PUT", k.path("/plans/"+k.plan.ID), map[string]any{"title": "  "})
	var title string
	one(t, `SELECT title FROM treatment_plans WHERE id = $1`, &title, dn2PlanUUID(t, k.plan.ID))
	if r.Status == 204 && strings.TrimSpace(title) == "" {
		testkit.KnownBug(t, "NEW-DEN-3", true,
			"PUT /dental/patients/:id/plans/:pid accepts a blank title and stores it (service.go:858-865 has no title check, CreatePlan does)")
	}
	r.Expect(t, 400, "blank title")
	if title != "Root canal" {
		t.Fatalf("refused edit changed the title to %q", title)
	}
}

// TestREG_DENTAL_143_OtherClinicCannotEditOrExtendAPlan: clinic B's dentist cannot
// edit, add a visit to, finish or reprice clinic A's course: each is 404 and A's
// course is unchanged.
func TestREG_DENTAL_143_OtherClinicCannotEditOrExtendAPlan(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	docB := srv.As(t, clinicB, "doctor")
	dn2Code(t, docB.Do("PUT", k.path("/plans/"+k.plan.ID), map[string]any{"title": "B"}), 404, "PLAN_NOT_FOUND", "B edits")
	dn2Code(t, docB.Do("POST", k.path("/plans/"+k.plan.ID+"/sessions"), map[string]any{"scheduled_date": denToday(), "amount_due": "5"}),
		404, "PLAN_NOT_FOUND", "B adds a visit")
	dn2Code(t, docB.Do("POST", k.path("/plans/"+k.plan.ID+"/finish"), nil), 404, "PLAN_NOT_FOUND", "B finishes")
	dn2Code(t, docB.Do("POST", k.path("/sessions/"+k.sid(0)+"/reprice"), map[string]any{"amount": "1", "mode": "total"}),
		404, "SESSION_NOT_FOUND", "B reprices")
	st, total := dn2Plan(t, k.plan.ID)
	var n int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE plan_id = $1`, &n, dn2PlanUUID(t, k.plan.ID))
	var title string
	one(t, `SELECT title FROM treatment_plans WHERE id = $1`, &title, dn2PlanUUID(t, k.plan.ID))
	if st != "active" || total != 2000 || n != 2 || title != "Root canal" {
		t.Fatalf("clinic B changed clinic A's course: status=%s total=%.2f sessions=%d title=%q", st, total, n, title)
	}
}

// ---- adding a visit ---------------------------------------------------------------

type dn2AddedSession struct {
	ID            string `json:"id"`
	Seq           int    `json:"seq"`
	Status        string `json:"status"`
	ScheduledDate string `json:"scheduled_date"`
	AmountDue     string `json:"amount_due"`
	Payment       string `json:"payment"`
}

// TestREG_DENTAL_150_AddVisitExtendsTheCourse: Given a 2-visit 2,000 course, When
// the dentist adds a third visit of 750 in 30 days, Then it is visit 3, planned and
// unpaid, and the course now counts 3 visits, totals 2,750 and ends on that date. A
// visit added with no fee is a 0 visit, not an error.
func TestREG_DENTAL_150_AddVisitExtendsTheCourse(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	var s dn2AddedSession
	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/sessions"), map[string]any{"scheduled_date": denDay(30), "amount_due": "750"}).
		Expect(t, 201, "add visit").Decode(t, &s)
	if s.Seq != 3 || s.Status != "planned" || s.Payment != "unpaid" || s.ScheduledDate != denDay(30) || denMoney(t, s.AmountDue) != 750 {
		t.Fatalf("added visit %+v", s)
	}
	var count int
	var deadline string
	pu := dn2PlanUUID(t, k.plan.ID)
	one(t, `SELECT session_count FROM treatment_plans WHERE id = $1`, &count, pu)
	one(t, `SELECT deadline::text FROM treatment_plans WHERE id = $1`, &deadline, pu)
	_, total := dn2Plan(t, k.plan.ID)
	if count != 3 || total != 2750 || deadline != denDay(30) {
		t.Fatalf("course after adding: %d visits, total %.2f, ends %s", count, total, deadline)
	}
	if n := dn2Events(t, k.c.TenantID, "dental.session.added", dn2SessUUID(t, s.ID).String()); n != 1 {
		t.Fatalf("session.added events = %d, want 1", n)
	}
	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/sessions"), map[string]any{"scheduled_date": denDay(40)}).Expect(t, 201, "add a 0 visit").Decode(t, &s)
	if s.Seq != 4 || denMoney(t, s.AmountDue) != 0 {
		t.Fatalf("visit added without a fee: %+v", s)
	}
}

// TestREG_DENTAL_151_AddVisitRefusals: a date that is not YYYY-MM-DD, a fee that is
// not a plain non-negative number, an unknown course and a cancelled course are all
// refused, and none of them adds a row.
func TestREG_DENTAL_151_AddVisitRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	path := k.path("/plans/" + k.plan.ID + "/sessions")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"scheduled_date": "12/10/2026", "amount_due": "5"}), 400, "VALIDATION_FAILED", "bad date")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"amount_due": "5"}), 400, "VALIDATION_FAILED", "no date")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"scheduled_date": denToday(), "amount_due": "1,500"}), 400, "VALIDATION_FAILED", "fee with a comma")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"scheduled_date": denToday(), "amount_due": "-10"}), 400, "VALIDATION_FAILED", "negative fee")
	k.doc.Do("POST", path, "x").Expect(t, 400, "malformed body")
	dn2Code(t, k.doc.Do("POST", k.path("/plans/"+id.Encode(id.PrefixTreatmentPlan, uuid.New())+"/sessions"),
		map[string]any{"scheduled_date": denToday()}), 404, "PLAN_NOT_FOUND", "unknown plan")
	k.doc.Do("POST", k.path("/plans/xx/sessions"), map[string]any{"scheduled_date": denToday()}).Expect(t, 400, "malformed plan id")
	srv.As(t, k.c, "receptionist").Do("POST", path, map[string]any{"scheduled_date": denToday()}).Expect(t, 403, "desk adds a visit")

	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/cancel"), map[string]any{"reason": "patient withdrew"}).Expect(t, 200, "cancel")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"scheduled_date": denToday(), "amount_due": "5"}), 409, "PLAN_CANCELLED", "add to a cancelled course")
	var n int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE plan_id = $1`, &n, dn2PlanUUID(t, k.plan.ID))
	if n != 2 {
		t.Fatalf("refused additions left %d sessions, want 2", n)
	}
}

// TestREG_DENTAL_152_AddVisitReopensAFinishedCourse: Given a course finished early,
// When the patient needs one more visit and the dentist adds it, Then the course is
// running again (active) with the new visit counted.
func TestREG_DENTAL_152_AddVisitReopensAFinishedCourse(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "done")
	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/finish"), nil).Expect(t, 200, "finish")
	if st, _ := dn2Plan(t, k.plan.ID); st != "completed" {
		t.Fatalf("finished course is %s", st)
	}
	var s dn2AddedSession
	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/sessions"), map[string]any{"scheduled_date": denDay(7), "amount_due": "400"}).
		Expect(t, 201, "add after finishing").Decode(t, &s)
	st, total := dn2Plan(t, k.plan.ID)
	var count int
	one(t, `SELECT session_count FROM treatment_plans WHERE id = $1`, &count, dn2PlanUUID(t, k.plan.ID))
	// visit 1 done (1,000), visit 2 cancelled by the finish, visit 3 new (400).
	if st != "active" || total != 1400 || s.Seq != 3 || count != 3 {
		t.Fatalf("reopened course: status=%s total=%.2f new seq=%d count=%d; want active 1400 seq 3 count 3", st, total, s.Seq, count)
	}
}

// ---- finishing a course early ------------------------------------------------------

// TestREG_DENTAL_160_FinishCourseKeepsWhatWasGivenOrPaidAhead: Given a 4-visit
// course where visit 1 was given (unbilled), visit 2 was paid for ahead at the desk
// (collected, still planned) and visits 3–4 never happened, When the dentist
// finishes it, Then only visits 3 and 4 are cancelled (sessions_cancelled = 2),
// visit 1 stays done and owed, visit 2 stays planned with its bill at the cashier,
// and the course is completed with total 2,000, 2 visits, ending on visit 2's date.
func TestREG_DENTAL_160_FinishCourseKeepsWhatWasGivenOrPaidAhead(t *testing.T) {
	k := dn2NewCourse(t, 4, "")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	srv.As(t, k.c, "receptionist").Do("POST", k.path("/sessions/"+k.sid(1)+"/collect"), nil).Expect(t, 204, "desk collects visit 2 ahead")

	var out struct {
		N int `json:"sessions_cancelled"`
	}
	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/finish"), nil).Expect(t, 200, "finish").Decode(t, &out)
	if out.N != 2 {
		t.Fatalf("sessions_cancelled = %d, want 2", out.N)
	}
	want := []string{"done", "planned", "cancelled", "cancelled"}
	for i, w := range want {
		if st, _ := dn2Sess(t, k.sid(i)); st != w {
			t.Fatalf("visit %d is %s after finishing, want %s", i+1, st, w)
		}
	}
	if ch := dn2Charge(t, k.sid(1)); ch != "pending" {
		t.Fatalf("paid-ahead visit's bill is %q, want still pending", ch)
	}
	st, total := dn2Plan(t, k.plan.ID)
	var count int
	var deadline string
	pu := dn2PlanUUID(t, k.plan.ID)
	one(t, `SELECT session_count FROM treatment_plans WHERE id = $1`, &count, pu)
	one(t, `SELECT deadline::text FROM treatment_plans WHERE id = $1`, &deadline, pu)
	if st != "completed" || total != 2000 || count != 2 || deadline != k.plan.Sessions[1].ScheduledDate {
		t.Fatalf("finished course: status=%s total=%.2f count=%d deadline=%s", st, total, count, deadline)
	}
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 1000 || denMoney(t, b.AtCashier) != 1000 {
		t.Fatalf("after finishing: due=%s at_cashier=%s, want 1000 and 1000", b.Due, b.AtCashier)
	}
	if n := dn2Events(t, k.c.TenantID, "dental.plan.completed", dn2PlanUUID(t, k.plan.ID).String()); n != 1 {
		t.Fatalf("plan.completed events = %d, want 1", n)
	}
}

// TestREG_DENTAL_161_FinishCourseKeepsAnUnpaidDepositOwed: Given a course with an
// unpaid 500 down payment, When it is finished before any visit, Then every visit is
// cancelled but the deposit is not — it stays owed (audit D3).
func TestREG_DENTAL_161_FinishCourseKeepsAnUnpaidDepositOwed(t *testing.T) {
	k := dn2NewCourse(t, 2, "500")
	if k.plan.Deposit == nil {
		t.Fatalf("course has no deposit")
	}
	var out struct {
		N int `json:"sessions_cancelled"`
	}
	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/finish"), nil).Expect(t, 200, "finish").Decode(t, &out)
	if st, _ := dn2Sess(t, k.plan.Deposit.ID); st != "planned" || out.N != 2 {
		t.Fatalf("deposit is %s, %d cancelled; want the deposit kept and 2 visits cancelled", st, out.N)
	}
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 500 {
		t.Fatalf("after finishing, due = %s, want the 500 deposit", b.Due)
	}
}

// TestREG_DENTAL_162_FinishCourseExtrasGoWithTheirVisit: an extra added to a visit
// that never happened is cancelled with it; an extra on a given visit stays.
func TestREG_DENTAL_162_FinishCourseExtrasGoWithTheirVisit(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	svc := denDentalService(t, k.doc, 300)
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	for _, i := range []int{0, 1} {
		k.doc.Do("POST", k.path("/sessions/"+k.sid(i)+"/extras"), map[string]any{"service_id": svc}).Expect(t, 204, "add extra")
	}
	k.doc.Do("POST", k.path("/plans/"+k.plan.ID+"/finish"), nil).Expect(t, 200, "finish")
	var givenExtra, plannedExtra string
	one(t, `SELECT status FROM treatment_sessions WHERE parent_session_id = $1 AND kind = 'extra'`, &givenExtra, dn2SessUUID(t, k.sid(0)))
	one(t, `SELECT status FROM treatment_sessions WHERE parent_session_id = $1 AND kind = 'extra'`, &plannedExtra, dn2SessUUID(t, k.sid(1)))
	if givenExtra != "done" || plannedExtra != "cancelled" {
		t.Fatalf("extras after finishing: on given visit %s, on cancelled visit %s", givenExtra, plannedExtra)
	}
	if _, total := dn2Plan(t, k.plan.ID); total != 1300 {
		t.Fatalf("finished total %.2f, want 1300 (visit 1 + its extra)", total)
	}
}

// TestREG_DENTAL_163_FinishCourseRefusals: finishing twice, finishing a cancelled
// course, an unknown course and a malformed id are refused; the desk cannot finish.
func TestREG_DENTAL_163_FinishCourseRefusals(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	path := k.path("/plans/" + k.plan.ID + "/finish")
	srv.As(t, k.c, "receptionist").Do("POST", path, nil).Expect(t, 403, "desk finishes")
	k.doc.Do("POST", path, nil).Expect(t, 200, "finish")
	dn2Code(t, k.doc.Do("POST", path, nil), 409, "PLAN_NOT_ACTIVE", "finish twice")

	k2 := createPlan(t, k.doc, k.p.ID, "1000", 1, "")
	k.doc.Do("POST", k.path("/plans/"+k2.ID+"/cancel"), map[string]any{"reason": "mistake"}).Expect(t, 200, "cancel")
	dn2Code(t, k.doc.Do("POST", k.path("/plans/"+k2.ID+"/finish"), nil), 409, "PLAN_NOT_ACTIVE", "finish a cancelled course")
	if st, _ := dn2Plan(t, k2.ID); st != "cancelled" {
		t.Fatalf("refused finish left the cancelled course %s", st)
	}
	dn2Code(t, k.doc.Do("POST", k.path("/plans/"+id.Encode(id.PrefixTreatmentPlan, uuid.New())+"/finish"), nil), 404, "PLAN_NOT_FOUND", "unknown")
	k.doc.Do("POST", k.path("/plans/zz/finish"), nil).Expect(t, 400, "malformed id")
}

// ---- repricing a visit ------------------------------------------------------------

// TestREG_DENTAL_170_RepriceRespreadKeepsTheCourseTotal: Given a 3,000 course of
// three 1,000 visits, When visit 1 becomes 1,600 "respread", Then visits 2 and 3
// absorb the difference (700 each) and the course still totals 3,000.
func TestREG_DENTAL_170_RepriceRespreadKeepsTheCourseTotal(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/reprice"), map[string]any{"amount": "1600", "mode": "respread"}).Expect(t, 204, "reprice")
	for i, want := range []float64{1600, 700, 700} {
		if _, a := dn2Sess(t, k.sid(i)); a != want {
			t.Fatalf("visit %d fee %.2f, want %.2f", i+1, a, want)
		}
	}
	if _, total := dn2Plan(t, k.plan.ID); total != 3000 {
		t.Fatalf("course total %.2f, want 3000", total)
	}
	if n := dn2Events(t, k.c.TenantID, "dental.session.repriced", denUUID(t, id.PrefixPatient, k.p.ID).String()); n != 1 {
		t.Fatalf("repriced events = %d, want 1", n)
	}
	// Lowering it again gives the money back to the later visits.
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/reprice"), map[string]any{"amount": "500", "mode": "respread"}).Expect(t, 204, "reprice down")
	for i, want := range []float64{500, 1250, 1250} {
		if _, a := dn2Sess(t, k.sid(i)); a != want {
			t.Fatalf("after lowering: visit %d fee %.2f, want %.2f", i+1, a, want)
		}
	}
}

// TestREG_DENTAL_171_RepriceTotalMovesOnlyTheCourseTotal: "total" mode leaves the
// other visits alone and the course total moves by the difference.
func TestREG_DENTAL_171_RepriceTotalMovesOnlyTheCourseTotal(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(1)+"/reprice"), map[string]any{"amount": "1600", "mode": "total"}).Expect(t, 204, "reprice")
	for i, want := range []float64{1000, 1600, 1000} {
		if _, a := dn2Sess(t, k.sid(i)); a != want {
			t.Fatalf("visit %d fee %.2f, want %.2f", i+1, a, want)
		}
	}
	if _, total := dn2Plan(t, k.plan.ID); total != 3600 {
		t.Fatalf("course total %.2f, want 3600", total)
	}
}

// TestREG_DENTAL_172_RepriceValidation: the mode must be respread or total; the fee a
// plain non-negative number; the last visit cannot respread (nothing after it); a
// respread larger than the later visits hold is refused; a down payment is not a
// visit; unknown session 404; the desk cannot reprice. Nothing changes on a refusal.
func TestREG_DENTAL_172_RepriceValidation(t *testing.T) {
	k := dn2NewCourse(t, 3, "600")
	p := func(sid string) string { return k.path("/sessions/" + sid + "/reprice") }
	dn2Code(t, k.doc.Do("POST", p(k.sid(0)), map[string]any{"amount": "100", "mode": "split"}), 400, "VALIDATION_FAILED", "unknown mode")
	dn2Code(t, k.doc.Do("POST", p(k.sid(0)), map[string]any{"amount": "100"}), 400, "VALIDATION_FAILED", "no mode")
	dn2Code(t, k.doc.Do("POST", p(k.sid(0)), map[string]any{"amount": "1,000", "mode": "total"}), 400, "VALIDATION_FAILED", "comma fee")
	dn2Code(t, k.doc.Do("POST", p(k.sid(0)), map[string]any{"amount": "-1", "mode": "total"}), 400, "VALIDATION_FAILED", "negative fee")
	dn2Code(t, k.doc.Do("POST", p(k.sid(0)), map[string]any{"amount": "NaN", "mode": "total"}), 400, "VALIDATION_FAILED", "NaN fee")
	k.doc.Do("POST", p(k.sid(0)), "x").Expect(t, 400, "malformed body")
	dn2Code(t, k.doc.Do("POST", p(k.sid(2)), map[string]any{"amount": "1500", "mode": "respread"}), 400, "VALIDATION_FAILED", "respread the last visit")
	dn2Code(t, k.doc.Do("POST", p(k.sid(0)), map[string]any{"amount": "4000", "mode": "respread"}), 400, "VALIDATION_FAILED", "respread more than the rest holds")
	dn2Code(t, k.doc.Do("POST", p(k.plan.Deposit.ID), map[string]any{"amount": "100", "mode": "total"}), 400, "VALIDATION_FAILED", "reprice the deposit")
	dn2Code(t, k.doc.Do("POST", p(id.Encode(id.PrefixTreatmentSession, uuid.New())), map[string]any{"amount": "1", "mode": "total"}),
		404, "SESSION_NOT_FOUND", "unknown session")
	k.doc.Do("POST", p("zz"), map[string]any{"amount": "1", "mode": "total"}).Expect(t, 400, "malformed session id")
	srv.As(t, k.c, "receptionist").Do("POST", p(k.sid(0)), map[string]any{"amount": "1", "mode": "total"}).Expect(t, 403, "desk reprices")
	for i := 0; i < 3; i++ {
		if _, a := dn2Sess(t, k.sid(i)); a != 1000 {
			t.Fatalf("refused reprices changed visit %d to %.2f", i+1, a)
		}
	}
	if _, total := dn2Plan(t, k.plan.ID); total != 3600 {
		t.Fatalf("refused reprices changed the course total to %.2f", total)
	}
}

// TestREG_DENTAL_173_RepriceFreezesBilledVisits: a visit whose fee is at the cashier
// cannot be repriced (409 SESSION_ALREADY_BILLED), and a respread never lands on a
// later visit that is billed or already given — only planned, unbilled ones absorb.
func TestREG_DENTAL_173_RepriceFreezesBilledVisits(t *testing.T) {
	k := dn2NewCourse(t, 4, "")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/collect"), nil).Expect(t, 204, "collect visit 1")
	dn2Code(t, k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/reprice"), map[string]any{"amount": "1200", "mode": "total"}),
		409, "SESSION_ALREADY_BILLED", "reprice a billed visit")

	k.doc.Do("POST", k.path("/sessions/"+k.sid(2)+"/collect"), nil).Expect(t, 204, "collect visit 3 ahead")
	denRecord(t, k.doc, k.p.ID, k.sid(3), "given early")
	// visit 2 up by 600 respread: visit 3 is billed, visit 4 is given → nothing can absorb.
	dn2Code(t, k.doc.Do("POST", k.path("/sessions/"+k.sid(1)+"/reprice"), map[string]any{"amount": "1600", "mode": "respread"}),
		400, "VALIDATION_FAILED", "respread with only frozen visits after")

	k2 := dn2NewCourse(t, 4, "")
	k2.doc.Do("POST", k2.path("/sessions/"+k2.sid(2)+"/collect"), nil).Expect(t, 204, "collect visit 3 ahead")
	k2.doc.Do("POST", k2.path("/sessions/"+k2.sid(0)+"/reprice"), map[string]any{"amount": "400", "mode": "respread"}).Expect(t, 204, "respread")
	for i, want := range []float64{400, 1300, 1000, 1300} {
		if _, a := dn2Sess(t, k2.sid(i)); a != want {
			t.Fatalf("visit %d fee %.2f, want %.2f (billed visit 3 must be untouched)", i+1, a, want)
		}
	}
}

// TestREG_DENTAL_174_LoweringAGivenVisitsFeeIsForgiveness: Given visit 1 recorded
// today by dentist A, unbilled, When its fee is lowered, Then dentist A must give a
// reason (400 without), dentist B is refused 403 VISIT_OWED even with one, and the
// owner (payment.waive) may with a reason. Raising a given visit's fee needs no
// reason — it forgives nothing.
func TestREG_DENTAL_174_LoweringAGivenVisitsFeeIsForgiveness(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	docB, _ := denSecondDentist(t, k.c)
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	path := k.path("/sessions/" + k.sid(0) + "/reprice")

	dn2Code(t, k.doc.Do("POST", path, map[string]any{"amount": "800", "mode": "total"}), 400, "VALIDATION_FAILED", "author, no reason")
	dn2Code(t, docB.Do("POST", path, map[string]any{"amount": "800", "mode": "total", "reason": "discount"}), 403, "VISIT_OWED", "colleague")
	if _, a := dn2Sess(t, k.sid(0)); a != 1000 {
		t.Fatalf("refused cuts changed the fee to %.2f", a)
	}
	k.doc.Do("POST", path, map[string]any{"amount": "900", "mode": "total", "reason": "less work than planned"}).Expect(t, 204, "author with reason")
	ownerDoc := srv.As(t, k.c, "owner")
	ownerDoc.Do("POST", path, map[string]any{"amount": "700", "mode": "total", "reason": "owner discount"}).Expect(t, 204, "owner with reason")
	docB.Do("POST", path, map[string]any{"amount": "1100", "mode": "total"}).Expect(t, 204, "colleague raises, no reason")
	if _, a := dn2Sess(t, k.sid(0)); a != 1100 {
		t.Fatalf("visit 1 fee %.2f, want 1100", a)
	}
}

// TestREG_DENTAL_175_RepriceACancelledVisitDoesNotMoveTheCourse: Given a 3-visit
// course whose visit 1 was called off (cancelled; the course now totals 2,000),
// When visit 1 is "repriced" to 0 with respread — which promises to keep the course
// total — Then the course still totals 2,000 and visits 2–3 keep 1,000 each (or the
// reprice is refused). RepriceSession never checks the visit's status, so the
// cancelled visit's 1,000 is spread onto the live visits and the patient is quoted
// 1,000 more than the course they agreed.
func TestREG_DENTAL_175_RepriceACancelledVisitDoesNotMoveTheCourse(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(0)), map[string]any{"status": "cancelled"}).Expect(t, 204, "cancel visit 1")
	if _, total := dn2Plan(t, k.plan.ID); total != 2000 {
		t.Fatalf("course after cancelling visit 1 totals %.2f, want 2000", total)
	}
	r := k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/reprice"), map[string]any{"amount": "0", "mode": "respread"})
	_, total := dn2Plan(t, k.plan.ID)
	_, v2 := dn2Sess(t, k.sid(1))
	if total != 2000 || v2 != 1000 {
		testkit.KnownBug(t, "NEW-DEN-4", true,
			"repricing a CANCELLED visit with mode=respread moved the course total to "+dn2F(total)+" and visit 2 to "+dn2F(v2)+
				" (HTTP "+itoa(r.Status)+"); service.go:2975-3106 has no status check")
	}
	if r.Status != 204 && r.Status != 409 && r.Status != 400 {
		t.Fatalf("reprice of a cancelled visit: HTTP %d", r.Status)
	}
}

func dn2F(f float64) string { return strconv.FormatFloat(f, 'f', 2, 64) }

// ---- pulling a bill back --------------------------------------------------------------

// TestREG_DENTAL_180_UncollectNeedsAReasonAndVoidsTheBill: Given visit 1's fee at the
// cashier, When the dentist pulls it back without a reason, Then 400 and it stays at
// the cashier; With one, Then the charge is voided (kept, with the reason), the visit
// has no bill, and it is billable again.
func TestREG_DENTAL_180_UncollectNeedsAReasonAndVoidsTheBill(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	sid := k.sid(0)
	k.doc.Do("POST", k.path("/sessions/"+sid+"/collect"), nil).Expect(t, 204, "collect")
	var chargeID uuid.UUID
	one(t, `SELECT charge_id FROM treatment_sessions WHERE id = $1`, &chargeID, dn2SessUUID(t, sid))
	path := k.path("/sessions/" + sid + "/uncollect")

	dn2Code(t, k.doc.Do("POST", path, map[string]any{"reason": "  "}), 400, "VALIDATION_FAILED", "blank reason")
	k.doc.Do("POST", path, nil).Expect(t, 400, "no body")
	if dn2Charge(t, sid) != "pending" {
		t.Fatalf("refused uncollect changed the bill")
	}
	k.doc.Do("POST", path, map[string]any{"reason": "wrong visit"}).Expect(t, 204, "uncollect")

	var st, why string
	one(t, `SELECT status FROM charges WHERE id = $1`, &st, chargeID)
	one(t, `SELECT coalesce(void_reason,'') FROM charges WHERE id = $1`, &why, chargeID)
	if st != "void" || !strings.Contains(why, "wrong visit") || dn2Charge(t, sid) != "" {
		t.Fatalf("after uncollect: charge %s (%q), session link %q", st, why, dn2Charge(t, sid))
	}
	if len(payPendingFor(t, srv.As(t, k.c, "cashier"), k.p.ID)) != 0 {
		t.Fatalf("a pulled-back bill is still on the cashier's queue")
	}
	k.doc.Do("POST", k.path("/sessions/"+sid+"/collect"), nil).Expect(t, 204, "bill again")
	if n := dn2Events(t, k.c.TenantID, "dental.charge.reversed", "wrong visit"); n != 1 {
		t.Fatalf("charge.reversed events = %d, want 1", n)
	}
}

// TestREG_DENTAL_181_UncollectRefusals: nothing at the cashier is 409
// NOTHING_TO_REVERSE; a paid bill is 409 NOT_PENDING (refund it instead); an unknown
// session is 404. The front desk (payment.charge only) may not pull a bill back; the
// cashier (payment.waive) may.
func TestREG_DENTAL_181_UncollectRefusals(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	u := func(sid string) string { return k.path("/sessions/" + sid + "/uncollect") }
	body := map[string]any{"reason": "test"}
	dn2Code(t, k.doc.Do("POST", u(k.sid(0)), body), 409, "NOTHING_TO_REVERSE", "nothing billed")
	dn2Code(t, k.doc.Do("POST", u(id.Encode(id.PrefixTreatmentSession, uuid.New())), body), 404, "SESSION_NOT_FOUND", "unknown")
	k.doc.Do("POST", u("zz"), body).Expect(t, 400, "malformed id")

	cashier := srv.As(t, k.c, "cashier")
	denRecord(t, k.doc, k.p.ID, k.sid(0), "given")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/collect"), nil).Expect(t, 204, "collect 1")
	paySettle(cashier, dn2PendingCharge(t, k.c, k.p.ID)).Expect(t, 204, "settle")
	dn2Code(t, k.doc.Do("POST", u(k.sid(0)), body), 409, "NOT_PENDING", "paid bill")

	k.doc.Do("POST", k.path("/sessions/"+k.sid(1)+"/collect"), nil).Expect(t, 204, "collect 2")
	srv.As(t, k.c, "receptionist").Do("POST", u(k.sid(1)), body).Expect(t, 403, "desk pulls back")
	cashier.Do("POST", u(k.sid(1)), body).Expect(t, 204, "cashier pulls back")
	if dn2Charge(t, k.sid(1)) != "" || dn2Charge(t, k.sid(0)) != "paid" {
		t.Fatalf("links after: visit1 %q visit2 %q", dn2Charge(t, k.sid(0)), dn2Charge(t, k.sid(1)))
	}
}

// ---- collecting several visits at once -----------------------------------------------

// TestREG_DENTAL_185_CollectSessionsBillsWhatWasTicked: When the desk sends visits 1
// and 2 of a 3-visit course to the cashier at once, Then 2 are billed for 2,000 and
// there are exactly two pending charges; sending 1 (already billed) and 3 together
// bills only 3 — the billed one is skipped, not billed twice.
func TestREG_DENTAL_185_CollectSessionsBillsWhatWasTicked(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	desk := srv.As(t, k.c, "receptionist")
	var out struct {
		Billed int    `json:"billed"`
		Total  string `json:"total"`
	}
	desk.Do("POST", k.path("/collect-sessions"), map[string]any{"session_ids": []string{k.sid(0), k.sid(1)}}).
		Expect(t, 200, "bulk collect").Decode(t, &out)
	if out.Billed != 2 || denMoney(t, out.Total) != 2000 {
		t.Fatalf("bulk collect: %+v, want 2 for 2000", out)
	}
	if n := len(payPendingFor(t, srv.As(t, k.c, "cashier"), k.p.ID)); n != 2 {
		t.Fatalf("%d pending charges, want 2", n)
	}
	desk.Do("POST", k.path("/collect-sessions"), map[string]any{"session_ids": []string{k.sid(0), k.sid(2)}}).
		Expect(t, 200, "mixed").Decode(t, &out)
	if out.Billed != 1 || denMoney(t, out.Total) != 1000 {
		t.Fatalf("mixed bulk collect: %+v, want 1 for 1000", out)
	}
	var charges int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1 AND deleted_at IS NULL`, &charges, denUUID(t, id.PrefixPatient, k.p.ID))
	if charges != 3 {
		t.Fatalf("%d charges for three visits", charges)
	}
}

// TestREG_DENTAL_186_CollectSessionsRefusals: an empty list is 400 (it used to mean
// "bill the whole future course"); a malformed id or body is 400; a list of only
// billed, cancelled, written-off, zero-fee or other-patient visits is 409
// NOTHING_TO_COLLECT; a nurse (no billing or dental permission) is 403.
func TestREG_DENTAL_186_CollectSessionsRefusals(t *testing.T) {
	k := dn2NewCourse(t, 4, "")
	path := k.path("/collect-sessions")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{"session_ids": []string{}}), 400, "VALIDATION_FAILED", "empty list")
	dn2Code(t, k.doc.Do("POST", path, map[string]any{}), 400, "VALIDATION_FAILED", "no list")
	k.doc.Do("POST", path, "x").Expect(t, 400, "malformed body")
	k.doc.Do("POST", path, map[string]any{"session_ids": []string{"zz"}}).Expect(t, 400, "malformed id")
	srv.As(t, k.c, "nurse").Do("POST", path, map[string]any{"session_ids": []string{k.sid(0)}}).Expect(t, 403, "nurse")

	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/collect"), nil).Expect(t, 204, "visit 1 billed")
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(1)), map[string]any{"status": "cancelled"}).Expect(t, 204, "visit 2 cancelled")
	srv.As(t, k.c, "cashier").Do("POST", k.path("/sessions/"+k.sid(2)+"/write-off"), map[string]any{"reason": "goodwill"}).Expect(t, 204, "visit 3 waived")
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(3)), map[string]any{"amount_due": "0"}).Expect(t, 204, "visit 4 free")
	other := createPlan(t, k.doc, denPatient(t, k.c).ID, "1000", 1, "")

	dn2Code(t, k.doc.Do("POST", path, map[string]any{"session_ids": []string{k.sid(0), k.sid(1), k.sid(2), k.sid(3), other.Sessions[0].ID}}),
		409, "NOTHING_TO_COLLECT", "nothing billable")
	if dn2Charge(t, k.sid(2)) != "waived" || dn2Charge(t, other.Sessions[0].ID) != "" {
		t.Fatalf("refused bulk collect changed a bill: visit3 %q other %q", dn2Charge(t, k.sid(2)), dn2Charge(t, other.Sessions[0].ID))
	}
}

// TestREG_DENTAL_187_SingleCollectRefusals: collecting a cancelled visit is 409
// SESSION_CANCELLED, a billed one 409 SESSION_ALREADY_BILLED, a written-off one 409
// SESSION_WAIVED, a zero-fee visit 400, an unknown one 404 — and none raises a charge.
func TestREG_DENTAL_187_SingleCollectRefusals(t *testing.T) {
	k := dn2NewCourse(t, 4, "")
	c := func(sid string) string { return k.path("/sessions/" + sid + "/collect") }
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(0)), map[string]any{"status": "cancelled"}).Expect(t, 204, "cancel visit 1")
	dn2Code(t, k.doc.Do("POST", c(k.sid(0)), nil), 409, "SESSION_CANCELLED", "cancelled visit")
	k.doc.Do("POST", c(k.sid(1)), nil).Expect(t, 204, "collect visit 2")
	dn2Code(t, k.doc.Do("POST", c(k.sid(1)), nil), 409, "SESSION_ALREADY_BILLED", "twice")
	srv.As(t, k.c, "cashier").Do("POST", k.path("/sessions/"+k.sid(2)+"/write-off"), map[string]any{"reason": "goodwill"}).Expect(t, 204, "waive 3")
	dn2Code(t, k.doc.Do("POST", c(k.sid(2)), nil), 409, "SESSION_WAIVED", "written off")
	k.doc.Do("PUT", k.path("/sessions/"+k.sid(3)), map[string]any{"amount_due": "0"}).Expect(t, 204, "visit 4 free")
	dn2Code(t, k.doc.Do("POST", c(k.sid(3)), nil), 400, "VALIDATION_FAILED", "zero fee")
	dn2Code(t, k.doc.Do("POST", c(id.Encode(id.PrefixTreatmentSession, uuid.New())), nil), 404, "SESSION_NOT_FOUND", "unknown")
	var charges int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1 AND deleted_at IS NULL`, &charges, denUUID(t, id.PrefixPatient, k.p.ID))
	if charges != 2 { // visit 2's pending charge and visit 3's waived one
		t.Fatalf("%d charges, want 2", charges)
	}
}

// TestREG_DENTAL_188_OtherClinicCannotBillOrPullBack: clinic B's cashier cannot bulk
// collect, write off, undo a write-off or pull back clinic A's visits; A's visits
// keep the bills they had.
func TestREG_DENTAL_188_OtherClinicCannotBillOrPullBack(t *testing.T) {
	k := dn2NewCourse(t, 3, "")
	k.doc.Do("POST", k.path("/sessions/"+k.sid(0)+"/collect"), nil).Expect(t, 204, "A collects 1")
	srv.As(t, k.c, "cashier").Do("POST", k.path("/sessions/"+k.sid(1)+"/write-off"), map[string]any{"reason": "goodwill"}).Expect(t, 204, "A waives 2")
	bc := srv.As(t, clinicB, "cashier")
	dn2Code(t, bc.Do("POST", k.path("/collect-sessions"), map[string]any{"session_ids": []string{k.sid(2)}}), 409, "NOTHING_TO_COLLECT", "B bulk")
	dn2Code(t, bc.Do("POST", k.path("/sessions/"+k.sid(0)+"/uncollect"), map[string]any{"reason": "x"}), 404, "SESSION_NOT_FOUND", "B uncollect")
	dn2Code(t, bc.Do("POST", k.path("/sessions/"+k.sid(1)+"/undo-write-off"), nil), 404, "SESSION_NOT_FOUND", "B undo")
	dn2Code(t, bc.Do("POST", k.path("/sessions/"+k.sid(2)+"/write-off"), map[string]any{"reason": "x"}), 404, "SESSION_NOT_FOUND", "B write-off")
	if dn2Charge(t, k.sid(0)) != "pending" || dn2Charge(t, k.sid(1)) != "waived" || dn2Charge(t, k.sid(2)) != "" {
		t.Fatalf("clinic B changed A's bills: %q %q %q", dn2Charge(t, k.sid(0)), dn2Charge(t, k.sid(1)), dn2Charge(t, k.sid(2)))
	}
}

// ---- write-off and its undo -------------------------------------------------------------

// TestREG_DENTAL_190_WriteOffAndUndo: Given a given, unbilled 1,000 visit, When the
// cashier writes it off without a reason, Then 400; With one, Then a waived charge
// with that reason is linked, nothing is due and 1,000 reads as waived; a second
// write-off is 409 ALREADY_WAIVED. When the write-off is undone, Then that charge is
// voided (kept), the visit is unlinked, the 1,000 is due again and can be billed;
// undoing again is 409 NOT_WAIVED.
func TestREG_DENTAL_190_WriteOffAndUndo(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	sid := k.sid(0)
	denRecord(t, k.doc, k.p.ID, sid, "given")
	cashier := srv.As(t, k.c, "cashier")
	w := k.path("/sessions/" + sid + "/write-off")
	u := k.path("/sessions/" + sid + "/undo-write-off")

	dn2Code(t, cashier.Do("POST", w, map[string]any{"reason": " "}), 400, "VALIDATION_FAILED", "blank reason")
	cashier.Do("POST", w, "x").Expect(t, 400, "malformed body")
	cashier.Do("POST", w, map[string]any{"reason": "staff family"}).Expect(t, 204, "write off")
	var chargeID uuid.UUID
	one(t, `SELECT charge_id FROM treatment_sessions WHERE id = $1`, &chargeID, dn2SessUUID(t, sid))
	var reason string
	one(t, `SELECT coalesce(waive_reason, '') FROM charges WHERE id = $1`, &reason, chargeID)
	if dn2Charge(t, sid) != "waived" || reason != "staff family" {
		t.Fatalf("after write-off: link %q reason %q", dn2Charge(t, sid), reason)
	}
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 0 || denMoney(t, b.Waived) != 1000 {
		t.Fatalf("after write-off: due=%s waived=%s", b.Due, b.Waived)
	}
	dn2Code(t, cashier.Do("POST", w, map[string]any{"reason": "again"}), 409, "ALREADY_WAIVED", "write off twice")

	k.doc.Do("POST", u, nil).Expect(t, 403, "dentist (no payment.waive) undoes")
	cashier.Do("POST", u, nil).Expect(t, 204, "undo")
	var st string
	one(t, `SELECT status FROM charges WHERE id = $1`, &st, chargeID)
	if st != "void" || dn2Charge(t, sid) != "" {
		t.Fatalf("after undo: old charge %s, link %q", st, dn2Charge(t, sid))
	}
	if b := payBalance(t, k.doc, k.p.ID); denMoney(t, b.Due) != 1000 || denMoney(t, b.Waived) != 0 {
		t.Fatalf("after undo: due=%s waived=%s", b.Due, b.Waived)
	}
	dn2Code(t, cashier.Do("POST", u, nil), 409, "NOT_WAIVED", "undo twice")
	dn2Code(t, cashier.Do("POST", k.path("/sessions/"+id.Encode(id.PrefixTreatmentSession, uuid.New())+"/undo-write-off"), nil),
		404, "SESSION_NOT_FOUND", "undo unknown")
	cashier.Do("POST", k.path("/sessions/zz/undo-write-off"), nil).Expect(t, 400, "malformed id")
	k.doc.Do("POST", k.path("/sessions/"+sid+"/collect"), nil).Expect(t, 204, "bill after undo")
	if n := dn2Events(t, k.c.TenantID, "dental.session.write_off_undone", dn2SessUUID(t, sid).String()); n != 1 {
		t.Fatalf("write_off_undone events = %d", n)
	}
}

// TestREG_DENTAL_191_WriteOffOfABillAtTheCashierWaivesThatBill: Given visit 1's bill
// at the cashier, When it is written off, Then that same charge becomes waived — no
// second charge is raised.
func TestREG_DENTAL_191_WriteOffOfABillAtTheCashierWaivesThatBill(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	sid := k.sid(0)
	k.doc.Do("POST", k.path("/sessions/"+sid+"/collect"), nil).Expect(t, 204, "collect")
	var before, after uuid.UUID
	one(t, `SELECT charge_id FROM treatment_sessions WHERE id = $1`, &before, dn2SessUUID(t, sid))
	srv.As(t, k.c, "cashier").Do("POST", k.path("/sessions/"+sid+"/write-off"), map[string]any{"reason": "goodwill"}).Expect(t, 204, "write off")
	one(t, `SELECT charge_id FROM treatment_sessions WHERE id = $1`, &after, dn2SessUUID(t, sid))
	var n int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1`, &n, denUUID(t, id.PrefixPatient, k.p.ID))
	if before != after || dn2Charge(t, sid) != "waived" || n != 1 {
		t.Fatalf("write-off of a pending bill: link %s→%s status %q, %d charges", before, after, dn2Charge(t, sid), n)
	}
}

// TestREG_DENTAL_192_WriteOffAfterPaymentAndAfterRefund: a paid visit cannot be
// written off (409 SESSION_PAID — refund it); once refunded it is owed again, and
// then it CAN be written off, for the refunded amount; collecting the refunded visit
// bills the refunded amount again.
func TestREG_DENTAL_192_WriteOffAfterPaymentAndAfterRefund(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	cashier := srv.As(t, k.c, "cashier")
	manager := srv.As(t, k.c, "branch_manager")
	for _, i := range []int{0, 1} {
		denRecord(t, k.doc, k.p.ID, k.sid(i), "given")
		k.doc.Do("POST", k.path("/sessions/"+k.sid(i)+"/collect"), nil).Expect(t, 204, "collect")
		ch := dn2PendingCharge(t, k.c, k.p.ID)
		paySettle(cashier, ch).Expect(t, 204, "settle")
		if i == 0 {
			dn2Code(t, cashier.Do("POST", k.path("/sessions/"+k.sid(0)+"/write-off"), map[string]any{"reason": "x"}), 409, "SESSION_PAID", "write off paid")
		}
		if r := manager.Do("POST", "/billing/charges/"+ch+"/refund", map[string]any{"reason": "redo"}); r.Status >= 300 {
			t.Fatalf("refund: HTTP %d %s %s", r.Status, r.Code, r.Message)
		}
	}
	cashier.Do("POST", k.path("/sessions/"+k.sid(0)+"/write-off"), map[string]any{"reason": "not re-billing"}).Expect(t, 204, "write off refunded")
	var amt string
	one(t, `SELECT c.amount::text FROM charges c JOIN treatment_sessions se ON se.charge_id = c.id WHERE se.id = $1`, &amt, dn2SessUUID(t, k.sid(0)))
	if dn2Charge(t, k.sid(0)) != "waived" || denMoney(t, amt) != 1000 {
		t.Fatalf("written-off refunded visit: link %q amount %s", dn2Charge(t, k.sid(0)), amt)
	}
	k.doc.Do("POST", k.path("/sessions/"+k.sid(1)+"/collect"), nil).Expect(t, 204, "bill the refunded visit again")
	if r := payOnePending(t, cashier, k.p.ID, 1000); r.Source != "dental" {
		t.Fatalf("re-bill source %q", r.Source)
	}
}

// ---- pay later ------------------------------------------------------------------------------

// TestREG_DENTAL_195_PayLaterOnAndOff: When the dentist flags visit 2 "pay later"
// with a note, Then the plan shows the flag and the note (the desk sees them too —
// a money note), and an undelivered promise is counted apart from the unbilled
// rows; switching it off clears the note. "on" omitted means on.
func TestREG_DENTAL_195_PayLaterOnAndOff(t *testing.T) {
	k := dn2NewCourse(t, 2, "")
	sid := k.sid(1)
	path := k.path("/sessions/" + sid + "/pay-later")
	k.doc.Do("POST", path, map[string]any{"note": "pays on the 30th"}).Expect(t, 204, "pay later on (default)")

	var desk []struct {
		Sessions []struct {
			ID           string `json:"id"`
			PayLater     bool   `json:"pay_later"`
			PayLaterNote string `json:"pay_later_note"`
		} `json:"sessions"`
	}
	srv.As(t, k.c, "receptionist").Do("GET", k.path("/plans"), nil).Expect(t, 200, "desk plans").Decode(t, &desk)
	found := false
	for _, s := range desk[0].Sessions {
		if s.ID == sid {
			found = s.PayLater && s.PayLaterNote == "pays on the 30th"
		}
	}
	if !found {
		t.Fatalf("desk does not see the pay-later promise: %+v", desk)
	}
	var ub dn2Unbilled
	srv.As(t, k.c, "cashier").Do("GET", "/dental/unbilled", nil).Expect(t, 200, "unbilled").Decode(t, &ub)
	if ub.PromisedCount != 1 || denMoney(t, ub.PromisedTotal) != 1000 || len(ub.Rows) != 0 {
		t.Fatalf("unbilled with an undelivered promise: %+v", ub)
	}

	k.doc.Do("POST", path, map[string]any{"on": false, "note": "ignored"}).Expect(t, 204, "pay later off")
	var on bool
	var note *string
	one(t, `SELECT pay_later FROM treatment_sessions WHERE id = $1`, &on, dn2SessUUID(t, sid))
	one(t, `SELECT pay_later_note FROM treatment_sessions WHERE id = $1`, &note, dn2SessUUID(t, sid))
	if on || note != nil {
		t.Fatalf("after switching off: pay_later=%v note=%v", on, note)
	}
	dn2Code(t, k.doc.Do("POST", k.path("/sessions/"+id.Encode(id.PrefixTreatmentSession, uuid.New())+"/pay-later"), map[string]any{"on": true}),
		404, "SESSION_NOT_FOUND", "unknown session")
	k.doc.Do("POST", path, "x").Expect(t, 400, "malformed body")
	srv.As(t, k.c, "receptionist").Do("POST", path, map[string]any{"on": true}).Expect(t, 403, "desk flags pay later")
	dn2Code(t, srv.As(t, clinicB, "doctor").Do("POST", path, map[string]any{"on": true}), 404, "SESSION_NOT_FOUND", "clinic B flags A's visit")
}
