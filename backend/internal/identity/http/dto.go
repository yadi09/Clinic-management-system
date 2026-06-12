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
}

type statusRequest struct {
	Status string `json:"status" binding:"required"`
}

type assignRolesRequest struct {
	Roles []string `json:"roles"`
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

type meResponse struct {
	User        userDTO         `json:"user"`
	Permissions []string        `json:"permissions"`
	Flags       map[string]bool `json:"flags"`
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
