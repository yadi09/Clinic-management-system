// Package http exposes the identity module's REST endpoints. Handlers are thin:
// they bind/validate DTOs, call the identity.Service, set the refresh cookie,
// and shape responses via the standard envelope.
package http

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/identity"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
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
	tokens, user, err := h.svc.AcceptInvite(c.Request.Context(), req.Token, req.Password, c.Request.UserAgent(), c.ClientIP())
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

// Login handles POST /auth/login.
func (h *Handlers) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("workspace, a valid email, and password are required"))
		return
	}
	res, err := h.svc.Login(c.Request.Context(), identity.LoginInput{
		Workspace: req.Workspace,
		Email:     req.Email,
		Password:  req.Password,
		UserAgent: c.Request.UserAgent(),
		IP:        c.ClientIP(),
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
	tokens, user, err := h.svc.VerifyMFA(c.Request.Context(), req.MFAToken, req.Code, c.Request.UserAgent(), c.ClientIP())
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
	tokens, err := h.svc.Refresh(c.Request.Context(), raw, c.Request.UserAgent(), c.ClientIP())
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
	res, err := h.svc.Me(c.Request.Context(), p.TenantID, p.UserID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, meResponse{User: toUserDTO(res.User), Permissions: res.Permissions, Flags: res.Flags})
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
