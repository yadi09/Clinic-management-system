package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the messaging routes (the group already has RequireAuth).
//
// Two permissions, because two different people are involved. message.manage is
// the owner deciding how the clinic speaks to patients and what it spends;
// message.send is whoever actually writes to a patient today, which includes
// reception. Reading the log needs neither on its own — anyone who can send or
// manage can see what was sent, because "did we tell her?" is a front-desk
// question and hiding the answer from the front desk helps nobody.
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/messaging")
	manage := httpx.RequirePermission("message.manage")
	use := httpx.RequireAnyPermission("message.send", "message.manage")

	g.GET("/settings", use, h.GetSettings)
	g.PUT("/settings", manage, h.SaveSettings)
	g.GET("/usage", use, h.Usage)
	g.POST("/preview", use, h.Preview)
	g.GET("/log", use, h.Log)
	// A test send spends real money and reaches a real phone, so it sits with the
	// people allowed to message patients rather than with anyone who can log in.
	g.POST("/test", use, h.SendTest)

	// What the clinic says, and when. Wording and timing are policy, so they sit
	// with whoever runs the clinic rather than with whoever is on the desk today.
	g.GET("/templates", use, h.ListTemplates)
	g.PUT("/templates", manage, h.SaveTemplate)
	g.GET("/rules", use, h.ListRules)
	g.PUT("/rules", manage, h.SaveRule)
	g.GET("/variables", use, h.Variables)

	// A one-off message to chosen patients. Reception can send these — it is the
	// desk that knows a holiday is coming and who to tell.
	g.GET("/audience", use, h.Audience)
	g.POST("/campaigns", use, h.SendCampaign)
	// Chasing unbilled treatment is desk work, same permission as writing to
	// patients — the money facts come from the ledger, not the caller.
	g.POST("/unbilled-reminders", use, h.UnbilledReminders)

	// Trying again is the front desk's job — they are the ones who just corrected
	// the phone number that made it fail in the first place.
	g.POST("/messages/:id/resend", use, h.Resend)
	g.POST("/messages/:id/send-now", use, h.SendNow)
}
