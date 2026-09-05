package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterPublic mounts endpoints that do not require an access token. Refresh
// and logout authenticate via the httpOnly refresh cookie.
func (h *Handlers) RegisterPublic(rg *gin.RouterGroup) {
	auth := rg.Group("/auth")
	auth.POST("/login", h.Login)
	auth.POST("/mfa", h.VerifyMFA)
	auth.POST("/refresh", h.Refresh)
	auth.POST("/logout", h.Logout)
	auth.POST("/accept-invite", h.AcceptInvite)
}

// RegisterProtected mounts endpoints requiring a valid access token (the group
// must already have RequireAuth applied). Staff management is permission-gated.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	rg.GET("/auth/me", h.Me)
	rg.POST("/auth/switch-branch", h.SwitchBranch)
	// Self-service account changes for the signed-in user (no admin permission;
	// both confirm the current password server-side).
	rg.POST("/auth/password", h.ChangePassword)
	rg.POST("/auth/email", h.ChangeEmail)
	rg.POST("/auth/sessions/logout-others", h.SignOutOtherDevices)

	rg.GET("/roles", httpx.RequirePermission("user.read"), h.ListRoles)
	// Assignable clinicians for the triage/reception "assign doctor" pickers — usable
	// by staff who route patients (queue/triage/appointment), not just user.read admins.
	rg.GET("/providers", httpx.RequireAnyPermission("queue.manage", "triage.manage", "appointment.manage", "user.read"), h.ListProviders)

	u := rg.Group("/users")
	u.GET("", httpx.RequirePermission("user.read"), h.ListUsers)
	u.POST("", httpx.RequirePermission("user.invite"), h.InviteUser)
	// A forgotten password: a fresh single-use link the admin passes on.
	u.POST("/:id/reset-link", httpx.RequirePermission("user.invite"), h.ResetLink)
	u.POST("/:id/status", httpx.RequirePermission("user.update"), h.UpdateUserStatus)
	u.POST("/:id/profile", httpx.RequirePermission("user.update"), h.UpdateUserProfile)
	// Kept so a console left open across a deploy can still save a name change.
	u.POST("/:id/name", httpx.RequirePermission("user.update"), h.UpdateUserProfile)
	u.DELETE("/:id", httpx.RequirePermission("user.update"), h.DeleteUser)
	u.PUT("/:id/roles", httpx.RequirePermission("role.assign"), h.AssignRoles)
}
