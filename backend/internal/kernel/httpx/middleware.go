package httpx

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/ratelimit"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

const (
	requestIDKey    = "request_id"
	principalCtxKey = "principal"
)

// RequestID returns the correlation id assigned to the request.
func RequestID(c *gin.Context) string { return c.GetString(requestIDKey) }

// WithRequestID assigns a correlation id and echoes it in the response header.
func WithRequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		rid := c.GetHeader("X-Request-Id")
		if rid == "" {
			rid = uuid.NewString()
		}
		c.Set(requestIDKey, rid)
		c.Header("X-Request-Id", rid)
		c.Next()
	}
}

// Recovery converts panics into a 500 envelope without crashing the process.
func Recovery(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic recovered", "request_id", RequestID(c), "panic", r)
				Fail(c, apperr.Internal(nil))
			}
		}()
		c.Next()
	}
}

// AccessLog emits one structured access-log line per request.
func AccessLog(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		attrs := []any{
			"method", c.Request.Method,
			"path", c.FullPath(),
			"status", c.Writer.Status(),
			"latency_ms", time.Since(start).Milliseconds(),
			"request_id", RequestID(c),
			"ip", c.ClientIP(),
		}
		if p, ok := PrincipalFrom(c); ok {
			attrs = append(attrs, "tenant_id", p.TenantID.String(), "user_id", p.UserID.String())
		}
		log.Info("request", attrs...)
	}
}

// CORS allows the configured origins (credentialed) and short-circuits preflight.
func CORS(origins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		if origin := c.GetHeader("Origin"); origin != "" && allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// RateLimit enforces a per-tenant (or per-IP when anonymous) request budget.
func RateLimit(limiter ratelimit.Limiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		key := "ip:" + c.ClientIP()
		if p, ok := PrincipalFrom(c); ok {
			key = "t:" + p.TenantID.String()
		}
		if !limiter.Allow(key) {
			Fail(c, apperr.RateLimited())
			return
		}
		c.Next()
	}
}

// RequireAuth verifies the bearer access token, builds the principal, and
// injects it into the request context so the data layer resolves the tenant.
func RequireAuth(ts *auth.TokenService) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := bearerToken(c)
		if raw == "" {
			Fail(c, apperr.Unauthenticated("missing bearer token"))
			return
		}
		claims, err := ts.ParseAccess(raw)
		if err != nil {
			Fail(c, apperr.Unauthenticated("invalid or expired token"))
			return
		}
		userID, err1 := uuid.Parse(claims.Subject)
		tenantID, err2 := uuid.Parse(claims.TenantID)
		if err1 != nil || err2 != nil {
			Fail(c, apperr.Unauthenticated("malformed token claims"))
			return
		}
		p := &tenancy.Principal{
			UserID:      userID,
			TenantID:    tenantID,
			Email:       claims.Email,
			Roles:       claims.Roles,
			Permissions: claims.Permissions,
			Flags:       claims.Flags,
		}
		c.Set(principalCtxKey, p)
		c.Request = c.Request.WithContext(tenancy.WithPrincipal(c.Request.Context(), p))
		c.Next()
	}
}

// RequireRole authorizes the request if the principal holds any of the roles.
func RequireRole(anyOf ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := PrincipalFrom(c)
		if !ok {
			Fail(c, apperr.Unauthenticated("authentication required"))
			return
		}
		if !p.HasAnyRole(anyOf...) {
			Fail(c, apperr.Forbidden("FORBIDDEN_ROLE", "you do not have the required role"))
			return
		}
		c.Next()
	}
}

// RequirePermission authorizes the request if the principal holds the permission.
func RequirePermission(code string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := PrincipalFrom(c)
		if !ok {
			Fail(c, apperr.Unauthenticated("authentication required"))
			return
		}
		if !p.HasPermission(code) {
			Fail(c, apperr.Forbidden("FORBIDDEN_PERMISSION", "you do not have permission to perform this action"))
			return
		}
		c.Next()
	}
}

// RequireFlag blocks the request when the tenant's feature flag is off (FR-TEN-03).
func RequireFlag(flag string) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, ok := PrincipalFrom(c)
		if !ok {
			Fail(c, apperr.Unauthenticated("authentication required"))
			return
		}
		if !p.FlagEnabled(flag) {
			Fail(c, apperr.ModuleDisabled(flag))
			return
		}
		c.Next()
	}
}

// PrincipalFrom returns the authenticated principal from the gin context.
func PrincipalFrom(c *gin.Context) (*tenancy.Principal, bool) {
	v, ok := c.Get(principalCtxKey)
	if !ok {
		return nil, false
	}
	p, ok := v.(*tenancy.Principal)
	return p, ok
}

func bearerToken(c *gin.Context) string {
	const pfx = "Bearer "
	if h := c.GetHeader("Authorization"); strings.HasPrefix(h, pfx) {
		return strings.TrimSpace(h[len(pfx):])
	}
	return ""
}
