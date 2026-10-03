package regression

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/testkit"
)

// The live queue stream (REG_STREAM): GET /queue/stream?token=… is Server-Sent Events
// fed by Postgres NOTIFY on every queue change. The token rides in the query because
// EventSource cannot set headers. These tests open real streams against the API and
// check who hears what: a clinic hears its own arrivals, never another clinic's, and
// (APT-10) a branch hears only its own branch.

// ---- helpers (prefixed xc) -------------------------------------------------------

// xcQueueEvent is the data line of one "queue" event.
type xcQueueEvent struct {
	TenantID     string `json:"tenant_id"`
	BranchID     string `json:"branch_id"`
	DepartmentID string `json:"department_id"`
}

// xcSSE is an open stream: every queue event it delivers lands on Events.
type xcSSE struct {
	Events chan xcQueueEvent
	cancel context.CancelFunc
}

// xcOpenStream connects with the token in the query (plus any extra query), waits for
// the ": connected" line, and pumps queue events into a channel until the test ends.
func xcOpenStream(t *testing.T, token, extra string) *xcSSE {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	q := "token=" + url.QueryEscape(token)
	if extra != "" {
		q += "&" + extra
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.BaseURL+"/queue/stream?"+q, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		t.Fatalf("open stream: HTTP %d", res.StatusCode)
	}
	rd := bufio.NewReader(res.Body)
	if line, err := rd.ReadString('\n'); err != nil || !strings.HasPrefix(line, ": connected") {
		t.Fatalf("first stream line %q (%v)", line, err)
	}
	s := &xcSSE{Events: make(chan xcQueueEvent, 64), cancel: cancel}
	go func() {
		defer res.Body.Close()
		inQueue := false
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "event: queue":
				inQueue = true
			case inQueue && strings.HasPrefix(line, "data: "):
				var ev xcQueueEvent
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) == nil {
					select {
					case s.Events <- ev:
					default:
					}
				}
				inQueue = false
			}
		}
	}()
	return s
}

// xcAwait waits up to d for an event matching ok; false if none came.
func (s *xcSSE) xcAwait(d time.Duration, ok func(xcQueueEvent) bool) bool {
	deadline := time.After(d)
	for {
		select {
		case ev := <-s.Events:
			if ok(ev) {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

// xcStreamStatus is the HTTP status of a stream request (closed straight away).
func xcStreamStatus(t *testing.T, query string, header string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.BaseURL+"/queue/stream?"+query, nil)
	if header != "" {
		req.Header.Set("Authorization", "Bearer "+header)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	res.Body.Close()
	return res.StatusCode
}

// ---- tests --------------------------------------------------------------------------

// TestREG_STREAM_001_AClinicHearsItsOwnArrivalsOnly: Given the desks of two clinics
// watching the live queue, When clinic X receives a walk-in and then checks in a
// booked patient, Then X's stream gets a queue event for each, carrying X's clinic,
// branch and department; clinic Y's stream hears nothing of either.
func TestREG_STREAM_001_AClinicHearsItsOwnArrivalsOnly(t *testing.T) {
	x := apptNewEnv(t)
	y := apptNewEnv(t)
	sx := xcOpenStream(t, x.desk.Token, "")
	sy := xcOpenStream(t, y.desk.Token, "")
	tenant, branch, dept := x.c.TenantID.String(), x.c.BranchID.String(), x.c.DeptID.String()
	mine := func(ev xcQueueEvent) bool {
		return ev.TenantID == tenant && ev.BranchID == branch && ev.DepartmentID == dept
	}

	p := x.patient(t)
	xcWalkIn(x.desk, x.branch, x.dept, p.ID).Expect(t, 201, "walk-in")
	if !sx.xcAwait(5*time.Second, mine) {
		t.Fatalf("clinic X's stream heard nothing of its own walk-in")
	}
	a := x.book(t, x.patient(t).ID, time.Now().Add(-time.Minute), 30)
	x.checkIn(t, a.ID).Expect(t, 200, "check in")
	if !sx.xcAwait(5*time.Second, mine) {
		t.Fatalf("clinic X's stream heard nothing of its own check-in")
	}
	if sy.xcAwait(1500*time.Millisecond, func(ev xcQueueEvent) bool { return ev.TenantID == tenant }) {
		t.Fatalf("CROSS-CLINIC LEAK: clinic Y's live queue received clinic X's queue event")
	}
}

// TestREG_STREAM_002_DepartmentFilterNarrowsTheStream: Given a stream opened for one
// department, When a patient arrives in a different department of the same clinic,
// Then that stream does not hear it while an unfiltered stream of the clinic does.
func TestREG_STREAM_002_DepartmentFilterNarrowsTheStream(t *testing.T) {
	x := xcTwoBranchClinic(t)
	onlyB := xcOpenStream(t, x.owner.Token, "department="+x.deptB)
	every := xcOpenStream(t, x.owner.Token, "")
	desk := srv.As(t, x.c, "receptionist")
	xcWalkIn(desk, x.brA, x.deptA, createPatient(t, desk, uniq("Dept"), "Stream").ID).Expect(t, 201, "walk-in at A")
	tenant := x.c.TenantID.String()
	if !every.xcAwait(5*time.Second, func(ev xcQueueEvent) bool { return ev.TenantID == tenant }) {
		t.Fatalf("the unfiltered stream heard nothing")
	}
	if onlyB.xcAwait(1500*time.Millisecond, func(ev xcQueueEvent) bool { return ev.TenantID == tenant }) {
		t.Fatalf("a stream filtered to department B heard an arrival in department A")
	}
}

// TestREG_STREAM_003_TheStreamNeedsAValidToken: Given the stream route, When it is
// opened with no token, a garbage token, a token signed with another key, or the
// token only in an Authorization header (the route reads the query), Then 401; a
// malformed department is 400.
func TestREG_STREAM_003_TheStreamNeedsAValidToken(t *testing.T) {
	desk := srv.As(t, clinicA, "receptionist")
	forged := strings.Join([]string{
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
		"eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjQxMDI0NDQ4MDB9",
		"c2lnbmVkLXdpdGgtYW5vdGhlci1rZXk",
	}, ".")
	for name, st := range map[string]int{
		"no token":      xcStreamStatus(t, "", ""),
		"garbage":       xcStreamStatus(t, "token=not-a-jwt", ""),
		"forged":        xcStreamStatus(t, "token="+url.QueryEscape(forged), ""),
		"header only":   xcStreamStatus(t, "", desk.Token),
		"tampered sig":  xcStreamStatus(t, "token="+url.QueryEscape(desk.Token[:len(desk.Token)-4]+"AAAA"), ""),
		"truncated jwt": xcStreamStatus(t, "token="+url.QueryEscape(desk.Token[:len(desk.Token)/2]), ""),
	} {
		if st != 401 {
			t.Fatalf("stream with %s: HTTP %d, want 401", name, st)
		}
	}
	if st := xcStreamStatus(t, "department=dpt_bad&token="+url.QueryEscape(desk.Token), ""); st != 400 {
		t.Fatalf("stream with a malformed department: HTTP %d, want 400", st)
	}
}

// TestREG_STREAM_004_ABranchHearsOnlyItsOwnBranch: Given a desk pinned to branch B
// watching the live queue, When a patient arrives at branch A, Then B's stream must
// not hear it (branch A's patient names and timings are not B's business). APT-10:
// QueueStream filters on clinic and department only, never on the user's branches.
func TestREG_STREAM_004_ABranchHearsOnlyItsOwnBranch(t *testing.T) {
	x := xcTwoBranchClinic(t)
	deskA, _ := x.scoped(t, "receptionist", x.brAID)
	deskB, _ := x.scoped(t, "receptionist", x.brBID)
	sB := xcOpenStream(t, deskB.Token, "")
	sA := xcOpenStream(t, deskA.Token, "")
	xcWalkIn(deskA, x.brA, x.deptA, createPatient(t, deskA, uniq("BrA"), "Stream").ID).Expect(t, 201, "walk-in at A")
	branchA := x.brAID.String()
	if !sA.xcAwait(5*time.Second, func(ev xcQueueEvent) bool { return ev.BranchID == branchA }) {
		t.Fatalf("branch A's own stream heard nothing of its walk-in")
	}
	heard := sB.xcAwait(1500*time.Millisecond, func(ev xcQueueEvent) bool { return ev.BranchID == branchA })
	testkit.KnownBug(t, "APT-10", heard, fmt.Sprintf(
		"a receptionist pinned to branch B receives branch A's queue events on GET /queue/stream "+
			"(scheduling/http/handlers.go QueueStream compares tenant_id and department_id only; payload carries branch_id %s)", branchA))
}
