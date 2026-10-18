package service

// Moving between a clinic's branches.
//
// Each branch is a workspace of its own, behind the same database wall that
// separates two clinics. A person allowed to work in several (the owner, a branch
// admin) has an account in each, tied together by org_links. Moving to another
// branch is a sign-in to that branch's workspace as that account — a fresh session
// there — and the end of the session here. Nothing about the branch being left
// travels with them: the new token names only the new workspace.

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/identity"
	identitydb "github.com/reicb/clinicsaas/internal/identity/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

var errBranchDenied = apperr.Forbidden("BRANCH_DENIED", "you don't have access to that branch")

// ListWorkspaces lists the branches this person may move to, this one included.
// Someone who works in one branch only gets an empty list: there is nowhere to go.
func (s *AuthService) ListWorkspaces(ctx context.Context, tenantID, userID uuid.UUID) ([]identity.Workspace, error) {
	out := []identity.Workspace{}
	err := s.db.WithTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `
			SELECT t.id, t.name, t.slug
			  FROM org_links me
			  JOIN org_links l ON l.person_id = me.person_id
			  JOIN tenants t ON t.id = l.tenant_id AND t.deleted_at IS NULL AND t.status IN ('active','onboarding')
			 WHERE me.tenant_id = $1 AND me.user_id = $2
			 ORDER BY t.created_at`, tenantID, userID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var w identity.Workspace
			if e := rows.Scan(&w.TenantID, &w.Name, &w.Slug); e != nil {
				return e
			}
			w.ID, w.Current = id.Encode(id.PrefixTenant, w.TenantID), w.TenantID == tenantID
			out = append(out, w)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	if len(out) < 2 {
		return []identity.Workspace{}, nil
	}
	return out, nil
}

// SwitchWorkspace signs this person into another branch of their clinic.
func (s *AuthService) SwitchWorkspace(ctx context.Context, tenantID, userID, target uuid.UUID, refreshToken, userAgent, ip string) (*identity.TokenPair, identity.UserProfile, error) {
	if target == tenantID {
		return nil, identity.UserProfile{}, apperr.Validation("you are already in this branch")
	}
	// Their account in the target branch, if they have one — and only through their
	// own link: the target is never trusted on its own.
	var targetUser uuid.UUID
	err := s.db.WithTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT l.user_id
			  FROM org_links me
			  JOIN org_links l ON l.person_id = me.person_id AND l.tenant_id = $3
			  JOIN tenants t ON t.id = l.tenant_id AND t.deleted_at IS NULL AND t.status IN ('active','onboarding')
			 WHERE me.tenant_id = $1 AND me.user_id = $2`, tenantID, userID, target).Scan(&targetUser)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, identity.UserProfile{}, errBranchDenied
	}
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Internal(err)
	}

	tctx := tenancy.WithTenantID(ctx, target)
	var u identitydb.GetUserByIDRow
	err = s.db.WithTx(tctx, func(tx pgx.Tx) error {
		var e error
		u, e = identitydb.New(tx).GetUserByID(tctx, identitydb.GetUserByIDParams{TenantID: target, ID: targetUser})
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && u.Status != "active") {
		return nil, identity.UserProfile{}, errBranchDenied
	}
	if err != nil {
		return nil, identity.UserProfile{}, apperr.Internal(err)
	}

	tokens, roles, err := s.issueTokens(tctx, target, targetUser, u.Email, userAgent, ip, nil, nil)
	if err != nil {
		return nil, identity.UserProfile{}, err
	}
	// The session in the branch being left ends now: one browser, one branch.
	if refreshToken != "" {
		_ = s.Logout(ctx, refreshToken)
	}
	s.emit(ctx, tenantID, userID, "auth.user.switched_branch_out", map[string]any{"to": id.Encode(id.PrefixTenant, target)})
	s.emit(tctx, target, targetUser, "auth.user.switched_branch_in", map[string]any{"from": id.Encode(id.PrefixTenant, tenantID), "ip": ip})
	return tokens, identity.UserProfile{ID: targetUser, TenantID: target, Email: u.Email, FullName: u.FullName, Roles: roles}, nil
}

// syncLinkedPassword gives this person's accounts in the clinic's other branches the
// same password: one person, one password, whichever branch they sign in at. Best
// effort — a branch that cannot be reached keeps its old password rather than
// failing a change that has already happened here.
func (s *AuthService) syncLinkedPassword(ctx context.Context, tenantID, userID uuid.UUID, hash string) {
	type acct struct{ tenant, user uuid.UUID }
	var others []acct
	_ = s.db.WithTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `
			SELECT l.tenant_id, l.user_id
			  FROM org_links me JOIN org_links l ON l.person_id = me.person_id AND l.tenant_id <> me.tenant_id
			 WHERE me.tenant_id = $1 AND me.user_id = $2`, tenantID, userID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var a acct
			if e := rows.Scan(&a.tenant, &a.user); e != nil {
				return e
			}
			others = append(others, a)
		}
		return rows.Err()
	})
	for _, a := range others {
		h := hash
		_ = s.db.WithTenantTx(ctx, a.tenant, func(tx pgx.Tx) error {
			return identitydb.New(tx).UpdateUserPassword(ctx, identitydb.UpdateUserPasswordParams{TenantID: a.tenant, ID: a.user, PasswordHash: &h})
		})
	}
}
