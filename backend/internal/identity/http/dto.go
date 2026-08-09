package http

import (
	"github.com/reicb/clinicsaas/internal/identity"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

// --- requests ---

type loginRequest struct {
	Workspace string `json:"workspace" binding:"required"`
	Email     string `json:"email" binding:"required,email"`
	Password  string `json:"password" binding:"required"`
}

type mfaRequest struct {
	MFAToken string `json:"mfa_token" binding:"required"`
	Code     string `json:"code" binding:"required"`
}

type acceptInviteRequest struct {
	Token    string `json:"token" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type inviteRequest struct {
	Email     string   `json:"email" binding:"required,email"`
	FullName  string   `json:"full_name" binding:"required"`
	RoleCodes []string `json:"roles"`
	Branches  []string `json:"branch_ids"` // encoded brn_… ids; empty = all branches
}

type statusRequest struct {
	Status string `json:"status" binding:"required"`
}

type assignRolesRequest struct {
	Roles    []string `json:"roles"`
	Branches []string `json:"branch_ids"` // encoded brn_… ids; empty = all branches
}

type switchBranchRequest struct {
	BranchID string `json:"branch_id"` // encoded brn_… id, or "all" for the consolidated view
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password" binding:"required"`
	NewPassword     string `json:"new_password" binding:"required,min=8"`
}

type changeEmailRequest struct {
	NewEmail        string `json:"new_email" binding:"required,email"`
	CurrentPassword string `json:"current_password" binding:"required"`
}

// --- responses ---

type userDTO struct {
	ID       string   `json:"id"`
	TenantID string   `json:"tenant_id"`
	Email    string   `json:"email"`
	FullName string   `json:"full_name"`
	Roles    []string `json:"roles"`
}

func toUserDTO(p identity.UserProfile) userDTO {
	roles := p.Roles
	if roles == nil {
		roles = []string{}
	}
	return userDTO{
		ID:       id.Encode(id.PrefixUser, p.ID),
		TenantID: id.Encode(id.PrefixTenant, p.TenantID),
		Email:    p.Email,
		FullName: p.FullName,
		Roles:    roles,
	}
}

type tokenResponse struct {
	AccessToken string  `json:"access_token"`
	TokenType   string  `json:"token_type"`
	ExpiresIn   int     `json:"expires_in"` // seconds until access token expiry
	User        userDTO `json:"user"`
}

type mfaChallengeResponse struct {
	MFARequired bool   `json:"mfa_required"`
	MFAToken    string `json:"mfa_token"`
}

type branchRefDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Code string `json:"code"`
}

type meResponse struct {
	User           userDTO         `json:"user"`
	Permissions    []string        `json:"permissions"`
	Flags          map[string]bool `json:"flags"`
	Branches       []branchRefDTO  `json:"branches"`
	ActiveBranchID *string         `json:"active_branch_id"`
	AllBranches    bool            `json:"all_branches"`
}

func toMeResponse(r *identity.MeResult) meResponse {
	branches := make([]branchRefDTO, 0, len(r.Branches))
	for _, b := range r.Branches {
		branches = append(branches, branchRefDTO{ID: id.Encode(id.PrefixBranch, b.ID), Name: b.Name, Code: b.Code})
	}
	var active *string
	if r.ActiveBranchID != nil {
		s := id.Encode(id.PrefixBranch, *r.ActiveBranchID)
		active = &s
	}
	return meResponse{
		User:           toUserDTO(r.User),
		Permissions:    r.Permissions,
		Flags:          r.Flags,
		Branches:       branches,
		ActiveBranchID: active,
		AllBranches:    r.AllBranches,
	}
}

type userListDTO struct {
	ID string `json:"id"`
	identity.UserListItem
}

type roleDTO struct {
	ID string `json:"id"`
	identity.RoleItem
}

type inviteResultDTO struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	InviteLink string `json:"invite_link"`
}
