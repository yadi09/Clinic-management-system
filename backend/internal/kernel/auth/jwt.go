package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// AccessClaims are the JWT claims for a short-lived access token. Roles,
// permissions, and feature flags are embedded so authorization middleware is
// stateless; the short TTL bounds staleness after a grant change.
type AccessClaims struct {
	jwt.RegisteredClaims
	TenantID    string          `json:"tid"`
	Email       string          `json:"email"`
	Roles       []string        `json:"roles,omitempty"`
	Permissions []string        `json:"perms,omitempty"`
	Flags       map[string]bool `json:"flags,omitempty"`
	// Branches lists the branch ids this user may access. Empty means tenant-wide
	// (all branches). ActiveBranch is the branch the session is currently working
	// in; empty means the consolidated "all branches" view (tenant-wide users only).
	Branches     []string `json:"brs,omitempty"`
	ActiveBranch string   `json:"abr,omitempty"`
	Type         string   `json:"typ"`
}

// ErrInvalidToken is returned when an access token is missing/invalid/expired.
var ErrInvalidToken = errors.New("invalid token")

// TokenService issues and verifies access tokens and mints refresh tokens.
type TokenService struct {
	secret    []byte
	issuer    string
	accessTTL time.Duration
}

// NewTokenService constructs a TokenService.
func NewTokenService(secret []byte, issuer string, accessTTL time.Duration) *TokenService {
	return &TokenService{secret: secret, issuer: issuer, accessTTL: accessTTL}
}

// IssueAccess signs an access token for the user and returns it with its expiry.
// branches are the accessible branch ids (empty = tenant-wide); activeBranch is
// the branch the session is working in (empty = consolidated all-branches view).
func (ts *TokenService) IssueAccess(userID, tenantID uuid.UUID, email string, roles, permissions []string, flags map[string]bool, branches []string, activeBranch string) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(ts.accessTTL)
	claims := AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    ts.issuer,
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
			ID:        uuid.NewString(),
		},
		TenantID:     tenantID.String(),
		Email:        email,
		Roles:        roles,
		Permissions:  permissions,
		Flags:        flags,
		Branches:     branches,
		ActiveBranch: activeBranch,
		Type:         "access",
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(ts.secret)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, exp, nil
}

// mfaChallengeTTL bounds how long a partial (post-password, pre-MFA) login is valid.
const mfaChallengeTTL = 5 * time.Minute

// ParseAccess verifies signature, algorithm, issuer, and expiry.
func (ts *TokenService) ParseAccess(token string) (*AccessClaims, error) {
	return ts.parseTyped(token, "access")
}

// IssueMFAChallenge mints a short-lived token proving the password step
// succeeded; it is exchanged for real tokens by completing TOTP.
func (ts *TokenService) IssueMFAChallenge(userID, tenantID uuid.UUID, email string) (string, error) {
	now := time.Now()
	claims := AccessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    ts.issuer,
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(mfaChallengeTTL)),
			ID:        uuid.NewString(),
		},
		TenantID: tenantID.String(),
		Email:    email,
		Type:     "mfa",
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(ts.secret)
}

// ParseMFAChallenge verifies an MFA challenge token.
func (ts *TokenService) ParseMFAChallenge(token string) (*AccessClaims, error) {
	return ts.parseTyped(token, "mfa")
}

func (ts *TokenService) parseTyped(token, wantType string) (*AccessClaims, error) {
	claims := &AccessClaims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalidToken
		}
		return ts.secret, nil
	}, jwt.WithIssuer(ts.issuer), jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !parsed.Valid || claims.Type != wantType {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

// GenerateRefreshToken returns a cryptographically-random opaque token (the
// raw value is shown to the client once; only its hash is stored).
func GenerateRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// HashToken returns the SHA-256 hex digest of an opaque token for storage.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
