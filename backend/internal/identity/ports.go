// Package identity defines the public contracts of the identity bounded module
// (auth, users, roles, tenants). Other modules and the HTTP layer depend on
// these interfaces and DTOs — never on the module's internal service/repo. This
// ports.go is the module's extraction seam (Part 2 §5.3, §5.10).
package identity

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// LoginInput carries credentials and request metadata for a login attempt.
type LoginInput struct {
	Workspace string // tenant slug
	Email     string
	Password  string
	UserAgent string
	IP        string
}

// TokenPair is an issued access token plus the opaque rotating refresh token.
type TokenPair struct {
	AccessToken      string
	AccessExpiresAt  time.Time
	RefreshToken     string // composite cookie value: <tenant-prefix>.<opaque>
	RefreshExpiresAt time.Time
}

// UserProfile is the minimal authenticated-user view.
type UserProfile struct {
	ID       uuid.UUID `json:"id"`
	TenantID uuid.UUID `json:"tenant_id"`
	Email    string    `json:"email"`
	FullName string    `json:"full_name"`
	Roles    []string  `json:"roles"`
}

// LoginResult is either an MFA challenge or an issued token pair.
type LoginResult struct {
	MFARequired  bool
	MFAChallenge string // set when MFARequired
	Tokens       *TokenPair
	User         UserProfile
}

// BranchRef is a branch the user can access (for the branch switcher).
type BranchRef struct {
	ID   uuid.UUID `json:"-"`
	Name string    `json:"name"`
	Code string    `json:"code"`
}

// MeResult is the authenticated principal's full context (FR for /auth/me).
type MeResult struct {
	User           UserProfile     `json:"user"`
	Permissions    []string        `json:"permissions"`
	Flags          map[string]bool `json:"flags"`
	Branches       []BranchRef     `json:"branches"`
	ActiveBranchID *uuid.UUID      `json:"active_branch_id,omitempty"`
	AllBranches    bool            `json:"all_branches"`
}

// SwitchResult is the access token re-issued for a newly-selected branch.
type SwitchResult struct {
	AccessToken     string
	AccessExpiresAt time.Time
}

// Service is the identity module's authentication API.
type Service interface {
	Login(ctx context.Context, in LoginInput) (*LoginResult, error)
	VerifyMFA(ctx context.Context, challengeToken, code, userAgent, ip string) (*TokenPair, UserProfile, error)
	Refresh(ctx context.Context, refreshToken, userAgent, ip string) (*TokenPair, error)
	Logout(ctx context.Context, refreshToken string) error
	// RevokeOtherSessions signs the user out of all devices except currentRefresh
	// (empty = everywhere). Returns how many sessions were revoked.
	RevokeOtherSessions(ctx context.Context, tenantID, userID uuid.UUID, currentRefresh string) (int64, error)
	Me(ctx context.Context, tenantID, userID uuid.UUID, activeBranch *uuid.UUID) (*MeResult, error)
	// SwitchBranch re-issues an access token for a different branch (target nil =
	// consolidated "all branches" view, for tenant-wide users).
	SwitchBranch(ctx context.Context, tenantID, userID uuid.UUID, target *uuid.UUID, refreshToken string) (*SwitchResult, error)
	AcceptInvite(ctx context.Context, token, password, userAgent, ip string) (*TokenPair, UserProfile, error)
	ChangePassword(ctx context.Context, tenantID, userID uuid.UUID, currentPassword, newPassword string) error
	ChangeEmail(ctx context.Context, tenantID, userID uuid.UUID, newEmail, currentPassword string) error
}

// InviteInput is the staff-invitation payload. BranchIDs scopes the assigned
// roles to those branches; empty means tenant-wide (all branches).
type InviteInput struct {
	Email     string
	FullName  string
	Phone     string // local 09… form; the only way to reach this person off email
	RoleCodes []string
	BranchIDs []uuid.UUID
}

// InviteResult is returned after inviting a user; InviteLink is shown to the
// admin to share until an email provider is configured (Q3).
type InviteResult struct {
	UserID     uuid.UUID
	Email      string
	InviteLink string
}

// UserListItem is a staff row for the admin user list.
type UserListItem struct {
	ID          uuid.UUID  `json:"-"`
	Email       string     `json:"email"`
	FullName    string     `json:"full_name"`
	Phone       string     `json:"phone"`
	Status      string     `json:"status"`
	Roles       []string   `json:"roles"`
	LastLoginAt *time.Time `json:"last_login_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

// Provider is an assignable consulting clinician (for triage/reception pickers).
type Provider struct {
	ID       uuid.UUID `json:"-"`
	FullName string    `json:"full_name"`
}

// RoleItem is an assignable role.
type RoleItem struct {
	ID       uuid.UUID `json:"-"`
	Code     string    `json:"code"`
	Name     string    `json:"name"`
	IsSystem bool      `json:"is_system"`
}

// UserAdmin is the identity module's staff-management API.
type UserAdmin interface {
	InviteUser(ctx context.Context, in InviteInput) (*InviteResult, error)
	ListUsers(ctx context.Context) ([]UserListItem, error)
	IssueResetLink(ctx context.Context, userID uuid.UUID) (*InviteResult, error)
	ListProviders(ctx context.Context) ([]Provider, error)
	UpdateUserStatus(ctx context.Context, userID uuid.UUID, status string) error
	// UpdateUserProfile edits the details an admin maintains. A nil phone leaves
	// the stored number alone; an empty one clears it.
	UpdateUserProfile(ctx context.Context, userID uuid.UUID, fullName string, phone *string) error
	DeleteUser(ctx context.Context, userID uuid.UUID) error
	// AssignRoles replaces a user's role assignments. branchIDs scopes them to
	// those branches; empty means tenant-wide (all branches).
	AssignRoles(ctx context.Context, userID uuid.UUID, roleCodes []string, branchIDs []uuid.UUID) error
	ListRoles(ctx context.Context) ([]RoleItem, error)
}
