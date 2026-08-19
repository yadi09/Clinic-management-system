package service

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
)

// Resend has another go at a message that did not reach the patient.
//
// Three decisions worth stating, because the obvious implementation gets each of
// them wrong:
//
// It writes a NEW row rather than retrying the old one. The clinic needs to be able
// to see that the first attempt failed — that is the record of why a patient was
// not told something — and it needs both charges counted, because two attempts cost
// two messages.
//
// It reuses the frozen text but re-reads the phone number. The text is what a staff
// member is looking at on screen when they press the button, so changing it under
// them would be a surprise; the number is the thing most likely to have been wrong
// and since fixed, and re-reading it is the whole point of the retry. A bill
// reminder whose amount has changed is not re-rendered — if the facts moved, the
// clinic should write a new message rather than have this one quietly mutate.
//
// It carries no dedupe key. Idempotency exists to stop an automated pass producing
// duplicates; a person pressing "send again" is deliberately asking for another one.
// The guard against a double-click is instead a check for an identical message still
// waiting to go, which is the only duplicate that would actually be delivered twice.
func (s *Service) Resend(ctx context.Context, messageID uuid.UUID) error {
	tid, actor := actorOf(ctx)

	set, err := s.GetSettings(ctx)
	if err != nil {
		return err
	}
	if !set.Enabled {
		return apperr.Validation("turn sending on before resending")
	}

	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var (
			kind, lang, body, status, skipReason, origMSISDN string
			patientID                                        *uuid.UUID
			branchID                                         *uuid.UUID
			bypassQuiet                                      bool
		)
		e := tx.QueryRow(ctx,
			`SELECT kind, lang, body, status, coalesce(skip_reason,''), msisdn,
			        patient_id, branch_id, bypass_quiet_hours
			   FROM messages
			  WHERE tenant_id = $1 AND id = $2
			  FOR UPDATE`, tid, messageID).
			Scan(&kind, &lang, &body, &status, &skipReason, &origMSISDN,
				&patientID, &branchID, &bypassQuiet)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("MESSAGE_NOT_FOUND", "that message is no longer there")
		}
		if e != nil {
			return e
		}

		// A message that has not been tried yet does not need resending — it needs
		// releasing, which is a different button.
		if status == "scheduled" || status == "sending" {
			return apperr.Conflict("MESSAGE_NOT_TRIED_YET",
				"this one has not been sent yet — use Send now if you do not want to wait")
		}
		// Consent is never overridden by a retry. The patient asked not to be
		// messaged; pressing a button again does not change that.
		if skipReason == "no_consent" {
			return apperr.Validation("this patient asked not to be messaged")
		}

		// Re-resolve the number from the patient's record: the usual reason a resend
		// is wanted is that somebody has just corrected it.
		msisdn := origMSISDN
		if patientID != nil {
			var raw string
			var optedOut bool
			if e := tx.QueryRow(ctx,
				`SELECT coalesce(phone,''), sms_opt_out FROM patients
				  WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
				tid, *patientID).Scan(&raw, &optedOut); e != nil {
				if errors.Is(e, pgx.ErrNoRows) {
					return apperr.NotFound("PATIENT_NOT_FOUND", "that patient is no longer on file")
				}
				return e
			}
			if optedOut {
				return apperr.Validation("this patient has since asked not to be messaged")
			}
			resolved, st := phone.MSISDN(raw)
			switch st {
			case phone.OK:
				msisdn = resolved
			case phone.Missing:
				return apperr.Validation("there is still no phone number on this patient's record — add one first")
			case phone.Unsupported:
				return apperr.Validation("this number is not an Ethio Telecom number, which is all this gateway reaches")
			default:
				return apperr.Validation("the number on this patient's record is still not a valid mobile")
			}
		}
		if strings.TrimSpace(msisdn) == "" {
			return apperr.Validation("there is no number to send this to")
		}

		// The only duplicate that would actually reach the patient twice is one that
		// has not gone yet. Two delivered copies an hour apart were two deliberate
		// presses; two queued copies are a double-click.
		var pending int
		if e := tx.QueryRow(ctx,
			`SELECT count(*) FROM messages
			  WHERE tenant_id = $1 AND msisdn = $2 AND body = $3
			    AND status IN ('scheduled','sending')`, tid, msisdn, body).Scan(&pending); e != nil {
			return e
		}
		if pending > 0 {
			return apperr.Conflict("ALREADY_QUEUED", "this message is already waiting to go out")
		}

		segs, _ := sms.Segments(body)
		if e := limits.EnsureSMSRoom(ctx, tx, tid, int64(segs)); e != nil {
			return e
		}

		// bypass_quiet_hours is inherited, not granted. Whether a message is an
		// intrusion at 11pm is a property of the message — a welcome is not, a bill
		// chase is — and that does not change because a human pressed the button.
		_, e = tx.Exec(ctx,
			`INSERT INTO messages (tenant_id, branch_id, patient_id, kind, lang, msisdn, body,
			                       segments, cost, status, scheduled_for, created_by,
			                       bypass_quiet_hours, resent_from)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled',now(),$10,$11,$12)`,
			tid, branchID, patientID, kind, lang, msisdn, body,
			segs, float64(segs)*s.cost, actor, bypassQuiet, messageID)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// SendNow releases a message that is waiting out the clinic's quiet hours.
//
// Separate from Resend because it is a different act on a different row: nothing
// has been attempted, nothing needs charging twice, and there is no lineage to
// record. The clinic is saying "I know it is late, send it anyway" — which is a
// judgement they are entitled to make about their own patients.
func (s *Service) SendNow(ctx context.Context, messageID uuid.UUID) error {
	tid, _ := actorOf(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE messages
			    SET scheduled_for = now(), bypass_quiet_hours = true, updated_at = now()
			  WHERE tenant_id = $1 AND id = $2 AND status = 'scheduled'`, tid, messageID)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.Conflict("NOT_WAITING", "that message is not waiting to be sent")
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}
