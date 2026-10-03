package service

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/identity"
	identitydb "github.com/reicb/clinicsaas/internal/identity/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/kernel/notify"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// UserConfig holds knobs for staff management.
type UserConfig struct {
	AppBaseURL string
	InviteTTL  time.Duration
}

// UserService implements identity.UserAdmin (staff invitation + management).
type UserService struct {
	db       *kerneldb.DB
	notifier notify.Provider
	cfg      UserConfig
}

var _ identity.UserAdmin = (*UserService)(nil)

// NewUserService constructs a UserService.
func NewUserService(db *kerneldb.DB, notifier notify.Provider, cfg UserConfig) *UserService {
	return &UserService{db: db, notifier: notifier, cfg: cfg}
}

// InviteUser creates an invited staff account, assigns roles, and issues a
// time-limited invitation link (FR-USR-01). The link is returned for the admin
// to share until an email provider is configured.
func (s *UserService) InviteUser(ctx context.Context, in identity.InviteInput) (*identity.InviteResult, error) {
	tenantID, actorID := userActor(ctx)
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if email == "" || !strings.Contains(email, "@") {
		return nil, apperr.Validation("a valid email is required").WithField("email", "invalid")
	}
	if strings.TrimSpace(in.FullName) == "" {
		return nil, apperr.Validation("full name is required")
	}
	// A number that cannot be dialled is worse than none: it looks like a way to
	// reach this person. Anything kernel/phone can read is accepted, including a
	// foreign or Safaricom number the SMS gateway will not carry — the record is
	// still correct, and the UI is where "we can't text this one" belongs.
	tel, ok := phone.Normalise(in.Phone)
	if !ok {
		return nil, apperr.Validation("that phone number doesn't look right").WithField("phone", "invalid")
	}

	var userID uuid.UUID
	var composite string
	if err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		if e := checkUserLimit(ctx, tx, q, tenantID); e != nil {
			return e
		}
		uid, e := q.CreateInvitedUser(ctx, identitydb.CreateInvitedUserParams{TenantID: tenantID, Email: email, FullName: in.FullName, CreatedBy: actorID})
		if e != nil {
			return e
		}
		userID = uid
		// users.phone arrived in 00076 and sqlc is not available here, so the
		// generated insert does not carry it — set it in the same transaction.
		if tel != "" {
			if _, e := tx.Exec(ctx, `UPDATE users SET phone = $3 WHERE tenant_id = $1 AND id = $2`, tenantID, uid, tel); e != nil {
				return e
			}
		}
		if e := assignRoleScopes(ctx, q, tenantID, uid, in.RoleCodes, in.BranchIDs); e != nil {
			return e
		}
		opaque, e := auth.GenerateRefreshToken()
		if e != nil {
			return e
		}
		composite = id.Encode(id.PrefixTenant, tenantID) + "." + opaque
		_, e = q.CreateInvitation(ctx, identitydb.CreateInvitationParams{
			TenantID: tenantID, UserID: uid, TokenHash: auth.HashToken(opaque),
			ExpiresAt: time.Now().Add(s.cfg.InviteTTL), CreatedBy: actorID,
		})
		return e
	}); err != nil {
		if ae, ok := apperr.As(err); ok {
			return nil, ae
		}
		if isUnique(err) {
			return nil, apperr.Conflict("USER_EMAIL_TAKEN", "a user with this email already exists")
		}
		return nil, apperr.Internal(err)
	}

	link := strings.TrimRight(s.cfg.AppBaseURL, "/") + "/accept-invite?token=" + composite
	_ = s.notifier.Send(ctx, notify.Message{Channel: notify.ChannelEmail, To: email, Template: "user.invite", Vars: map[string]any{"link": link}})
	return &identity.InviteResult{UserID: userID, Email: email, InviteLink: link}, nil
}

// ListUsers returns staff accounts with their roles.
func (s *UserService) ListUsers(ctx context.Context) ([]identity.UserListItem, error) {
	tenantID, _ := userActor(ctx)
	var out []identity.UserListItem
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		// Raw rather than the generated ListUsers because that one predates
		// users.phone (00076) and sqlc is not available here to regenerate it.
		// Otherwise identical: one row per staff member with their role codes.
		rows, e := tx.Query(ctx, `
			SELECT u.id, u.email, u.full_name, coalesce(u.phone, ''), u.status,
			       u.last_login_at, u.created_at,
			       coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}')::text[] AS roles
			  FROM users u
			  LEFT JOIN user_role_scopes urs ON urs.user_id = u.id AND urs.tenant_id = u.tenant_id
			  LEFT JOIN roles r ON r.id = urs.role_id AND r.tenant_id = u.tenant_id
			 WHERE u.tenant_id = $1 AND u.deleted_at IS NULL
			 GROUP BY u.id
			 ORDER BY u.created_at DESC`, tenantID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var it identity.UserListItem
			if e := rows.Scan(&it.ID, &it.Email, &it.FullName, &it.Phone, &it.Status, &it.LastLoginAt, &it.CreatedAt, &it.Roles); e != nil {
				return e
			}
			out = append(out, it)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// ListProviders returns active consulting clinicians (hold encounter.manage) for
// the triage/reception assign pickers — usable without full user.read.
func (s *UserService) ListProviders(ctx context.Context) ([]identity.Provider, error) {
	tenantID, _ := userActor(ctx)
	out := []identity.Provider{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := identitydb.New(tx).ListProviders(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, identity.Provider{ID: r.ID, FullName: r.FullName})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// UpdateUserStatus changes a user's lifecycle state (FR-USR-02); activation is
// subject to the plan's active-user limit.
func (s *UserService) UpdateUserStatus(ctx context.Context, userID uuid.UUID, status string) error {
	tenantID, _ := userActor(ctx)
	if status != "active" && status != "suspended" && status != "deactivated" {
		return apperr.Validation("status must be active, suspended, or deactivated")
	}
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		if status == "active" {
			if e := checkUserLimit(ctx, tx, q, tenantID); e != nil {
				return e
			}
		}
		e := q.UpdateUserStatus(ctx, identitydb.UpdateUserStatusParams{TenantID: tenantID, ID: userID, Status: status})
		if e != nil || status == "active" {
			return e
		}
		// Locked out means locked out now (SEC-2): every device they are signed in on
		// is signed out, and any invite or reset link they still hold stops working,
		// so neither a phone left signed in nor an old link brings them back. One
		// statement, in the same transaction as the status change.
		_, e = tx.Exec(ctx,
			`WITH ended AS (
			   UPDATE sessions SET revoked_at = now()
			    WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL)
			 UPDATE user_invitations SET expires_at = now()
			  WHERE tenant_id = $1 AND user_id = $2 AND accepted_at IS NULL AND expires_at > now()`,
			tenantID, userID)
		return e
	})
}

// UpdateUserProfile corrects the details an admin maintains for a staff member:
// the display name (e.g. a typo at invite) and the phone number to reach them on.
func (s *UserService) UpdateUserProfile(ctx context.Context, userID uuid.UUID, fullName string, tel *string) error {
	tenantID, _ := userActor(ctx)
	name := strings.TrimSpace(fullName)
	if name == "" {
		return apperr.Validation("a name is required")
	}
	// nil means the caller is not touching the number; "" means clear it. Both
	// have to be expressible, or an older client that sends only a name would
	// silently wipe a phone somebody typed in.
	var stored *string
	if tel != nil {
		norm, ok := phone.Normalise(*tel)
		if !ok {
			return apperr.Validation("that phone number doesn't look right").WithField("phone", "invalid")
		}
		stored = &norm
		if norm == "" {
			stored = nil
		}
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE users SET full_name = $3,
			        phone = CASE WHEN $5::bool THEN $4 ELSE phone END,
			        updated_at = now()
			  WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
			tenantID, userID, name, stored, tel != nil)
		if e != nil {
			return e
		}
		if ct.RowsAffected() == 0 {
			return apperr.NotFound("USER_NOT_FOUND", "staff member not found")
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

// DeleteUser soft-deletes a staff member and revokes their sessions. The caller
// cannot delete their own account.
func (s *UserService) DeleteUser(ctx context.Context, userID uuid.UUID) error {
	tenantID, actorID := userActor(ctx)
	if actorID != nil && *actorID == userID {
		return apperr.Validation("you can't delete your own account")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		if e := q.SoftDeleteUser(ctx, identitydb.SoftDeleteUserParams{TenantID: tenantID, ID: userID}); e != nil {
			return e
		}
		return q.RevokeAllUserSessions(ctx, identitydb.RevokeAllUserSessionsParams{TenantID: tenantID, UserID: userID})
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// AssignRoles replaces a user's role assignments, scoped to branchIDs (empty =
// tenant-wide / all branches).
func (s *UserService) AssignRoles(ctx context.Context, userID uuid.UUID, roleCodes []string, branchIDs []uuid.UUID) error {
	tenantID, _ := userActor(ctx)
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		q := identitydb.New(tx)
		if e := q.ClearUserRoles(ctx, identitydb.ClearUserRolesParams{TenantID: tenantID, UserID: userID}); e != nil {
			return e
		}
		return assignRoleScopes(ctx, q, tenantID, userID, roleCodes, branchIDs)
	})
}

// assignRoleScopes assigns each role to the user, scoped to each branch in
// branchIDs (or tenant-wide when branchIDs is empty). Shared by invite + edit.
func assignRoleScopes(ctx context.Context, q *identitydb.Queries, tenantID, userID uuid.UUID, roleCodes []string, branchIDs []uuid.UUID) error {
	for _, code := range roleCodes {
		rid, e := q.GetRoleByCode(ctx, identitydb.GetRoleByCodeParams{TenantID: tenantID, Code: code})
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.Validation("unknown role: " + code)
			}
			return e
		}
		if len(branchIDs) == 0 {
			if e := q.AssignUserRole(ctx, identitydb.AssignUserRoleParams{TenantID: tenantID, UserID: userID, RoleID: rid, BranchID: nil}); e != nil {
				return e
			}
			continue
		}
		for i := range branchIDs {
			b := branchIDs[i]
			if e := q.AssignUserRole(ctx, identitydb.AssignUserRoleParams{TenantID: tenantID, UserID: userID, RoleID: rid, BranchID: &b}); e != nil {
				return e
			}
		}
	}
	return nil
}

// ListRoles returns the tenant's assignable roles.
func (s *UserService) ListRoles(ctx context.Context) ([]identity.RoleItem, error) {
	tenantID, _ := userActor(ctx)
	var out []identity.RoleItem
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := identitydb.New(tx).ListRoles(ctx, tenantID)
		if e != nil {
			return e
		}
		for _, r := range rows {
			out = append(out, identity.RoleItem{ID: r.ID, Code: r.Code, Name: r.Name, IsSystem: r.IsSystem})
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// --- shared helpers (package service) ---

// checkUserLimit enforces the effective active-user cap (per-clinic override, else
// plan; nil = unlimited) — FR-USR-03.
func checkUserLimit(ctx context.Context, tx pgx.Tx, q *identitydb.Queries, tenantID uuid.UUID) error {
	limit, err := limits.UserLimit(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if limit == nil { // unlimited
		return nil
	}
	n, err := q.CountActiveUsers(ctx, tenantID)
	if err != nil {
		return err
	}
	if n >= *limit {
		return apperr.New(http.StatusForbidden, "USER_LIMIT_REACHED", "your plan's active-user limit has been reached — upgrade to add more staff")
	}
	return nil
}

func userActor(ctx context.Context) (uuid.UUID, *uuid.UUID) {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		uid := p.UserID
		return p.TenantID, &uid
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid, nil
}

func isUnique(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "duplicate key") || strings.Contains(msg, "unique constraint")
}

// resetLinkTTL is deliberately shorter than an invitation's.
//
// An invitation is sent to somebody who has nothing yet; a reset link opens an
// account that already holds patient records, so it should stop working the same
// day it was issued.
const resetLinkTTL = 12 * time.Hour

// IssueResetLink gives an admin a fresh single-use link for a member of staff who
// has forgotten their password.
//
// It is the same token an invitation uses, marked as a reset so that accepting it
// sets the password WITHOUT signing the person in — otherwise anyone holding the
// link would walk past an enabled second factor.
//
// A suspended or deactivated account is refused rather than reset. The password path activates the
// user as it sets the password, so resetting a suspended account would quietly
// restore access that somebody deliberately removed; reactivating is a separate
// decision, and it belongs to whoever suspended them.
func (s *UserService) IssueResetLink(ctx context.Context, userID uuid.UUID) (*identity.InviteResult, error) {
	tenantID, actorID := userActor(ctx)
	var composite, email, fullName string
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var status string
		e := tx.QueryRow(ctx,
			`SELECT email, coalesce(full_name,''), status FROM users
			  WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
			tenantID, userID).Scan(&email, &fullName, &status)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("USER_NOT_FOUND", "no such member of staff")
		}
		if e != nil {
			return e
		}
		if status == "suspended" || status == "deactivated" {
			return apperr.Validation("this account is " + status + " — reactivate it first, then issue a reset link")
		}
		// Retire every link still outstanding for this person, so the one just issued
		// is the only one that works.
		if _, e := tx.Exec(ctx,
			`UPDATE user_invitations SET expires_at = now()
			  WHERE tenant_id = $1 AND user_id = $2 AND accepted_at IS NULL AND expires_at > now()`,
			tenantID, userID); e != nil {
			return e
		}
		opaque, e := auth.GenerateRefreshToken()
		if e != nil {
			return e
		}
		composite = id.Encode(id.PrefixTenant, tenantID) + "." + opaque
		_, e = tx.Exec(ctx,
			`INSERT INTO user_invitations (tenant_id, user_id, token_hash, expires_at, created_by, purpose)
			 VALUES ($1, $2, $3, $4, $5, 'reset')`,
			tenantID, userID, auth.HashToken(opaque), time.Now().Add(resetLinkTTL), actorID)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	// Same route the invitation uses: the page it lands on already knows how to take
	// a token and a new password.
	link := strings.TrimRight(s.cfg.AppBaseURL, "/") + "/accept-invite?token=" + composite
	_ = fullName
	return &identity.InviteResult{UserID: userID, Email: email, InviteLink: link}, nil
}
