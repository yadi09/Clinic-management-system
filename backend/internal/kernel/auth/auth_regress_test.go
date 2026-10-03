package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/pquerna/otp/totp"
)

var regSecret = []byte("0123456789abcdef0123456789abcdef")

func regTS() *TokenService { return NewTokenService(regSecret, "clinicsaas", time.Minute) }

func issue(t *testing.T, ts *TokenService) (string, uuid.UUID, uuid.UUID) {
	t.Helper()
	uid, tid := uuid.New(), uuid.New()
	tok, _, err := ts.IssueAccess(uid, tid, "dr@x.et", []string{"doctor"}, []string{"patient.read"}, map[string]bool{"lab": true}, []string{"b1", "b2"}, "b1")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return tok, uid, tid
}

// signRaw signs arbitrary claims with HS256 and the given key.
func signRaw(t *testing.T, claims jwt.Claims, key []byte) string {
	t.Helper()
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// Given an issued access token, When parsed, Then every claim round-trips
// (tenant, email, roles, perms, flags, branches, active branch, issuer, expiry).
func TestREG_KERNEL_AUTH_001_AccessTokenClaimsRoundTrip(t *testing.T) {
	ts := regTS()
	before := time.Now()
	uid, tid := uuid.New(), uuid.New()
	tok, exp, err := ts.IssueAccess(uid, tid, "dr@x.et", []string{"doctor"}, []string{"patient.read"}, map[string]bool{"lab": true}, []string{"b1", "b2"}, "b1")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if d := exp.Sub(before); d < 59*time.Second || d > 61*time.Second {
		t.Fatalf("expiry %v not ~accessTTL", d)
	}
	c, err := ts.ParseAccess(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if c.Subject != uid.String() || c.TenantID != tid.String() || c.Email != "dr@x.et" || c.Issuer != "clinicsaas" ||
		c.Type != "access" || c.ActiveBranch != "b1" || len(c.Branches) != 2 || !c.Flags["lab"] ||
		len(c.Roles) != 1 || c.Roles[0] != "doctor" || len(c.Permissions) != 1 || c.ID == "" {
		t.Fatalf("claims = %+v", c)
	}
	if c.ExpiresAt.Unix() != exp.Unix() {
		t.Fatalf("exp claim %v != returned %v", c.ExpiresAt, exp)
	}
}

// Given a token whose TTL has elapsed, When parsed, Then ErrInvalidToken.
func TestREG_KERNEL_AUTH_002_ExpiredTokenRejected(t *testing.T) {
	ts := NewTokenService(regSecret, "clinicsaas", -time.Minute)
	tok, _, _ := issue(t, ts)
	if _, err := ts.ParseAccess(tok); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expired token err = %v", err)
	}
}

// Given a token signed with another secret, When parsed, Then rejected.
func TestREG_KERNEL_AUTH_003_WrongSecretRejected(t *testing.T) {
	tok, _, _ := issue(t, NewTokenService([]byte("another-secret-another-secret-xx"), "clinicsaas", time.Minute))
	if _, err := regTS().ParseAccess(tok); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("err = %v", err)
	}
}

// Given a token with a different issuer, When parsed, Then rejected.
func TestREG_KERNEL_AUTH_004_WrongIssuerRejected(t *testing.T) {
	tok, _, _ := issue(t, NewTokenService(regSecret, "evil", time.Minute))
	if _, err := regTS().ParseAccess(tok); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("err = %v", err)
	}
}

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func validPayload() string {
	exp := time.Now().Add(time.Hour).Unix()
	return b64(`{"iss":"clinicsaas","sub":"` + uuid.NewString() + `","tid":"` + uuid.NewString() + `","typ":"access","exp":` + strconv.FormatInt(exp, 10) + `}`)
}

// Given alg=none (unsigned) with valid-looking claims, When parsed, Then rejected.
func TestREG_KERNEL_AUTH_005_AlgNoneRejected(t *testing.T) {
	for _, tok := range []string{
		b64(`{"alg":"none","typ":"JWT"}`) + "." + validPayload() + ".",
		b64(`{"alg":"none","typ":"JWT"}`) + "." + validPayload(),
	} {
		if _, err := regTS().ParseAccess(tok); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("alg none accepted: %v", err)
		}
	}
	// Even a library-signed "none" token (UnsafeAllowNoneSignatureType) fails.
	none, _ := jwt.NewWithClaims(jwt.SigningMethodNone, AccessClaims{RegisteredClaims: jwt.RegisteredClaims{Issuer: "clinicsaas", ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}, Type: "access"}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	if _, err := regTS().ParseAccess(none); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("library none token accepted: %v", err)
	}
}

// Given an RS256-signed token (alg confusion) or HS512 with the right secret,
// When parsed, Then rejected because only HS256 is allowed.
func TestREG_KERNEL_AUTH_006_OtherAlgorithmsRejected(t *testing.T) {
	claims := AccessClaims{RegisteredClaims: jwt.RegisteredClaims{Issuer: "clinicsaas", ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}, Type: "access"}
	pk, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rs, _ := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(pk)
	hs512, _ := jwt.NewWithClaims(jwt.SigningMethodHS512, claims).SignedString(regSecret)
	// RS256 header but HMAC-SHA256 bytes signed with our secret.
	hdr := b64(`{"alg":"RS256","typ":"JWT"}`)
	body := strings.Split(signRaw(t, claims, regSecret), ".")[1]
	sig, _ := jwt.SigningMethodHS256.Sign(hdr+"."+body, regSecret)
	confused := hdr + "." + body + "." + base64.RawURLEncoding.EncodeToString(sig)
	for name, tok := range map[string]string{"rs256": rs, "hs512": hs512, "rs256-header-hmac-sig": confused} {
		if _, err := regTS().ParseAccess(tok); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}
}

// Given a valid token, When its payload is swapped (privilege escalation) or a
// signature byte flipped, Then the token is rejected.
func TestREG_KERNEL_AUTH_007_TamperedTokenRejected(t *testing.T) {
	ts := regTS()
	tok, _, _ := issue(t, ts)
	parts := strings.Split(tok, ".")
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	evil := strings.Replace(string(raw), `"perms":["patient.read"]`, `"perms":["platform.admin"]`, 1)
	if evil == string(raw) {
		t.Fatal("test setup: perms not found in payload")
	}
	forged := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(evil)) + "." + parts[2]
	if _, err := ts.ParseAccess(forged); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("tampered payload accepted: %v", err)
	}
	sig := []byte(parts[2])
	if sig[0] == 'A' {
		sig[0] = 'B'
	} else {
		sig[0] = 'A'
	}
	if _, err := ts.ParseAccess(parts[0] + "." + parts[1] + "." + string(sig)); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("tampered signature accepted: %v", err)
	}
	for _, junk := range []string{"", "abc", "a.b.c", tok + "x"} {
		if _, err := ts.ParseAccess(junk); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("junk %q accepted", junk)
		}
	}
}

// Given correctly signed tokens missing typ/iss, or with a future nbf, When
// parsed, Then rejected.
func TestREG_KERNEL_AUTH_008_MissingTypeIssuerOrFutureNbfRejected(t *testing.T) {
	exp := jwt.NewNumericDate(time.Now().Add(time.Hour))
	cases := map[string]AccessClaims{
		"no-typ":     {RegisteredClaims: jwt.RegisteredClaims{Issuer: "clinicsaas", ExpiresAt: exp}},
		"no-iss":     {RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: exp}, Type: "access"},
		"future-nbf": {RegisteredClaims: jwt.RegisteredClaims{Issuer: "clinicsaas", ExpiresAt: exp, NotBefore: jwt.NewNumericDate(time.Now().Add(10 * time.Minute))}, Type: "access"},
		"wrong-typ":  {RegisteredClaims: jwt.RegisteredClaims{Issuer: "clinicsaas", ExpiresAt: exp}, Type: "refresh"},
	}
	for name, c := range cases {
		if _, err := regTS().ParseAccess(signRaw(t, c, regSecret)); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}
}

// Given an MFA challenge token, When parsed, Then ParseMFAChallenge accepts it
// (typ=mfa, ~5 min expiry, no roles) and an access token is NOT a challenge.
func TestREG_KERNEL_AUTH_009_MFAChallengeTyped(t *testing.T) {
	ts := regTS()
	uid, tid := uuid.New(), uuid.New()
	ch, err := ts.IssueMFAChallenge(uid, tid, "a@b.c")
	if err != nil {
		t.Fatal(err)
	}
	c, err := ts.ParseMFAChallenge(ch)
	if err != nil {
		t.Fatalf("parse challenge: %v", err)
	}
	if c.Type != "mfa" || c.Subject != uid.String() || c.TenantID != tid.String() || len(c.Permissions) != 0 {
		t.Fatalf("claims = %+v", c)
	}
	if d := time.Until(c.ExpiresAt.Time); d < 4*time.Minute || d > 5*time.Minute+time.Second {
		t.Fatalf("challenge ttl %v, want ~5m", d)
	}
	acc, _, _ := issue(t, ts)
	if _, err := ts.ParseMFAChallenge(acc); !errors.Is(err, ErrInvalidToken) {
		t.Fatal("access token accepted as MFA challenge")
	}
	if _, err := NewTokenService([]byte("other-secret-other-secret-other!"), "clinicsaas", time.Minute).ParseMFAChallenge(ch); !errors.Is(err, ErrInvalidToken) {
		t.Fatal("challenge accepted under wrong secret")
	}
}

// Given refresh tokens, When generated, Then they are 43-char URL-safe base64 of
// 32 random bytes and HashToken is the 64-hex SHA-256.
func TestREG_KERNEL_AUTH_010_RefreshTokenShape(t *testing.T) {
	tok, err := GenerateRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil || len(raw) != 32 {
		t.Fatalf("token %q not 32 raw-url bytes: %v", tok, err)
	}
	if got := HashToken("abc"); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("HashToken(abc) = %s", got)
	}
}

// Given a hash, When verified with the right/wrong/empty password, Then only the
// right password matches and the encoding is $argon2id$v=19$m=65536,t=1,p=4$...
func TestREG_KERNEL_AUTH_011_PasswordHashFormatAndVerify(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=65536,t=1,p=4$") || len(strings.Split(h, "$")) != 6 {
		t.Fatalf("hash format = %q", h)
	}
	for pw, want := range map[string]bool{"correct horse": true, "Correct horse": false, "": false, "correct horse ": false} {
		ok, err := VerifyPassword(pw, h)
		if err != nil || ok != want {
			t.Fatalf("verify(%q) = %v, %v; want %v", pw, ok, err, want)
		}
	}
	// Changing the salt makes the right password fail.
	parts := strings.Split(h, "$")
	parts[4] = "AAAAAAAAAAAAAAAAAAAAAA"
	if ok, _ := VerifyPassword("correct horse", strings.Join(parts, "$")); ok {
		t.Fatal("altered salt still verified")
	}
}

// Given malformed encodings, When verified, Then ErrInvalidHash and false.
func TestREG_KERNEL_AUTH_012_MalformedHashRejected(t *testing.T) {
	for _, h := range []string{
		"",
		"plaintext",
		"$2a$10$bcrypthashbcrypthashbcrypthashbcrypthashbcrypthashbcry",
		"$argon2i$v=19$m=65536,t=1,p=4$c2FsdA$a2V5",
		"$argon2id$v=x$m=65536,t=1,p=4$c2FsdA$a2V5",
		"$argon2id$v=19$m=a,t=1,p=4$c2FsdA$a2V5",
		"$argon2id$v=19$m=65536,t=1,p=4$!!!$a2V5",
		"$argon2id$v=19$m=65536,t=1,p=4$c2FsdA$!!!",
		"$argon2id$v=19$m=65536,t=1,p=4$c2FsdA",
	} {
		ok, err := VerifyPassword("x", h)
		if ok || !errors.Is(err, ErrInvalidHash) {
			t.Fatalf("hash %q: ok=%v err=%v", h, ok, err)
		}
	}
}

func testKey(n int, seed byte) []byte {
	k := make([]byte, n)
	for i := range k {
		k[i] = seed + byte(i)
	}
	return k
}

// Given a secret encrypted twice, When decrypted, Then both round-trip and the
// ciphertexts differ (random nonce), including empty and unicode plaintexts.
func TestREG_KERNEL_AUTH_013_EncryptRoundTripRandomNonce(t *testing.T) {
	k := testKey(32, 1)
	for _, pt := range []string{"JBSWY3DPEHPK3PXP", "", "ሰላም-σ-✓"} {
		a, err := EncryptSecret(k, pt)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := EncryptSecret(k, pt)
		if a == b {
			t.Fatalf("deterministic ciphertext for %q", pt)
		}
		if strings.Contains(a, pt) && pt != "" {
			t.Fatal("plaintext visible in ciphertext")
		}
		got, err := DecryptSecret(k, a)
		if err != nil || got != pt {
			t.Fatalf("roundtrip %q -> %q, %v", pt, got, err)
		}
	}
}

// Given a ciphertext, When any byte is flipped or the wrong key is used, Then
// decryption fails with ErrDecrypt (GCM authentication).
func TestREG_KERNEL_AUTH_014_TamperOrWrongKeyFailsDecrypt(t *testing.T) {
	k := testKey(32, 1)
	ct, _ := EncryptSecret(k, "JBSWY3DPEHPK3PXP")
	raw, _ := base64.StdEncoding.DecodeString(ct)
	for i := range raw {
		mut := append([]byte(nil), raw...)
		mut[i] ^= 0x01
		if _, err := DecryptSecret(k, base64.StdEncoding.EncodeToString(mut)); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("flip byte %d: err = %v", i, err)
		}
	}
	if _, err := DecryptSecret(testKey(32, 9), ct); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("wrong key: %v", err)
	}
}

// Given inputs shorter than a nonce or not base64, When decrypted, Then
// ErrDecrypt; and invalid AES key sizes error on both encrypt and decrypt.
func TestREG_KERNEL_AUTH_015_ShortInputAndBadKeySize(t *testing.T) {
	k := testKey(32, 1)
	for _, in := range []string{"", base64.StdEncoding.EncodeToString([]byte("short")), "%%%"} {
		if _, err := DecryptSecret(k, in); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("input %q: err = %v", in, err)
		}
	}
	bad := testKey(10, 1)
	if _, err := EncryptSecret(bad, "x"); err == nil {
		t.Fatal("10-byte key accepted by EncryptSecret")
	}
	ct, _ := EncryptSecret(k, "x")
	if _, err := DecryptSecret(bad, ct); err == nil {
		t.Fatal("10-byte key accepted by DecryptSecret")
	}
}

// Given a generated TOTP secret, When validated with the current code, Then it
// passes; a wrong code, empty code, or a code from 10 minutes ago fails.
func TestREG_KERNEL_AUTH_016_TOTPValidation(t *testing.T) {
	key, err := GenerateTOTPSecret("ClinicOS", "dr@x.et")
	if err != nil {
		t.Fatal(err)
	}
	if key.Issuer() != "ClinicOS" || key.AccountName() != "dr@x.et" || len(key.Secret()) < 16 {
		t.Fatalf("key = %s", key.URL())
	}
	if !strings.HasPrefix(key.URL(), "otpauth://totp/ClinicOS:dr@x.et?") {
		t.Fatalf("provisioning url = %s", key.URL())
	}
	now, err := totp.GenerateCode(key.Secret(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !ValidateTOTP(key.Secret(), now) {
		t.Fatal("current code rejected")
	}
	old, _ := totp.GenerateCode(key.Secret(), time.Now().Add(-10*time.Minute))
	wrong := "000000"
	if wrong == now {
		wrong = "111111"
	}
	for _, c := range []string{wrong, "", "12345", "abcdef", now + "0"} {
		if ValidateTOTP(key.Secret(), c) {
			t.Fatalf("code %q accepted", c)
		}
	}
	if old != now && ValidateTOTP(key.Secret(), old) {
		t.Fatal("10-minute-old code accepted")
	}
	other, _ := GenerateTOTPSecret("ClinicOS", "x@y")
	if ValidateTOTP(other.Secret(), now) && other.Secret() != key.Secret() {
		// 1-in-a-million collision is possible; re-check with a fresh code to be safe.
		c2, _ := totp.GenerateCode(key.Secret(), time.Now())
		if ValidateTOTP(other.Secret(), c2) && c2 == now {
			t.Fatal("code valid for a different secret")
		}
	}
	if _, err := GenerateTOTPSecret("", "acct"); err == nil {
		t.Fatal("empty issuer accepted")
	}
}
