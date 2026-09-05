package http

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/identity"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

// ListUsers handles GET /users.
func (h *Handlers) ListUsers(c *gin.Context) {
	items, err := h.users.ListUsers(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]userListDTO, 0, len(items))
	for _, u := range items {
		out = append(out, userListDTO{ID: id.Encode(id.PrefixUser, u.ID), UserListItem: u})
	}
	httpx.OK(c, out)
}

// ListProviders handles GET /providers — assignable consulting clinicians.
func (h *Handlers) ListProviders(c *gin.Context) {
	items, err := h.users.ListProviders(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(items))
	for _, p := range items {
		out = append(out, gin.H{"id": id.Encode(id.PrefixUser, p.ID), "full_name": p.FullName})
	}
	httpx.OK(c, out)
}

// InviteUser handles POST /users.
func (h *Handlers) InviteUser(c *gin.Context) {
	var req inviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a valid email and full name are required"))
		return
	}
	branchIDs, err := decodeBranchIDs(req.Branches)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	res, err := h.users.InviteUser(c.Request.Context(), identity.InviteInput{Email: req.Email, FullName: req.FullName, Phone: req.Phone, RoleCodes: req.RoleCodes, BranchIDs: branchIDs})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, inviteResultDTO{ID: id.Encode(id.PrefixUser, res.UserID), Email: res.Email, InviteLink: res.InviteLink})
}

// UpdateUserStatus handles POST /users/:id/status.
func (h *Handlers) UpdateUserStatus(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		return
	}
	var req statusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("status is required"))
		return
	}
	if err := h.users.UpdateUserStatus(c.Request.Context(), uid, req.Status); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// UpdateUserProfile handles POST /users/:id/profile (and the older /name path).
// Phone is a pointer so that omitting it leaves the stored number alone, while
// sending "" clears it.
func (h *Handlers) UpdateUserProfile(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		return
	}
	var req struct {
		FullName string  `json:"full_name"`
		Phone    *string `json:"phone"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a name is required"))
		return
	}
	if err := h.users.UpdateUserProfile(c.Request.Context(), uid, req.FullName, req.Phone); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// DeleteUser handles DELETE /users/:id (soft-delete + session revoke).
func (h *Handlers) DeleteUser(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		return
	}
	if err := h.users.DeleteUser(c.Request.Context(), uid); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AssignRoles handles PUT /users/:id/roles.
func (h *Handlers) AssignRoles(c *gin.Context) {
	uid, ok := userID(c)
	if !ok {
		return
	}
	var req assignRolesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("roles is required"))
		return
	}
	branchIDs, err := decodeBranchIDs(req.Branches)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if err := h.users.AssignRoles(c.Request.Context(), uid, req.Roles, branchIDs); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// decodeBranchIDs turns encoded brn_… ids into UUIDs (empty input = all branches).
func decodeBranchIDs(raw []string) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, 0, len(raw))
	for _, s := range raw {
		if s == "" {
			continue
		}
		b, err := id.Decode(id.PrefixBranch, s)
		if err != nil {
			return nil, apperr.Validation("invalid branch id")
		}
		out = append(out, b)
	}
	return out, nil
}

// ListRoles handles GET /roles.
func (h *Handlers) ListRoles(c *gin.Context) {
	items, err := h.users.ListRoles(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]roleDTO, 0, len(items))
	for _, r := range items {
		out = append(out, roleDTO{ID: id.Encode(id.PrefixRole, r.ID), RoleItem: r})
	}
	httpx.OK(c, out)
}

func userID(c *gin.Context) (uuid.UUID, bool) {
	u, err := id.Decode(id.PrefixUser, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.NotFound("USER_NOT_FOUND", "user not found"))
		return uuid.Nil, false
	}
	return u, true
}

// ResetLink handles POST /users/:id/reset-link.
//
// Issuing a credential reset is the same power as creating a member of staff, so it
// takes the same permission. There is no email or SMS sender in this system: the
// link is handed back to the admin, who gives it to the person in front of them.
func (h *Handlers) ResetLink(c *gin.Context) {
	uid, err := id.Decode(id.PrefixUser, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("that id is not valid"))
		return
	}
	res, err := h.users.IssueResetLink(c.Request.Context(), uid)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, inviteResultDTO{
		ID: id.Encode(id.PrefixUser, res.UserID), Email: res.Email, InviteLink: res.InviteLink,
	})
}
