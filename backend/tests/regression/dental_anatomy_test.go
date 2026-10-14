package regression

// The anatomical tooth chart and the clinic's choice of chart. Both charts share one
// row (teeth by Palmer code, anatomy by FDI number), so a clinic can switch without
// losing or hiding anything a dentist recorded.

import (
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/id"
)

type anatTooth struct {
	Surfaces      map[string]string `json:"surfaces"`
	Crown         bool              `json:"crown"`
	RootCanal     bool              `json:"root_canal"`
	Missing       bool              `json:"missing"`
	Rotation      float64           `json:"rotation"`
	Tipping       float64           `json:"tipping"`
	BuccalLingual float64           `json:"buccal_lingual"`
	Vertical      float64           `json:"vertical"`
	GapMesial     float64           `json:"gap_mesial"`
}

type anatChart struct {
	Teeth   map[string]string    `json:"teeth"`
	Anatomy map[string]anatTooth `json:"anatomy"`
}

// TestREG_DENTAL_ANAT_001_EveryFindingAndPositionPersists: Given a dentist on the
// anatomical chart, When they record surfaces, whole-tooth findings and every
// position value on adult and child teeth, Then a fresh session reads back exactly
// that, and the database holds it under the FDI number.
func TestREG_DENTAL_ANAT_001_EveryFindingAndPositionPersists(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	changes := map[string]any{
		"16": map[string]any{"surfaces": map[string]string{"O": "caries", "M": "filling"}},
		"26": map[string]any{"root_canal": true, "crown": true},
		"46": map[string]any{"missing": true},
		"12": map[string]any{"rotation": 35, "tipping": -10, "buccal_lingual": 1.5, "vertical": -2.5, "gap_mesial": 2},
		"54": map[string]any{"surfaces": map[string]string{"D": "caries", "B": "filling", "L": "caries"}},
		"75": map[string]any{"crown": true, "gap_mesial": 1},
	}
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy", map[string]any{"changes": changes}).Expect(t, 200, "save anatomy")

	var ch anatChart
	srv.As(t, clinicA, "doctor").Do("GET", "/dental/patients/"+p.ID+"/chart", nil).Expect(t, 200, "get chart").Decode(t, &ch)
	a := ch.Anatomy
	if a["16"].Surfaces["O"] != "caries" || a["16"].Surfaces["M"] != "filling" {
		t.Fatalf("16 surfaces = %v", a["16"].Surfaces)
	}
	if !a["26"].RootCanal || !a["26"].Crown || !a["46"].Missing {
		t.Fatalf("whole-tooth findings lost: 26=%+v 46=%+v", a["26"], a["46"])
	}
	if q := a["12"]; q.Rotation != 35 || q.Tipping != -10 || q.BuccalLingual != 1.5 || q.Vertical != -2.5 || q.GapMesial != 2 {
		t.Fatalf("12 position = %+v", q)
	}
	if a["54"].Surfaces["L"] != "caries" || !a["75"].Crown || a["75"].GapMesial != 1 {
		t.Fatalf("child teeth lost: 54=%+v 75=%+v", a["54"], a["75"])
	}
	var stored float64
	one(t, `SELECT (anatomy->'12'->>'buccal_lingual')::float FROM dental_charts WHERE patient_id = $1`, &stored,
		denUUID(t, id.PrefixPatient, p.ID))
	if stored != 1.5 {
		t.Fatalf("database holds 12 buccal_lingual=%v, want 1.5", stored)
	}
}

// TestREG_DENTAL_ANAT_002_TheTwoChartsNeverEraseEachOther: Given a tooth marked on
// the simple chart and findings on the anatomical one, When either chart saves,
// Then the other chart's record is untouched and comes back in the reply.
func TestREG_DENTAL_ANAT_002_TheTwoChartsNeverEraseEachOther(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	denSeedConditions(t, doc)
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UR1": "decayed"}}).Expect(t, 200, "simple save")

	var after anatChart
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy", map[string]any{"changes": map[string]any{
		"11": map[string]any{"rotation": 20},
	}}).Expect(t, 200, "anatomy save").Decode(t, &after)
	if after.Teeth["UR1"] != "decayed" {
		t.Fatalf("anatomy save reply lost the simple mark: %v", after.Teeth)
	}

	var again anatChart
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"LL6": "filled"}}).
		Expect(t, 200, "simple save 2").Decode(t, &again)
	if again.Anatomy["11"].Rotation != 20 {
		t.Fatalf("simple save reply lost the anatomy: %v", again.Anatomy)
	}
	if again.Teeth["UR1"] != "decayed" || again.Teeth["LL6"] != "filled" {
		t.Fatalf("simple marks = %v", again.Teeth)
	}
}

// TestREG_DENTAL_ANAT_003_SavesOnDifferentTeethMergeAndNullClears: two people on two
// teeth both keep their work; a null, or an all-empty record, clears a tooth.
func TestREG_DENTAL_ANAT_003_SavesOnDifferentTeethMergeAndNullClears(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	owner := srv.As(t, clinicA, "owner")
	path := "/dental/patients/" + p.ID + "/chart/anatomy"
	doc.Do("PUT", path, map[string]any{"changes": map[string]any{"21": map[string]any{"gap_mesial": 3}}}).Expect(t, 200, "first")
	owner.Do("PUT", path, map[string]any{"changes": map[string]any{"36": map[string]any{"missing": true}}}).Expect(t, 200, "second")

	var ch anatChart
	doc.Do("GET", "/dental/patients/"+p.ID+"/chart", nil).Expect(t, 200, "get").Decode(t, &ch)
	if ch.Anatomy["21"].GapMesial != 3 || !ch.Anatomy["36"].Missing {
		t.Fatalf("after two saves = %v", ch.Anatomy)
	}

	doc.Do("PUT", path, map[string]any{"changes": map[string]any{"21": nil, "36": map[string]any{}}}).Expect(t, 200, "clear")
	var cleared anatChart // fresh: decoding into a used map would keep its old keys
	doc.Do("GET", "/dental/patients/"+p.ID+"/chart", nil).Expect(t, 200, "get").Decode(t, &cleared)
	if len(cleared.Anatomy) != 0 {
		t.Fatalf("cleared teeth still stored: %v", cleared.Anatomy)
	}
}

// TestREG_DENTAL_ANAT_004_ValuesTheChartCannotDrawAreRefused: an unknown tooth,
// surface or finding, or a position out of range, is a 400 and nothing is stored.
func TestREG_DENTAL_ANAT_004_ValuesTheChartCannotDrawAreRefused(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	path := "/dental/patients/" + p.ID + "/chart/anatomy"
	bad := []map[string]any{
		{"19": map[string]any{"missing": true}},                                    // no such permanent tooth
		{"56": map[string]any{"missing": true}},                                    // children have five per quadrant
		{"UR1": map[string]any{"missing": true}},                                   // Palmer belongs to the simple chart
		{"11": map[string]any{"surfaces": map[string]string{"X": "caries"}}},       // no such surface
		{"11": map[string]any{"surfaces": map[string]string{"O": "decayed"}}},      // not caries/filling
		{"11": map[string]any{"rotation": 91}},
		{"11": map[string]any{"tipping": -31}},
		{"11": map[string]any{"buccal_lingual": 3.5}},
		{"11": map[string]any{"vertical": -4}},
		{"11": map[string]any{"gap_mesial": -1}},
		{"11": map[string]any{"gap_mesial": 6.5}},
	}
	for i, ch := range bad {
		// a valid tooth rides along: it must not be stored either
		ch["22"] = map[string]any{"missing": true}
		r := doc.Do("PUT", path, map[string]any{"changes": ch})
		if r.Status != 400 {
			t.Fatalf("case %d %v: want 400, got %d %s", i, ch, r.Status, r.Raw)
		}
	}
	doc.Do("PUT", path, map[string]any{}).Expect(t, 400, "no changes")

	var got anatChart
	doc.Do("GET", "/dental/patients/"+p.ID+"/chart", nil).Expect(t, 200, "get").Decode(t, &got)
	if len(got.Anatomy) != 0 {
		t.Fatalf("a refused save stored something: %v", got.Anatomy)
	}
}

// TestREG_DENTAL_ANAT_005_OnlyTheClinicianWritesAndTheDeskSeesNothing: the front desk
// cannot save findings, and reads an empty chart, as with the simple one.
func TestREG_DENTAL_ANAT_005_OnlyTheClinicianWritesAndTheDeskSeesNothing(t *testing.T) {
	p := denPatient(t, clinicA)
	srv.As(t, clinicA, "doctor").Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy",
		map[string]any{"changes": map[string]any{"11": map[string]any{"missing": true}}}).Expect(t, 200, "doctor saves")
	desk := srv.As(t, clinicA, "receptionist")
	desk.Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy",
		map[string]any{"changes": map[string]any{"11": nil}}).Expect(t, 403, "desk cannot write")
	var ch anatChart
	desk.Do("GET", "/dental/patients/"+p.ID+"/chart", nil).Expect(t, 200, "desk reads").Decode(t, &ch)
	if len(ch.Anatomy) != 0 {
		t.Fatalf("the front desk was shown clinical findings: %v", ch.Anatomy)
	}
}

// TestREG_DENTAL_ANAT_006_AnotherClinicCannotTouchTheAnatomy: clinic B cannot read or
// write clinic A's patient's anatomical chart.
func TestREG_DENTAL_ANAT_006_AnotherClinicCannotTouchTheAnatomy(t *testing.T) {
	p := denPatient(t, clinicA)
	srv.As(t, clinicA, "doctor").Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy",
		map[string]any{"changes": map[string]any{"11": map[string]any{"rotation": 10}}}).Expect(t, 200, "A saves")
	other := srv.As(t, clinicB, "doctor")
	var ch anatChart
	other.Do("GET", "/dental/patients/"+p.ID+"/chart", nil).Decode(t, &ch)
	if len(ch.Anatomy) != 0 {
		t.Fatalf("clinic B read clinic A's anatomy: %v", ch.Anatomy)
	}
	other.Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy",
		map[string]any{"changes": map[string]any{"11": nil}})
	var mine anatChart
	srv.As(t, clinicA, "doctor").Do("GET", "/dental/patients/"+p.ID+"/chart", nil).Decode(t, &mine)
	if mine.Anatomy["11"].Rotation != 10 {
		t.Fatalf("clinic B changed clinic A's chart: %v", mine.Anatomy)
	}
}

// TestREG_DENTAL_ANAT_007_TheAdminChoosesTheChart: a new clinic starts on the
// anatomical chart; only clinic.manage can change it; anything else is refused; the
// change is recorded; and the choice is per clinic.
func TestREG_DENTAL_ANAT_007_TheAdminChoosesTheChart(t *testing.T) {
	c := newClinic(t)
	owner := srv.As(t, c, "owner")
	var st struct {
		ChartStyle string `json:"chart_style"`
	}
	owner.Do("GET", "/dental/settings", nil).Expect(t, 200, "read").Decode(t, &st)
	if st.ChartStyle != "anatomical" {
		t.Fatalf("a new clinic starts on %q, want anatomical", st.ChartStyle)
	}
	srv.As(t, c, "doctor").Do("GET", "/dental/settings", nil).Expect(t, 200, "the dentist reads it")
	srv.As(t, c, "doctor").Do("PUT", "/dental/settings", map[string]any{"chart_style": "simple"}).Expect(t, 403, "the dentist cannot choose")
	owner.Do("PUT", "/dental/settings", map[string]any{"chart_style": "squares"}).Expect(t, 400, "unknown style")

	owner.Do("PUT", "/dental/settings", map[string]any{"chart_style": "simple"}).Expect(t, 200, "owner chooses")
	srv.As(t, c, "doctor").Do("GET", "/dental/settings", nil).Expect(t, 200, "read").Decode(t, &st)
	if st.ChartStyle != "simple" {
		t.Fatalf("after choosing simple, read %q", st.ChartStyle)
	}
	var events int
	one(t, `SELECT count(*) FROM event_outbox WHERE event_type = 'dental.settings.saved' AND tenant_id = $1`, &events, c.TenantID)
	if events != 1 {
		t.Fatalf("the change was recorded %d times, want once", events)
	}
	// Another clinic is not affected.
	var b struct {
		ChartStyle string `json:"chart_style"`
	}
	srv.As(t, clinicB, "owner").Do("GET", "/dental/settings", nil).Expect(t, 200, "B reads").Decode(t, &b)
	if b.ChartStyle == "" {
		t.Fatalf("clinic B has no chart style")
	}
}

// TestREG_DENTAL_ANAT_008_ARequestOfTheWrongShapeIsRefused: a body the server cannot
// read, or a patient id that is not one, is a 400 — never a half-applied save.
func TestREG_DENTAL_ANAT_008_ARequestOfTheWrongShapeIsRefused(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy", map[string]any{"changes": "everything"}).Expect(t, 400, "changes not a map")
	doc.Do("PUT", "/dental/patients/"+p.ID+"/chart/anatomy", map[string]any{"changes": map[string]any{"11": map[string]any{"rotation": "a lot"}}}).Expect(t, 400, "a number that is text")
	doc.Do("PUT", "/dental/patients/not-a-patient/chart/anatomy", map[string]any{"changes": map[string]any{}}).Expect(t, 400, "bad patient id")
	doc.Do("GET", "/dental/patients/not-a-patient/chart", nil).Expect(t, 400, "reading a chart by a bad patient id")
	owner := srv.As(t, clinicA, "owner")
	owner.Do("PUT", "/dental/settings", map[string]any{"chart_style": 5}).Expect(t, 400, "style not text")
	owner.Do("PUT", "/dental/settings", nil).Expect(t, 400, "no body")
}

// TestREG_DENTAL_ANAT_009_SavingWhatIsAlreadyThereChangesNothing: re-sending a tooth
// exactly as stored, clearing a tooth that has nothing, or choosing the chart already
// in use writes nothing and records nothing — the history only holds real changes.
func TestREG_DENTAL_ANAT_009_SavingWhatIsAlreadyThereChangesNothing(t *testing.T) {
	c := newClinic(t)
	p := denPatient(t, c)
	doc := srv.As(t, c, "doctor")
	path := "/dental/patients/" + p.ID + "/chart/anatomy"
	tooth := map[string]any{"11": map[string]any{"surfaces": map[string]string{"O": "caries"}, "rotation": 15}}
	doc.Do("PUT", path, map[string]any{"changes": tooth}).Expect(t, 200, "first save")
	count := func(kind string) int {
		var n int
		one(t, `SELECT count(*) FROM event_outbox WHERE event_type = $1 AND tenant_id = $2`, &n, kind, c.TenantID)
		return n
	}
	before := count("dental.chart.saved")
	var again anatChart
	doc.Do("PUT", path, map[string]any{"changes": tooth}).Expect(t, 200, "same again").Decode(t, &again)
	doc.Do("PUT", path, map[string]any{"changes": map[string]any{"21": nil}}).Expect(t, 200, "clear an empty tooth")
	if got := count("dental.chart.saved"); got != before {
		t.Fatalf("saves that changed nothing recorded %d events", got-before)
	}
	if again.Anatomy["11"].Rotation != 15 || again.Anatomy["11"].Surfaces["O"] != "caries" {
		t.Fatalf("the reply to an unchanged save = %v", again.Anatomy)
	}

	owner := srv.As(t, c, "owner")
	owner.Do("PUT", "/dental/settings", map[string]any{"chart_style": "anatomical"}).Expect(t, 200, "the style already in use")
	if n := count("dental.settings.saved"); n != 0 {
		t.Fatalf("re-choosing the chart in use recorded %d events", n)
	}
	owner.Do("PUT", "/dental/settings", map[string]any{"chart_style": "simple"}).Expect(t, 200, "switch")
	owner.Do("PUT", "/dental/settings", map[string]any{"chart_style": "simple"}).Expect(t, 200, "same again")
	if n := count("dental.settings.saved"); n != 1 {
		t.Fatalf("one real change recorded %d events", n)
	}
	// The desk reads the setting (it needs to know how teeth are numbered).
	srv.As(t, c, "receptionist").Do("GET", "/dental/settings", nil).Expect(t, 200, "desk reads the setting")
}

// TestREG_DENTAL_ANAT_010_TheSimpleChartsReplyCarriesTheAnatomyOfAFreshPatient: the
// first simple-chart save on a patient with no chart row returns an empty anatomy,
// not a missing one.
func TestREG_DENTAL_ANAT_010_TheSimpleChartsReplyCarriesTheAnatomyOfAFreshPatient(t *testing.T) {
	p := denPatient(t, clinicA)
	doc := srv.As(t, clinicA, "doctor")
	denSeedConditions(t, doc)
	r := doc.Do("PUT", "/dental/patients/"+p.ID+"/chart", map[string]any{"changes": map[string]string{"UL2": "filled"}}).Expect(t, 200, "save")
	if !strings.Contains(r.Raw, `"anatomy":{}`) {
		t.Fatalf("reply = %s, want an empty anatomy object", r.Raw)
	}
	var fresh struct {
		Anatomy map[string]any `json:"anatomy"`
	}
	srv.As(t, clinicA, "doctor").Do("GET", "/dental/patients/"+denPatient(t, clinicA).ID+"/chart", nil).Expect(t, 200, "never charted").Decode(t, &fresh)
	if fresh.Anatomy == nil {
		t.Fatalf("a patient never charted has no anatomy object")
	}
}
