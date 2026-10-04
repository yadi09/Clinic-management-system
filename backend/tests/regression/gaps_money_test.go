package regression

import (
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Money gaps an audit found untested: the catalogue price a client can override, the
// intake fee under concurrent arrivals, the follow-up free window at its edges, the
// clinic day at midnight Addis, and the dental compare-and-set, pay-later and
// chairside guards.
//
// Rules held here (read from the code and the approved workflow, not invented):
//   - A catalogue item is sold at the catalogue's price. The client names the item;
//     it does not name the price (audit FIN-15).
//   - One registration fee per patient per Addis day, however many desks press at once
//     (audit FIN-6).
//   - "Free" means a follow-up a DOCTOR booked, attended on or before the day its
//     window ends. Walk-ins, late follow-ups, cancelled or missed bookings, and
//     bookings the desk itself labelled "follow-up" all pay (docs/patient-workflow.md).
//   - The clinic's day runs midnight to midnight Africa/Addis_Ababa, not UTC.
//   - A dental visit has at most one live charge; two people billing / forgiving it at
//     once must not leave two, or one with nothing pointing at it.
//
// Every test runs in its own clinic so the totals it asserts are exact.

// ---- helpers (gm-prefixed: other files in this package are written concurrently) ----

var gmAddis = func() *time.Location {
	loc, err := time.LoadLocation("Africa/Addis_Ababa")
	if err != nil {
		return time.FixedZone("EAT", 3*3600)
	}
	return loc
}()

// gmAddisMidnight is midnight Addis, `days` days from today (0 = today).
func gmAddisMidnight(days int) time.Time {
	n := time.Now().In(gmAddis)
	return time.Date(n.Year(), n.Month(), n.Day()+days, 0, 0, 0, 0, gmAddis)
}

func gmAddisDate(days int) string { return gmAddisMidnight(days).Format("2006-01-02") }

// gmFeeClinic is a private clinic whose registration (default service) costs 200.
func gmFeeClinic(t *testing.T) (*testkit.Clinic, string) {
	t.Helper()
	clinic := payClinic(t)
	mgr := srv.As(t, clinic, "branch_manager")
	svc := blService(t, mgr, "Registration", "general", 200, "either")
	mgr.Do("PUT", "/billing/services/"+svc+"/default", map[string]any{"is_default": true}).Expect(t, 204, "make default")
	return clinic, svc
}

// gmFees counts the patient's live (not void) charges for the default service.
func gmFees(t *testing.T, p patientRef, svc string) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1 AND service_item_id = $2 AND deleted_at IS NULL AND status <> 'void'`,
		&n, blPatientUUID(t, p), blUUID(t, id.PrefixServiceItem, svc))
	return n
}

func gmQueued(t *testing.T, p patientRef) int {
	t.Helper()
	var n int
	one(t, `SELECT count(*) FROM queue_entries WHERE patient_id = $1 AND deleted_at IS NULL`, &n, blPatientUUID(t, p))
	return n
}

// gmBookFollowup books a follow-up as `who`, starting `startIn` from now, free until freeUntil.
func gmBookFollowup(t *testing.T, who *testkit.Client, clinic *testkit.Clinic, p patientRef, startIn time.Duration, freeUntil time.Time) string {
	t.Helper()
	var a struct {
		ID string `json:"id"`
	}
	who.Do("POST", "/appointments", map[string]any{
		"branch_id": payBranch(t, clinic), "patient_id": p.ID, "provider_id": blUser(clinic.Staff["doctor"]), "department_id": blDept(clinic),
		"starts_at": time.Now().Add(startIn).UTC().Format(time.RFC3339), "duration_min": 30, "is_followup": true,
		"free_until": freeUntil.UTC().Format(time.RFC3339),
	}).Expect(t, 201, "book follow-up").Decode(t, &a)
	return a.ID
}

type gmArrival struct {
	Gated     bool     `json:"gated"`
	ChargeIDs []string `json:"charge_ids"`
}

func gmCheckIn(t *testing.T, desk *testkit.Client, apptID string) (testkit.Resp, gmArrival) {
	t.Helper()
	r := desk.Do("POST", "/appointments/"+apptID+"/check-in", map[string]any{})
	var a gmArrival
	if r.Status == 200 {
		r.Decode(t, &a)
	}
	return r, a
}

// ---- FIN-15: the catalogue price ------------------------------------------------------

// TestREG_BILL_092_CatalogueItemIsChargedAtItsListPrice (FIN-15): Given a 1,500
// catalogue service, When the desk raises it for a patient (singly, and as part of a
// visit registration) with the amount set to 1, Then the request is refused or the
// stored charge is 1,500 — never 1. The amount is taken from the client even when a
// catalogue item is named, so the price list can be bypassed by anyone with
// payment.charge.
func TestREG_BILL_092_CatalogueItemIsChargedAtItsListPrice(t *testing.T) {
	clinic := payClinic(t)
	recp, mgr := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "branch_manager")
	svc := blService(t, mgr, "Panoramic X-ray", "general", 1500, "either")

	stored := func(p patientRef) []float64 {
		rows, err := super.Pool.Query(t.Context(),
			`SELECT amount::text FROM charges WHERE patient_id = $1 AND service_item_id = $2 AND deleted_at IS NULL`,
			blPatientUUID(t, p), blUUID(t, id.PrefixServiceItem, svc))
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := []float64{}
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				t.Fatal(err)
			}
			out = append(out, payNum(t, s))
		}
		return out
	}
	// A correct answer is a refusal (4xx, nothing stored) or the list price stored.
	judge := func(what string, r testkit.Resp, p patientRef) (cheap bool) {
		t.Helper()
		got := stored(p)
		switch {
		case r.Status >= 400 && r.Status < 500:
			if len(got) != 0 {
				t.Fatalf("%s: refused (%d %s) but stored %v", what, r.Status, r.Code, got)
			}
			return false
		case r.Status == 201:
			if len(got) != 1 {
				t.Fatalf("%s: accepted but stored %d charges for the service: %v", what, len(got), got)
			}
			if payEq(got[0], 1500) {
				return false
			}
			if payEq(got[0], 1) {
				return true
			}
			t.Fatalf("%s: stored %v, want 1500 (list price)", what, got[0])
		default:
			t.Fatalf("%s: HTTP %d %s %s", what, r.Status, r.Code, r.Message)
		}
		return false
	}

	single := createPatient(t, recp, uniq("Cheap"), "Single")
	r1 := recp.Do("POST", "/billing/charges", map[string]any{
		"patient_id": single.ID, "service_item_id": svc, "source": "service", "description": "Panoramic X-ray",
		"amount": 1, "branch_id": payBranch(t, clinic),
	})
	cheap1 := judge("single raise", r1, single)

	batch := createPatient(t, recp, uniq("Cheap"), "Batch")
	r2 := recp.Do("POST", "/billing/charges/batch", map[string]any{
		"patient_id": batch.ID, "branch_id": payBranch(t, clinic), "department_id": blDept(clinic),
		"items": []map[string]any{{"service_item_id": svc, "source": "service", "description": "Panoramic X-ray", "amount": 1}},
	})
	cheap2 := judge("visit registration", r2, batch)

	if cheap1 || cheap2 {
		testkit.KnownBug(t, "FIN-15", true, fmt.Sprintf(
			"a 1,500 catalogue service was stored at 1 (single raise: %v, batch: %v) — billing/service/service.go RaiseChargeTx "+
				"stores priceOrZero(in.Amount) even when a service_item_id is named", cheap1, cheap2))
	}
	testkit.KnownBug(t, "FIN-15", false, "a catalogue item is charged at its list price whatever amount the client sends")
}

// ---- FIN-6: concurrent arrivals --------------------------------------------------------

// TestREG_BILL_093_ConcurrentArrivalsRaiseOneIntakeFee (FIN-6): Given a 200 registration
// fee, When four desks receive the same walk-in at the same instant (repeated for
// several patients), Then each patient has exactly one registration fee and every
// press is answered (201). The guard counts today's fee and then inserts, with no lock,
// so simultaneous presses can each see "none yet" and each raise one.
func TestREG_BILL_093_ConcurrentArrivalsRaiseOneIntakeFee(t *testing.T) {
	clinic, svc := gmFeeClinic(t)
	desks := []*testkit.Client{
		srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "receptionist"),
		srv.As(t, clinic, "branch_manager"), srv.As(t, clinic, "owner"),
	}
	// Control: two presses one after the other must hand back the same fee, or a
	// race below could not be told apart from a broken "today" (NEW-DAY-2).
	// (NEW-DAY-2, fixed 2026-10-04: sequential presses are idempotent at every hour.)
	if !gmSequentialPressIsIdempotent(t, clinic, desks[0]) {
		t.Fatal("two sequential walk-ins raised two registration fees")
	}
	const rounds = 6
	worst, dupPatients := 0, 0
	for i := 0; i < rounds; i++ {
		p := createPatient(t, desks[0], uniq("Race"), "Arrival")
		body := map[string]any{"patient_id": p.ID, "department_id": blDept(clinic), "branch_id": payBranch(t, clinic)}
		fns := make([]func() testkit.Resp, len(desks))
		for j, d := range desks {
			d := d
			fns[j] = func() testkit.Resp { return d.Do("POST", "/queue/walk-in", body) }
		}
		rs := blRace(fns...)
		for _, r := range rs {
			if r.Status != 201 {
				t.Fatalf("round %d: a concurrent walk-in answered %d %s %s, want 201 (%s)", i, r.Status, r.Code, r.Message, payDescribe(rs))
			}
		}
		n := gmFees(t, p, svc)
		if n == 0 {
			t.Fatalf("round %d: four walk-ins raised no registration fee", i)
		}
		if gmQueued(t, p) != 0 {
			t.Fatalf("round %d: an unpaid walk-in was queued", i)
		}
		if n > 1 {
			dupPatients++
		}
		if n > worst {
			worst = n
		}
	}
	if dupPatients > 0 {
		testkit.KnownBug(t, "FIN-6", true, fmt.Sprintf(
			"%d of %d patients received simultaneously were charged the registration fee more than once (worst: %d fees) — "+
				"RaiseIntakeChargeIDsTx counts then inserts without a lock", dupPatients, rounds, worst))
	}
	testkit.KnownBug(t, "FIN-6", false, "simultaneous arrivals raise one registration fee per patient")
}

// gmSequentialPressIsIdempotent receives a fresh walk-in twice in a row and reports
// whether the second press handed back the first press's fee.
func gmSequentialPressIsIdempotent(t *testing.T, clinic *testkit.Clinic, desk *testkit.Client) bool {
	t.Helper()
	p := createPatient(t, desk, uniq("Seq"), "Arrival")
	body := map[string]any{"patient_id": p.ID, "department_id": blDept(clinic), "branch_id": payBranch(t, clinic)}
	var a, b gmArrival
	desk.Do("POST", "/queue/walk-in", body).Expect(t, 201, "first press").Decode(t, &a)
	desk.Do("POST", "/queue/walk-in", body).Expect(t, 201, "second press").Decode(t, &b)
	return len(a.ChargeIDs) == 1 && len(b.ChargeIDs) == 1 && a.ChargeIDs[0] == b.ChargeIDs[0]
}

// TestREG_BILL_096_TodaysFeeCountsFromAddisMidnight (NEW-DAY-2): Given a registration
// fee raised at 00:01 Addis today and still unpaid, When the desk presses "receive"
// for the same patient again, Then that fee is handed back and no second fee is raised.
// The guard's "today" is ((now() AT TIME ZONE Addis)::date) AT TIME ZONE Addis, which
// yields a naive timestamp read back in the SESSION time zone: on a UTC server that is
// 06:00 Addis, so from midnight to 06:00 every press raises another fee (on a server
// in any other zone the window moves again).
func TestREG_BILL_096_TodaysFeeCountsFromAddisMidnight(t *testing.T) {
	early := gmAddisMidnight(0).Add(time.Minute)
	if time.Now().Before(early.Add(time.Minute)) {
		t.Skip("runs only after 00:02 Addis, so the back-dated fee is in the past")
	}
	clinic, svc := gmFeeClinic(t)
	desk := srv.As(t, clinic, "receptionist")
	p := createPatient(t, desk, uniq("Early"), "Fee")
	body := map[string]any{"patient_id": p.ID, "department_id": blDept(clinic), "branch_id": payBranch(t, clinic)}
	var first, again gmArrival
	desk.Do("POST", "/queue/walk-in", body).Expect(t, 201, "first press").Decode(t, &first)
	if !first.Gated || len(first.ChargeIDs) != 1 {
		t.Fatalf("first press %+v, want one fee", first)
	}
	blExec(t, `UPDATE charges SET created_at = $2 WHERE id = $1`, blUUID(t, id.PrefixCharge, first.ChargeIDs[0]), early)
	desk.Do("POST", "/queue/walk-in", body).Expect(t, 201, "press again").Decode(t, &again)
	// (NEW-DAY-2, fixed 2026-10-04.)
	if n := gmFees(t, p, svc); n != 1 || len(again.ChargeIDs) != 1 || again.ChargeIDs[0] != first.ChargeIDs[0] {
		t.Fatalf("a fee raised at 00:01 Addis today was not found by the next press: %d fees, handed back %v", n, again.ChargeIDs)
	}
}

// ---- the follow-up free window ------------------------------------------------------------

// TestREG_APPT_040_ExpiredFollowupPaysTheFee: Given a doctor-booked follow-up whose
// free window ended yesterday (noon Addis) or five days ago, When the patient is checked in today, Then
// the 200 registration fee is raised and they wait for payment — a late follow-up pays.
func TestREG_APPT_040_ExpiredFollowupPaysTheFee(t *testing.T) {
	clinic, svc := gmFeeClinic(t)
	desk, doc := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "doctor")
	for i, until := range []time.Time{gmAddisMidnight(-1).Add(12 * time.Hour), gmAddisMidnight(-5)} {
		p := createPatient(t, desk, uniq("Late"), "Followup")
		appt := gmBookFollowup(t, doc, clinic, p, time.Duration(i+1)*time.Hour, until)
		r, a := gmCheckIn(t, desk, appt)
		r.Expect(t, 200, "check in a late follow-up")
		if !a.Gated || len(a.ChargeIDs) != 1 || gmFees(t, p, svc) != 1 || gmQueued(t, p) != 0 {
			t.Fatalf("follow-up free until %s: gated=%v charges=%v fees=%d queued=%d; want one fee and waiting to pay",
				until.Format(time.RFC3339), a.Gated, a.ChargeIDs, gmFees(t, p, svc), gmQueued(t, p))
		}
		if st := blStatus(t, a.ChargeIDs[0]); st != "pending" {
			t.Fatalf("late follow-up fee status %q, want pending", st)
		}
	}
}

// TestREG_APPT_041_CancelledOrMissedFollowupIsNotFree (NEW-FU-2): Given doctor-booked
// follow-ups inside their window that were then cancelled, or marked no-show, When the
// desk checks the patient in anyway, Then either the check-in is refused or the
// registration fee is raised — a booking that did not happen covers nothing. Check-in
// overwrites the status with 'checked_in' before the coverage rule reads it, so the
// rule's cancelled / no_show exclusion never fires.
func TestREG_APPT_041_CancelledOrMissedFollowupIsNotFree(t *testing.T) {
	clinic, svc := gmFeeClinic(t)
	desk, doc := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "doctor")
	freeBy := []string{}
	for i, status := range []string{"cancelled", "no_show"} {
		p := createPatient(t, desk, uniq("Gone"), "Followup")
		appt := gmBookFollowup(t, doc, clinic, p, time.Duration(i+1)*time.Hour, time.Now().AddDate(0, 0, 14))
		desk.Do("POST", "/appointments/"+appt+"/status", map[string]any{"status": status, "cancel_reason": "patient called"}).
			Expect(t, 204, "set "+status)
		r, a := gmCheckIn(t, desk, appt)
		switch {
		case r.Status >= 400 && r.Status < 500:
			if gmFees(t, p, svc) != 0 || gmQueued(t, p) != 0 {
				t.Fatalf("%s follow-up: check-in refused (%d %s) but left fees=%d queued=%d", status, r.Status, r.Code, gmFees(t, p, svc), gmQueued(t, p))
			}
		case r.Status == 200 && a.Gated:
			if gmFees(t, p, svc) != 1 || gmQueued(t, p) != 0 {
				t.Fatalf("%s follow-up: gated but fees=%d queued=%d, want 1 and 0", status, gmFees(t, p, svc), gmQueued(t, p))
			}
		case r.Status == 200:
			if gmFees(t, p, svc) != 0 || gmQueued(t, p) != 1 {
				t.Fatalf("%s follow-up: free check-in left fees=%d queued=%d", status, gmFees(t, p, svc), gmQueued(t, p))
			}
			freeBy = append(freeBy, status)
		default:
			t.Fatalf("%s follow-up check-in: HTTP %d %s %s", status, r.Status, r.Code, r.Message)
		}
	}
	if len(freeBy) > 0 {
		testkit.KnownBug(t, "NEW-FU-2", true, fmt.Sprintf(
			"a %s follow-up was checked in free with no fee — scheduling CheckIn sets status=checked_in before "+
				"RaiseIntakeChargeIDsTx reads the coverage, so the cancelled/no_show exclusion is dead", strings.Join(freeBy, " and a ")))
	}
	testkit.KnownBug(t, "NEW-FU-2", false, "a cancelled or no-show follow-up does not make the visit free")
}

// TestREG_APPT_042_FollowupIsFreeThroughItsLastDay (NEW-FU-3): Given a doctor-booked
// follow-up whose window ends today (free_until = today, midnight Addis — the date the
// booking screen shows as "free if attended on or before <date>"), When the patient
// arrives later today, Then the visit is free. Coverage compares the instant, not the
// clinic day, so a patient who comes on the last day the screen promised pays.
func TestREG_APPT_042_FollowupIsFreeThroughItsLastDay(t *testing.T) {
	clinic, svc := gmFeeClinic(t)
	desk, doc := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "doctor")
	p := createPatient(t, desk, uniq("Last"), "Day")
	appt := gmBookFollowup(t, doc, clinic, p, time.Hour, gmAddisMidnight(0))
	r, a := gmCheckIn(t, desk, appt)
	r.Expect(t, 200, "check in on the window's last day")
	if a.Gated {
		if gmFees(t, p, svc) != 1 {
			t.Fatalf("last-day follow-up gated with %d fees", gmFees(t, p, svc))
		}
		testkit.KnownBug(t, "NEW-FU-3", true,
			"a follow-up free until today (Addis) was charged on that day — billing coverage uses time.Now().After(free_until), "+
				"an instant, while the screens promise the whole date")
	}
	if gmFees(t, p, svc) != 0 || gmQueued(t, p) != 1 {
		t.Fatalf("last-day follow-up: fees=%d queued=%d, want free and queued", gmFees(t, p, svc), gmQueued(t, p))
	}
	testkit.KnownBug(t, "NEW-FU-3", false, "a follow-up is free through the last day of its window")
}

// TestREG_APPT_043_OnlyADoctorBookedFollowupIsFree (NEW-FU-1): Given the same 14-day
// window, When the DOCTOR books the follow-up, Then check-in is free and the patient is
// queued; When the RECEPTIONIST books a "follow-up" (or marks an ordinary booking as
// one), Then the patient pays — "free" is the doctor's decision, not a checkbox at the
// desk. Today the desk's label is enough (REG_APPT_020 shows the desk may mark).
func TestREG_APPT_043_OnlyADoctorBookedFollowupIsFree(t *testing.T) {
	clinic, svc := gmFeeClinic(t)
	desk, doc := srv.As(t, clinic, "receptionist"), srv.As(t, clinic, "doctor")
	window := time.Now().AddDate(0, 0, 14)

	// The doctor's follow-up: free, straight to the queue, ordered by the doctor.
	pd := createPatient(t, desk, uniq("Doc"), "Booked")
	ad := gmBookFollowup(t, doc, clinic, pd, time.Hour, window)
	var orderedBy string
	one(t, `SELECT coalesce(ordered_by::text,'') FROM appointments WHERE id = $1`, &orderedBy, apptUUID(t, ad))
	if orderedBy != clinic.Staff["doctor"].ID.String() {
		t.Fatalf("doctor's follow-up ordered_by %q, want the doctor", orderedBy)
	}
	r, a := gmCheckIn(t, desk, ad)
	r.Expect(t, 200, "check in the doctor's follow-up")
	if a.Gated || gmFees(t, pd, svc) != 0 || gmQueued(t, pd) != 1 {
		t.Fatalf("doctor-booked follow-up: gated=%v fees=%d queued=%d; want free and queued", a.Gated, gmFees(t, pd, svc), gmQueued(t, pd))
	}

	// The desk's "follow-up", booked as one.
	free := []string{}
	pr := createPatient(t, desk, uniq("Desk"), "Booked")
	ar := gmBookFollowup(t, desk, clinic, pr, 2*time.Hour, window)
	r, a = gmCheckIn(t, desk, ar)
	r.Expect(t, 200, "check in the desk's follow-up")
	if !a.Gated {
		free = append(free, "booked as a follow-up by the receptionist")
	} else if gmFees(t, pr, svc) != 1 {
		t.Fatalf("desk follow-up gated with %d fees", gmFees(t, pr, svc))
	}

	// The desk marking an ordinary booking as a follow-up.
	pm := createPatient(t, desk, uniq("Desk"), "Marked")
	var plain struct {
		ID string `json:"id"`
	}
	desk.Do("POST", "/appointments", map[string]any{
		"branch_id": payBranch(t, clinic), "patient_id": pm.ID, "provider_id": blUser(clinic.Staff["doctor"]), "department_id": blDept(clinic),
		"starts_at": time.Now().Add(3 * time.Hour).UTC().Format(time.RFC3339), "duration_min": 30,
	}).Expect(t, 201, "book ordinary").Decode(t, &plain)
	desk.Do("POST", "/appointments/"+plain.ID+"/followup", map[string]any{"free_until": window.UTC().Format(time.RFC3339)}).
		Expect(t, 204, "desk marks follow-up")
	r, a = gmCheckIn(t, desk, plain.ID)
	r.Expect(t, 200, "check in the desk-marked booking")
	if !a.Gated {
		free = append(free, "an ordinary booking the receptionist marked as a follow-up")
	} else if gmFees(t, pm, svc) != 1 {
		t.Fatalf("desk-marked booking gated with %d fees", gmFees(t, pm, svc))
	}

	if len(free) > 0 {
		testkit.KnownBug(t, "NEW-FU-1", true, fmt.Sprintf(
			"free visits granted without a doctor: %s — coverage checks is_followup/free_until only, never who ordered it "+
				"(note REG_BILL_080 currently relies on a desk-booked follow-up being free)", strings.Join(free, "; ")))
	}
	testkit.KnownBug(t, "NEW-FU-1", false, "only a doctor-booked follow-up makes the visit free")
}

// ---- the clinic day is Addis ---------------------------------------------------------------

// gmSettleAt raises and settles `amount` in cash, then moves its settled_at to `at`.
func gmSettleAt(t *testing.T, clinic *testkit.Clinic, cashier *testkit.Client, p patientRef, amount float64, at time.Time) string {
	t.Helper()
	cid := payRaise(t, cashier, clinic, p.ID, amount)
	paySettle(cashier, cid).Expect(t, 204, "settle")
	blExec(t, `UPDATE charges SET settled_at = $2 WHERE id = $1`, blUUID(t, id.PrefixCharge, cid), at)
	return cid
}

// TestREG_BILL_094_DayClosesListFilesMoneyUnderTheAddisDay (FIN-1): Given 700 taken at
// 00:30 Addis today and 300 at noon Addis yesterday, When the cashier opens the list of
// their days, Then today's row expects 700 and yesterday's 300. The list groups by the
// UTC date, so the 700 taken after midnight is filed under yesterday.
func TestREG_BILL_094_DayClosesListFilesMoneyUnderTheAddisDay(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Day"), "List")
	gmSettleAt(t, clinic, cashier, p, 700, gmAddisMidnight(0).Add(30*time.Minute))
	gmSettleAt(t, clinic, cashier, p, 300, gmAddisMidnight(-1).Add(12*time.Hour))

	var days []struct {
		BusinessDate  string `json:"business_date"`
		ExpectedTotal string `json:"expected_total"`
	}
	cashier.Do("GET", "/billing/day-closes?from="+gmAddisDate(-3)+"&to="+gmAddisDate(1), nil).Expect(t, 200, "day list").Decode(t, &days)
	got := map[string]float64{}
	total := 0.0
	for _, d := range days {
		got[d.BusinessDate] = payNum(t, d.ExpectedTotal)
		total += payNum(t, d.ExpectedTotal)
	}
	if !payEq(total, 1000) {
		t.Fatalf("day list totals %.2f over %v, want the 1000 taken", total, got)
	}
	today, yesterday := gmAddisDate(0), gmAddisDate(-1)
	if !payEq(got[today], 700) || !payEq(got[yesterday], 300) {
		testkit.KnownBug(t, "FIN-1", true, fmt.Sprintf(
			"day list reads %v; want %s=700 and %s=300 — billing/service/service.go DayCloses groups by settled_at AT TIME ZONE 'UTC'",
			got, today, yesterday))
	}
	testkit.KnownBug(t, "FIN-1", false, "the day list files money under the Addis day it was taken")
}

// TestREG_BILL_095_PaidTodayStartsAtAddisMidnight (NEW-DAY-1): Given a receipt taken at
// 00:30 Addis today and one at noon Addis yesterday, When the cashier opens "Paid
// today" (no since), Then it lists the 00:30 receipt and not yesterday's. The default
// window starts at UTC midnight (03:00 Addis), so the early receipt is missing — or,
// between 00:00 and 03:00 Addis, yesterday's afternoon appears.
func TestREG_BILL_095_PaidTodayStartsAtAddisMidnight(t *testing.T) {
	clinic := payClinic(t)
	cashier := srv.As(t, clinic, "cashier")
	p := createPatient(t, srv.As(t, clinic, "receptionist"), uniq("Paid"), "Today")
	early := gmSettleAt(t, clinic, cashier, p, 450, gmAddisMidnight(0).Add(30*time.Minute))
	old := gmSettleAt(t, clinic, cashier, p, 250, gmAddisMidnight(-1).Add(12*time.Hour))

	var list []struct {
		ReceiptNo int64 `json:"receipt_no"`
	}
	cashier.Do("GET", "/billing/payments", nil).Expect(t, 200, "paid today").Decode(t, &list)
	seen := map[int64]bool{}
	for _, v := range list {
		seen[v.ReceiptNo] = true
	}
	hasEarly, hasOld := seen[blReceipt(t, early)], seen[blReceipt(t, old)]
	if !hasEarly || hasOld {
		testkit.KnownBug(t, "NEW-DAY-1", true, fmt.Sprintf(
			"'Paid today' lists the 00:30 Addis receipt: %v, yesterday's noon receipt: %v — billing/http/handlers.go Payments "+
				"defaults since to UTC midnight", hasEarly, hasOld))
	}
	testkit.KnownBug(t, "NEW-DAY-1", false, "'Paid today' runs from midnight Addis")
}

// TestREG_APPT_044_QueueBoardStartsAtAddisMidnight (APT-9): Given a walk-in who arrived
// at 00:30 Addis today and one who arrived at noon Addis yesterday, When the desk opens
// the queue board with no date filter, Then today's arrival is on it and yesterday's
// is not. The default window starts at UTC midnight (03:00 Addis).
func TestREG_APPT_044_QueueBoardStartsAtAddisMidnight(t *testing.T) {
	e := apptNewEnv(t)
	arrive := func(at time.Time) patientRef {
		p, q := opWalkIn(t, e, false)
		blExec(t, `UPDATE queue_entries SET enqueued_at = $2 WHERE id = $1`, opUUID(t, id.PrefixQueueEntry, q.ID), at)
		return p
	}
	early := arrive(gmAddisMidnight(0).Add(30 * time.Minute))
	old := arrive(gmAddisMidnight(-1).Add(12 * time.Hour))
	onBoard := map[string]bool{}
	for _, q := range opQueue(t, e, "") {
		onBoard[q.PatientID] = true
	}
	// An explicit Addis-day window is the board's own filter, and must already be right.
	var win []opQueueEntry
	e.desk.Do("GET", "/queue?department="+e.dept+"&from="+url.QueryEscape(gmAddisMidnight(0).Format(time.RFC3339)), nil).Expect(t, 200, "queue today (Addis)").Decode(t, &win)
	inWin := map[string]bool{}
	for _, q := range win {
		inWin[q.PatientID] = true
	}
	if !inWin[early.ID] || inWin[old.ID] {
		t.Fatalf("explicit Addis-day window: early=%v yesterday=%v, want true/false", inWin[early.ID], inWin[old.ID])
	}
	if !onBoard[early.ID] || onBoard[old.ID] {
		testkit.KnownBug(t, "APT-9", true, fmt.Sprintf(
			"default queue board shows the 00:30 Addis arrival: %v, yesterday's noon arrival: %v — scheduling ListQueue "+
				"defaults from to startOfDayUTC()", onBoard[early.ID], onBoard[old.ID]))
	}
	testkit.KnownBug(t, "APT-9", false, "the default queue board is the Addis day")
}

// ---- dental: one live charge per visit -------------------------------------------------------

// gmDentalCharges counts the patient's non-void dental charges (linked or orphaned) and
// lists every dental charge's status, so a race that leaves a second live one shows.
func gmDentalCharges(t *testing.T, p patientRef) (live int, statuses string) {
	t.Helper()
	one(t, `SELECT count(*) FROM charges WHERE patient_id = $1 AND source = 'dental' AND status <> 'void' AND deleted_at IS NULL`,
		&live, blPatientUUID(t, p))
	one(t, `SELECT coalesce(string_agg(status, ',' ORDER BY status), '') FROM charges WHERE patient_id = $1 AND source = 'dental' AND deleted_at IS NULL`,
		&statuses, blPatientUUID(t, p))
	return live, statuses
}

// TestREG_DENTAL_271_WriteOffRacingACollectLeavesOneCharge: Given a delivered 1,000
// visit, When the dentist sends it to the cashier at the same instant as the cashier
// writes it off (several times over), Then the visit ends written off with exactly one
// live charge, linked from the visit, and nothing pending at the cashier; a loser is
// refused with 409 (SESSION_WAIVED / SESSION_CHANGED), never a 500.
func TestREG_DENTAL_271_WriteOffRacingACollectLeavesOneCharge(t *testing.T) {
	clinic := newClinic(t)
	doc, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	for i := 0; i < 5; i++ {
		p := denPatient(t, clinic)
		plan := createPlan(t, doc, p.ID, "1000", 1, "")
		sid := plan.Sessions[0].ID
		payDone(t, doc, p.ID, sid)
		base := "/dental/patients/" + p.ID + "/sessions/" + sid
		rs := blRace(
			func() testkit.Resp { return doc.Do("POST", base+"/collect", nil) },
			func() testkit.Resp {
				return cashier.Do("POST", base+"/write-off", map[string]any{"reason": "goodwill"})
			},
		)
		collect, wo := rs[0], rs[1]
		if wo.Status != 204 {
			t.Fatalf("round %d: write-off answered %d %s (%s); a write-off always lands, before or after the bill", i, wo.Status, wo.Code, wo.Message)
		}
		switch {
		case collect.Status == 204:
		case collect.Status == 409 && (collect.Code == "SESSION_WAIVED" || collect.Code == "SESSION_CHANGED"):
		default:
			t.Fatalf("round %d: collect answered %d %s (%s), want 204 or 409 SESSION_WAIVED/SESSION_CHANGED", i, collect.Status, collect.Code, collect.Message)
		}
		live, sts := gmDentalCharges(t, p)
		if live != 1 || sts != "waived" || dn2Charge(t, sid) != "waived" {
			t.Fatalf("round %d (collect %d %s): %d live dental charges [%s], visit links %q; want one waived charge, linked",
				i, collect.Status, collect.Code, live, sts, dn2Charge(t, sid))
		}
		if rows := payPendingFor(t, cashier, p.ID); len(rows) != 0 {
			t.Fatalf("round %d: %d charges left pending at the cashier after the write-off", i, len(rows))
		}
	}
}

// gmRelinkOnInsert installs a trigger (this clinic only) that, the moment a charge is
// inserted, points the session at it — simulating a concurrent writer moving the link
// between the locked read and the compare-and-set. Returns the cleanup.
func gmRelinkOnInsert(t *testing.T, clinic *testkit.Clinic, sid string) func() {
	t.Helper()
	tid := clinic.TenantID.String()
	name := "regress_relink_" + strings.ReplaceAll(tid, "-", "")[:12]
	blExec(t, `CREATE OR REPLACE FUNCTION `+name+`() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
	           BEGIN UPDATE treatment_sessions SET charge_id = NEW.id WHERE id = '`+dn2SessUUID(t, sid).String()+`'::uuid; RETURN NEW; END $$`)
	blExec(t, `CREATE TRIGGER `+name+` AFTER INSERT ON charges FOR EACH ROW
	           WHEN (NEW.tenant_id = '`+tid+`'::uuid) EXECUTE FUNCTION `+name+`()`)
	done := false
	clear := func() {
		if !done {
			done = true
			blExecBg(t, `DROP TRIGGER IF EXISTS `+name+` ON charges`)
			blExecBg(t, `DROP FUNCTION IF EXISTS `+name+`()`)
		}
	}
	t.Cleanup(clear)
	return clear
}

// TestREG_DENTAL_272_ALinkMovedMidBillingIsRefused: Given a delivered visit whose charge
// link is moved by someone else between the locked read and the write (forced here by
// a trigger), When the dentist collects it, Then 409 SESSION_CHANGED and nothing is
// billed; When the cashier writes off another such visit, Then 409 SESSION_CHANGED and
// nothing is waived; once the interference stops, collecting works.
func TestREG_DENTAL_272_ALinkMovedMidBillingIsRefused(t *testing.T) {
	clinic := newClinic(t)
	doc, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	p := denPatient(t, clinic)
	plan := createPlan(t, doc, p.ID, "2000", 2, "")
	s1, s2 := plan.Sessions[0].ID, plan.Sessions[1].ID
	payDone(t, doc, p.ID, s1)
	payDone(t, doc, p.ID, s2)
	base := "/dental/patients/" + p.ID + "/sessions/"

	stop := gmRelinkOnInsert(t, clinic, s1)
	dn2Code(t, doc.Do("POST", base+s1+"/collect", nil), 409, "SESSION_CHANGED", "collect while the link moves")
	stop()
	if live, sts := gmDentalCharges(t, p); live != 0 || sts != "" || dn2Charge(t, s1) != "" {
		t.Fatalf("refused collect left charges [%s] and link %q", sts, dn2Charge(t, s1))
	}

	stop = gmRelinkOnInsert(t, clinic, s2)
	dn2Code(t, cashier.Do("POST", base+s2+"/write-off", map[string]any{"reason": "goodwill"}), 409, "SESSION_CHANGED", "write-off while the link moves")
	stop()
	if live, sts := gmDentalCharges(t, p); live != 0 || sts != "" || dn2Charge(t, s2) != "" {
		t.Fatalf("refused write-off left charges [%s] and link %q", sts, dn2Charge(t, s2))
	}

	doc.Do("POST", base+s1+"/collect", nil).Expect(t, 204, "collect once the link is still")
	payOnePending(t, cashier, p.ID, 1000)
	if dn2Charge(t, s1) != "pending" {
		t.Fatalf("collected visit links %q, want pending", dn2Charge(t, s1))
	}
}

// ---- dental: pay later ---------------------------------------------------------------------

// TestREG_DENTAL_273_PayLaterOnlyOnAVisitStillOwed (NEW-PAYLATER-1): Given a visit
// already paid, one waiting at the cashier, and one in a cancelled course, When the
// dentist flags each "pay later", Then each is refused with 409 and the flag stays off;
// a planned visit still accepts it. SetPayLater updates any session with no status
// check, so a promise to pay can be recorded on a visit that is settled or will never
// happen.
func TestREG_DENTAL_273_PayLaterOnlyOnAVisitStillOwed(t *testing.T) {
	clinic := newClinic(t)
	doc, cashier := srv.As(t, clinic, "doctor"), srv.As(t, clinic, "cashier")
	p := denPatient(t, clinic)
	plan := createPlan(t, doc, p.ID, "3000", 3, "")
	paid, billed, open := plan.Sessions[0].ID, plan.Sessions[1].ID, plan.Sessions[2].ID
	base := "/dental/patients/" + p.ID + "/sessions/"
	payDone(t, doc, p.ID, paid)
	payCollect(t, doc, p.ID, paid)
	paySettle(cashier, payOnePending(t, cashier, p.ID, 1000).ID).Expect(t, 204, "settle")
	payDone(t, doc, p.ID, billed)
	payCollect(t, doc, p.ID, billed)

	q := denPatient(t, clinic)
	gone := createPlan(t, doc, q.ID, "1000", 1, "")
	doc.Do("POST", "/dental/patients/"+q.ID+"/plans/"+gone.ID+"/cancel", map[string]any{"reason": "changed mind"}).Expect(t, 200, "cancel course")
	if st, _ := dn2Sess(t, gone.Sessions[0].ID); st != "cancelled" {
		t.Fatalf("cancelled course left its visit %q", st)
	}

	flag := func(sid string) bool {
		var on bool
		one(t, `SELECT pay_later FROM treatment_sessions WHERE id = $1`, &on, dn2SessUUID(t, sid))
		return on
	}
	accepted := []string{}
	for _, c := range []struct{ what, path, sid string }{
		{"paid", base + paid, paid},
		{"at the cashier", base + billed, billed},
		{"cancelled", "/dental/patients/" + q.ID + "/sessions/" + gone.Sessions[0].ID, gone.Sessions[0].ID},
	} {
		r := doc.Do("POST", c.path+"/pay-later", map[string]any{"on": true, "note": "next month"})
		switch {
		case r.Status == 409:
			if flag(c.sid) {
				t.Fatalf("%s visit: refused but flagged", c.what)
			}
		case r.Status == 204:
			accepted = append(accepted, c.what)
		default:
			t.Fatalf("%s visit pay-later: HTTP %d %s %s", c.what, r.Status, r.Code, r.Message)
		}
	}
	doc.Do("POST", base+open+"/pay-later", map[string]any{"on": true, "note": "next month"}).Expect(t, 204, "planned visit pay later")
	if !flag(open) {
		t.Fatalf("planned visit not flagged pay-later")
	}
	if len(accepted) > 0 {
		testkit.KnownBug(t, "NEW-PAYLATER-1", true, fmt.Sprintf(
			"pay-later accepted on a visit that is %s — dental/service/service.go SetPayLater has no status guard",
			strings.Join(accepted, ", a visit ")))
	}
	testkit.KnownBug(t, "NEW-PAYLATER-1", false, "pay-later is refused on a paid, billed or cancelled visit")
}

// TestREG_DENTAL_274_PayLaterIsTheDentistsCall: Given a delivered visit, Then the
// dentist and the owner (dental.manage) may flag it "pay later", and the receptionist,
// cashier and branch manager (no dental.manage — the role seed gives none of them it)
// are refused with 403 and the flag is untouched.
func TestREG_DENTAL_274_PayLaterIsTheDentistsCall(t *testing.T) {
	clinic := newClinic(t)
	doc := srv.As(t, clinic, "doctor")
	p := denPatient(t, clinic)
	plan := createPlan(t, doc, p.ID, "1000", 1, "")
	sid := plan.Sessions[0].ID
	payDone(t, doc, p.ID, sid)
	path := "/dental/patients/" + p.ID + "/sessions/" + sid + "/pay-later"
	read := func() bool {
		var on bool
		one(t, `SELECT pay_later FROM treatment_sessions WHERE id = $1`, &on, dn2SessUUID(t, sid))
		return on
	}
	for _, role := range []string{"receptionist", "cashier", "branch_manager"} {
		dn2Code(t, srv.As(t, clinic, role).Do("POST", path, map[string]any{"on": true}), 403, "", role+" flags pay later")
		if read() {
			t.Fatalf("%s's refused request flagged the visit", role)
		}
	}
	doc.Do("POST", path, map[string]any{"on": true, "note": "salary day"}).Expect(t, 204, "dentist flags")
	if !read() {
		t.Fatalf("dentist's pay-later not stored")
	}
	srv.As(t, clinic, "owner").Do("POST", path, map[string]any{"on": false}).Expect(t, 204, "owner clears")
	if read() {
		t.Fatalf("owner's clear not stored")
	}
}

// ---- dental: chairside course progress -----------------------------------------------------

// TestREG_DENTAL_275_ChairsideCountsVisitsNotExtras (DEN-11): Given a three-visit course
// with a deposit, visit 1 delivered with an X-ray added to it, When the dentist opens
// the chair list for the checked-in patient, Then it reads "1 of 3" — the extra is not
// a visit. The "done" count has no kind='visit' filter (the total does), so it reads
// "2 of 3".
func TestREG_DENTAL_275_ChairsideCountsVisitsNotExtras(t *testing.T) {
	clinic := newClinic(t)
	doc := srv.As(t, clinic, "doctor")
	p := denPatient(t, clinic)
	plan := createPlan(t, doc, p.ID, "3500", 3, "500")
	if plan.Deposit == nil && len(plan.Sessions) != 3 {
		t.Fatalf("course with a deposit: %+v", plan)
	}
	visit := ""
	for _, s := range plan.Sessions {
		if s.Kind == "" || s.Kind == "visit" {
			visit = s.ID
			break
		}
	}
	payDone(t, doc, p.ID, visit)
	svc := denDentalService(t, doc, 300)
	doc.Do("POST", "/dental/patients/"+p.ID+"/sessions/"+visit+"/extras", map[string]any{"service_id": svc}).Expect(t, 204, "add extra")
	var extraDone int
	one(t, `SELECT count(*) FROM treatment_sessions WHERE parent_session_id = $1 AND kind = 'extra' AND status = 'done'`, &extraDone, dn2SessUUID(t, visit))
	if extraDone != 1 {
		t.Fatalf("extra on a delivered visit: %d done extras, want 1", extraDone)
	}
	srv.As(t, clinic, "receptionist").Do("POST", "/queue/walk-in", map[string]any{
		"department_id": blDept(clinic), "patient_id": p.ID,
	}).Expect(t, 201, "walk-in")

	var rows []struct {
		PatientID string `json:"patient_id"`
		PlanDone  int    `json:"plan_done"`
		PlanTotal int    `json:"plan_total"`
	}
	doc.Do("GET", "/dental/chairside", nil).Expect(t, 200, "chairside").Decode(t, &rows)
	for _, r := range rows {
		if r.PatientID != p.ID {
			continue
		}
		if r.PlanTotal != 3 {
			t.Fatalf("chairside course total %d, want 3 visits", r.PlanTotal)
		}
		if r.PlanDone != 1 {
			testkit.KnownBug(t, "DEN-11", true, fmt.Sprintf(
				"chairside reads %d of %d for one delivered visit plus an extra — dental/service/chairside.go counts done "+
					"sessions of every kind", r.PlanDone, r.PlanTotal))
		}
		testkit.KnownBug(t, "DEN-11", false, "chairside counts delivered visits only")
		return
	}
	t.Fatalf("patient %s not on the chair list", p.ID)
}
