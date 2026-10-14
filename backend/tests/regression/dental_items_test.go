package regression

// The anatomical chart, version 2: items recorded on teeth with a status, and the
// business rules the server enforces whatever the screen did.

import (
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// exec runs a statement as the superuser: for arranging a state the API would refuse.
func exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := super.Pool.Exec(t.Context(), q, args...); err != nil {
		t.Fatalf("%v\n%s", err, q)
	}
}

type itemOut struct {
	ID        string `json:"id"`
	Tooth     int    `json:"tooth"`
	Kind      string `json:"kind"`
	Surface   string `json:"surface"`
	Material  string `json:"material"`
	Status    string `json:"status"`
	BridgeEnd int    `json:"bridge_end"`
	Note      string `json:"note"`
	DoneOn    string `json:"done_on"`
	CreatedBy string `json:"created_by"`
}

type chartV2 struct {
	Items     []itemOut                     `json:"items"`
	Positions map[string]map[string]float64 `json:"positions"`
	Teeth     map[string]string             `json:"teeth"`
}

type it = map[string]any

func put(t *testing.T, cl *testkit.Client, pid string, teeth map[string][]it) testkit.Resp {
	t.Helper()
	return cl.Do("PUT", "/dental/patients/"+pid+"/chart/items", map[string]any{"teeth": teeth})
}

func chartOf(t *testing.T, cl *testkit.Client, pid string) chartV2 {
	t.Helper()
	var c chartV2
	cl.Do("GET", "/dental/patients/"+pid+"/chart", nil).Expect(t, 200, "get chart").Decode(t, &c)
	return c
}

func find(c chartV2, tooth int, kind, surface string) *itemOut {
	for i := range c.Items {
		x := &c.Items[i]
		if x.Tooth == tooth && x.Kind == kind && x.Surface == surface {
			return x
		}
	}
	return nil
}

func refused(t *testing.T, r testkit.Resp, says string) {
	t.Helper()
	if r.Status != 400 || !strings.Contains(r.Message, says) {
		t.Fatalf("want 400 saying %q, got %d %q", says, r.Status, r.Message)
	}
}

// TestREG_DENTAL_ITEMS_001_EveryItemWithEveryStatusPersists: each kind of item, with
// each status it may take, is stored and read back exactly; who recorded it is named.
func TestREG_DENTAL_ITEMS_001_EveryItemWithEveryStatusPersists(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	put(t, doc, p.ID, map[string][]it{
		"16": {{"kind": "caries", "surface": "O", "status": "existing"}, {"kind": "filling", "surface": "M", "material": "composite", "status": "planned"}},
		"36": {{"kind": "filling", "surface": "O", "material": "amalgam", "status": "existing"}, {"kind": "filling", "surface": "B", "material": "amalgam", "status": "done"}},
		"26": {{"kind": "crown", "material": "pfm", "status": "existing"}, {"kind": "root_canal", "status": "existing"}},
		"21": {{"kind": "crown", "material": "zirconia", "status": "planned"}, {"kind": "root_canal", "status": "done"}},
		"38": {{"kind": "extraction", "status": "planned"}},
		"46": {{"kind": "missing", "status": "existing"}, {"kind": "implant", "material": "gold", "status": "planned"}},
		"47": {{"kind": "missing", "status": "done"}},
		"75": {{"kind": "crown", "material": "steel", "status": "existing"}},
	}).Expect(t, 200, "save")
	c := chartOf(t, srv.As(t, clinicA, "doctor"), p.ID)
	if len(c.Items) != 13 {
		t.Fatalf("items = %d, want 13: %+v", len(c.Items), c.Items)
	}
	checks := []struct {
		tooth                   int
		kind, surf, mat, status string
	}{
		{16, "caries", "O", "", "existing"}, {16, "filling", "M", "composite", "planned"},
		{36, "filling", "O", "amalgam", "existing"}, {36, "filling", "B", "amalgam", "done"},
		{26, "crown", "", "pfm", "existing"}, {26, "root_canal", "", "", "existing"},
		{21, "crown", "", "zirconia", "planned"}, {21, "root_canal", "", "", "done"},
		{38, "extraction", "", "", "planned"}, {46, "implant", "", "gold", "planned"}, {75, "crown", "", "steel", "existing"},
	}
	for _, w := range checks {
		g := find(c, w.tooth, w.kind, w.surf)
		if g == nil || g.Material != w.mat || g.Status != w.status {
			t.Fatalf("%d %s %s = %+v", w.tooth, w.kind, w.surf, g)
		}
		if !strings.HasPrefix(g.ID, "dci_") || g.CreatedBy == "" {
			t.Fatalf("%d %s: id %q, recorded by %q", w.tooth, w.kind, g.ID, g.CreatedBy)
		}
	}
	// Done items carry the clinic day; others do not.
	if find(c, 36, "filling", "B").DoneOn == "" || find(c, 21, "root_canal", "").DoneOn == "" || find(c, 47, "missing", "").DoneOn == "" {
		t.Fatal("a done item has no day")
	}
	if find(c, 16, "filling", "M").DoneOn != "" {
		t.Fatal("a planned item has a done day")
	}
}

// TestREG_DENTAL_ITEMS_002_AnItemKeepsItsIdentityWhenItChanges: changing a planned
// filling to done keeps the same item (so a plan or a bill linked to it stays linked);
// an item left out of a tooth's list is removed; an empty list clears the tooth.
func TestREG_DENTAL_ITEMS_002_AnItemKeepsItsIdentityWhenItChanges(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	put(t, doc, p.ID, map[string][]it{"14": {{"kind": "filling", "surface": "O", "material": "composite", "status": "planned"}, {"kind": "caries", "surface": "D", "status": "existing"}}}).Expect(t, 200, "plan")
	before := find(chartOf(t, doc, p.ID), 14, "filling", "O")
	put(t, doc, p.ID, map[string][]it{"14": {{"kind": "filling", "surface": "O", "material": "composite", "status": "done"}}}).Expect(t, 200, "complete")
	c := chartOf(t, doc, p.ID)
	after := find(c, 14, "filling", "O")
	if after == nil || after.ID != before.ID || after.Status != "done" || after.DoneOn == "" {
		t.Fatalf("before %+v, after %+v", before, after)
	}
	if find(c, 14, "caries", "D") != nil {
		t.Fatal("an item left out of the list is still there")
	}
	put(t, doc, p.ID, map[string][]it{"14": {}}).Expect(t, 200, "clear")
	if n := len(chartOf(t, doc, p.ID).Items); n != 0 {
		t.Fatalf("after clearing, %d items remain", n)
	}
	// Removed items are kept, marked deleted, with who removed them.
	var kept int
	one(t, `SELECT count(*) FROM dental_chart_items WHERE patient_id = $1 AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL`, &kept, denUUID(t, id.PrefixPatient, p.ID))
	if kept != 2 {
		t.Fatalf("removed items kept = %d, want 2", kept)
	}
}

// TestREG_DENTAL_ITEMS_003_TheRulesAreEnforcedWithPlainReasons: every rule from the
// chart is refused by the server too, in the chart's own words, and nothing in a
// refused save is stored.
func TestREG_DENTAL_ITEMS_003_TheRulesAreEnforcedWithPlainReasons(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	put(t, doc, p.ID, map[string][]it{
		"25": {{"kind": "missing", "status": "existing"}},
		"26": {{"kind": "crown", "material": "zirconia", "status": "existing"}},
	}).Expect(t, 200, "setup")
	cases := []struct {
		name  string
		teeth map[string][]it
		says  string
	}{
		{"implant on a tooth that is there", map[string][]it{"24": {{"kind": "implant", "material": "zirconia", "status": "planned"}}}, "Mark tooth 24 as Missing first"},
		{"implant on a baby tooth", map[string][]it{"54": {{"kind": "missing", "status": "existing"}, {"kind": "implant", "material": "zirconia", "status": "planned"}}}, "Implants are not used for baby teeth"},
		{"bridge on baby teeth", map[string][]it{"54": {{"kind": "bridge", "bridge_end": 52, "material": "zirconia", "status": "planned"}}}, "Bridges are not used for baby teeth"},
		{"existing extraction", map[string][]it{"24": {{"kind": "extraction", "status": "existing"}}}, "use Missing"},
		{"done extraction stored as extraction", map[string][]it{"24": {{"kind": "extraction", "status": "done"}}}, "recorded as missing, done today"},
		{"caries on a missing tooth", map[string][]it{"25": {{"kind": "missing", "status": "existing"}, {"kind": "caries", "surface": "O", "status": "existing"}}}, "Tooth 25 is missing"},
		{"crown on a missing tooth", map[string][]it{"25": {{"kind": "missing", "status": "existing"}, {"kind": "crown", "material": "gold", "status": "planned"}}}, "Tooth 25 is missing"},
		{"surface under a real crown", map[string][]it{"26": {{"kind": "crown", "material": "zirconia", "status": "existing"}, {"kind": "filling", "surface": "O", "material": "composite", "status": "planned"}}}, "covered by a crown"},
		{"caries under an existing filling", map[string][]it{"24": {{"kind": "caries", "surface": "O", "status": "existing"}, {"kind": "filling", "surface": "O", "material": "amalgam", "status": "existing"}}}, "replaces the caries"},
		{"caries recorded as planned", map[string][]it{"24": {{"kind": "caries", "surface": "O", "status": "planned"}}}, "caries is a finding"},
		{"a filling of the wrong material", map[string][]it{"24": {{"kind": "filling", "surface": "O", "material": "gold", "status": "planned"}}}, "composite or amalgam"},
		{"a crown with no material", map[string][]it{"24": {{"kind": "crown", "status": "planned"}}}, "pick the crown material"},
		{"no such surface", map[string][]it{"24": {{"kind": "caries", "surface": "X", "status": "existing"}}}, "pick the surface"},
		{"no such tooth", map[string][]it{"19": {}}, "not a tooth on the chart"},
		{"the same item twice", map[string][]it{"24": {{"kind": "root_canal", "status": "planned"}, {"kind": "root_canal", "status": "done"}}}, "recorded twice"},
		{"bridge across jaws", map[string][]it{"24": {{"kind": "bridge", "bridge_end": 34, "material": "zirconia", "status": "planned"}}}, "stay in one jaw"},
		{"bridge between neighbours", map[string][]it{"24": {{"kind": "bridge", "bridge_end": 23, "material": "zirconia", "status": "planned"}}}, "next to each other"},
		{"bridge over a living tooth", map[string][]it{"24": {{"kind": "bridge", "bridge_end": 27, "material": "zirconia", "status": "planned"}}}, "26 is not missing. Mark it as Missing first"},
		{"bridge too long", map[string][]it{"21": {{"kind": "bridge", "bridge_end": 26, "material": "zirconia", "status": "planned"}}}, "at most 3 missing teeth"},
		{"bridge ending on a missing tooth", map[string][]it{"25": {{"kind": "missing", "status": "existing"}, {"kind": "bridge", "bridge_end": 23, "material": "zirconia", "status": "planned"}}}, "Both ends of a bridge must be natural teeth"},
	}
	for _, c := range cases {
		r := put(t, doc, p.ID, c.teeth)
		if r.Status != 400 || !strings.Contains(r.Message, c.says) {
			t.Fatalf("%s: want 400 saying %q, got %d %q", c.name, c.says, r.Status, r.Message)
		}
	}
	got := chartOf(t, doc, p.ID)
	if len(got.Items) != 2 {
		t.Fatalf("refused saves stored something: %+v", got.Items)
	}
}

// TestREG_DENTAL_ITEMS_004_ABridgeIsAddedRefusedAndCleared: a valid bridge is stored on
// one end and spans to the other; a second bridge over the same teeth is refused; a
// crown on a bridge end and taking a pontic out of "missing" are refused; clearing
// the bridge's tooth removes it.
func TestREG_DENTAL_ITEMS_004_ABridgeIsAddedRefusedAndCleared(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	put(t, doc, p.ID, map[string][]it{"14": {{"kind": "missing", "status": "existing"}}, "15": {{"kind": "missing", "status": "existing"}}}).Expect(t, 200, "gap")
	put(t, doc, p.ID, map[string][]it{"13": {{"kind": "bridge", "bridge_end": 16, "material": "zirconia", "status": "existing"}}}).Expect(t, 200, "bridge 13–16")
	b := find(chartOf(t, doc, p.ID), 13, "bridge", "")
	if b == nil || b.BridgeEnd != 16 || b.Material != "zirconia" {
		t.Fatalf("bridge = %+v", b)
	}
	refused(t, put(t, doc, p.ID, map[string][]it{"16": {{"kind": "bridge", "bridge_end": 13, "material": "gold", "status": "planned"}}}), "already part of a bridge")
	refused(t, put(t, doc, p.ID, map[string][]it{"16": {{"kind": "crown", "material": "gold", "status": "planned"}}}), "Bridge end teeth already have crowns")
	refused(t, put(t, doc, p.ID, map[string][]it{"14": {}}), "14 is not missing")
	refused(t, put(t, doc, p.ID, map[string][]it{"16": {{"kind": "filling", "surface": "O", "material": "composite", "status": "planned"}}}), "end of a bridge")
	// Clearing the tooth that holds the bridge removes it; the pontics stay missing.
	put(t, doc, p.ID, map[string][]it{"13": {}}).Expect(t, 200, "clear the bridge tooth")
	c := chartOf(t, doc, p.ID)
	if find(c, 13, "bridge", "") != nil || find(c, 14, "missing", "") == nil {
		t.Fatalf("after clearing: %+v", c.Items)
	}
}

// TestREG_DENTAL_ITEMS_005_ImplantComesAndGoes: an implant on a missing tooth is kept;
// removing it leaves the tooth missing; a missing tooth cannot be "brought back" while
// it holds an implant.
func TestREG_DENTAL_ITEMS_005_ImplantComesAndGoes(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	put(t, doc, p.ID, map[string][]it{"36": {{"kind": "missing", "status": "existing"}, {"kind": "implant", "material": "zirconia", "status": "planned"}}}).Expect(t, 200, "implant")
	refused(t, put(t, doc, p.ID, map[string][]it{"36": {{"kind": "implant", "material": "zirconia", "status": "planned"}}}), "Mark tooth 36 as Missing first")
	put(t, doc, p.ID, map[string][]it{"36": {{"kind": "missing", "status": "existing"}}}).Expect(t, 200, "remove the implant")
	c := chartOf(t, doc, p.ID)
	if find(c, 36, "implant", "") != nil || find(c, 36, "missing", "") == nil {
		t.Fatalf("after removing the implant: %+v", c.Items)
	}
}

// TestREG_DENTAL_ITEMS_006_ACrownOrBridgeGoesOverExistingFillingsButNoNewMarkGoesUnderIt:
// as in the chart, a crown or a bridge may be put on a tooth that already has
// fillings (they stay on record beneath it), but a new surface mark on a tooth under
// a real crown or at a bridge end is refused; and a record made before a rule never
// blocks work on another tooth.
func TestREG_DENTAL_ITEMS_006_ACrownOrBridgeGoesOverExistingFillingsButNoNewMarkGoesUnderIt(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	put(t, doc, p.ID, map[string][]it{"26": {{"kind": "filling", "surface": "O", "material": "amalgam", "status": "existing"}}}).Expect(t, 200, "a filled tooth")
	put(t, doc, p.ID, map[string][]it{"26": {{"kind": "filling", "surface": "O", "material": "amalgam", "status": "existing"}, {"kind": "crown", "material": "zirconia", "status": "existing"}}}).Expect(t, 200, "a crown over it")
	refused(t, put(t, doc, p.ID, map[string][]it{"26": {{"kind": "filling", "surface": "O", "material": "amalgam", "status": "existing"}, {"kind": "crown", "material": "zirconia", "status": "existing"}, {"kind": "caries", "surface": "D", "status": "existing"}}}), "covered by a crown")
	// A bridge onto a filled end tooth.
	put(t, doc, p.ID, map[string][]it{"16": {{"kind": "filling", "surface": "M", "material": "composite", "status": "existing"}}, "14": {{"kind": "missing", "status": "existing"}}, "15": {{"kind": "missing", "status": "existing"}}}).Expect(t, 200, "setup")
	put(t, doc, p.ID, map[string][]it{"13": {{"kind": "bridge", "bridge_end": 16, "material": "gold", "status": "existing"}}}).Expect(t, 200, "bridge onto a filled tooth")
	refused(t, put(t, doc, p.ID, map[string][]it{"16": {{"kind": "filling", "surface": "M", "material": "composite", "status": "existing"}, {"kind": "caries", "surface": "O", "status": "existing"}}}), "end of a bridge")
	// A legacy inconsistency elsewhere does not block another tooth.
	pid := denUUID(t, id.PrefixPatient, p.ID)
	var tid string
	one(t, `SELECT tenant_id::text FROM patients WHERE id = $1`, &tid, pid)
	exec(t, `INSERT INTO dental_chart_items (id, tenant_id, patient_id, tooth, kind, status) VALUES (gen_random_uuid(), $1, $2, 33, 'root_canal', 'existing')`, tid, pid)
	exec(t, `INSERT INTO dental_chart_items (id, tenant_id, patient_id, tooth, kind, status) VALUES (gen_random_uuid(), $1, $2, 33, 'missing', 'existing')`, tid, pid)
	put(t, doc, p.ID, map[string][]it{"11": {{"kind": "root_canal", "status": "planned"}}}).Expect(t, 200, "another tooth")
	refused(t, put(t, doc, p.ID, map[string][]it{"33": {{"kind": "missing", "status": "existing"}, {"kind": "root_canal", "status": "existing"}, {"kind": "crown", "material": "gold", "status": "planned"}}}), "Tooth 33 is missing")
}

// TestREG_DENTAL_ITEMS_007_PositionsHistoryAndAccess: positions save and clear; each
// real change is in the chart's history and an unchanged save is not; the front desk
// sees no items and cannot write; another clinic cannot touch them.
func TestREG_DENTAL_ITEMS_007_PositionsHistoryAndAccess(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	doc := srv.As(t, c, "doctor")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/positions", map[string]any{"changes": map[string]any{"12": map[string]any{"rotation": 20, "gap_mesial": 1.5}}}).Expect(t, 200, "position")
	got := chartOf(t, doc, p.ID)
	if got.Positions["12"]["rotation"] != 20 || got.Positions["12"]["gap_mesial"] != 1.5 {
		t.Fatalf("positions = %v", got.Positions)
	}
	refused(t, doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/positions", map[string]any{"changes": map[string]any{"12": map[string]any{"rotation": 95}}}), "rotation")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/positions", map[string]any{"changes": map[string]any{"12": nil}}).Expect(t, 200, "clear")
	if len(chartOf(t, doc, p.ID).Positions) != 0 {
		t.Fatal("cleared position still stored")
	}

	put(t, doc, p.ID, map[string][]it{"11": {{"kind": "root_canal", "status": "planned"}}}).Expect(t, 200, "item")
	var events int
	count := func() int {
		one(t, `SELECT count(*) FROM event_outbox WHERE event_type = 'dental.chart.saved' AND tenant_id = $1`, &events, c.TenantID)
		return events
	}
	before := count()
	put(t, doc, p.ID, map[string][]it{"11": {{"kind": "root_canal", "status": "planned"}}}).Expect(t, 200, "same again")
	if count() != before {
		t.Fatal("an unchanged save was recorded in the history")
	}

	desk := srv.As(t, c, "receptionist")
	put(t, desk, p.ID, map[string][]it{"11": {}}).Expect(t, 403, "desk cannot write")
	if n := len(chartOf(t, desk, p.ID).Items); n != 0 {
		t.Fatalf("the front desk was shown %d clinical items", n)
	}
	other := srv.As(t, clinicB, "doctor")
	put(t, other, p.ID, map[string][]it{"11": {}})
	if len(chartOf(t, doc, p.ID).Items) != 1 {
		t.Fatal("another clinic changed this chart")
	}
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/items", map[string]any{"teeth": "all"}).Expect(t, 400, "wrong shape")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/positions", map[string]any{"changes": "all"}).Expect(t, 400, "wrong shape")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/positions", map[string]any{"changes": map[string]any{"99": nil}}).Expect(t, 400, "no such tooth")
	doc.Do("PUT", "/dental/patients/not-a-patient/chart/items", map[string]any{"teeth": map[string]any{}}).Expect(t, 400, "bad patient id")
	doc.Do("PUT", "/dental/patients/not-a-patient/chart/positions", map[string]any{"changes": map[string]any{}}).Expect(t, 400, "bad patient id")
	// A note travels with its item, and "" clears it.
	put(t, doc, p.ID, map[string][]it{"11": {{"kind": "root_canal", "status": "planned", "note": "patient asked to wait"}}}).Expect(t, 200, "note")
	if got := find(chartOf(t, doc, p.ID), 11, "root_canal", ""); got == nil || got.Note != "patient asked to wait" {
		t.Fatalf("note = %+v", got)
	}
	put(t, doc, p.ID, map[string][]it{"11": {{"kind": "root_canal", "status": "planned", "note": ""}}}).Expect(t, 200, "clear note")
	if got := find(chartOf(t, doc, p.ID), 11, "root_canal", ""); got == nil || got.Note != "" {
		t.Fatalf("note after clearing = %+v", got)
	}
}
