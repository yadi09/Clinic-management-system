package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// Register mounts the campaign routes.
//
// The public half is unauthenticated by necessity — a dental clinic answering
// these questions has no account and may never have one. It is protected by the
// unguessable code in the URL, the per-IP rate limit the whole v1 group carries,
// a honeypot field, and by never sending the browser anything it should not know:
// not which answer is right, and not the seed until the draw is over.
func (h *Handlers) Register(v1 *gin.RouterGroup, tokens *auth.TokenService) {
	pub := v1.Group("/campaigns/:code")
	pub.GET("", h.Public)
	pub.POST("/enter", h.Enter)
	pub.GET("/me", h.Resume)
	pub.GET("/questions", h.Questions)
	pub.POST("/answer", h.Answer)
	pub.POST("/spin", h.Spin)

	adm := v1.Group("/platform/campaigns",
		httpx.RequireAuth(tokens), httpx.RequirePermission("platform.admin"))
	adm.GET("", h.AdminList)
	adm.GET("/:id", h.AdminGet)
	adm.PUT("/:id", h.AdminSave)
	adm.POST("/:id/open", h.AdminOpen)
	adm.POST("/:id/close", h.AdminClose)
	adm.POST("/:id/reset", h.AdminReset)
	adm.GET("/:id/questions", h.AdminQuestions)
	adm.POST("/:id/questions", h.AdminSaveQuestion)
	adm.PUT("/:id/questions/:qid", h.AdminSaveQuestion)
	adm.DELETE("/:id/questions/:qid", h.AdminDeleteQuestion)
	adm.GET("/:id/prizes", h.AdminPrizes)
	adm.POST("/:id/prizes", h.AdminSavePrize)
	adm.PUT("/:id/prizes/:pid", h.AdminSavePrize)
	adm.DELETE("/:id/prizes/:pid", h.AdminDeletePrize)
	adm.GET("/:id/entries", h.AdminEntries)
	adm.GET("/:id/missed", h.AdminMissed)
}
