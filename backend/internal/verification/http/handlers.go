// Package http serves the check of a printed paper. Two halves: the clinic's own
// screen asks for a paper's token while printing (signed in), and whoever holds the
// paper opens the link (public, no account).
package http

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/ratelimit"
	"github.com/reicb/clinicsaas/internal/verification"
)

// Handlers serves the verification endpoints.
type Handlers struct {
	svc verification.Service
	// typing is the limit on guessing a short code by hand. A short code is typed by a
	// person, so it is short; a person does not need more than a few tries a minute.
	typing ratelimit.Limiter
}

// New constructs the handlers.
func New(svc verification.Service, typing ratelimit.Limiter) *Handlers {
	return &Handlers{svc: svc, typing: typing}
}

// Issue handles POST /verify/issue — the clinic's screen, while printing.
func (h *Handlers) Issue(c *gin.Context) {
	var req struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("a kind and an id are required"))
		return
	}
	prefix := id.PrefixEncounter
	if req.Kind == verification.KindDentalRx {
		prefix = id.PrefixDentalRx
	}
	subject, err := id.Decode(prefix, req.ID)
	if err != nil {
		httpx.Fail(c, apperr.Validation("that is not a valid prescription id"))
		return
	}
	out, e := h.svc.Issue(c.Request.Context(), req.Kind, subject)
	if e != nil {
		httpx.Fail(c, e)
		return
	}
	httpx.OK(c, out)
}

// answer writes a public result. Never cached: a paper that was valid a minute ago
// may be cancelled now, and the look is counted.
func answer(c *gin.Context, res *verification.Result, err error) {
	c.Header("Cache-Control", "no-store")
	c.Header("X-Robots-Tag", "noindex, nofollow")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, res)
}

// Check handles GET /verify/t/:slug/:token.
func (h *Handlers) Check(c *gin.Context) {
	res, err := h.svc.Check(c.Request.Context(), strings.ToLower(c.Param("slug")), c.Param("token"))
	answer(c, res, err)
}

// ByCode handles GET /verify/c/:slug/:code — the paper's short code, typed by hand.
func (h *Handlers) ByCode(c *gin.Context) {
	if h.typing != nil && !h.typing.Allow("verify-code:"+c.ClientIP()) {
		c.Header("Cache-Control", "no-store")
		httpx.Fail(c, apperr.RateLimited())
		return
	}
	res, err := h.svc.ByCode(c.Request.Context(), strings.ToLower(c.Param("slug")), c.Param("code"))
	answer(c, res, err)
}

// Logo handles GET /verify/logo/:slug — the clinic's logo for the check page.
func (h *Handlers) Logo(c *gin.Context) {
	mime, data, err := h.svc.Logo(c.Request.Context(), strings.ToLower(c.Param("slug")))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	// An image is only ever served as an image, whatever its bytes claim to be.
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "public, max-age=3600")
	c.Data(http.StatusOK, mime, data)
}
