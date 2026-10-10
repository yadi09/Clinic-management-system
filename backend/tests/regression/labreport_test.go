package regression

import (
	"testing"

	"github.com/reicb/clinicsaas/internal/testkit"
)

// The printed laboratory report names who drew the sample and who signed it off, and
// when. The sample's detail is what the print is drawn from, so it must carry them.

// TestREG_LABREPORT_001_SampleDetailCarriesTheSignOffTrail: Given a sample taken,
// resulted and validated, When its detail is read, Then it says who collected it,
// when, who validated it and when; before validation the validator is empty.
func TestREG_LABREPORT_001_SampleDetailCarriesTheSignOffTrail(t *testing.T) {
	c := testkit.NewClinic(t, super, testkit.ClinicOpts{Flags: map[string]bool{"laboratory": true}})
	owner := srv.As(t, c, "owner")
	p := createPatient(t, srv.As(t, c, "receptionist"), uniq("Lab"), "Patient")

	var test struct {
		ID string `json:"id"`
	}
	owner.Do("POST", "/lab/tests", map[string]any{"code": uniq("CBC"), "name": "Complete blood count", "specimen": "Blood", "price": "0"}).
		Expect(t, 201, "create test").Decode(t, &test)
	owner.Do("POST", "/lab/tests/"+test.ID+"/analytes", map[string]any{"name": "Haemoglobin", "unit": "g/dL", "ref_low": "12", "ref_high": "16"}).
		Expect(t, 204, "add analyte")
	var analytes []struct {
		ID string `json:"id"`
	}
	owner.Do("GET", "/lab/tests/"+test.ID+"/analytes", nil).Expect(t, 200, "analytes").Decode(t, &analytes)
	if len(analytes) != 1 {
		t.Fatalf("analytes = %+v", analytes)
	}
	owner.Do("POST", "/lab/orders", map[string]any{"patient_id": p.ID, "test_ids": []string{test.ID}, "priority": "routine"}).
		Expect(t, 201, "order")
	var wl []struct {
		ID       string `json:"id"`
		TestName string `json:"test_name"`
	}
	owner.Do("GET", "/lab/worklist", nil).Expect(t, 200, "worklist").Decode(t, &wl)
	if len(wl) != 1 {
		t.Fatalf("worklist = %+v", wl)
	}
	item := wl[0].ID

	type detail struct {
		CollectedBy string `json:"collected_by"`
		CollectedAt string `json:"collected_at"`
		ValidatedBy string `json:"validated_by"`
		ValidatedAt string `json:"validated_at"`
	}
	read := func() detail {
		var d detail
		owner.Do("GET", "/lab/items/"+item, nil).Expect(t, 200, "item detail").Decode(t, &d)
		return d
	}
	if d := read(); d.CollectedBy != "" || d.ValidatedBy != "" || d.ValidatedAt != "" {
		t.Fatalf("a fresh sample already has a trail: %+v", d)
	}
	owner.Do("POST", "/lab/items/"+item+"/accession", map[string]any{"collected_by": "Nurse Selam"}).Expect(t, 204, "accession")
	owner.Do("PUT", "/lab/items/"+item+"/results", map[string]any{"results": []map[string]any{{"analyte_id": analytes[0].ID, "value": "13.5"}}}).Expect(t, 204, "results")
	owner.Do("POST", "/lab/items/"+item+"/submit", nil).Expect(t, 204, "submit")
	if d := read(); d.CollectedBy != "Nurse Selam" || d.CollectedAt == "" || d.ValidatedBy != "" {
		t.Fatalf("after collecting: %+v, want the collector and no validator yet", d)
	}
	owner.Do("POST", "/lab/items/"+item+"/validate", nil).Expect(t, 204, "validate")
	d := read()
	if d.ValidatedBy == "" || d.ValidatedAt == "" || d.CollectedBy != "Nurse Selam" {
		t.Fatalf("after validation: %+v, want the validator named and timed", d)
	}
}
