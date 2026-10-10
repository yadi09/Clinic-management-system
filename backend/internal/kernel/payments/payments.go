// Package payments answers one question for every surface that takes money: how did
// it arrive, and what is the proof?
//
// It lives in the kernel because three surfaces ask it — the cashier, reception and
// the pharmacy counter — and each used to answer it with its own hard-coded list of
// four words. Same reason kernel/limits exists: the rule belongs in one place, and
// the caller passes its transaction in.
package payments

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

// Payment evidence: which rail took the money, and the transaction reference proving
// it arrived.
//
// A settle used to record one free-text word — "mobile" — and nothing else. So a
// 1,000 ETB Telebirr payment left no trace of WHICH transfer paid it: a patient
// disputing a bill a month later could not be answered, and a day's takings could not
// be held against any bank statement.

// Resolve turns the rail the desk chose into the values a settle writes, and
// refuses the combinations that would produce a record nobody can use later.
//
// Returns the rail id (nil for an unconfigured legacy method), the key to store in
// payment_method — which every existing report groups on, so it must keep being
// written — and the trimmed reference.
func Resolve(ctx context.Context, tx pgx.Tx, tid uuid.UUID, railID *uuid.UUID, method, reference string, force bool) (*uuid.UUID, string, string, error) {
	ref := strings.TrimSpace(reference)
	if railID == nil {
		// No rail chosen: an older client, or a clinic that has not configured any.
		// Fall back to the free-text method exactly as before.
		m := strings.TrimSpace(method)
		if m == "" {
			m = "cash"
		}
		return nil, m, ref, nil
	}
	var key, kind string
	var needsRef, active bool
	e := tx.QueryRow(ctx,
		`SELECT key, kind, needs_reference, active FROM payment_rails
		  WHERE tenant_id = $1 AND id = $2`, tid, *railID).Scan(&key, &kind, &needsRef, &active)
	if e == pgx.ErrNoRows {
		return nil, "", "", apperr.Validation("unknown payment method")
	}
	if e != nil {
		return nil, "", "", e
	}
	if !active {
		return nil, "", "", apperr.Validation("that payment method has been switched off")
	}
	if needsRef && ref == "" {
		return nil, "", "", apperr.Validation("enter the transaction reference for this payment")
	}
	// A reference the bank has contradicted must not quietly become a paid bill. This
	// is the one verdict that blocks: "review" and "could not check" still settle,
	// flagged, because a clinic cannot stop taking money when a third party is down.
	if ref != "" {
		state, reason, e := VerifyStateOf(ctx, tx, tid, railID, ref)
		if e != nil {
			return nil, "", "", e
		}
		if state == "rejected" && !force {
			return nil, "", "", apperr.Conflict("VERIFY_REJECTED", reason)
		}
	}
	// Cash has nothing to reference. Storing one would put a value in the uniqueness
	// table that means nothing and could block a later, real reference.
	if kind == "cash" {
		ref = ""
	}
	return railID, key, ref, nil
}

// ClaimReference records that this reference has now been used, and fails if it
// already has been.
//
// The uniqueness cannot sit on charges: a visit checkout settles every pending charge
// a patient has under ONE payment, so the same reference legitimately lands on
// several rows. What must be unique is the payment event, which is what this table
// holds — one row, whether it paid one charge or six.
func ClaimReference(ctx context.Context, tx pgx.Tx, tid uuid.UUID, railID *uuid.UUID,
	ref string, receiptNo *int64, patientID *uuid.UUID, amount string, actor *uuid.UUID) error {
	if railID == nil || ref == "" {
		return nil
	}
	// A row may already exist because the desk checked this reference before taking
	// the money. That is the same payment arriving, not a second use — claim it.
	// Only a row that already carries a receipt is a real double-spend.
	var existing *int64
	var checked bool
	// The bank's own answer, when the desk asked it (FIN-5): a payment the bank
	// confirmed for 300 must not be marked as having paid 1,500.
	var exceeds bool
	var confirmed *string
	switch e := tx.QueryRow(ctx,
		`SELECT receipt_no, true,
		        coalesce(verify_state = 'verified' AND verified_amount IS NOT NULL
		                 AND $4::numeric > verified_amount + 0.005, false),
		        verified_amount::text
		   FROM payment_references
		  WHERE tenant_id=$1 AND payment_rail_id=$2 AND reference_norm=upper(btrim($3))`,
		tid, *railID, ref, amount).Scan(&existing, &checked, &exceeds, &confirmed); {
	case e == pgx.ErrNoRows:
	case e != nil:
		return e
	case existing == nil && exceeds:
		// Refused whole: this runs in the settlement's transaction, so nothing is
		// marked paid. The words are for the desk, who can still do the right thing:
		// collect the part the transfer covers and take the rest another way.
		return apperr.Conflict("AMOUNT_EXCEEDS_VERIFIED",
			"the bank confirmed "+*confirmed+" for this reference, but this would mark "+amount+
				" as paid. Collect only up to "+*confirmed+" with this transfer, and take the rest another way.")
	case existing == nil:
		_, e = tx.Exec(ctx,
			`UPDATE payment_references
			    SET receipt_no=$4, patient_id=coalesce($5, patient_id), amount=$6, settled_by=$7, settled_at=now()
			  WHERE tenant_id=$1 AND payment_rail_id=$2 AND reference_norm=upper(btrim($3))`,
			tid, *railID, ref, receiptNo, patientID, amount, actor)
		return e
	default:
		return apperr.Conflict("REFERENCE_USED",
			"that reference has already been used — it paid receipt #"+itoa(*existing))
	}
	var existingReceipt *int64
	e := tx.QueryRow(ctx,
		`INSERT INTO payment_references
		   (tenant_id, payment_rail_id, reference, reference_norm, receipt_no, patient_id, amount, settled_by)
		 VALUES ($1,$2,$3,upper(btrim($3)),$4,$5,$6,$7)
		 ON CONFLICT (tenant_id, payment_rail_id, reference_norm) DO NOTHING
		 RETURNING receipt_no`, tid, *railID, ref, receiptNo, patientID, amount, actor).Scan(&existingReceipt)
	if e == nil {
		return nil
	}
	if e != pgx.ErrNoRows {
		return e
	}
	// Nothing inserted: somebody already used this reference. Name the receipt it
	// paid, because the answer at the desk is almost always "that is the one we did
	// five minutes ago", not "this patient is committing fraud".
	var prior *int64
	if e := tx.QueryRow(ctx,
		`SELECT receipt_no FROM payment_references
		  WHERE tenant_id=$1 AND payment_rail_id=$2 AND reference_norm=upper(btrim($3))`,
		tid, *railID, ref).Scan(&prior); e != nil && e != pgx.ErrNoRows {
		return e
	}
	if prior != nil {
		return apperr.Conflict("REFERENCE_USED",
			"that reference has already been used — it paid receipt #"+itoa(*prior))
	}
	return apperr.Conflict("REFERENCE_USED", "that reference has already been used")
}

// StampCharges records the evidence on the charge rows themselves, so a receipt
// and a dispute can both say how the money arrived.
func StampCharges(ctx context.Context, tx pgx.Tx, tid uuid.UUID, ids []uuid.UUID,
	railID *uuid.UUID, ref string) error {
	if railID == nil && ref == "" {
		return nil
	}
	_, e := tx.Exec(ctx,
		`UPDATE charges SET payment_rail_id = $3, payment_reference = nullif($4,''), updated_at = now()
		  WHERE tenant_id = $1 AND id = ANY($2)`, tid, ids, railID, ref)
	return e
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
