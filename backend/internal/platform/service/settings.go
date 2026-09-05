package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/platform"
)

// Vendor-owned credentials, entered in the console instead of on the server.
//
// The Verify.ET key used to live only in an environment variable, so supplying or
// rotating it meant an SSH session and an API restart. Every other third-party
// credential in this product is pasted into the app and encrypted at rest; this
// makes the platform's own key work the same way.
//
// The plaintext is written once, encrypted immediately, and never read back out to
// any client — the console gets a hint ("…a3f9") so an admin can tell which key is
// loaded, and nothing more.

// SetIntegrationKey stores a platform credential, encrypted.
func (s *Service) SetIntegrationKey(ctx context.Context, key, secret string, actor *uuid.UUID) (*platform.Integration, error) {
	if key != platform.SettingVerifyETKey {
		return nil, apperr.Validation("unknown setting")
	}
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil, apperr.Validation("paste the key first")
	}
	enc, err := auth.EncryptSecret(s.encKey, secret)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	_, err = s.db.Pool.Exec(ctx,
		`INSERT INTO platform_settings (key, value_enc, hint, updated_by, updated_at)
		 VALUES ($1,$2,$3,$4,now())
		 ON CONFLICT (key) DO UPDATE
		   SET value_enc = EXCLUDED.value_enc, hint = EXCLUDED.hint,
		       updated_by = EXCLUDED.updated_by, updated_at = now()`,
		key, enc, hintOf(secret), actor)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.integration(ctx, key)
}

// ClearIntegrationKey removes a credential. Verification then switches itself off,
// which is the honest behaviour: better a desk that says "not checked" than one
// silently trusting a key that was revoked at the vendor.
func (s *Service) ClearIntegrationKey(ctx context.Context, key string) error {
	if _, err := s.db.Pool.Exec(ctx, `DELETE FROM platform_settings WHERE key = $1`, key); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// GetIntegration reports whether a credential is loaded, without revealing it.
func (s *Service) GetIntegration(ctx context.Context, key string) (*platform.Integration, error) {
	return s.integration(ctx, key)
}

func (s *Service) integration(ctx context.Context, key string) (*platform.Integration, error) {
	out := &platform.Integration{Key: key}
	var hint *string
	var at *time.Time
	err := s.db.Pool.QueryRow(ctx,
		`SELECT hint, updated_at FROM platform_settings WHERE key = $1`, key).Scan(&hint, &at)
	switch {
	case err == pgx.ErrNoRows:
		return out, nil
	case err != nil:
		return nil, apperr.Internal(err)
	}
	out.Configured, out.Source = true, "saved"
	if hint != nil {
		out.Hint = *hint
	}
	if at != nil {
		out.UpdatedAt = at.Format(time.RFC3339)
	}
	return out, nil
}

// LookupSecret decrypts a stored credential. Used by the API to build a vendor
// client at request time, never exposed over HTTP.
func (s *Service) LookupSecret(ctx context.Context, key string) (string, error) {
	var enc string
	err := s.db.Pool.QueryRow(ctx, `SELECT value_enc FROM platform_settings WHERE key = $1`, key).Scan(&enc)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return auth.DecryptSecret(s.encKey, enc)
}

// hintOf keeps the last four characters, which is enough to tell two keys apart and
// useless to anyone who steals it.
func hintOf(secret string) string {
	if len(secret) <= 4 {
		return "…"
	}
	return "…" + secret[len(secret)-4:]
}

// --- plan features & per-clinic entitlements ----------------------------------

// Features returns the catalogue: every paid feature the system actually gates,
// grouped the way the pricing page groups them.
func (s *Service) Features(ctx context.Context) ([]platform.Feature, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT code, name, coalesce(detail,''), category, clinic_type FROM features ORDER BY sort`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []platform.Feature{}
	for rows.Next() {
		var f platform.Feature
		if err := rows.Scan(&f.Code, &f.Name, &f.Detail, &f.Category, &f.ClinicType); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// PlanFeatures returns what one plan includes. Configured is false for a plan
// nobody has described yet — such a plan gates nothing at all (see
// kernel/entitlements), and the console has to say so rather than showing a grid
// of empty boxes that look like deliberate exclusions.
func (s *Service) PlanFeatures(ctx context.Context, planID uuid.UUID) (*platform.PlanFeatureSet, error) {
	out := &platform.PlanFeatureSet{Features: map[string]bool{}}
	rows, err := s.db.Pool.Query(ctx,
		`SELECT feature, enabled FROM plan_features WHERE plan_id = $1`, planID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		var on bool
		if err := rows.Scan(&code, &on); err != nil {
			return nil, apperr.Internal(err)
		}
		out.Features[code] = on
		out.Configured = true
	}
	return out, rows.Err()
}

// SetPlanFeatures replaces what a plan includes.
//
// Every clinic on the plan is affected at once, which is the point — this is the
// price list, not one clinic's settings. It takes effect for a clinic when its
// next access token is issued, the same as the module toggles have always done.
func (s *Service) SetPlanFeatures(ctx context.Context, planID uuid.UUID, features map[string]bool) error {
	var exists bool
	if err := s.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plans WHERE id = $1)`, planID).Scan(&exists); err != nil {
		return apperr.Internal(err)
	}
	if !exists {
		return apperr.NotFound("PLAN_NOT_FOUND", "plan not found")
	}
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return apperr.Internal(err)
	}
	defer tx.Rollback(ctx)
	for code, on := range features {
		if _, err := tx.Exec(ctx,
			`INSERT INTO plan_features (plan_id, feature, enabled) VALUES ($1,$2,$3)
			 ON CONFLICT (plan_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`,
			planID, code, on); err != nil {
			return apperr.Internal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ClinicEntitlements returns one clinic's exceptions to its plan, and what the
// plan itself says, so the operator can see which of the two is in force.
func (s *Service) ClinicEntitlements(ctx context.Context, tenantID uuid.UUID) (*platform.ClinicEntitlements, error) {
	out := &platform.ClinicEntitlements{FromPlan: map[string]bool{}, Override: map[string]bool{}, Note: map[string]string{}}
	if err := s.db.Pool.QueryRow(ctx,
		`SELECT p.name, (SELECT count(*) FROM plan_features x WHERE x.plan_id = p.id) > 0
		   FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1 AND t.deleted_at IS NULL`,
		tenantID).Scan(&out.PlanName, &out.PlanConfigured); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
		}
		return nil, apperr.Internal(err)
	}
	rows, err := s.db.Pool.Query(ctx,
		`SELECT f.code, coalesce(pf.enabled, false), te.enabled, coalesce(te.note, '')
		   FROM features f
		   LEFT JOIN plan_features pf ON pf.feature = f.code
		        AND pf.plan_id = (SELECT plan_id FROM tenants WHERE id = $1)
		   LEFT JOIN tenant_entitlements te ON te.feature = f.code AND te.tenant_id = $1
		  ORDER BY f.sort`, tenantID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var code, note string
		var fromPlan bool
		var override *bool
		if err := rows.Scan(&code, &fromPlan, &override, &note); err != nil {
			return nil, apperr.Internal(err)
		}
		out.FromPlan[code] = fromPlan
		if override != nil {
			out.Override[code] = *override
			out.Note[code] = note
		}
	}
	return out, rows.Err()
}

// SetClinicEntitlement grants or withdraws one feature for one clinic, or clears
// the exception so the plan decides again (state nil).
func (s *Service) SetClinicEntitlement(ctx context.Context, tenantID uuid.UUID, feature string, state *bool, note string) error {
	if state == nil {
		if _, err := s.db.Pool.Exec(ctx,
			`DELETE FROM tenant_entitlements WHERE tenant_id = $1 AND feature = $2`, tenantID, feature); err != nil {
			return apperr.Internal(err)
		}
		return nil
	}
	if _, err := s.db.Pool.Exec(ctx,
		`INSERT INTO tenant_entitlements (tenant_id, feature, enabled, note) VALUES ($1,$2,$3,nullif($4,''))
		 ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled, note = EXCLUDED.note`,
		tenantID, feature, *state, strings.TrimSpace(note)); err != nil {
		if isFKViolation(err) {
			return apperr.Validation("unknown feature")
		}
		return apperr.Internal(err)
	}
	return nil
}

// isFKViolation spots a reference to a feature code that does not exist, which is
// a bad request rather than a server fault.
func isFKViolation(err error) bool {
	var pge *pgconn.PgError
	return errors.As(err, &pge) && pge.Code == "23503"
}
