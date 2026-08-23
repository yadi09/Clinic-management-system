package service

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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
