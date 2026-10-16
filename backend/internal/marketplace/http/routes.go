package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Register mounts the marketplace routes.
//
// Browsing and contacting are public by design: the point is that a dentist who is
// not on ClinicOS yet can find a supplier. Contact numbers are only handed out by
// POST .../contact, so every lead is counted. Posting needs a seller session, and
// nothing a seller posts is public until the vendor has approved them.
func (h *Handlers) Register(v1 *gin.RouterGroup, tokens *auth.TokenService) {
	m := v1.Group("/marketplace")
	m.GET("/meta", h.Meta)
	m.GET("/listings", h.Browse)
	m.GET("/listings/:id", h.Get)
	m.POST("/listings/:id/contact", h.Contact)
	m.GET("/stores/:slug", h.Store)
	m.POST("/sellers/signup", h.SignUp)
	m.POST("/sellers/login", h.Login)

	me := m.Group("", h.requireSeller())
	me.GET("/me", h.Me)
	me.PUT("/me", h.UpdateMe)
	me.PUT("/my/slug", h.ChangeSlug)
	me.GET("/my/stats", h.MyStats)
	me.GET("/my/listings", h.MyListings)
	me.POST("/my/listings", h.SaveListing)
	me.PUT("/my/listings/:id", h.SaveListing)
	me.DELETE("/my/listings/:id", h.DeleteListing)
	me.POST("/my/photos/sign", h.SignPhoto)

	adm := v1.Group("/platform/marketplace",
		httpx.RequireAuth(tokens), httpx.RequirePermission("platform.admin"))
	adm.GET("/stats", h.AdminStats)
	adm.GET("/sellers", h.AdminSellers)
	adm.POST("/sellers/:id/status", h.AdminSetStatus)
	adm.GET("/listings", h.AdminListings)
	adm.POST("/listings/:id/status", h.AdminSetListingStatus)
}
