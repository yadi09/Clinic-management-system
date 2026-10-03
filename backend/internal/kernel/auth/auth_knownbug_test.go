package auth_test

import (
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// verifyNoPanic runs VerifyPassword, converting a panic into (false, panicked=true).
func verifyNoPanic(pw, hash string) (ok bool, err error, panicked bool) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
		}
	}()
	ok, err = auth.VerifyPassword(pw, hash)
	return ok, err, false
}

// Given a stored hash that parses but has t=0, p=0 or an empty key segment,
// When a login verifies against it, Then VerifyPassword should return
// ErrInvalidHash; today argon2.IDKey panics inside VerifyPassword.
func TestREG_KERNEL_AUTH_017_DegenerateHashParamsDoNotPanic(t *testing.T) {
	present := false
	for _, h := range []string{
		"$argon2id$v=19$m=8,t=0,p=1$c2FsdHNhbHQ$AAAAAAAAAAAAAAAAAAAAAA",
		"$argon2id$v=19$m=8,t=1,p=0$c2FsdHNhbHQ$AAAAAAAAAAAAAAAAAAAAAA",
		"$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$",
	} {
		ok, err, panicked := verifyNoPanic("anything", h)
		if ok {
			t.Fatalf("hash %q verified an arbitrary password (fail-open)", h)
		}
		if panicked || !errors.Is(err, auth.ErrInvalidHash) {
			present = true
		}
	}
	testkit.KnownBug(t, "NEW-KERNEL-AUTH-1", present,
		"VerifyPassword does not range-check t/p/key length; argon2.IDKey panics (password.go:69)")
}

// Given a correctly signed access token with no exp claim, When parsed, Then it
// should be rejected; today jwt.WithExpirationRequired is not set, so a token
// without exp never expires (jwt.go:111-117).
func TestREG_KERNEL_AUTH_018_TokenWithoutExpRejected(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	ts := auth.NewTokenService(secret, "clinicsaas", time.Minute)
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, auth.AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{Issuer: "clinicsaas", Subject: uuid.NewString()},
		TenantID:         uuid.NewString(),
		Type:             "access",
	}).SignedString(secret)
	if err != nil {
		t.Fatal(err)
	}
	_, perr := ts.ParseAccess(tok)
	testkit.KnownBug(t, "NEW-KERNEL-AUTH-2", perr == nil,
		"ParseAccess accepts a signed token with no exp claim (never expires)")
}
