// Package tenancy carries the authenticated principal and the active tenant
// through request context. Tenant isolation is enforced in kernel/db (RLS GUC)
// using the tenant id resolved here — never trusted from a request body.
package tenancy

import (
	"context"

	"github.com/google/uuid"
)

type ctxKey int

const (
	principalKey ctxKey = iota
	tenantKey
)

// Scope is a (branch, department) authorization scope attached to a role
// assignment. A nil BranchID means tenant-wide; a nil DepartmentID means all
// departments within scope.
type Scope struct {
	RoleCode     string     `json:"role"`
	BranchID     *uuid.UUID `json:"branch_id,omitempty"`
	DepartmentID *uuid.UUID `json:"department_id,omitempty"`
}

// Principal is the authenticated actor for a request.
type Principal struct {
	UserID      uuid.UUID       `json:"user_id"`
	TenantID    uuid.UUID       `json:"tenant_id"`
	Email       string          `json:"email"`
	Roles       []string        `json:"roles"`
	Permissions []string        `json:"permissions,omitempty"`
	Scopes      []Scope         `json:"scopes,omitempty"`
	Flags       map[string]bool `json:"flags,omitempty"`
}

// HasRole reports whether the principal holds the given role code.
func (p *Principal) HasRole(code string) bool {
	for _, r := range p.Roles {
		if r == code {
			return true
		}
	}
	return false
}

// HasAnyRole reports whether the principal holds any of the given role codes.
func (p *Principal) HasAnyRole(codes ...string) bool {
	for _, c := range codes {
		if p.HasRole(c) {
			return true
		}
	}
	return false
}

// HasPermission reports whether the principal holds the given permission code.
func (p *Principal) HasPermission(code string) bool {
	for _, perm := range p.Permissions {
		if perm == code {
			return true
		}
	}
	return false
}

// FlagEnabled reports whether the given feature flag is enabled for the tenant.
func (p *Principal) FlagEnabled(flag string) bool {
	return p.Flags != nil && p.Flags[flag]
}

// WithPrincipal returns a context carrying the principal. The principal's
// tenant becomes the active tenant for data access.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	ctx = context.WithValue(ctx, principalKey, p)
	if p != nil && p.TenantID != uuid.Nil {
		ctx = context.WithValue(ctx, tenantKey, p.TenantID)
	}
	return ctx
}

// PrincipalFromContext returns the authenticated principal, if any.
func PrincipalFromContext(ctx context.Context) (*Principal, bool) {
	p, ok := ctx.Value(principalKey).(*Principal)
	return p, ok && p != nil
}

// WithTenantID sets the active tenant explicitly. Used pre-authentication
// (e.g. resolving a tenant by workspace slug during login) before a principal
// exists.
func WithTenantID(ctx context.Context, tenantID uuid.UUID) context.Context {
	return context.WithValue(ctx, tenantKey, tenantID)
}

// TenantIDFromContext returns the active tenant id, if any. It prefers an
// explicitly-set tenant, falling back to the principal's tenant.
func TenantIDFromContext(ctx context.Context) (uuid.UUID, bool) {
	if t, ok := ctx.Value(tenantKey).(uuid.UUID); ok && t != uuid.Nil {
		return t, true
	}
	if p, ok := PrincipalFromContext(ctx); ok && p.TenantID != uuid.Nil {
		return p.TenantID, true
	}
	return uuid.Nil, false
}
