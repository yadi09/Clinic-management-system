package service

// Pay from home.
//
// A patient picks what to pay, transfers the money from their own phone, and types the
// transaction number. This file decides what happens next, and the rule it is written
// around is the clinic's own: nothing becomes a receipt on the patient's word. The same
// bank check the cashier uses (billing.VerifyPayment) must confirm the exact amount and
// the clinic's own account, and then the same settlement the cashier uses
// (billing.SettleVisit) books it, so a home payment lands on the same charges, the same
// receipt numbering and the same day's report as one taken at the desk.
//
// When the check cannot decide — the bank is slow, credits ran out, an amount differs —
// the attempt WAITS for the cashier. It is never silently accepted and never silently
// lost.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/kernel/verifyet"
	"github.com/reicb/clinicsaas/internal/portal"
)

var refRe = regexp.MustCompile(`^[A-Za-z0-9._/-]{6,40}$`)

const (
	sayChecking = "We are checking this payment with the bank. The clinic will confirm it shortly — you can close this page."
	sayRefused  = "We could not confirm this payment with the bank. Check the transaction number and try again, or show the SMS at the clinic."
	sayUsed     = "This transaction number has already been used."
	sayClinicNo = "The clinic could not confirm this payment. Please contact the clinic."
)

// stored is one chosen item, as it was when the patient chose it.
type stored struct {
	Kind   string    `json:"kind"` // charge | session
	ID     uuid.UUID `json:"id"`
	Label  string    `json:"label"`
	Amount string    `json:"amount"`
}

func cents(s string) int64 {
	f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return int64(math.Round(f * 100))
}
func fromCents(c int64) string { return fmt.Sprintf("%d.%02d", c/100, c%100) }

func (s *Service) addis() *time.Location { l, _ := time.LoadLocation(addisTZ); return l }

// auth checks the token and that it belongs to this clinic's address.
func (s *Service) auth(ctx context.Context, slug, token string) (tid, pid uuid.UUID, err error) {
	tid, pid, err = s.open(token)
	if err != nil {
		return
	}
	want, e := s.tenantBySlug(ctx, strings.ToLower(slug))
	if e != nil || want != tid {
		return uuid.Nil, uuid.Nil, errSession
	}
	return
}

// payables lists what this patient could pay, from the clinic's own records. Everything
// that decides money is read here and again at Pay time; the browser's list is a menu,
// never an instruction.
func payables(ctx context.Context, tx pgx.Tx, tid, pid uuid.UUID, loc *time.Location) ([]portal.PayItem, map[string]stored, error) {
	var out []portal.PayItem
	byKey := map[string]stored{}
	add := func(kind string, id uuid.UUID, label, amount, hint string, payable, upcoming bool) {
		k := map[string]string{"charge": "c:", "session": "s:"}[kind] + id.String()
		out = append(out, portal.PayItem{Key: k, Label: label, Amount: amount, Hint: hint, Payable: payable, Upcoming: upcoming})
		if payable {
			byKey[k] = stored{Kind: kind, ID: id, Label: label, Amount: amount}
		}
	}
	// 1. Bills the clinic has already raised for the patient's treatment. Only treatment
	//    bills: a consultation fee is routed to the queue, and paying it from a phone must
	//    not put someone in a line.
	rows, err := tx.Query(ctx, `
		SELECT c.id, c.description, c.amount::text
		  FROM charges c
		 WHERE c.tenant_id = $1 AND c.patient_id = $2 AND c.status = 'pending' AND c.deleted_at IS NULL
		   AND c.reverses_charge_id IS NULL AND c.amount > 0
		   AND EXISTS (SELECT 1 FROM treatment_sessions se WHERE se.tenant_id = c.tenant_id AND se.charge_id = c.id)
		 ORDER BY c.created_at`, tid, pid)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var cid uuid.UUID
		var label, amt string
		if err := rows.Scan(&cid, &label, &amt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		add("charge", cid, label, amt, "Waiting for payment", true, false)
	}
	rows.Close()
	// 2. Treatment the patient has had and not paid for: the visit is done, its price was
	//    agreed with the course, and no bill was raised yet (often a promise to pay later).
	//    It is owed, so it can be paid — the payment raises the bill and settles it, the
	//    same way paying a visit ahead does. Listed before anything paid ahead: debt first.
	rows, err = tx.Query(ctx, `
		SELECT se.id, pl.title, se.seq, se.amount_due::text
		  FROM treatment_sessions se JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
		 WHERE se.tenant_id = $1 AND se.patient_id = $2 AND se.kind = 'visit' AND se.status = 'done'
		   AND pl.status <> 'cancelled' AND se.charge_id IS NULL AND se.amount_due > 0
		 ORDER BY se.scheduled_date, se.seq`, tid, pid)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var sid uuid.UUID
		var title, amt string
		var seq int
		if err := rows.Scan(&sid, &title, &seq, &amt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		add("session", sid, fmt.Sprintf("%s · visit %d", title, seq), amt, "Treatment done — not paid yet", true, false)
	}
	rows.Close()
	// 3. Down payments not billed yet (owed from the day the course was agreed), and the
	//    NEXT visit of each course, so it can be paid ahead.
	rows, err = tx.Query(ctx, `
		SELECT * FROM (
		  SELECT se.id, pl.title, se.seq, se.scheduled_date::text AS date_text, se.amount_due::text, se.kind, 1 AS ord, se.scheduled_date, se.plan_id
		    FROM treatment_sessions se JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
		   WHERE se.tenant_id = $1 AND se.patient_id = $2 AND se.kind = 'deposit' AND se.status <> 'cancelled'
		     AND pl.status <> 'cancelled' AND se.charge_id IS NULL AND se.amount_due > 0
		  UNION ALL
		  SELECT * FROM (
		    SELECT DISTINCT ON (se.plan_id) se.id, pl.title, se.seq, se.scheduled_date::text AS date_text, se.amount_due::text, se.kind, 2, se.scheduled_date, se.plan_id
		      FROM treatment_sessions se JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
		     WHERE se.tenant_id = $1 AND se.patient_id = $2 AND se.kind = 'visit' AND se.status = 'planned'
		       AND pl.status = 'active' AND se.charge_id IS NULL AND se.amount_due > 0
		     ORDER BY se.plan_id, se.scheduled_date, se.seq) nxt
		) u ORDER BY ord, scheduled_date`, tid, pid)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var sid, plan uuid.UUID
		var title, date, amt, kind string
		var seq, ord int
		var sd time.Time
		if err := rows.Scan(&sid, &title, &seq, &date, &amt, &kind, &ord, &sd, &plan); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if kind == "deposit" {
			add("session", sid, title+" · down payment", amt, "Owed from the day the treatment was agreed", true, false)
		} else {
			add("session", sid, fmt.Sprintf("%s · visit %d", title, seq), amt, "Next visit on "+dayLabel(date)+" — pay ahead", true, true)
		}
	}
	rows.Close()
	return out, byKey, nil
}

func dayLabel(iso string) string {
	t, err := time.Parse("2006-01-02", iso)
	if err != nil {
		return iso
	}
	return t.Format("2 Jan")
}

// payRails are the ways this clinic can be paid from a phone.
func payRails(ctx context.Context, tx pgx.Tx, tid uuid.UUID) ([]portal.PayRail, error) {
	rows, err := tx.Query(ctx, `
		SELECT id, label, kind, coalesce(account_name,''), account_number
		  FROM payment_rails
		 WHERE tenant_id = $1 AND active AND kind IN ('wallet','bank') AND bank_key IS NOT NULL
		   AND btrim(coalesce(account_number,'')) <> ''
		 ORDER BY sort_order, label`, tid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []portal.PayRail{}
	for rows.Next() {
		var rid uuid.UUID
		var r portal.PayRail
		if err := rows.Scan(&rid, &r.Label, &r.Kind, &r.AccountName, &r.AccountNumber); err != nil {
			return nil, err
		}
		r.ID = id.Encode(id.PrefixPaymentRail, rid)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) statusOf(ctx context.Context, tx pgx.Tx, tid uuid.UUID, where string, args ...any) ([]portal.PayStatus, error) {
	rows, err := tx.Query(ctx, `
		SELECT p.id, p.state, p.amount::text, r.label, p.reference, coalesce(p.reason,''), p.receipt_no, p.created_at
		  FROM portal_payments p JOIN payment_rails r ON r.id = p.rail_id AND r.tenant_id = p.tenant_id
		 WHERE p.tenant_id = $1 AND `+where+` ORDER BY p.created_at DESC LIMIT 20`, append([]any{tid}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []portal.PayStatus{}
	for rows.Next() {
		var x portal.PayStatus
		var pid uuid.UUID
		var at time.Time
		if err := rows.Scan(&pid, &x.State, &x.Amount, &x.Rail, &x.Reference, &x.Reason, &x.ReceiptNo, &at); err != nil {
			return nil, err
		}
		x.ID, x.Date = id.Encode(id.PrefixPortalPayment, pid), at.In(s.addis()).Format("2006-01-02")
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Service) PayOptions(ctx context.Context, slug, token string) (*portal.PayOptions, error) {
	tid, pid, err := s.auth(ctx, slug, token)
	if err != nil {
		return nil, err
	}
	out := &portal.PayOptions{Items: []portal.PayItem{}, Rails: []portal.PayRail{}, Open: []portal.PayStatus{}}
	err = s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		st, e := loadSettings(ctx, tx, tid)
		if e != nil {
			return e
		}
		if !st.Enabled || !st.AllowPay || !st.ShowMoney {
			return pgx.ErrNoRows
		}
		if out.Items, _, e = payables(ctx, tx, tid, pid, s.addis()); e != nil {
			return e
		}
		if out.Rails, e = payRails(ctx, tx, tid); e != nil {
			return e
		}
		open, e := s.statusOf(ctx, tx, tid, `p.patient_id = $2 AND p.state IN ('checking','waiting')`, pid)
		out.Open = open
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.Forbidden("PORTAL_PAY_OFF", "Paying from home is not available at this clinic.")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// Pay takes the patient's claim and decides it as far as the bank can.
func (s *Service) Pay(ctx context.Context, slug, token string, in portal.PayInput) (*portal.PayStatus, error) {
	tid, pid, err := s.auth(ctx, slug, token)
	if err != nil {
		return nil, err
	}
	ref := strings.TrimSpace(in.Reference)
	if !refRe.MatchString(ref) {
		return nil, apperr.Validation("Type the transaction number exactly as it is in your SMS.")
	}
	railID, e := id.Decode(id.PrefixPaymentRail, in.RailID)
	if e != nil {
		return nil, apperr.Validation("Choose where you paid from.")
	}
	if len(in.Items) == 0 || len(in.Items) > 20 {
		return nil, apperr.Validation("Choose what you are paying.")
	}

	var payID uuid.UUID
	var chosen []stored
	var total int64
	err = s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		st, e := loadSettings(ctx, tx, tid)
		if e != nil {
			return e
		}
		if !st.Enabled || !st.AllowPay || !st.ShowMoney {
			return apperr.Forbidden("PORTAL_PAY_OFF", "Paying from home is not available at this clinic.")
		}
		rails, e := payRails(ctx, tx, tid)
		if e != nil {
			return e
		}
		okRail := false
		for _, r := range rails {
			okRail = okRail || r.ID == in.RailID
		}
		if !okRail {
			return apperr.Validation("Choose where you paid from.")
		}
		_, by, e := payables(ctx, tx, tid, pid, s.addis())
		if e != nil {
			return e
		}
		seen := map[string]bool{}
		for _, k := range in.Items {
			it, ok := by[k]
			if !ok || seen[k] {
				return apperr.Conflict("PORTAL_ITEM_GONE", "One of those can no longer be paid from here. Refresh the page and choose again.")
			}
			seen[k] = true
			chosen = append(chosen, it)
			total += cents(it.Amount)
		}
		if total <= 0 {
			return apperr.Validation("Choose what you are paying.")
		}
		js, _ := json.Marshal(chosen)
		e = tx.QueryRow(ctx, `
			INSERT INTO portal_payments (tenant_id, patient_id, rail_id, reference, reference_norm, amount, items, state)
			VALUES ($1,$2,$3,$4,upper($4),$5,$6,'checking') RETURNING id`,
			tid, pid, railID, ref, fromCents(total), js).Scan(&payID)
		if e != nil && strings.Contains(e.Error(), "idx_portal_payments_ref") {
			return apperr.Conflict("PORTAL_REF_USED", sayUsed)
		}
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.decide(ctx, tid, pid, payID, railID, ref, total, chosen)
}

// decide asks the bank and acts on the answer.
func (s *Service) decide(ctx context.Context, tid, pid, payID, railID uuid.UUID, ref string, total int64, chosen []stored) (*portal.PayStatus, error) {
	tctx := tenancy.WithTenantID(ctx, tid)
	chk, cerr := s.billing.VerifyPayment(tctx, billing.VerifyInput{RailID: &railID, Reference: ref, Expected: fromCents(total), PatientID: pid})
	if cerr != nil || chk == nil {
		chk = &billing.VerifyResult{State: "unchecked", Reason: "The bank check could not run."}
	}
	switch {
	case chk.AlreadyUsed:
		return s.finish(ctx, tid, payID, "rejected", sayUsed, chk, nil)
	case chk.State == verifyet.Accept:
		rcpt, e := s.settle(tctx, pid, railID, ref, total, chosen)
		if e != nil {
			// The bank said yes but booking it failed (a price moved, a bill was paid at the
			// desk meanwhile). That is a human's problem, not a patient's.
			c := *chk
			c.Reason = "The bank confirmed it, but it could not be booked automatically: " + e.Error()
			return s.finish(ctx, tid, payID, "waiting", sayChecking, &c, nil)
		}
		return s.finish(ctx, tid, payID, "paid", "", chk, &rcpt)
	case chk.State == verifyet.Reject:
		return s.finish(ctx, tid, payID, "rejected", sayRefused, chk, nil)
	case chk.State == verifyet.Pending:
		return s.finish(ctx, tid, payID, "checking", sayChecking, chk, nil)
	default: // review, unchecked
		return s.finish(ctx, tid, payID, "waiting", sayChecking, chk, nil)
	}
}

// settle books the payment exactly as the cashier would: raise the bill for a visit that
// has none, then settle those bills under one receipt with the bank reference.
func (s *Service) settle(ctx context.Context, pid, railID uuid.UUID, ref string, total int64, chosen []stored) (int64, error) {
	ids := []uuid.UUID{}
	for _, it := range chosen {
		if it.Kind == "session" {
			if e := s.dental.CollectSession(ctx, pid, it.ID); e != nil {
				if ae, ok := apperr.As(e); !ok || ae.Code != "SESSION_ALREADY_BILLED" {
					return 0, e
				}
			}
		}
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		tid = p.TenantID
	}
	err := s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		for _, it := range chosen {
			var cid uuid.UUID
			if it.Kind == "charge" {
				cid = it.ID
			} else if e := tx.QueryRow(ctx, `SELECT charge_id FROM treatment_sessions WHERE tenant_id=$1 AND id=$2 AND charge_id IS NOT NULL`, tid, it.ID).Scan(&cid); e != nil {
				return errors.New("a visit has no bill")
			}
			ids = append(ids, cid)
		}
		// What is pending right now must be exactly what the patient paid for.
		var sum *string
		var n int
		if e := tx.QueryRow(ctx, `SELECT sum(amount)::text, count(*) FROM charges WHERE tenant_id=$1 AND id = ANY($2) AND status='pending' AND deleted_at IS NULL`, tid, ids).Scan(&sum, &n); e != nil {
			return e
		}
		if sum == nil || n != len(ids) || cents(*sum) != total {
			return errors.New("the amount owed changed since the patient chose")
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	res, err := s.billing.SettleVisit(ctx, pid, billing.SettleInput{RailID: &railID, Reference: ref, ChargeIDs: ids})
	if err != nil {
		return 0, err
	}
	return res.ReceiptNo, nil
}

func (s *Service) finish(ctx context.Context, tid, payID uuid.UUID, state, reason string, chk *billing.VerifyResult, receipt *int64) (*portal.PayStatus, error) {
	var out []portal.PayStatus
	err := s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `
			UPDATE portal_payments SET state=$3, reason=nullif($4,''), verify_state=$5, verify_reason=$6,
			       receipt_no=coalesce($7, receipt_no), updated_at=now()
			 WHERE tenant_id=$1 AND id=$2`, tid, payID, state, reason, chk.State, chk.Reason, receipt)
		if e != nil {
			return e
		}
		out, e = s.statusOf(ctx, tx, tid, `p.id = $2`, payID)
		return e
	})
	if err != nil || len(out) != 1 {
		return nil, apperr.Internal(fmt.Errorf("portal payment %s: %v", payID, err))
	}
	return &out[0], nil
}

// PayStatus reports one attempt. An attempt still "checking" is asked of the bank again,
// because the bank may simply have been slow the first time.
func (s *Service) PayStatus(ctx context.Context, slug, token, payRef string) (*portal.PayStatus, error) {
	tid, pid, err := s.auth(ctx, slug, token)
	if err != nil {
		return nil, err
	}
	payID, e := id.Decode(id.PrefixPortalPayment, payRef)
	if e != nil {
		return nil, apperr.NotFound("", "")
	}
	var st portal.PayStatus
	var railID uuid.UUID
	var ref string
	var total int64
	var itemsJSON []byte
	err = s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		var amt string
		e := tx.QueryRow(ctx, `SELECT state, rail_id, reference, amount::text, items FROM portal_payments WHERE tenant_id=$1 AND id=$2 AND patient_id=$3`,
			tid, payID, pid).Scan(&st.State, &railID, &ref, &amt, &itemsJSON)
		total = cents(amt)
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("", "")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	if st.State == "checking" {
		var chosen []stored
		_ = json.Unmarshal(itemsJSON, &chosen)
		return s.decide(ctx, tid, pid, payID, railID, ref, total, chosen)
	}
	var out []portal.PayStatus
	err = s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		var e error
		out, e = s.statusOf(ctx, tx, tid, `p.id = $2 AND p.patient_id = $3`, payID, pid)
		return e
	})
	if err != nil || len(out) != 1 {
		return nil, apperr.NotFound("", "")
	}
	return &out[0], nil
}

// --- the cashier's side ---------------------------------------------------------------

func (s *Service) ListPayments(ctx context.Context) ([]portal.StaffPayment, error) {
	p, ok := tenancy.PrincipalFromContext(ctx)
	if !ok {
		return nil, errSession
	}
	out := []portal.StaffPayment{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `
			SELECT p.id, p.state, p.amount::text, r.label, p.reference, coalesce(p.reason,''), p.receipt_no, p.created_at,
			       pt.first_name || ' ' || pt.last_name, pt.mrn, pt.id, p.items, coalesce(p.verify_state,''), coalesce(p.verify_reason,'')
			  FROM portal_payments p
			  JOIN payment_rails r ON r.id = p.rail_id AND r.tenant_id = p.tenant_id
			  JOIN patients pt ON pt.id = p.patient_id AND pt.tenant_id = p.tenant_id
			 WHERE p.tenant_id = $1 AND p.state IN ('checking','waiting')
			 ORDER BY p.created_at LIMIT 100`, p.TenantID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var x portal.StaffPayment
			var pid, ptid uuid.UUID
			var at time.Time
			var js []byte
			if e := rows.Scan(&pid, &x.State, &x.Amount, &x.Rail, &x.Reference, &x.Reason, &x.ReceiptNo, &at,
				&x.Patient, &x.MRN, &ptid, &js, &x.VerifyState, &x.VerifyReason); e != nil {
				return e
			}
			x.ID, x.PatientID = id.Encode(id.PrefixPortalPayment, pid), id.Encode(id.PrefixPatient, ptid)
			x.Date = at.In(s.addis()).Format("2006-01-02")
			var chosen []stored
			_ = json.Unmarshal(js, &chosen)
			labels := make([]string, 0, len(chosen))
			for _, c := range chosen {
				labels = append(labels, c.Label)
			}
			x.Items = strings.Join(labels, ", ")
			out = append(out, x)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// load reads one open attempt for the cashier.
func (s *Service) loadOpen(ctx context.Context, payRef string) (tid, payID, pid, railID uuid.UUID, ref string, total int64, chosen []stored, err error) {
	p, ok := tenancy.PrincipalFromContext(ctx)
	if !ok {
		err = errSession
		return
	}
	tid = p.TenantID
	if payID, err = id.Decode(id.PrefixPortalPayment, payRef); err != nil {
		err = apperr.NotFound("", "")
		return
	}
	var amt string
	var js []byte
	e := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT patient_id, rail_id, reference, amount::text, items FROM portal_payments
			WHERE tenant_id=$1 AND id=$2 AND state IN ('checking','waiting')`, tid, payID).Scan(&pid, &railID, &ref, &amt, &js)
	})
	if errors.Is(e, pgx.ErrNoRows) {
		err = apperr.Conflict("PORTAL_PAY_CLOSED", "This payment has already been dealt with.")
		return
	}
	if e != nil {
		err = apperr.Internal(e)
		return
	}
	total = cents(amt)
	_ = json.Unmarshal(js, &chosen)
	return
}

// ConfirmPayment books an attempt the bank check could not decide, after the cashier has
// looked at the patient's SMS. It uses the cashier's own settlement, so a transfer the
// bank has contradicted is still refused here.
func (s *Service) ConfirmPayment(ctx context.Context, payRef string) (*portal.PayStatus, error) {
	tid, payID, pid, railID, ref, total, chosen, err := s.loadOpen(ctx, payRef)
	if err != nil {
		return nil, err
	}
	rcpt, e := s.settle(ctx, pid, railID, ref, total, chosen)
	if e != nil {
		if ae, ok := apperr.As(e); ok {
			return nil, ae
		}
		return nil, apperr.Conflict("PORTAL_PAY_CANNOT_BOOK", e.Error())
	}
	p, _ := tenancy.PrincipalFromContext(ctx)
	out, err := s.finish(ctx, tid, payID, "paid", "", &billing.VerifyResult{State: "verified", Reason: "Confirmed by the cashier."}, &rcpt)
	if err == nil {
		_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `UPDATE portal_payments SET handled_by=$3 WHERE tenant_id=$1 AND id=$2`, tid, payID, p.UserID)
			return e
		})
	}
	return out, err
}

func (s *Service) RejectPayment(ctx context.Context, payRef, reason string) error {
	tid, payID, _, _, _, _, _, err := s.loadOpen(ctx, payRef)
	if err != nil {
		return err
	}
	p, _ := tenancy.PrincipalFromContext(ctx)
	reason = strings.TrimSpace(reason)
	if len(reason) > 200 {
		return apperr.Validation("the reason can be at most 200 characters")
	}
	e := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE portal_payments SET state='rejected', reason=$3, verify_reason=nullif($4,''), handled_by=$5, updated_at=now()
			WHERE tenant_id=$1 AND id=$2 AND state IN ('checking','waiting')`, tid, payID, sayClinicNo, reason, p.UserID)
		return e
	})
	if e != nil {
		return apperr.Internal(e)
	}
	return nil
}
