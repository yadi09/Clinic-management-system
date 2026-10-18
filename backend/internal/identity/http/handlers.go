// Package http exposes the identity module's REST endpoints. Handlers are thin:
// they bind/validate DTOs, call the identity.Service, set the refresh cookie,
// and shape responses via the standard envelope.
package http

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/identity"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

const refreshCookieName = "refresh_token"

// Options configure cookie behaviour.
type Options struct {
	SecureCookies bool   // true in prod (HTTPS)
	CookiePath    string // path scope for the refresh cookie
}

// Handlers wires the identity service to HTTP.
type Handlers struct {
	svc   identity.Service
	users identity.UserAdmin
	opts  Options
}

// NewHandlers constructs identity HTTP handlers.
func NewHandlers(svc identity.Service, users identity.UserAdmin, opts Options) *Handlers {
	if opts.CookiePath == "" {
		opts.CookiePath = "/api/v1/auth"
	}
	return &Handlers{svc: svc, users: users, opts: opts}
}

// AcceptInvite handles POST /auth/accept-invite (public): set password + sign in.
func (h *Handlers) AcceptInvite(c *gin.Context) {
	var req acceptInviteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("token and password are required"))
		return
	}
	tokens, user, err := h.svc.AcceptInvite(signInCtx(c), req.Token, req.Password, c.Request.UserAgent(), clientIP(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// A reset sets the password and stops. No cookie, no access token: the person
	// signs in with the new password, which is also where their second factor is
	// asked for.
	if tokens == nil {
		httpx.OK(c, gin.H{"password_set": true, "sign_in_required": true, "user": toUserDTO(user)})
		return
	}
	h.setRefreshCookie(c, tokens)
	httpx.OK(c, tokenResponse{
		AccessToken: tokens.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(time.Until(tokens.AccessExpiresAt).Seconds()),
		User:        toUserDTO(user),
	})
}

// Login handles POST /auth/login.
func (h *Handlers) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("workspace, a valid email, and password are required"))
		return
	}
	res, err := h.svc.Login(signInCtx(c), identity.LoginInput{
		Workspace: req.Workspace,
		Email:     req.Email,
		Password:  req.Password,
		UserAgent: c.Request.UserAgent(),
		IP:        clientIP(c),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if res.MFARequired {
		httpx.OK(c, mfaChallengeResponse{MFARequired: true, MFAToken: res.MFAChallenge})
		return
	}
	h.setRefreshCookie(c, res.Tokens)
	httpx.OK(c, tokenResponse{
		AccessToken: res.Tokens.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(time.Until(res.Tokens.AccessExpiresAt).Seconds()),
		User:        toUserDTO(res.User),
	})
}

// VerifyMFA handles POST /auth/mfa.
func (h *Handlers) VerifyMFA(c *gin.Context) {
	var req mfaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("mfa_token and code are required"))
		return
	}
	tokens, user, err := h.svc.VerifyMFA(signInCtx(c), req.MFAToken, req.Code, c.Request.UserAgent(), clientIP(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, tokens)
	httpx.OK(c, tokenResponse{
		AccessToken: tokens.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(time.Until(tokens.AccessExpiresAt).Seconds()),
		User:        toUserDTO(user),
	})
}

// Refresh handles POST /auth/refresh using the refresh cookie.
func (h *Handlers) Refresh(c *gin.Context) {
	raw, err := c.Cookie(refreshCookieName)
	if err != nil || raw == "" {
		httpx.Fail(c, apperr.Unauthenticated("missing refresh token"))
		return
	}
	tokens, err := h.svc.Refresh(signInCtx(c), raw, c.Request.UserAgent(), clientIP(c))
	if err != nil {
		h.clearRefreshCookie(c)
		httpx.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, tokens)
	httpx.OK(c, tokenResponse{
		AccessToken: tokens.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(time.Until(tokens.AccessExpiresAt).Seconds()),
	})
}

// Logout handles POST /auth/logout, revoking the current session.
func (h *Handlers) Logout(c *gin.Context) {
	if raw, err := c.Cookie(refreshCookieName); err == nil && raw != "" {
		_ = h.svc.Logout(c.Request.Context(), raw)
	}
	h.clearRefreshCookie(c)
	httpx.NoContent(c)
}

// Me handles GET /auth/me for the authenticated principal.
func (h *Handlers) Me(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	res, err := h.svc.Me(c.Request.Context(), p.TenantID, p.UserID, p.ActiveBranchID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, toMeResponse(res))
}

// SwitchBranch handles POST /auth/switch-branch — re-issue the access token for a
// different branch the user can access (branch_id "all" = consolidated view).
func (h *Handlers) SwitchBranch(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	var req switchBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("branch_id is required"))
		return
	}
	var target *uuid.UUID
	if req.BranchID != "" && req.BranchID != "all" {
		bid, err := id.Decode(id.PrefixBranch, req.BranchID)
		if err != nil {
			httpx.Fail(c, apperr.Validation("invalid branch"))
			return
		}
		target = &bid
	}
	raw, _ := c.Cookie(refreshCookieName)
	res, err := h.svc.SwitchBranch(c.Request.Context(), p.TenantID, p.UserID, target, raw)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, tokenResponse{
		AccessToken: res.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(time.Until(res.AccessExpiresAt).Seconds()),
	})
}

// ListWorkspaces handles GET /auth/workspaces — the clinic's branches this person may move to.
func (h *Handlers) ListWorkspaces(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	out, err := h.svc.ListWorkspaces(c.Request.Context(), p.TenantID, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SwitchWorkspace handles POST /auth/switch-workspace {workspace_id}: sign in to another
// branch of the clinic. The browser's session moves with it (a new refresh cookie).
func (h *Handlers) SwitchWorkspace(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	var req struct {
		WorkspaceID string `json:"workspace_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("choose a branch"))
		return
	}
	target, err := id.Decode(id.PrefixTenant, req.WorkspaceID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("choose a branch"))
		return
	}
	raw, _ := c.Cookie(refreshCookieName)
	tokens, user, err := h.svc.SwitchWorkspace(signInCtx(c), p.TenantID, p.UserID, target, raw, c.Request.UserAgent(), clientIP(c))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	h.setRefreshCookie(c, tokens)
	httpx.OK(c, tokenResponse{
		AccessToken: tokens.AccessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(time.Until(tokens.AccessExpiresAt).Seconds()),
		User:        toUserDTO(user),
	})
}

// ChangePassword handles POST /auth/password for the signed-in user.
func (h *Handlers) ChangePassword(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a current password and a new password of at least 8 characters are required"))
		return
	}
	if err := h.svc.ChangePassword(c.Request.Context(), p.TenantID, p.UserID, req.CurrentPassword, req.NewPassword); err != nil {
		httpx.Fail(c, err)
		return
	}
	// A password change signs the user out on every other device (best-effort);
	// the current device keeps its session.
	if raw, e := c.Cookie(refreshCookieName); e == nil && raw != "" {
		_, _ = h.svc.RevokeOtherSessions(c.Request.Context(), p.TenantID, p.UserID, raw)
	}
	httpx.NoContent(c)
}

// SignOutOtherDevices handles POST /auth/sessions/logout-others — revoke every
// session for the user except the caller's current one.
func (h *Handlers) SignOutOtherDevices(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	raw, _ := c.Cookie(refreshCookieName)
	n, err := h.svc.RevokeOtherSessions(c.Request.Context(), p.TenantID, p.UserID, raw)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, gin.H{"revoked": n})
}

// ChangeEmail handles POST /auth/email for the signed-in user.
func (h *Handlers) ChangeEmail(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	var req changeEmailRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a valid new email and your current password are required"))
		return
	}
	if err := h.svc.ChangeEmail(c.Request.Context(), p.TenantID, p.UserID, req.NewEmail, req.CurrentPassword); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func (h *Handlers) setRefreshCookie(c *gin.Context, t *identity.TokenPair) {
	maxAge := int(time.Until(t.RefreshExpiresAt).Seconds())
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(refreshCookieName, t.RefreshToken, maxAge, h.opts.CookiePath, "", h.opts.SecureCookies, true)
}

func (h *Handlers) clearRefreshCookie(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(refreshCookieName, "", -1, h.opts.CookiePath, "", h.opts.SecureCookies, true)
}

// clientIP is the visitor's address. Behind Cloudflare the connection's own address is
// Cloudflare's, so the address Cloudflare reports is preferred; it is only ever shown to
// the account's own user as "where was I signed in from", never used to decide access.
func clientIP(c *gin.Context) string {
	if v := strings.TrimSpace(c.GetHeader("CF-Connecting-IP")); net.ParseIP(v) != nil {
		return v
	}
	return c.ClientIP()
}

// signInCtx is the request context plus the visitor's country (Cloudflare's header).
func signInCtx(c *gin.Context) context.Context {
	cc := strings.ToUpper(strings.TrimSpace(c.GetHeader("CF-IPCountry")))
	if len(cc) != 2 || cc == "XX" || cc == "T1" {
		cc = ""
	}
	return identity.WithClientCountry(c.Request.Context(), cc)
}

// ListSessions handles GET /auth/sessions — the caller's live devices.
func (h *Handlers) ListSessions(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	raw, _ := c.Cookie(refreshCookieName)
	ds, err := h.svc.ListSessions(c.Request.Context(), p.TenantID, p.UserID, raw)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(ds))
	for _, d := range ds {
		out = append(out, gin.H{
			"id": id.Encode(id.PrefixSession, d.ID), "user_agent": d.UserAgent, "ip": d.IP, "country": d.Country, "label": d.Label,
			"started_at": d.StartedAt, "last_active": d.LastActive, "expires_at": d.ExpiresAt, "current": d.Current,
		})
	}
	httpx.OK(c, out)
}

// RevokeSession handles DELETE /auth/sessions/:id — sign one other device out.
func (h *Handlers) RevokeSession(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	sid, err := id.Decode(id.PrefixSession, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid device id"))
		return
	}
	raw, _ := c.Cookie(refreshCookieName)
	if err := h.svc.RevokeSession(c.Request.Context(), p.TenantID, p.UserID, sid, raw); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// LabelSession handles PUT /auth/sessions/:id/label {"label": "Reception PC"}.
func (h *Handlers) LabelSession(c *gin.Context) {
	p, ok := httpx.PrincipalFrom(c)
	if !ok {
		httpx.Fail(c, apperr.Unauthenticated("authentication required"))
		return
	}
	sid, err := id.Decode(id.PrefixSession, c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.Validation("invalid device id"))
		return
	}
	var req struct {
		Label string `json:"label"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("send the device name"))
		return
	}
	if err := h.svc.LabelSession(c.Request.Context(), p.TenantID, p.UserID, sid, req.Label); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}
