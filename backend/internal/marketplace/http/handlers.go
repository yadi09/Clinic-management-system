// Package http exposes the marketplace: public browse and contact, the seller's own
// portal behind a session token, and the vendor's approval console behind platform.admin.
package http

import (
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/marketplace"
)

// Handlers serves the marketplace endpoints.
type Handlers struct{ svc marketplace.Service }

// New constructs the handlers.
func New(svc marketplace.Service) *Handlers { return &Handlers{svc: svc} }

const sellerKey = "mp.seller"

// requireSeller resolves X-Marketplace-Token. The token travels in a header, not the
// URL, so it stays out of logs and browser history.
func (h *Handlers) requireSeller() gin.HandlerFunc {
	return func(c *gin.Context) {
		sel, err := h.svc.Authenticate(c.Request.Context(), strings.TrimSpace(c.GetHeader("X-Marketplace-Token")))
		if err != nil {
			httpx.Fail(c, err)
			c.Abort()
			return
		}
		c.Set(sellerKey, sel)
		c.Next()
	}
}

func seller(c *gin.Context) marketplace.Seller { return c.MustGet(sellerKey).(marketplace.Seller) }

func pathID(c *gin.Context) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		httpx.Fail(c, apperr.NotFound("not_found", "not found"))
		return uuid.Nil, false
	}
	return id, true
}

// Meta handles GET /marketplace/meta — the lists the forms and filters share.
func (h *Handlers) Meta(c *gin.Context) {
	httpx.OK(c, gin.H{
		"categories": marketplace.Categories,
		"conditions": marketplace.Conditions,
		"kinds":      marketplace.Kinds,
	})
}

// Browse handles GET /marketplace/listings.
func (h *Handlers) Browse(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	offset, _ := strconv.Atoi(c.Query("offset"))
	out, err := h.svc.Browse(c.Request.Context(), marketplace.Query{
		Text: c.Query("q"), Category: c.Query("category"), Condition: c.Query("condition"),
		City: c.Query("city"), Limit: limit, Offset: offset,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Get handles GET /marketplace/listings/:id.
func (h *Handlers) Get(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	out, err := h.svc.Get(c.Request.Context(), id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Contact handles POST /marketplace/listings/:id/contact.
func (h *Handlers) Contact(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	var req struct {
		Channel string `json:"channel"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("choose how to contact the seller"))
		return
	}
	out, err := h.svc.Contact(c.Request.Context(), id, req.Channel)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

type signupReq struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Telegram string `json:"telegram"`
	City     string `json:"city"`
	Subcity  string `json:"subcity"`
	About    string `json:"about"`
	Password string `json:"password"`
	Website  string `json:"website"` // honeypot
}

func (r signupReq) input() marketplace.SellerSignup {
	return marketplace.SellerSignup{Kind: r.Kind, Name: r.Name, Phone: r.Phone, Telegram: r.Telegram,
		City: r.City, Subcity: r.Subcity, About: r.About, Password: r.Password, Honeypot: r.Website}
}

// SignUp handles POST /marketplace/sellers/signup.
func (h *Handlers) SignUp(c *gin.Context) {
	var req signupReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("please fill in the form"))
		return
	}
	out, err := h.svc.SignUp(c.Request.Context(), req.input())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, out)
}

// Login handles POST /marketplace/sellers/login.
func (h *Handlers) Login(c *gin.Context) {
	var req struct {
		Phone    string `json:"phone"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("enter your phone number and password"))
		return
	}
	out, err := h.svc.Login(c.Request.Context(), req.Phone, req.Password)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// Me handles GET /marketplace/me.
func (h *Handlers) Me(c *gin.Context) { httpx.OK(c, seller(c)) }

// UpdateMe handles PUT /marketplace/me.
func (h *Handlers) UpdateMe(c *gin.Context) {
	var req signupReq
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("please fill in the form"))
		return
	}
	out, err := h.svc.UpdateProfile(c.Request.Context(), seller(c).ID, req.input())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// MyListings handles GET /marketplace/my/listings.
func (h *Handlers) MyListings(c *gin.Context) {
	out, err := h.svc.MyListings(c.Request.Context(), seller(c).ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// SaveListing handles POST /marketplace/my/listings and PUT .../:id.
func (h *Handlers) SaveListing(c *gin.Context) {
	var in marketplace.ListingInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, apperr.Validation("please fill in the listing"))
		return
	}
	var idp *uuid.UUID
	if c.Param("id") != "" {
		id, ok := pathID(c)
		if !ok {
			return
		}
		idp = &id
	}
	out, err := h.svc.SaveListing(c.Request.Context(), seller(c).ID, idp, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	if idp == nil {
		httpx.Created(c, out)
		return
	}
	httpx.OK(c, out)
}

// DeleteListing handles DELETE /marketplace/my/listings/:id.
func (h *Handlers) DeleteListing(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	if err := h.svc.DeleteListing(c.Request.Context(), seller(c).ID, id); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// SignPhoto handles POST /marketplace/my/photos/sign.
func (h *Handlers) SignPhoto(c *gin.Context) {
	out, err := h.svc.SignPhoto(c.Request.Context(), seller(c).ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// MyStats handles GET /marketplace/my/stats.
func (h *Handlers) MyStats(c *gin.Context) {
	out, err := h.svc.MyStats(c.Request.Context(), seller(c).ID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// ---- vendor console ---------------------------------------------------------

// AdminSellers handles GET /platform/marketplace/sellers.
func (h *Handlers) AdminSellers(c *gin.Context) {
	out, err := h.svc.AdminSellers(c.Request.Context(), c.Query("status"))
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// AdminSetStatus handles POST /platform/marketplace/sellers/:id/status.
func (h *Handlers) AdminSetStatus(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	var req struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("choose a status"))
		return
	}
	if err := h.svc.AdminSetStatus(c.Request.Context(), id, req.Status, req.Note); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminListings handles GET /platform/marketplace/listings.
func (h *Handlers) AdminListings(c *gin.Context) {
	out, err := h.svc.AdminListings(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}

// AdminSetListingStatus handles POST /platform/marketplace/listings/:id/status.
func (h *Handlers) AdminSetListingStatus(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, apperr.Validation("choose a status"))
		return
	}
	if err := h.svc.AdminSetListingStatus(c.Request.Context(), id, req.Status); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// AdminStats handles GET /platform/marketplace/stats.
func (h *Handlers) AdminStats(c *gin.Context) {
	out, err := h.svc.AdminStats(c.Request.Context())
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, out)
}
