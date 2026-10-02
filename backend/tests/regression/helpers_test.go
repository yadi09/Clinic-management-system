package regression

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/testkit"
)

// Arranging data through the API keeps fixtures honest: if creating a patient
// breaks, every test that needs one says so, instead of passing on rows the API
// could no longer create.

type patientRef struct {
	ID        string `json:"id"`
	MRN       string `json:"mrn"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

// createPatient registers a patient as the given user (needs patient.create).
func createPatient(t *testing.T, c *testkit.Client, first, last string) patientRef {
	t.Helper()
	r := c.Do("POST", "/patients", map[string]any{
		"first_name": first, "last_name": last, "gender": "female", "dob": "1990-05-14",
		"phone": "09" + time.Now().Format("05040201")[:8], "force": true,
	}).Expect(t, 201, "create patient")
	var p patientRef
	r.Decode(t, &p)
	if p.ID == "" {
		t.Fatalf("create patient returned no id: %s", r.Raw)
	}
	return p
}

type sessionRef struct {
	ID            string `json:"id"`
	Seq           int    `json:"seq"`
	Kind          string `json:"kind"`
	Status        string `json:"status"`
	ScheduledDate string `json:"scheduled_date"`
	AmountDue     string `json:"amount_due"`
	Payment       string `json:"payment"`
}

type planRef struct {
	ID       string       `json:"id"`
	Title    string       `json:"title"`
	Status   string       `json:"status"`
	Sessions []sessionRef `json:"sessions"`
	Deposit  *sessionRef  `json:"deposit"`
}

// createPlan creates a dental treatment of n visits (needs dental.manage).
func createPlan(t *testing.T, c *testkit.Client, patientID string, total string, visits int, deposit string) planRef {
	t.Helper()
	body := map[string]any{
		"title": "Root canal", "tooth": "UR5", "total_amount": total,
		"start_date": time.Now().Format("2006-01-02"), "interval_unit": "week", "interval_count": 2,
		"session_count": visits,
	}
	if deposit != "" {
		body["deposit"] = deposit
	}
	r := c.Do("POST", "/dental/patients/"+patientID+"/plans", body).Expect(t, 201, "create plan")
	var p planRef
	r.Decode(t, &p)
	if p.ID == "" || len(p.Sessions) == 0 {
		t.Fatalf("create plan returned no plan/sessions: %s", r.Raw)
	}
	return p
}

// summary reads a patient's dental summary (plans, money).
func summary(t *testing.T, c *testkit.Client, patientID string) map[string]json.RawMessage {
	t.Helper()
	r := c.Do("GET", "/dental/patients/"+patientID+"/summary", nil).Expect(t, 200, "dental summary")
	var m map[string]json.RawMessage
	r.Decode(t, &m)
	return m
}

// one runs a query as the superuser and scans one value: for asserting what the
// database actually holds, never for exercising behaviour.
func one(t *testing.T, q string, out any, args ...any) {
	t.Helper()
	if err := super.Pool.QueryRow(t.Context(), q, args...).Scan(out); err != nil {
		t.Fatalf("%v\n%s", err, q)
	}
}
