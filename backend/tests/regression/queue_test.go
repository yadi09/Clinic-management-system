package regression

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// The live queue (REG_QUEUE) and the appointment actions not covered in
// appointments_test.go (REG_APPT_020..): follow-up marking, reassignment and a
// patient's own schedule. Every test builds its own clinic with apptNewEnv, so queue
// contents and doctor diaries never depend on other tests.

// ---- helpers (prefixed op) ---------------------------------------------------

type opQueueEntry struct {
	ID                 string     `json:"id"`
	PatientID          string     `json:"patient_id"`
	AssignedProviderID *string    `json:"assigned_provider_id"`
	State              string     `json:"state"`
	Stage              string     `json:"stage"`
	Priority           int        `json:"priority"`
	CalledAt           *time.Time `json:"called_at"`
	StartedAt          *time.Time `json:"started_at"`
	EndedAt            *time.Time `json:"ended_at"`
	PatientName        string     `json:"patient_name"`
}

// opQueue reads the department's queue board (optionally one stage).
func opQueue(t *testing.T, e *apptEnv, stage string) []opQueueEntry {
	t.Helper()
	path := "/queue?department=" + e.dept
	if stage != "" {
		path += "&stage=" + stage
	}
	var out []opQueueEntry
	e.desk.Do("GET", path, nil).Expect(t, 200, "queue").Decode(t, &out)
	return out
}

// opWalkIn receives a new patient as a walk-in and returns their queue entry.
func opWalkIn(t *testing.T, e *apptEnv, toTriage bool) (patientRef, opQueueEntry) {
	t.Helper()
	p := e.patient(t)
	e.desk.Do("POST", "/queue/walk-in", map[string]any{
		"branch_id": e.branch, "department_id": e.dept, "patient_id": p.ID, "to_triage": toTriage,
	}).Expect(t, 201, "walk-in")
	for _, q := range opQueue(t, e, "") {
		if q.PatientID == p.ID {
			return p, q
		}
	}
	t.Fatalf("walk-in %s not on the queue board", p.ID)
	return p, opQueueEntry{}
}

type opQueueRow struct {
	State, Stage           string
	Priority               int
	Called, Started, Ended bool
	Provider               *uuid.UUID
}

func opQueueRowOf(t *testing.T, qid string) opQueueRow {
	t.Helper()
	var r opQueueRow
	if err := super.Pool.QueryRow(t.Context(),
		`SELECT state, stage, priority, called_at IS NOT NULL, started_at IS NOT NULL, ended_at IS NOT NULL, assigned_provider_id
		   FROM queue_entries WHERE id = $1`, opUUID(t, id.PrefixQueueEntry, qid)).
		Scan(&r.State, &r.Stage, &r.Priority, &r.Called, &r.Started, &r.Ended, &r.Provider); err != nil {
		t.Fatalf("queue entry %s: %v", qid, err)
	}
	return r
}

func opTransition(e *apptEnv, qid, state string) testkit.Resp {
	return e.desk.Do("POST", "/queue/"+qid+"/transition", map[string]any{"state": state})
}

// ---- the queue board -----------------------------------------------------------

// TestREG_QUEUE_001_BoardListsTodaysWalkIns: Given a walk-in sent straight to the
// dentist and one sent to triage, When the desk reads the department board, Then both
// are there, waiting, with their stage and name; the stage filter narrows it; a
// malformed department is 400; staff without queue.manage cannot read it; another
// clinic's desk does not see them.
func TestREG_QUEUE_001_BoardListsTodaysWalkIns(t *testing.T) {
	e := apptNewEnv(t)
	pd, qd := opWalkIn(t, e, false)
	_, qt := opWalkIn(t, e, true)
	if qd.State != "waiting" || qd.Stage != "with_doctor" || !strings.Contains(qd.PatientName, pd.FirstName) || qt.Stage != "triage" {
		t.Fatalf("board rows doctor=%+v triage=%+v", qd, qt)
	}
	tri := opQueue(t, e, "triage")
	if len(tri) != 1 || tri[0].ID != qt.ID {
		t.Fatalf("triage filter %+v", tri)
	}
	e.desk.Do("GET", "/queue?department=nope", nil).Expect(t, 400, "malformed department")
	srv.As(t, e.c, "cashier").Do("GET", "/queue?department="+e.dept, nil).Expect(t, 403, "cashier reads queue")
	past := url.QueryEscape(time.Now().Add(-72 * time.Hour).Format(time.RFC3339))
	before := url.QueryEscape(time.Now().Add(-48 * time.Hour).Format(time.RFC3339))
	var old []opQueueEntry
	e.desk.Do("GET", "/queue?department="+e.dept+"&from="+past+"&to="+before, nil).Expect(t, 200, "queue window").Decode(t, &old)
	if len(old) != 0 {
		t.Fatalf("a window two days ago lists today's walk-ins: %+v", old)
	}
	var other []opQueueEntry
	srv.As(t, clinicB, "receptionist").Do("GET", "/queue?department="+e.dept, nil).Expect(t, 200, "B reads A's department").Decode(t, &other)
	if len(other) != 0 {
		t.Fatalf("CROSS-CLINIC READ: clinic B sees clinic A's queue: %+v", other)
	}
}

// TestREG_QUEUE_002_TransitionsStampTheTimes: Given a waiting walk-in, When it is called,
// taken into the consult and finished, Then each state is stored with its time
// (called_at, started_at, ended_at) and the board shows it.
func TestREG_QUEUE_002_TransitionsStampTheTimes(t *testing.T) {
	e := apptNewEnv(t)
	_, q := opWalkIn(t, e, false)
	if r := opQueueRowOf(t, q.ID); r.State != "waiting" || r.Called || r.Started || r.Ended {
		t.Fatalf("fresh entry %+v", r)
	}
	opTransition(e, q.ID, "called").Expect(t, 204, "call")
	if r := opQueueRowOf(t, q.ID); r.State != "called" || !r.Called || r.Started {
		t.Fatalf("after call %+v", r)
	}
	srv.As(t, e.c, "doctor").Do("POST", "/queue/"+q.ID+"/transition", map[string]any{"state": "in_consult"}).Expect(t, 204, "doctor starts consult")
	if r := opQueueRowOf(t, q.ID); r.State != "in_consult" || !r.Started || r.Ended {
		t.Fatalf("after start %+v", r)
	}
	opTransition(e, q.ID, "done").Expect(t, 204, "finish")
	if r := opQueueRowOf(t, q.ID); r.State != "done" || !r.Ended {
		t.Fatalf("after done %+v", r)
	}
	for _, x := range opQueue(t, e, "") {
		if x.ID == q.ID && (x.State != "done" || x.EndedAt == nil) {
			t.Fatalf("board row after done %+v", x)
		}
	}
	_, ns := opWalkIn(t, e, false)
	opTransition(e, ns.ID, "no_show").Expect(t, 204, "no show")
	if r := opQueueRowOf(t, ns.ID); r.State != "no_show" || !r.Ended {
		t.Fatalf("after no-show %+v", r)
	}
}

// TestREG_QUEUE_003_TransitionValidation: Given a waiting entry, When the state is
// unknown or missing, Then 400 and it stays waiting; an unknown entry is 404; a
// malformed id is 400; staff without queue.manage cannot move it.
func TestREG_QUEUE_003_TransitionValidation(t *testing.T) {
	e := apptNewEnv(t)
	_, q := opWalkIn(t, e, false)
	opTransition(e, q.ID, "teleported").Expect(t, 400, "unknown state")
	e.desk.Do("POST", "/queue/"+q.ID+"/transition", map[string]any{}).Expect(t, 400, "no state")
	if r := opQueueRowOf(t, q.ID); r.State != "waiting" {
		t.Fatalf("state after refused transitions %q", r.State)
	}
	if r := opTransition(e, id.Encode(id.PrefixQueueEntry, uuid.New()), "called"); r.Status != 404 || r.Code != "QUEUE_ENTRY_NOT_FOUND" {
		t.Fatalf("unknown entry: %d %s", r.Status, r.Code)
	}
	opTransition(e, "que_bad", "called").Expect(t, 400, "malformed id")
	srv.As(t, e.c, "cashier").Do("POST", "/queue/"+q.ID+"/transition", map[string]any{"state": "called"}).Expect(t, 403, "cashier moves queue")
}

// TestREG_QUEUE_004_FinishedVisitCannotBeReopened: Given a visit marked done, When the
// desk moves it back to waiting, Then 409 and it stays done. Today any state can follow
// any other: a finished visit reappears on the board as waiting, with its end time
// still set.
func TestREG_QUEUE_004_FinishedVisitCannotBeReopened(t *testing.T) {
	e := apptNewEnv(t)
	_, q := opWalkIn(t, e, false)
	opTransition(e, q.ID, "done").Expect(t, 204, "finish")
	r := opTransition(e, q.ID, "waiting")
	after := opQueueRowOf(t, q.ID)
	testkit.KnownBug(t, "NEW-QUEUE-1", r.Status < 400 || after.State != "done", fmt.Sprintf(
		"done → waiting answered %d and the entry is now %q: TransitionQueue checks the state name only, never the "+
			"current state (scheduling/service/service.go TransitionQueue)", r.Status, after.State))
}

// TestREG_QUEUE_005_PriorityIsStored: Given a waiting entry, When the desk raises its
// priority, Then it is stored and shown; a non-number is 400; staff without
// queue.manage cannot change it.
func TestREG_QUEUE_005_PriorityIsStored(t *testing.T) {
	e := apptNewEnv(t)
	_, q := opWalkIn(t, e, false)
	e.desk.Do("POST", "/queue/"+q.ID+"/priority", map[string]any{"priority": 2}).Expect(t, 204, "set priority")
	if r := opQueueRowOf(t, q.ID); r.Priority != 2 {
		t.Fatalf("priority stored %d", r.Priority)
	}
	for _, x := range opQueue(t, e, "") {
		if x.ID == q.ID && x.Priority != 2 {
			t.Fatalf("board priority %d", x.Priority)
		}
	}
	e.desk.Do("POST", "/queue/"+q.ID+"/priority", map[string]any{"priority": "urgent"}).Expect(t, 400, "priority not a number")
	e.desk.Do("POST", "/queue/que_bad/priority", map[string]any{"priority": 1}).Expect(t, 400, "malformed id")
	srv.As(t, e.c, "cashier").Do("POST", "/queue/"+q.ID+"/priority", map[string]any{"priority": 9}).Expect(t, 403, "cashier sets priority")
	if r := opQueueRowOf(t, q.ID); r.Priority != 2 {
		t.Fatalf("priority after refused writes %d", r.Priority)
	}
}

// TestREG_QUEUE_006_PriorityOfUnknownEntryIs404: Given a queue entry id that does not
// exist, When its priority is set, Then 404 — not a silent 204 (SetQueuePriority is
// :exec with no row check).
func TestREG_QUEUE_006_PriorityOfUnknownEntryIs404(t *testing.T) {
	e := apptNewEnv(t)
	r := e.desk.Do("POST", "/queue/"+id.Encode(id.PrefixQueueEntry, uuid.New())+"/priority", map[string]any{"priority": 1})
	opStatus(t, r, "priority of unknown entry", 404, 204)
	testkit.KnownBug(t, "NEW-QUEUE-2", r.Status == 204,
		"POST /queue/<nonexistent>/priority answers 204: SetQueuePriority is :exec with no row-count check")
}

// TestREG_QUEUE_007_AssignRoutesToTheDoctorsWorklist: Given a walk-in waiting for any
// doctor, When the desk assigns the clinic's dentist, Then the entry is assigned and at
// the doctor stage, it leaves the unassigned pool and appears on that dentist's
// worklist; a triage patient without vitals cannot be sent (409 VITALS_REQUIRED); a
// missing or malformed provider, or an unknown entry, is refused.
func TestREG_QUEUE_007_AssignRoutesToTheDoctorsWorklist(t *testing.T) {
	e := apptNewEnv(t)
	_, q := opWalkIn(t, e, false)
	type wl struct {
		ID string `json:"id"`
	}
	has := func(c *testkit.Client, path, qid string) bool {
		var list []wl
		c.Do("GET", path, nil).Expect(t, 200, path).Decode(t, &list)
		for _, x := range list {
			if x.ID == qid {
				return true
			}
		}
		return false
	}
	if !has(e.doc, "/worklist/unassigned", q.ID) || has(e.doc, "/worklist", q.ID) {
		t.Fatalf("before assignment the entry must be in the pool and on nobody's list")
	}
	e.desk.Do("POST", "/queue/"+q.ID+"/assign", map[string]any{}).Expect(t, 400, "assign without provider")
	e.desk.Do("POST", "/queue/"+q.ID+"/assign", map[string]any{"provider_id": "usr_bad"}).Expect(t, 400, "malformed provider")
	if r := e.desk.Do("POST", "/queue/"+id.Encode(id.PrefixQueueEntry, uuid.New())+"/assign", map[string]any{"provider_id": e.docID}); r.Status != 404 || r.Code != "QUEUE_ENTRY_NOT_FOUND" {
		t.Fatalf("assign unknown entry: %d %s", r.Status, r.Code)
	}
	srv.As(t, e.c, "cashier").Do("POST", "/queue/"+q.ID+"/assign", map[string]any{"provider_id": e.docID}).Expect(t, 403, "cashier assigns")

	e.desk.Do("POST", "/queue/"+q.ID+"/assign", map[string]any{"provider_id": e.docID}).Expect(t, 204, "assign dentist")
	r := opQueueRowOf(t, q.ID)
	if r.Provider == nil || *r.Provider != e.c.Staff["doctor"].ID || r.Stage != "with_doctor" {
		t.Fatalf("after assign %+v", r)
	}
	if !has(e.doc, "/worklist", q.ID) || has(e.doc, "/worklist/unassigned", q.ID) {
		t.Fatalf("after assignment the entry must be on the dentist's list and out of the pool")
	}
	owner := srv.As(t, e.c, "owner")
	if !has(owner, "/worklist?provider="+e.docID, q.ID) || has(owner, "/worklist", q.ID) {
		t.Fatalf("worklist by provider must show the dentist's patient and the owner's own list must not")
	}
	e.doc.Do("GET", "/worklist?provider=bad", nil).Expect(t, 400, "worklist malformed provider")
	e.desk.Do("GET", "/worklist", nil).Expect(t, 403, "desk reads a worklist")

	_, tq := opWalkIn(t, e, true)
	if x := e.desk.Do("POST", "/queue/"+tq.ID+"/assign", map[string]any{"provider_id": e.docID}); x.Status != 409 || x.Code != "VITALS_REQUIRED" {
		t.Fatalf("assign a triage patient without vitals: %d %s", x.Status, x.Code)
	}
	if r := opQueueRowOf(t, tq.ID); r.Stage != "triage" || r.Provider != nil {
		t.Fatalf("refused assignment changed the entry %+v", r)
	}
}

// TestREG_QUEUE_008_AssignOnlyToThisClinicsClinicians: Given a waiting walk-in, When the
// desk assigns it to the cashier, or to another clinic's dentist, Then the API refuses
// (4xx) and the entry stays unassigned. Today any user id is accepted (the foreign key
// is the only check), so a patient can be "with" the cashier or a stranger.
func TestREG_QUEUE_008_AssignOnlyToThisClinicsClinicians(t *testing.T) {
	e := apptNewEnv(t)
	_, q1 := opWalkIn(t, e, false)
	_, q2 := opWalkIn(t, e, false)
	cashier := e.desk.Do("POST", "/queue/"+q1.ID+"/assign", map[string]any{"provider_id": id.Encode(id.PrefixUser, e.c.Staff["cashier"].ID)})
	stranger := e.desk.Do("POST", "/queue/"+q2.ID+"/assign", map[string]any{"provider_id": id.Encode(id.PrefixUser, clinicB.Staff["doctor"].ID)})
	var leaked []struct {
		ID string `json:"id"`
	}
	srv.As(t, clinicB, "doctor").Do("GET", "/worklist", nil).Expect(t, 200, "B's dentist worklist").Decode(t, &leaked)
	for _, x := range leaked {
		if x.ID == q2.ID {
			t.Fatalf("CROSS-CLINIC READ: clinic A's patient is on clinic B's dentist's worklist")
		}
	}
	r1, r2 := opQueueRowOf(t, q1.ID), opQueueRowOf(t, q2.ID)
	testkit.KnownBug(t, "NEW-QUEUE-3", cashier.Status < 400 || stranger.Status < 400 || r1.Provider != nil || r2.Provider != nil, fmt.Sprintf(
		"assign accepts any user: to the cashier %d, to another clinic's dentist %d (AssignProvider never checks the provider "+
			"is an active clinician of this clinic)", cashier.Status, stranger.Status))
}

// TestREG_QUEUE_009_AnotherClinicCannotMoveTheQueue: Given clinic A's waiting entry,
// When clinic B's desk calls it, reprioritises it or assigns it, Then nothing about it
// changes (the transition and assignment are 404).
func TestREG_QUEUE_009_AnotherClinicCannotMoveTheQueue(t *testing.T) {
	e := apptNewEnv(t)
	_, q := opWalkIn(t, e, false)
	b := srv.As(t, clinicB, "receptionist")
	b.Do("POST", "/queue/"+q.ID+"/transition", map[string]any{"state": "done"}).Expect(t, 404, "B finishes A's entry")
	b.Do("POST", "/queue/"+q.ID+"/assign", map[string]any{"provider_id": id.Encode(id.PrefixUser, clinicB.Staff["doctor"].ID)}).Expect(t, 404, "B assigns A's entry")
	b.Do("POST", "/queue/"+q.ID+"/priority", map[string]any{"priority": 7})
	if r := opQueueRowOf(t, q.ID); r.State != "waiting" || r.Priority != 0 || r.Provider != nil {
		t.Fatalf("CROSS-CLINIC WRITE: A's entry is now %+v", r)
	}
}

// TestREG_QUEUE_010_LiveStreamConnectsWithAQueryToken: Given a desk user, When the board
// opens the live stream with its token in the query, Then the server answers 200
// text/event-stream and sends the "connected" comment; without a token it is 401, with
// a malformed department 400.
func TestREG_QUEUE_010_LiveStreamConnectsWithAQueryToken(t *testing.T) {
	e := apptNewEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.BaseURL+"/queue/stream?department="+e.dept+"&token="+url.QueryEscape(e.desk.Token), nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stream: %d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	line, err := bufio.NewReader(res.Body).ReadString('\n')
	if err != nil || !strings.HasPrefix(line, ": connected") {
		t.Fatalf("first stream line %q (%v)", line, err)
	}
	cancel()

	get := func(q string) int {
		r, err := http.Get(srv.BaseURL + "/queue/stream?" + q)
		if err != nil {
			t.Fatalf("stream: %v", err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	if s := get("department=" + e.dept); s != 401 {
		t.Fatalf("stream without token: %d", s)
	}
	if s := get("department=bad&token=" + url.QueryEscape(e.desk.Token)); s != 400 {
		t.Fatalf("stream with malformed department: %d", s)
	}
	if s := get("token=garbage"); s != 401 {
		t.Fatalf("stream with garbage token: %d", s)
	}
}

// ---- appointments: follow-up, reassignment, a patient's own schedule -------------------

// TestREG_APPT_020_MarkFollowupSetsTheFreeWindow: Given an ordinary booking, When the
// desk marks it a follow-up without a date, Then it is a follow-up free for 30 days;
// with an explicit free_until, Then that date is stored; a malformed date is 400; an
// unknown appointment 404; another clinic cannot mark it; a cashier is refused.
func TestREG_APPT_020_MarkFollowupSetsTheFreeWindow(t *testing.T) {
	e := apptNewEnv(t)
	a := e.book(t, e.patient(t).ID, apptTomorrowAt(10, 0), 30)
	path := "/appointments/" + a.ID + "/followup"
	read := func() (bool, *time.Time) {
		var fu bool
		var until *time.Time
		one(t, `SELECT is_followup FROM appointments WHERE id = $1`, &fu, apptUUID(t, a.ID))
		one(t, `SELECT free_until FROM appointments WHERE id = $1`, &until, apptUUID(t, a.ID))
		return fu, until
	}
	srv.As(t, clinicB, "receptionist").Do("POST", path, map[string]any{}).Expect(t, 404, "B marks A's appointment")
	srv.As(t, e.c, "cashier").Do("POST", path, map[string]any{}).Expect(t, 403, "cashier marks follow-up")
	if fu, _ := read(); fu {
		t.Fatalf("refused writes marked the appointment")
	}
	e.desk.Do("POST", path, nil).Expect(t, 204, "mark follow-up")
	fu, until := read()
	if !fu || until == nil || until.Sub(time.Now().AddDate(0, 0, 30)).Abs() > time.Hour {
		t.Fatalf("follow-up=%v free_until=%v, want ~30 days", fu, until)
	}
	want := time.Date(2030, 1, 15, 9, 0, 0, 0, time.UTC)
	e.desk.Do("POST", path, map[string]any{"free_until": want.Format(time.RFC3339)}).Expect(t, 204, "mark with date")
	if _, until := read(); until == nil || !until.Equal(want) {
		t.Fatalf("free_until %v, want %v", until, want)
	}
	e.desk.Do("POST", path, map[string]any{"free_until": "next week"}).Expect(t, 400, "malformed free_until")
	if r := e.desk.Do("POST", "/appointments/"+id.Encode(id.PrefixAppointment, uuid.New())+"/followup", map[string]any{}); r.Status != 404 || r.Code != "APPOINTMENT_NOT_FOUND" {
		t.Fatalf("unknown appointment: %d %s", r.Status, r.Code)
	}
	e.desk.Do("POST", "/appointments/apt_bad/followup", map[string]any{}).Expect(t, 400, "malformed id")
}

// TestREG_APPT_021_ReassignHandsTheVisitToACoveringDoctor: Given a follow-up the dentist
// ordered, When the desk hands it to the owner (also a clinician), Then the owner now
// attends, the dentist is still recorded as who ordered it, and the hand-off is
// published; a clash in the owner's diary is 409 APPOINTMENT_CONFLICT; missing or
// malformed provider and unknown appointment are refused; another clinic cannot do it.
func TestREG_APPT_021_ReassignHandsTheVisitToACoveringDoctor(t *testing.T) {
	e := apptNewEnv(t)
	body := e.bookBody(e.patient(t).ID, apptTomorrowAt(11, 0), 30)
	body["is_followup"] = true
	var fu apptRef
	e.doc.Do("POST", "/appointments", body).Expect(t, 201, "dentist books follow-up").Decode(t, &fu)
	ownerID := id.Encode(id.PrefixUser, e.c.Owner.ID)
	path := "/appointments/" + fu.ID + "/reassign"

	e.desk.Do("POST", path, map[string]any{}).Expect(t, 400, "reassign without provider")
	e.desk.Do("POST", path, map[string]any{"provider_id": "usr_bad"}).Expect(t, 400, "malformed provider")
	if r := e.desk.Do("POST", "/appointments/"+id.Encode(id.PrefixAppointment, uuid.New())+"/reassign", map[string]any{"provider_id": ownerID}); r.Status != 404 {
		t.Fatalf("reassign unknown appointment: %d", r.Status)
	}
	srv.As(t, clinicB, "receptionist").Do("POST", path, map[string]any{"provider_id": ownerID}).Expect(t, 404, "B reassigns A's appointment")
	srv.As(t, e.c, "cashier").Do("POST", path, map[string]any{"provider_id": ownerID}).Expect(t, 403, "cashier reassigns")

	e.desk.Do("POST", path, map[string]any{"provider_id": ownerID, "note": "dentist on leave"}).Expect(t, 204, "reassign")
	var prov, ordered uuid.UUID
	one(t, `SELECT provider_id FROM appointments WHERE id = $1`, &prov, apptUUID(t, fu.ID))
	one(t, `SELECT ordered_by FROM appointments WHERE id = $1`, &ordered, apptUUID(t, fu.ID))
	if prov != e.c.Owner.ID || ordered != e.c.Staff["doctor"].ID {
		t.Fatalf("after reassign provider=%v ordered_by=%v", prov, ordered)
	}
	var ev int
	one(t, `SELECT count(*) FROM event_outbox WHERE aggregate_id = $1 AND event_type = 'scheduling.appointment.reassigned'`, &ev, apptUUID(t, fu.ID))
	if ev != 1 {
		t.Fatalf("reassignment events %d", ev)
	}

	// The dentist's 11:00 slot is free now; book another dentist patient there, then
	// try to hand that one to the owner, who already has 11:00.
	clash := e.book(t, e.patient(t).ID, apptTomorrowAt(11, 0), 30)
	if r := e.desk.Do("POST", "/appointments/"+clash.ID+"/reassign", map[string]any{"provider_id": ownerID}); r.Status != 409 || r.Code != "APPOINTMENT_CONFLICT" {
		t.Fatalf("reassign into a clash: %d %s", r.Status, r.Code)
	}
	one(t, `SELECT provider_id FROM appointments WHERE id = $1`, &prov, apptUUID(t, clash.ID))
	if prov != e.c.Staff["doctor"].ID {
		t.Fatalf("refused reassignment moved the appointment to %v", prov)
	}
}

// TestREG_APPT_022_PatientScheduleListsAllTheirBookings: Given a patient with two
// bookings and another patient with one, When the desk asks for the first patient's
// schedule over the coming days, Then exactly their two come back; a malformed patient
// id is 400; another clinic sees none of them.
func TestREG_APPT_022_PatientScheduleListsAllTheirBookings(t *testing.T) {
	e := apptNewEnv(t)
	p := e.patient(t)
	a1 := e.book(t, p.ID, apptTomorrowAt(9, 0), 30)
	a2 := e.book(t, p.ID, apptTomorrowAt(15, 0).AddDate(0, 0, 2), 30)
	e.book(t, e.patient(t).ID, apptTomorrowAt(12, 0), 30)
	from := url.QueryEscape(time.Now().Format(time.RFC3339))
	to := url.QueryEscape(time.Now().AddDate(0, 0, 7).Format(time.RFC3339))
	var list []apptRef
	e.desk.Do("GET", "/appointments?patient="+p.ID+"&from="+from+"&to="+to, nil).Expect(t, 200, "patient schedule").Decode(t, &list)
	ids := []string{}
	for _, a := range list {
		ids = append(ids, a.ID)
		if a.PatientID != p.ID {
			t.Fatalf("another patient's booking in the schedule: %+v", a)
		}
	}
	if len(list) != 2 || !opHas(ids, a1.ID) || !opHas(ids, a2.ID) {
		t.Fatalf("schedule %v, want %s and %s", ids, a1.ID, a2.ID)
	}
	e.desk.Do("GET", "/appointments?patient=pat_bad", nil).Expect(t, 400, "malformed patient")
	var other []apptRef
	srv.As(t, clinicB, "receptionist").Do("GET", "/appointments?patient="+p.ID+"&from="+from+"&to="+to, nil).Expect(t, 200, "B asks").Decode(t, &other)
	if len(other) != 0 {
		t.Fatalf("CROSS-CLINIC READ: clinic B sees clinic A's patient's bookings")
	}
}

// TestREG_QUEUE_011_WalkInWaitsForTheDefaultFee: Given a clinic whose visit fee is
// charged by default, When the desk receives a walk-in without naming the branch, Then
// the walk-in is gated (one charge, no queue entry yet) in the desk's own branch; When
// the cashier settles it, Then the patient is on the queue.
func TestREG_QUEUE_011_WalkInWaitsForTheDefaultFee(t *testing.T) {
	e := apptNewEnv(t)
	opExec(t, `UPDATE service_items SET is_default = true WHERE tenant_id = $1 AND code = 'REG'`, e.c.TenantID)
	p := e.patient(t)
	var res struct {
		Gated     bool     `json:"gated"`
		ChargeIDs []string `json:"charge_ids"`
	}
	e.desk.Do("POST", "/queue/walk-in", map[string]any{"department_id": e.dept, "patient_id": p.ID}).Expect(t, 201, "walk-in").Decode(t, &res)
	if !res.Gated || len(res.ChargeIDs) != 1 {
		t.Fatalf("walk-in with a default fee: %+v", res)
	}
	var branch uuid.UUID
	one(t, `SELECT branch_id FROM charges WHERE id = $1`, &branch, opUUID(t, id.PrefixCharge, res.ChargeIDs[0]))
	var queued int
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id = $1`, &queued, opUUID(t, id.PrefixPatient, p.ID))
	if branch != e.c.BranchID || queued != 0 {
		t.Fatalf("gated walk-in: charge branch=%v queue entries=%d", branch, queued)
	}
	srv.As(t, e.c, "cashier").Do("POST", "/billing/charges/"+res.ChargeIDs[0]+"/settle", map[string]any{"method": "cash"}).Expect(t, 204, "settle")
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id = $1`, &queued, opUUID(t, id.PrefixPatient, p.ID))
	if queued != 1 {
		t.Fatalf("after paying, queue entries=%d, want 1", queued)
	}
	e.desk.Do("POST", "/queue/walk-in", map[string]any{"department_id": "x", "patient_id": p.ID}).Expect(t, 400, "malformed department")
	e.desk.Do("POST", "/queue/walk-in", map[string]any{"department_id": e.dept}).Expect(t, 400, "walk-in without patient")
}

// TestREG_APPT_023_CheckInRoutesAndRescues: Given a booking, When the desk checks it in
// to a named clinician, Then the queue entry is assigned to that clinician; When the
// clinic requires triage, Then a check-in lands at triage whatever the desk asked; Given
// an old booking with no department, When it is checked in without one, Then 400, and
// with one, Then the patient is queued there and the booking gains the department; an
// unknown booking is 404.
func TestREG_APPT_023_CheckInRoutesAndRescues(t *testing.T) {
	e := apptNewEnv(t)
	owner := id.Encode(id.PrefixUser, e.c.Owner.ID)
	a := e.book(t, e.patient(t).ID, time.Now().Add(-time.Minute), 30)
	e.desk.Do("POST", "/appointments/"+a.ID+"/check-in", map[string]any{"provider_id": owner, "priority": 1}).Expect(t, 200, "check in to the owner")
	var prov uuid.UUID
	var prio int
	one(t, `SELECT assigned_provider_id FROM queue_entries WHERE appointment_id = $1`, &prov, apptUUID(t, a.ID))
	one(t, `SELECT priority FROM queue_entries WHERE appointment_id = $1`, &prio, apptUUID(t, a.ID))
	if prov != e.c.Owner.ID || prio != 1 {
		t.Fatalf("checked-in entry provider=%v priority=%d", prov, prio)
	}

	old := e.book(t, e.patient(t).ID, time.Now().Add(-2*time.Hour), 30)
	opExec(t, `UPDATE appointments SET department_id = NULL WHERE id = $1`, apptUUID(t, old.ID))
	e.checkIn(t, old.ID).Expect(t, 400, "check in a booking with no department")
	e.desk.Do("POST", "/appointments/"+old.ID+"/check-in", map[string]any{"department_id": e.dept}).Expect(t, 200, "rescue with a department")
	var dept uuid.UUID
	one(t, `SELECT department_id FROM appointments WHERE id = $1`, &dept, apptUUID(t, old.ID))
	if dept != e.c.DeptID || apptQueueCount(t, old.ID) != 1 {
		t.Fatalf("rescued booking department=%v queue=%d", dept, apptQueueCount(t, old.ID))
	}

	srv.As(t, e.c, "owner").Do("PUT", "/org/settings", map[string]any{"triage_required": true}).Expect(t, 200, "require triage")
	tri := e.book(t, e.patient(t).ID, time.Now().Add(-3*time.Hour), 30)
	e.desk.Do("POST", "/appointments/"+tri.ID+"/check-in", map[string]any{"to_triage": false}).Expect(t, 200, "check in")
	var stage string
	one(t, `SELECT stage FROM queue_entries WHERE appointment_id = $1`, &stage, apptUUID(t, tri.ID))
	if stage != "triage" {
		t.Fatalf("check-in stage %q with triage required", stage)
	}
	if r := e.checkIn(t, id.Encode(id.PrefixAppointment, uuid.New())); r.Status != 404 || r.Code != "APPOINTMENT_NOT_FOUND" {
		t.Fatalf("check in unknown booking: %d %s", r.Status, r.Code)
	}
	e.desk.Do("POST", "/appointments/"+a.ID+"/check-in", map[string]any{"provider_id": "bad"}).Expect(t, 400, "malformed provider")
	e.desk.Do("POST", "/appointments/"+a.ID+"/check-in", map[string]any{"department_id": "bad"}).Expect(t, 400, "malformed department")
}
