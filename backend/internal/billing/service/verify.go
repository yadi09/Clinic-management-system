package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/payments"
)

// VerifyPayment checks a claimed transfer against the bank, before the clinic accepts
// it. It settles nothing: the desk sees the answer, then decides.
//
// Checking first, rather than after, is the whole point. Once a bill is marked paid
// the money has effectively been released; a verification that arrives afterwards can
// only produce an argument. The patient is standing there, so this is a few seconds
// spent in exactly the right place.
func (s *Service) VerifyPayment(ctx context.Context, in billing.VerifyInput) (*billing.VerifyResult, error) {
	tenantID, actor := actorOf(ctx)
	if in.RailID == nil {
		return nil, apperr.Validation("choose a payment method first")
	}
	var out billing.VerifyResult
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rail, e := payments.LoadRail(ctx, tx, tenantID, *in.RailID)
		if e != nil {
			return e
		}
		var patientID *uuid.UUID
		if in.PatientID != uuid.Nil {
			patientID = &in.PatientID
		}
		chk, e := payments.RunCheck(ctx, tx, s.verifier, tenantID, rail,
			in.Reference, in.Expected, patientID, s.waitMs, actor)
		if e != nil {
			return e
		}
		out = billing.VerifyResult{
			State: chk.State, Reason: chk.Reason, Amount: chk.Amount, Sender: chk.Sender,
			Account: chk.Account, When: chk.When, AlreadyUsed: chk.Already,
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// VerificationAvailable reports whether the desk should offer a bank check at all.
func (s *Service) VerificationAvailable() bool {
	return s.verifier != nil && s.verifier.Live()
}
