package auth

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPasswordHashAndVerify(t *testing.T) {
	hash, err := HashPassword("S3cret-pass!")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	ok, err := VerifyPassword("S3cret-pass!", hash)
	if err != nil || !ok {
		t.Fatalf("verify correct password: ok=%v err=%v", ok, err)
	}
	bad, err := VerifyPassword("wrong", hash)
	if err != nil {
		t.Fatalf("verify wrong: unexpected err %v", err)
	}
	if bad {
		t.Fatal("wrong password verified true")
	}
}

func TestPasswordHashIsSalted(t *testing.T) {
	h1, _ := HashPassword("same")
	h2, _ := HashPassword("same")
	if h1 == h2 {
		t.Fatal("hashes are not salted (identical for same input)")
	}
}

func TestEncryptDecryptSecret(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	ct, err := EncryptSecret(key, "JBSWY3DPEHPK3PXP")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	pt, err := DecryptSecret(key, ct)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if pt != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("roundtrip mismatch: %q", pt)
	}
	if _, err := DecryptSecret(key, "not-base64-or-tampered"); err == nil {
		t.Fatal("expected decrypt error on tampered ciphertext")
	}
}

func TestAccessTokenIssueParse(t *testing.T) {
	ts := NewTokenService([]byte("0123456789abcdef0123456789abcdef"), "clinicsaas", time.Minute)
	uid, tid := uuid.New(), uuid.New()
	tok, exp, err := ts.IssueAccess(uid, tid, "a@b.c", []string{"doctor"}, []string{"patient.read"}, map[string]bool{"laboratory": true}, []string{uuid.NewString()}, uuid.NewString())
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if time.Until(exp) <= 0 {
		t.Fatal("token already expired")
	}
	claims, err := ts.ParseAccess(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if claims.Subject != uid.String() || claims.TenantID != tid.String() || claims.Type != "access" {
		t.Fatalf("claims mismatch: %+v", claims)
	}
	// An MFA challenge token must not validate as an access token.
	mfa, _ := ts.IssueMFAChallenge(uid, tid, "a@b.c")
	if _, err := ts.ParseAccess(mfa); err == nil {
		t.Fatal("mfa token accepted as access token")
	}
}

func TestRefreshTokenHashStable(t *testing.T) {
	tok, err := GenerateRefreshToken()
	if err != nil {
		t.Fatalf("gen: %v", err)
	}
	if HashToken(tok) != HashToken(tok) {
		t.Fatal("hash not stable")
	}
	other, _ := GenerateRefreshToken()
	if HashToken(tok) == HashToken(other) {
		t.Fatal("distinct tokens produced same hash")
	}
}
