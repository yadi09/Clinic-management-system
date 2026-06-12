// Package service implements the identity module use-cases (authentication,
// session lifecycle). All tenant-scoped data access runs through
// kernel/db.WithTx so the RLS GUC is set; the tenant id is resolved from the
// workspace/credentials, never trusted from the client.
package service

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/identity"
	identitydb "github.com/reicb/clinicsaas/internal/identity/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// AuthConfig holds the auth-related knobs from application config.
type AuthConfig struct {
	AccessTTL       time.Duration
	RefreshTTL      time.Duration
	MaxFailedLogins int
	LockoutDuration time.Duration
	MFAEncKey       []byte
	Issuer          string
}

// AuthService implements identity.Service.
type AuthService struct {
	db        *kerneldb.DB
	tokens    *auth.TokenService
	publisher events.Publisher
	cfg       AuthConfig
}

var _ identity.Service = (*AuthService)(nil)

// NewAuthService constructs an AuthService.
func NewAuthService(db *kerneldb.DB, tokens *auth.TokenService, publisher events.Publisher, cfg AuthConfig) *AuthService {
	return &AuthService{db: db, tokens: tokens, publisher: publisher, cfg: cfg}
}

// Login authenticates by workspace + email + password, returning either an MFA
// challenge or an issued token pair (FR-AUTH-01/03/04).
func (s *AuthService) Login(ctx context.Context, in identity.LoginInput) (*identity.LoginResult, error) {
	email := strings.ToLower(strings.TrimSpace(in.Email))
	workspace := strings.ToLower(strings.TrimSpace(in.Workspace))

	// 1. Resolve tenant from workspace slug (registry table, no RLS).
	var tenant identitydb.GetTenantBySlugRow
	if err := s.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var e error
		tenant, e = identitydb.New(tx).GetTenantBySlug(ctx, workspace)
		return e
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.Unauthenticated("invalid credentials")
		}
		return nil, apperr.Internal(err)
	}
	if tenant.Status != "active" && tenant.Status != "onboarding" {
		return nil, apperr.Forbidden("TENANT_INACTIVE", "this workspace is not active")
	}
	tenantID := tenant.ID
	ctx = tenancy.WithTenantID(ctx, tenantID)

	// 2. Load the user within tenant scope (RLS enforced).
	user, err := s.userByEmail(ctx, tenantID, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.Unauthenticated("invalid credentials")
		}
		return nil, apperr.Internal(err)
	}

	// 3. Lockout (FR-AUTH-04).
	if user.LockedUntil != nil && time.Now().Before(*user.LockedUntil) {
		s.emit(ctx, tenantID, user.ID, "auth.user.login_blocked", map[string]any{"reason": "locked"})
		return nil, apperr.New(401, "ACCOUNT_LOCKED", "account temporarily locked after failed attempts")
	}

	// 4. Verify password (constant time).
	if user.PasswordHash == nil {
		return nil, apperr.Unauthenticated("invalid credentials")
	}
	ok, _ := auth.VerifyPassword(in.Password, *user.PasswordHash)
	if !ok {
		s.handleFailedLogin(ctx, tenantID, user.ID)
		return nil, apperr.Unauthenticated("invalid credentials")
	}
	if user.Status != "active" {
		return nil, apperr.Forbidden("ACCOUNT_INACTIVE", "account is not active")
	}
	s.clearFailures(ctx, tenantID, user.ID)

	profile := identity.UserProfile{ID: user.ID, TenantID: tenantID, Email: user.Email, FullName: user.FullName}

	// 5. MFA gate (FR-AUTH-03).
	if user.MfaEnabled && user.MfaSecret != nil {
		challenge, err := s.tokens.IssueMFAChallenge(user.ID, tenantID, user.Email)
		if err != nil {
			return nil, apperr.Internal(err)
		}
		s.emit(ctx, tenantID, user.ID, "auth.user.mfa_challenged", nil)
		return &identity.LoginResult{MFARequired: true, MFAChallenge: challenge, User: profile}, nil
	}

	tokens, roles, err := s.issueTokens(ctx, tenantID, user.ID, user.Email, in.UserAgent, in.IP, nil)
	if err != nil {
		return nil, err
	}
	profile.Roles = roles
	s.emit(ctx, tenantID, user.ID, "auth.user.logged_in", map[string]any{"ip": in.IP})
	return &identity.LoginResult{Tokens: tokens, User: profile}, nil
}

// VerifyMFA exchanges an MFA challenge + TOTP code for tokens (FR-AUTH-03).
func (s *AuthService) VerifyMFA(ctx context.Context, challengeToken, code, userAgent, ip string) (*identity.TokenPair, identity.UserProfile, error) {
	claims, err := s.tokens.ParseMFAChallenge(challengeToken)
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Unauthenticated("invalid or expired challenge")
	}
	tenantID, err := uuid.Parse(claims.TenantID)
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Unauthenticated("malformed challenge")
	}
	ctx = tenancy.WithTenantID(ctx, tenantID)

	user, err := s.userByEmail(ctx, tenantID, claims.Email)
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Unauthenticated("invalid credentials")
	}
	if !user.MfaEnabled || user.MfaSecret == nil {
		return nil, identity.UserProfile{}, apperr.Unauthenticated("mfa not enabled")
	}
	secret, err := auth.DecryptSecret(s.cfg.MFAEncKey, *user.MfaSecret)
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Internal(err)
	}
	if !auth.ValidateTOTP(secret, strings.TrimSpace(code)) {
		s.emit(ctx, tenantID, user.ID, "auth.user.mfa_failed", nil)
		return nil, identity.UserProfile{}, apperr.Unauthenticated("invalid code")
	}

	tokens, roles, err := s.issueTokens(ctx, tenantID, user.ID, user.Email, userAgent, ip, nil)
	if err != nil {
		return nil, identity.UserProfile{}, err
	}
	s.emit(ctx, tenantID, user.ID, "auth.user.logged_in", map[string]any{"mfa": true})
	return tokens, identity.UserProfile{ID: user.ID, TenantID: tenantID, Email: user.Email, FullName: user.FullName, Roles: roles}, nil
}

// Refresh rotates a refresh token: the presented session is revoked and a new
// one issued (FR-AUTH-02). Reuse of an already-rotated token revokes the family.
func (s *AuthService) Refresh(ctx context.Context, refreshToken, userAgent, ip string) (*identity.TokenPair, error) {
	tenantID, opaque, err := splitRefresh(refreshToken)
	if err != nil {
		return nil, apperr.Unauthenticated("invalid refresh token")
	}
	ctx = tenancy.WithTenantID(ctx, tenantID)
	hash := auth.HashToken(opaque)

	var sess identitydb.GetSessionByHashRow
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		sess, e = identitydb.New(tx).GetSessionByHash(ctx, identitydb.GetSessionByHashParams{TenantID: tenantID, RefreshTokenHash: hash})
		return e
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.Unauthenticated("invalid refresh token")
		}
		return nil, apperr.Internal(err)
	}
	if sess.RevokedAt != nil {
		// Token reuse: revoke the whole family as a precaution.
		_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
			return identitydb.New(tx).RevokeAllUserSessions(ctx, identitydb.RevokeAllUserSessionsParams{TenantID: tenantID, UserID: sess.UserID})
		})
		s.emit(ctx, tenantID, sess.UserID, "auth.user.refresh_reuse", nil)
		return nil, apperr.Unauthenticated("refresh token already used")
	}
	if time.Now().After(sess.ExpiresAt) {
		return nil, apperr.Unauthenticated("refresh token expired")
	}

	var email string
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		u, e := identitydb.New(tx).GetUserByID(ctx, identitydb.GetUserByIDParams{TenantID: tenantID, ID: sess.UserID})
		if e == nil {
			email = u.Email
		}
		return e
	}); err != nil {
		return nil, apperr.Unauthenticated("invalid refresh token")
	}

	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return identitydb.New(tx).RevokeSession(ctx, identitydb.RevokeSessionParams{TenantID: tenantID, ID: sess.ID})
	}); err != nil {
		return nil, apperr.Internal(err)
	}

	oldID := sess.ID
	tokens, _, err := s.issueTokens(ctx, tenantID, sess.UserID, email, userAgent, ip, &oldID)
	if err != nil {
		return nil, err
	}
	s.emit(ctx, tenantID, sess.UserID, "auth.user.refreshed", nil)
	return tokens, nil
}

// Logout revokes the session backing the presented refresh token (idempotent).
func (s *AuthService) Logout(ctx context.Context, refreshToken string) error {
	tenantID, opaque, err := splitRefresh(refreshToken)
	if err != nil {
		return nil // nothing to revoke
	}
	ctx = tenancy.WithTenantID(ctx, tenantID)
	hash := auth.HashToken(opaque)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		sess, e := q.GetSessionByHash(ctx, identitydb.GetSessionByHashParams{TenantID: tenantID, RefreshTokenHash: hash})
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return nil
			}
			return e
		}
		if err := q.RevokeSession(ctx, identitydb.RevokeSessionParams{TenantID: tenantID, ID: sess.ID}); err != nil {
			return err
		}
		return s.publisher.Publish(ctx, tx, &tenantID, "user", sess.UserID, "auth.user.logged_out", nil)
	})
}

// Me returns the authenticated principal's profile, roles, permissions, flags.
func (s *AuthService) Me(ctx context.Context, tenantID, userID uuid.UUID) (*identity.MeResult, error) {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	var res identity.MeResult
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		u, e := q.GetUserByID(ctx, identitydb.GetUserByIDParams{TenantID: tenantID, ID: userID})
		if e != nil {
			return e
		}
		roles, e := q.GetUserRoleCodes(ctx, identitydb.GetUserRoleCodesParams{TenantID: tenantID, UserID: userID})
		if e != nil {
			return e
		}
		perms, e := q.GetUserPermissionCodes(ctx, identitydb.GetUserPermissionCodesParams{TenantID: tenantID, UserID: userID})
		if e != nil {
			return e
		}
		flags, e := q.GetTenantFlags(ctx, tenantID)
		if e != nil {
			return e
		}
		fm := make(map[string]bool, len(flags))
		for _, f := range flags {
			fm[f.Flag] = f.Enabled
		}
		res = identity.MeResult{
			User:        identity.UserProfile{ID: u.ID, TenantID: u.TenantID, Email: u.Email, FullName: u.FullName, Roles: roles},
			Permissions: perms,
			Flags:       fm,
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("USER_NOT_FOUND", "user not found")
		}
		return nil, apperr.Internal(err)
	}
	return &res, nil
}

// AcceptInvite completes a staff invitation: it sets the password, activates the
// account (subject to the plan's active-user limit), and signs the user in
// (FR-USR-01/03).
func (s *AuthService) AcceptInvite(ctx context.Context, token, password, userAgent, ip string) (*identity.TokenPair, identity.UserProfile, error) {
	tenantID, opaque, err := splitRefresh(token)
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Unauthenticated("invalid invitation")
	}
	ctx = tenancy.WithTenantID(ctx, tenantID)
	if len(password) < 8 {
		return nil, identity.UserProfile{}, apperr.Validation("password must be at least 8 characters")
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Internal(err)
	}

	var userID uuid.UUID
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		inv, e := q.GetInvitationByToken(ctx, identitydb.GetInvitationByTokenParams{TenantID: tenantID, TokenHash: auth.HashToken(opaque)})
		if e != nil {
			return e
		}
		if inv.AcceptedAt != nil {
			return apperr.Conflict("INVITE_USED", "this invitation has already been used")
		}
		if time.Now().After(inv.ExpiresAt) {
			return apperr.Unauthenticated("invitation expired")
		}
		if e := checkUserLimit(ctx, q, tenantID); e != nil {
			return e
		}
		userID = inv.UserID
		if e := q.SetPasswordAndActivate(ctx, identitydb.SetPasswordAndActivateParams{TenantID: tenantID, ID: userID, PasswordHash: &hash}); e != nil {
			return e
		}
		return q.MarkInvitationAccepted(ctx, identitydb.MarkInvitationAcceptedParams{TenantID: tenantID, ID: inv.ID})
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, identity.UserProfile{}, apperr.Unauthenticated("invalid invitation")
		}
		if ae, ok := apperr.As(err); ok {
			return nil, identity.UserProfile{}, ae
		}
		return nil, identity.UserProfile{}, apperr.Internal(err)
	}

	var email, fullName string
	_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		u, e := identitydb.New(tx).GetUserByID(ctx, identitydb.GetUserByIDParams{TenantID: tenantID, ID: userID})
		if e == nil {
			email, fullName = u.Email, u.FullName
		}
		return e
	})
	tokens, roles, err := s.issueTokens(ctx, tenantID, userID, email, userAgent, ip, nil)
	if err != nil {
		return nil, identity.UserProfile{}, err
	}
	s.emit(ctx, tenantID, userID, "auth.user.invite_accepted", nil)
	return tokens, identity.UserProfile{ID: userID, TenantID: tenantID, Email: email, FullName: fullName, Roles: roles}, nil
}

// --- helpers ---

func (s *AuthService) userByEmail(ctx context.Context, tenantID uuid.UUID, email string) (identitydb.GetUserByEmailRow, error) {
	var user identitydb.GetUserByEmailRow
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		user, e = identitydb.New(tx).GetUserByEmail(ctx, identitydb.GetUserByEmailParams{TenantID: tenantID, Email: email})
		return e
	})
	return user, err
}

func (s *AuthService) handleFailedLogin(ctx context.Context, tenantID, userID uuid.UUID) {
	_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		n, err := q.IncrementFailedLogin(ctx, identitydb.IncrementFailedLoginParams{TenantID: tenantID, ID: userID})
		if err != nil {
			return err
		}
		if int(n) >= s.cfg.MaxFailedLogins {
			until := time.Now().Add(s.cfg.LockoutDuration)
			return q.LockUser(ctx, identitydb.LockUserParams{TenantID: tenantID, ID: userID, LockedUntil: &until})
		}
		return nil
	})
	s.emit(ctx, tenantID, userID, "auth.user.login_failed", nil)
}

func (s *AuthService) clearFailures(ctx context.Context, tenantID, userID uuid.UUID) {
	_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return identitydb.New(tx).ClearLoginFailures(ctx, identitydb.ClearLoginFailuresParams{TenantID: tenantID, ID: userID})
	})
}

func (s *AuthService) issueTokens(ctx context.Context, tenantID, userID uuid.UUID, email, userAgent, ip string, rotatedFrom *uuid.UUID) (*identity.TokenPair, []string, error) {
	var roles, perms []string
	flags := map[string]bool{}
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		var e error
		if roles, e = q.GetUserRoleCodes(ctx, identitydb.GetUserRoleCodesParams{TenantID: tenantID, UserID: userID}); e != nil {
			return e
		}
		if perms, e = q.GetUserPermissionCodes(ctx, identitydb.GetUserPermissionCodesParams{TenantID: tenantID, UserID: userID}); e != nil {
			return e
		}
		fl, e := q.GetTenantFlags(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, f := range fl {
			flags[f.Flag] = f.Enabled
		}
		return nil
	}); err != nil {
		return nil, nil, apperr.Internal(err)
	}

	access, exp, err := s.tokens.IssueAccess(userID, tenantID, email, roles, perms, flags)
	if err != nil {
		return nil, nil, apperr.Internal(err)
	}
	opaque, err := auth.GenerateRefreshToken()
	if err != nil {
		return nil, nil, apperr.Internal(err)
	}
	refreshExp := time.Now().Add(s.cfg.RefreshTTL)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := identitydb.New(tx).CreateSession(ctx, identitydb.CreateSessionParams{
			TenantID:         tenantID,
			UserID:           userID,
			RefreshTokenHash: auth.HashToken(opaque),
			UserAgent:        ptr(userAgent),
			Ip:               ptr(ip),
			ExpiresAt:        refreshExp,
			RotatedFrom:      rotatedFrom,
		})
		return e
	}); err != nil {
		return nil, nil, apperr.Internal(err)
	}

	composite := id.Encode(id.PrefixTenant, tenantID) + "." + opaque
	return &identity.TokenPair{
		AccessToken:      access,
		AccessExpiresAt:  exp,
		RefreshToken:     composite,
		RefreshExpiresAt: refreshExp,
	}, roles, nil
}

func (s *AuthService) emit(ctx context.Context, tenantID, userID uuid.UUID, eventType string, payload any) {
	if err := s.db.WithTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		return s.publisher.Publish(ctx, tx, &tenantID, "user", userID, eventType, payload)
	}); err != nil {
		slog.Warn("audit event publish failed", "event", eventType, "err", err)
	}
}

func splitRefresh(composite string) (uuid.UUID, string, error) {
	i := strings.IndexByte(composite, '.')
	if i <= 0 || i >= len(composite)-1 {
		return uuid.Nil, "", errors.New("malformed refresh token")
	}
	tenantID, err := id.Decode(id.PrefixTenant, composite[:i])
	if err != nil {
		return uuid.Nil, "", err
	}
	return tenantID, composite[i+1:], nil
}

func ptr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
