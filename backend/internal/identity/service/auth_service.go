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
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/identity"
	identitydb "github.com/reicb/clinicsaas/internal/identity/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/entitlements"
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

	tokens, roles, err := s.issueTokens(ctx, tenantID, user.ID, user.Email, in.UserAgent, in.IP, nil, nil)
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

	tokens, roles, err := s.issueTokens(ctx, tenantID, user.ID, user.Email, userAgent, ip, nil, nil)
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
		// A revoked token was presented. If it had already been rotated (a successor
		// session exists), this is genuine reuse — likely theft — so revoke the whole
		// family. If it was revoked intentionally (logout / sign-out-others / password
		// change) it has no successor, so just reject it and leave other sessions alive.
		var rotated bool
		sid := sess.ID
		_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
			var e error
			rotated, e = identitydb.New(tx).SessionRotated(ctx, identitydb.SessionRotatedParams{TenantID: tenantID, ID: &sid})
			return e
		})
		if rotated {
			_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
				return identitydb.New(tx).RevokeAllUserSessions(ctx, identitydb.RevokeAllUserSessionsParams{TenantID: tenantID, UserID: sess.UserID})
			})
			s.emit(ctx, tenantID, sess.UserID, "auth.user.refresh_reuse", nil)
			return nil, apperr.Unauthenticated("refresh token already used")
		}
		return nil, apperr.Unauthenticated("session ended")
	}
	if time.Now().After(sess.ExpiresAt) {
		return nil, apperr.Unauthenticated("refresh token expired")
	}

	// A suspended or deactivated account, or a suspended clinic, renews nothing,
	// whatever its session says (SEC-2, SEC-10): both status changes revoke
	// sessions too; this is the second lock.
	if err := s.CheckActive(ctx, tenantID, sess.UserID); err != nil {
		_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
			return identitydb.New(tx).RevokeAllUserSessions(ctx, identitydb.RevokeAllUserSessionsParams{TenantID: tenantID, UserID: sess.UserID})
		})
		return nil, err
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
	tokens, _, err := s.issueTokens(ctx, tenantID, sess.UserID, email, userAgent, ip, &oldID, sess.ActiveBranchID)
	if err != nil {
		return nil, err
	}
	s.emit(ctx, tenantID, sess.UserID, "auth.user.refreshed", nil)
	return tokens, nil
}

// CheckActive says whether this person, in this clinic, may act right now: the
// clinic is active (or still onboarding) and the account is active. It backs the
// per-request httpx.AccountGuard and the refresh path, so suspending a clinic or
// locking out a member of staff takes effect on their very next request.
func (s *AuthService) CheckActive(ctx context.Context, tenantID, userID uuid.UUID) error {
	var tenantStatus, userStatus string
	err := s.db.WithTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT t.status, u.status FROM users u JOIN tenants t ON t.id = u.tenant_id
			  WHERE u.tenant_id = $1 AND u.id = $2 AND u.deleted_at IS NULL AND t.deleted_at IS NULL`,
			tenantID, userID).Scan(&tenantStatus, &userStatus)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.Unauthenticated("account not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	if tenantStatus != "active" && tenantStatus != "onboarding" {
		return apperr.Forbidden("TENANT_INACTIVE", "this workspace is not active")
	}
	if userStatus != "active" {
		return apperr.Unauthenticated("account is not active")
	}
	return nil
}

// RevokeOtherSessions signs the user out of every device except the one holding
// currentRefresh (empty/invalid = sign out everywhere). Returns the count revoked.
// Backs the "sign out other devices" action and the auto-revoke on password change.
func (s *AuthService) RevokeOtherSessions(ctx context.Context, tenantID, userID uuid.UUID, currentRefresh string) (int64, error) {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	var keep *string
	if tid, opaque, err := splitRefresh(currentRefresh); err == nil && tid == tenantID {
		h := auth.HashToken(opaque)
		keep = &h
	}
	var n int64
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		n, e = identitydb.New(tx).RevokeOtherUserSessions(ctx, identitydb.RevokeOtherUserSessionsParams{TenantID: tenantID, UserID: userID, KeepHash: keep})
		return e
	}); err != nil {
		return 0, apperr.Internal(err)
	}
	if n > 0 {
		s.emit(ctx, tenantID, userID, "auth.user.sessions_revoked", map[string]any{"count": n})
	}
	return n, nil
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

// Me returns the authenticated principal's profile, roles, permissions, the
// branches they can access, the active branch, and the flags effective for it.
func (s *AuthService) Me(ctx context.Context, tenantID, userID uuid.UUID, activeBranch *uuid.UUID) (*identity.MeResult, error) {
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
		accessible, _, _, allBranches, e := resolveBranchState(ctx, q, tenantID, userID, nil)
		if e != nil {
			return e
		}
		// Honour the token's active branch only if it is still accessible;
		// otherwise fall back to the consolidated view / tenant defaults.
		effective := activeBranch
		if effective != nil {
			ok := false
			for _, b := range accessible {
				if b.ID == *effective {
					ok = true
					break
				}
			}
			if !ok {
				effective = nil
			}
		}
		fm, e := resolveFlags(ctx, tx, q, tenantID, effective)
		if e != nil {
			return e
		}
		branches := make([]identity.BranchRef, 0, len(accessible))
		for _, b := range accessible {
			branches = append(branches, identity.BranchRef{ID: b.ID, Name: b.Name, Code: b.Code})
		}
		res = identity.MeResult{
			User:           identity.UserProfile{ID: u.ID, TenantID: u.TenantID, Email: u.Email, FullName: u.FullName, Roles: roles},
			Permissions:    perms,
			Flags:          fm,
			Branches:       branches,
			ActiveBranchID: effective,
			AllBranches:    allBranches,
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
	// A reset must not sign anybody in. An invitation may — the account is new and
	// has no second factor yet — but a reset opens an account that might, and
	// issuing tokens straight from the link would walk past it.
	var isReset bool
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		inv, e := q.GetInvitationByToken(ctx, identitydb.GetInvitationByTokenParams{TenantID: tenantID, TokenHash: auth.HashToken(opaque)})
		if e != nil {
			return e
		}
		// Raw pgx: sqlc cannot be regenerated here, and the column is new.
		var purpose string
		if e := tx.QueryRow(ctx,
			`SELECT purpose FROM user_invitations WHERE tenant_id = $1 AND id = $2`,
			tenantID, inv.ID).Scan(&purpose); e != nil {
			return e
		}
		isReset = purpose == "reset"
		if inv.AcceptedAt != nil {
			return apperr.Conflict("INVITE_USED", "this invitation has already been used")
		}
		if time.Now().After(inv.ExpiresAt) {
			return apperr.Unauthenticated("invitation expired")
		}
		// A link may only do what it was issued for: an invitation completes an
		// invited account, a reset re-keys an active one (or re-sends a lapsed
		// invitation). Neither may switch a suspended or deactivated account back on
		// (SEC-2): reactivating is the owner's decision, made on the Staff page.
		var status string
		if e := tx.QueryRow(ctx,
			`SELECT status FROM users WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
			tenantID, inv.UserID).Scan(&status); e != nil {
			return e
		}
		if (isReset && status != "active" && status != "invited") || (!isReset && status != "invited") {
			return apperr.Forbidden("ACCOUNT_INACTIVE", "this account is not active; ask the clinic owner")
		}
		if e := checkUserLimit(ctx, tx, q, tenantID); e != nil {
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
	if isReset {
		// Every other device is signed out: a forgotten password is also how an
		// account gets taken, and the person who just proved they hold the link is
		// the one who should still be signed in — which here means nobody, until
		// they log in with the new password and pass their second factor.
		_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
			return identitydb.New(tx).RevokeAllUserSessions(ctx,
				identitydb.RevokeAllUserSessionsParams{TenantID: tenantID, UserID: userID})
		})
		s.syncLinkedPassword(ctx, tenantID, userID, hash)
		s.emit(ctx, tenantID, userID, "auth.user.password_reset", nil)
		return nil, identity.UserProfile{ID: userID, TenantID: tenantID, Email: email, FullName: fullName}, nil
	}
	tokens, roles, err := s.issueTokens(ctx, tenantID, userID, email, userAgent, ip, nil, nil)
	if err != nil {
		return nil, identity.UserProfile{}, err
	}
	s.emit(ctx, tenantID, userID, "auth.user.invite_accepted", nil)
	return tokens, identity.UserProfile{ID: userID, TenantID: tenantID, Email: email, FullName: fullName, Roles: roles}, nil
}

// ChangePassword lets the signed-in user set a new password after confirming
// their current one (self-service; no admin permission required).
func (s *AuthService) ChangePassword(ctx context.Context, tenantID, userID uuid.UUID, current, next string) error {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	if len(next) < 8 {
		return apperr.Validation("the new password must be at least 8 characters")
	}
	var newHash string
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		cred, e := q.GetUserCredentials(ctx, identitydb.GetUserCredentialsParams{TenantID: tenantID, ID: userID})
		if e != nil {
			return e
		}
		if cred.PasswordHash == nil {
			return apperr.Validation("no password is set for this account")
		}
		if ok, _ := auth.VerifyPassword(current, *cred.PasswordHash); !ok {
			return apperr.Forbidden("WRONG_PASSWORD", "the current password is incorrect")
		}
		hash, e := auth.HashPassword(next)
		if e != nil {
			return e
		}
		newHash = hash
		return q.UpdateUserPassword(ctx, identitydb.UpdateUserPasswordParams{TenantID: tenantID, ID: userID, PasswordHash: &hash})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.NotFound("USER_NOT_FOUND", "user not found")
		}
		if ae, ok := apperr.As(err); ok {
			return ae
		}
		return apperr.Internal(err)
	}
	// The same person in the clinic's other branches keeps the same password.
	s.syncLinkedPassword(ctx, tenantID, userID, newHash)
	s.emit(ctx, tenantID, userID, "auth.user.password_changed", nil)
	return nil
}

// ChangeEmail updates the signed-in user's login email after confirming the
// current password. The email is the login handle, so it must stay unique
// within the tenant.
func (s *AuthService) ChangeEmail(ctx context.Context, tenantID, userID uuid.UUID, newEmail, current string) error {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	email := strings.ToLower(strings.TrimSpace(newEmail))
	if email == "" {
		return apperr.Validation("enter a valid email address")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		cred, e := q.GetUserCredentials(ctx, identitydb.GetUserCredentialsParams{TenantID: tenantID, ID: userID})
		if e != nil {
			return e
		}
		if cred.PasswordHash == nil {
			return apperr.Validation("no password is set for this account")
		}
		if ok, _ := auth.VerifyPassword(current, *cred.PasswordHash); !ok {
			return apperr.Forbidden("WRONG_PASSWORD", "the current password is incorrect")
		}
		if e := q.UpdateUserEmail(ctx, identitydb.UpdateUserEmailParams{TenantID: tenantID, ID: userID, Email: email}); e != nil {
			var pgErr *pgconn.PgError
			if errors.As(e, &pgErr) && pgErr.Code == "23505" { // unique_violation
				return apperr.Conflict("EMAIL_TAKEN", "that email is already in use")
			}
			return e
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.NotFound("USER_NOT_FOUND", "user not found")
		}
		if ae, ok := apperr.As(err); ok {
			return ae
		}
		return apperr.Internal(err)
	}
	s.emit(ctx, tenantID, userID, "auth.user.email_changed", nil)
	return nil
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

// resolveFlags returns the effective feature flags for a branch: the tenant
// defaults with any per-branch overrides layered on top, and then what the plan
// actually entitles folded in. A nil branch (the consolidated "all branches"
// view) yields the tenant defaults.
//
// This is the only place the map is built — every RequireFlag gate, and the
// frontend's own nav filtering via /auth/me, reads what comes out of here. So
// connecting plans to features needed one change, not one per feature.
func resolveFlags(ctx context.Context, tx pgx.Tx, q *identitydb.Queries, tenantID uuid.UUID, active *uuid.UUID) (map[string]bool, error) {
	defaults, err := q.GetTenantFlags(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	flags := make(map[string]bool, len(defaults))
	for _, f := range defaults {
		flags[f.Flag] = f.Enabled
	}
	if active != nil {
		overrides, err := q.GetBranchFlagOverrides(ctx, identitydb.GetBranchFlagOverridesParams{TenantID: tenantID, BranchID: active})
		if err != nil {
			return nil, err
		}
		for _, f := range overrides {
			flags[f.Flag] = f.Enabled
		}
	}
	ent, err := entitlements.Effective(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	return entitlements.Apply(flags, ent), nil
}

// resolveBranchState loads the user's accessible branches (ordered, default
// first) and picks the active one. tokenBranchIDs is the raw-uuid list embedded
// in the access token — empty when the user is tenant-wide (all branches).
// preferred, when non-nil and accessible, is honoured; otherwise the default
// (first accessible) branch is chosen. active is nil only when no branch exists.
func resolveBranchState(ctx context.Context, q *identitydb.Queries, tenantID, userID uuid.UUID, preferred *uuid.UUID) (accessible []identitydb.ListActiveBranchesRow, tokenBranchIDs []string, active *uuid.UUID, allBranches bool, err error) {
	scopes, e := q.GetUserScopes(ctx, identitydb.GetUserScopesParams{TenantID: tenantID, UserID: userID})
	if e != nil {
		return nil, nil, nil, false, e
	}
	restricted := map[uuid.UUID]bool{}
	for _, sc := range scopes {
		if sc.BranchID == nil {
			allBranches = true
		} else {
			restricted[*sc.BranchID] = true
		}
	}
	all, e := q.ListActiveBranches(ctx, tenantID)
	if e != nil {
		return nil, nil, nil, false, e
	}
	for _, b := range all {
		if allBranches || restricted[b.ID] {
			accessible = append(accessible, b)
			if !allBranches {
				tokenBranchIDs = append(tokenBranchIDs, b.ID.String())
			}
		}
	}
	if preferred != nil {
		for _, b := range accessible {
			if b.ID == *preferred {
				bid := b.ID
				active = &bid
				break
			}
		}
	}
	if active == nil && len(accessible) > 0 {
		bid := accessible[0].ID
		active = &bid
	}
	return accessible, tokenBranchIDs, active, allBranches, nil
}

func (s *AuthService) issueTokens(ctx context.Context, tenantID, userID uuid.UUID, email, userAgent, ip string, rotatedFrom, preferredBranch *uuid.UUID) (*identity.TokenPair, []string, error) {
	var roles, perms, tokenBranchIDs []string
	var active *uuid.UUID
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
		if _, tokenBranchIDs, active, _, e = resolveBranchState(ctx, q, tenantID, userID, preferredBranch); e != nil {
			return e
		}
		flags, e = resolveFlags(ctx, tx, q, tenantID, active)
		return e
	}); err != nil {
		return nil, nil, apperr.Internal(err)
	}

	activeStr := ""
	if active != nil {
		activeStr = active.String()
	}
	access, exp, err := s.tokens.IssueAccess(userID, tenantID, email, roles, perms, flags, tokenBranchIDs, activeStr)
	if err != nil {
		return nil, nil, apperr.Internal(err)
	}
	opaque, err := auth.GenerateRefreshToken()
	if err != nil {
		return nil, nil, apperr.Internal(err)
	}
	refreshExp := time.Now().Add(s.cfg.RefreshTTL)
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		sid, e := identitydb.New(tx).CreateSession(ctx, identitydb.CreateSessionParams{
			TenantID:         tenantID,
			UserID:           userID,
			RefreshTokenHash: auth.HashToken(opaque),
			UserAgent:        ptr(userAgent),
			Ip:               ptr(ip),
			ExpiresAt:        refreshExp,
			RotatedFrom:      rotatedFrom,
			ActiveBranchID:   active,
		})
		if e != nil {
			return e
		}
		// The device's own facts: where the request came from, and — on a renewal —
		// the original sign-in time and the name the user gave it.
		if _, e := tx.Exec(ctx, `UPDATE sessions SET country = nullif($3, '') WHERE tenant_id = $1 AND id = $2`, tenantID, sid, identity.ClientCountry(ctx)); e != nil {
			return e
		}
		if rotatedFrom != nil {
			_, e = tx.Exec(ctx,
				`UPDATE sessions n SET started_at = o.started_at, label = o.label
				   FROM sessions o WHERE n.tenant_id = $1 AND n.id = $2 AND o.tenant_id = $1 AND o.id = $3`,
				tenantID, sid, *rotatedFrom)
		}
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

// SwitchBranch re-issues an access token scoped to a different branch (or the
// consolidated "all branches" view when target is nil, for tenant-wide users).
// It validates the target against the user's scopes and remembers the choice on
// the session so a later silent refresh lands on the same branch.
func (s *AuthService) SwitchBranch(ctx context.Context, tenantID, userID uuid.UUID, target *uuid.UUID, refreshToken string) (*identity.SwitchResult, error) {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	var email string
	var roles, perms, tokenBranchIDs []string
	var active *uuid.UUID
	flags := map[string]bool{}
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		u, e := q.GetUserByID(ctx, identitydb.GetUserByIDParams{TenantID: tenantID, ID: userID})
		if e != nil {
			return e
		}
		email = u.Email
		if roles, e = q.GetUserRoleCodes(ctx, identitydb.GetUserRoleCodesParams{TenantID: tenantID, UserID: userID}); e != nil {
			return e
		}
		if perms, e = q.GetUserPermissionCodes(ctx, identitydb.GetUserPermissionCodesParams{TenantID: tenantID, UserID: userID}); e != nil {
			return e
		}
		accessible, tbids, _, allBranches, e := resolveBranchState(ctx, q, tenantID, userID, nil)
		if e != nil {
			return e
		}
		tokenBranchIDs = tbids
		if target == nil {
			if !allBranches {
				return apperr.Forbidden("BRANCH_DENIED", "only clinic-wide roles can view all branches")
			}
			active = nil // consolidated view
		} else {
			ok := false
			for _, b := range accessible {
				if b.ID == *target {
					ok = true
					break
				}
			}
			if !ok {
				return apperr.Forbidden("BRANCH_DENIED", "you don't have access to that branch")
			}
			active = target
		}
		flags, e = resolveFlags(ctx, tx, q, tenantID, active)
		return e
	}); err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		return nil, apperr.Internal(err)
	}

	activeStr := ""
	if active != nil {
		activeStr = active.String()
	}
	access, exp, err := s.tokens.IssueAccess(userID, tenantID, email, roles, perms, flags, tokenBranchIDs, activeStr)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	// Remember a concrete branch on the session so silent refresh stays put.
	// The "all branches" view is transient and is not persisted.
	if active != nil && refreshToken != "" {
		if tid, opaque, e := splitRefresh(refreshToken); e == nil && tid == tenantID {
			_ = s.db.WithTx(ctx, func(tx pgx.Tx) error {
				q := identitydb.New(tx)
				sess, e := q.GetSessionByHash(ctx, identitydb.GetSessionByHashParams{TenantID: tenantID, RefreshTokenHash: auth.HashToken(opaque)})
				if e != nil {
					return nil
				}
				return q.SetSessionActiveBranch(ctx, identitydb.SetSessionActiveBranchParams{TenantID: tenantID, ID: sess.ID, ActiveBranchID: active})
			})
		}
	}
	s.emit(ctx, tenantID, userID, "auth.user.switched_branch", map[string]any{"branch": activeStr})
	return &identity.SwitchResult{AccessToken: access, AccessExpiresAt: exp}, nil
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

// ListSessions lists the user's live devices.
func (s *AuthService) ListSessions(ctx context.Context, tenantID, userID uuid.UUID, currentRefresh string) ([]identity.Device, error) {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	cur := currentHash(tenantID, currentRefresh)
	var out []identity.Device
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT id, coalesce(user_agent,''), coalesce(ip,''), coalesce(country,''), coalesce(label,''),
			        started_at, created_at, expires_at, refresh_token_hash
			   FROM sessions
			  WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
			  ORDER BY created_at DESC`, tenantID, userID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var d identity.Device
			var hash string
			if e := rows.Scan(&d.ID, &d.UserAgent, &d.IP, &d.Country, &d.Label, &d.StartedAt, &d.LastActive, &d.ExpiresAt, &hash); e != nil {
				return e
			}
			d.Current = cur != "" && hash == cur
			out = append(out, d)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// currentHash is the stored hash of the presented refresh token ("" if unusable).
func currentHash(tenantID uuid.UUID, currentRefresh string) string {
	if tid, opaque, err := splitRefresh(currentRefresh); err == nil && tid == tenantID {
		return auth.HashToken(opaque)
	}
	return ""
}

// RevokeSession signs one of the user's OTHER devices out.
func (s *AuthService) RevokeSession(ctx context.Context, tenantID, userID, sessionID uuid.UUID, currentRefresh string) error {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	cur := currentHash(tenantID, currentRefresh)
	var n int64
	var isCurrent bool
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var hash string
		e := tx.QueryRow(ctx, `SELECT refresh_token_hash FROM sessions WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND revoked_at IS NULL`,
			tenantID, userID, sessionID).Scan(&hash)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e != nil {
			return e
		}
		if cur != "" && hash == cur {
			isCurrent = true
			return nil
		}
		tag, e := tx.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND revoked_at IS NULL`, tenantID, userID, sessionID)
		n = tag.RowsAffected()
		return e
	})
	if err != nil {
		return apperr.Internal(err)
	}
	if isCurrent {
		return apperr.Validation("that is this device — use Sign out in the menu")
	}
	if n == 0 {
		return apperr.NotFound("device", "that device is no longer signed in")
	}
	s.emit(ctx, tenantID, userID, "auth.user.session_revoked", map[string]any{"session_id": sessionID})
	return nil
}

// LabelSession names (or unnames) one of the user's devices.
func (s *AuthService) LabelSession(ctx context.Context, tenantID, userID, sessionID uuid.UUID, label string) error {
	ctx = tenancy.WithTenantID(ctx, tenantID)
	label = strings.TrimSpace(label)
	if len([]rune(label)) > 60 {
		return apperr.Validation("a device name is at most 60 characters")
	}
	var n int64
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE sessions SET label = nullif($4, '') WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND revoked_at IS NULL`, tenantID, userID, sessionID, label)
		n = tag.RowsAffected()
		return e
	})
	if err != nil {
		return apperr.Internal(err)
	}
	if n == 0 {
		return apperr.NotFound("device", "that device is no longer signed in")
	}
	return nil
}
