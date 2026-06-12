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

// InviteUser handles POST /users.
func (h *Handlers) InviteUser(c *gin.Context) {
	var req inviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a valid email and full name are required"))
		return
	}
	res, err := h.users.InviteUser(c.Request.Context(), identity.InviteInput{Email: req.Email, FullName: req.FullName, RoleCodes: req.RoleCodes})
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
	if err := h.users.AssignRoles(c.Request.Context(), uid, req.Roles); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
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
