package service

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/org"
)

// The providers a rail can name. Deliberately the receipt-verification vocabulary
// rather than one of our own: when verification is wired up, the clinic's existing
// configuration is already the right shape and nobody re-enters anything.
var bankKeys = map[string]bool{
	"cbe": true, "boa": true, "telebirr": true, "mpesa": true, "cbebirr": true,
	"dashen": true, "awash": true, "siinqee": true, "kaafiebirr": true, "zemen": true,
}

var railKeyRe = regexp.MustCompile(`^[a-z0-9_]{2,24}$`)

const railCols = `id, key, label, kind, coalesce(bank_key,''), coalesce(account_name,''),
                  coalesce(account_number,''), needs_reference, active, sort_order`

func scanRail(row pgx.Row) (*org.PaymentRail, error) {
	var r org.PaymentRail
	if e := row.Scan(&r.ID, &r.Key, &r.Label, &r.Kind, &r.BankKey, &r.AccountName,
		&r.AccountNumber, &r.NeedsReference, &r.Active, &r.SortOrder); e != nil {
		return nil, e
	}
	return &r, nil
}

func (s *Service) ListPaymentRails(ctx context.Context, activeOnly bool) ([]org.PaymentRail, error) {
	tid, _ := actor(ctx)
	out := []org.PaymentRail{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT `+railCols+`
			 FROM payment_rails
			 WHERE tenant_id = $1 AND ($2::bool = false OR active)
			 ORDER BY sort_order, label`, tid, activeOnly)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			r, e := scanRail(rows)
			if e != nil {
				return e
			}
			out = append(out, *r)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// validateRail is shared by create and update so a rail cannot be edited into a
// shape that create would have refused.
func validateRail(in *org.PaymentRailInput) error {
	in.Label = strings.TrimSpace(in.Label)
	in.BankKey = strings.ToLower(strings.TrimSpace(in.BankKey))
	in.AccountName = strings.TrimSpace(in.AccountName)
	in.AccountNumber = strings.TrimSpace(in.AccountNumber)
	if in.Label == "" {
		return apperr.Validation("give this payment method a name")
	}
	switch in.Kind {
	case "cash", "card", "wallet", "bank":
	default:
		return apperr.Validation("kind must be cash, card, wallet or bank")
	}
	// Cash and card have no receipt anywhere to look up, so a provider or a
	// reference requirement on them is a configuration mistake, not a preference.
	if in.Kind == "cash" || in.Kind == "card" {
		if in.BankKey != "" {
			return apperr.Validation("cash and card are not paid through a provider")
		}
		in.AccountNumber, in.AccountName = "", ""
		in.NeedsReference = false
		return nil
	}
	if in.BankKey != "" && !bankKeys[in.BankKey] {
		return apperr.Validation("unknown provider")
	}
	return nil
}

func (s *Service) CreatePaymentRail(ctx context.Context, in org.PaymentRailInput) (*org.PaymentRail, error) {
	tid, actor := actor(ctx)
	if err := validateRail(&in); err != nil {
		return nil, err
	}
	in.Key = strings.ToLower(strings.TrimSpace(in.Key))
	if in.Key == "" {
		in.Key = slugKey(in.Label)
	}
	if !railKeyRe.MatchString(in.Key) {
		return nil, apperr.Validation("the code may use lowercase letters, numbers and underscores only")
	}
	var out *org.PaymentRail
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := scanRail(tx.QueryRow(ctx,
			`INSERT INTO payment_rails
			   (tenant_id, key, label, kind, bank_key, account_name, account_number,
			    needs_reference, active, sort_order, created_by)
			 VALUES ($1,$2,$3,$4,nullif($5,''),nullif($6,''),nullif($7,''),$8,$9,$10,$11)
			 RETURNING `+railCols,
			tid, in.Key, in.Label, in.Kind, in.BankKey, in.AccountName, in.AccountNumber,
			in.NeedsReference, in.Active, in.SortOrder, actor))
		if e != nil {
			return e
		}
		out = r
		return nil
	})
	if isUniqueViolation(err) {
		return nil, apperr.Conflict("RAIL_EXISTS", "a payment method with that code already exists")
	}
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// UpdatePaymentRail changes everything except the key. The key is what every settled
// charge and every takings report was written with; renaming it in place would
// silently re-bucket history.
func (s *Service) UpdatePaymentRail(ctx context.Context, id uuid.UUID, in org.PaymentRailInput) (*org.PaymentRail, error) {
	tid, _ := actor(ctx)
	if err := validateRail(&in); err != nil {
		return nil, err
	}
	var out *org.PaymentRail
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		r, e := scanRail(tx.QueryRow(ctx,
			`UPDATE payment_rails SET label=$3, kind=$4, bank_key=nullif($5,''),
			        account_name=nullif($6,''), account_number=nullif($7,''),
			        needs_reference=$8, active=$9, sort_order=$10, updated_at=now()
			 WHERE tenant_id=$1 AND id=$2
			 RETURNING `+railCols,
			tid, id, in.Label, in.Kind, in.BankKey, in.AccountName, in.AccountNumber,
			in.NeedsReference, in.Active, in.SortOrder))
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("RAIL_NOT_FOUND", "payment method not found")
		}
		if e != nil {
			return e
		}
		out = r
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// DeletePaymentRail removes a rail that has never been used. One that has taken money
// is switched off instead: the charges it settled point at it, and a receipt that
// cannot say how it was paid is worse than a picker with one dead option.
func (s *Service) DeletePaymentRail(ctx context.Context, id uuid.UUID) error {
	tid, _ := actor(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var used int
		if e := tx.QueryRow(ctx,
			`SELECT count(*) FROM charges WHERE tenant_id=$1 AND payment_rail_id=$2`, tid, id).Scan(&used); e != nil {
			return e
		}
		if used > 0 {
			return apperr.Conflict("RAIL_IN_USE",
				"this method has already taken payments — switch it off instead of deleting it")
		}
		ct, e := tx.Exec(ctx, `DELETE FROM payment_rails WHERE tenant_id=$1 AND id=$2`, tid, id)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("RAIL_NOT_FOUND", "payment method not found")
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

// slugKey derives a stable machine key from a label ("CBE — main account" -> "cbe_main_account").
func slugKey(label string) string {
	var b strings.Builder
	prev := false
	for _, r := range strings.ToLower(label) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prev = false
		case !prev && b.Len() > 0:
			b.WriteRune('_')
			prev = true
		}
	}
	return strings.Trim(b.String(), "_")
}

func isUniqueViolation(err error) bool {
	var pge *pgconn.PgError
	return errors.As(err, &pge) && pge.Code == "23505"
}
