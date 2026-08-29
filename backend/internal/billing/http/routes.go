package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the billing routes (group must already have
// RequireAuth). The card fee is collected at reception (payment.collect).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	g := rg.Group("/billing/card", httpx.RequirePermission("payment.collect"))
	g.GET("/assess", h.Assess)
	g.POST("/collect", h.Collect)
	g.GET("/history", h.History)

	// Billing-1: service catalog (admin), charges + cashier, finance view.
	b := rg.Group("/billing")
	mgr := httpx.RequirePermission("billing.manage")
	b.GET("/services", h.ListServices) // readable by any authenticated staff (to price a charge)
	// Dentists maintain the dental list themselves; the handler checks the category
	// against the caller, so this middleware only has to let both kinds through.
	catalog := httpx.RequireAnyPermission("billing.manage", "dental.manage")
	b.POST("/services", catalog, h.CreateService)
	b.PUT("/services/:id", catalog, h.UpdateService)
	b.PUT("/services/:id/active", mgr, h.SetServiceActive)
	b.PUT("/services/:id/default", mgr, h.SetServiceDefault)
	b.GET("/services/:id/providers", mgr, h.GetServiceProviders)
	b.PUT("/services/:id/providers", mgr, h.SetServiceProviders)
	b.DELETE("/services/:id", mgr, h.DeleteService)
	b.GET("/providers", httpx.RequirePermission("payment.charge"), h.ProvidersForServices) // reception's filtered list

	// Payment is split by capability: payment.charge raises a charge (reception),
	// payment.collect settles it (cashier). A user with both collects inline.
	charge := httpx.RequirePermission("payment.charge")
	collect := httpx.RequirePermission("payment.collect")
	b.POST("/charges", charge, h.RaiseCharge)
	b.POST("/charges/batch", charge, h.RaiseChargeBatch)                                                                   // reception registers a whole visit at once (guards duplicates)
	b.GET("/charges/pending", collect, h.PendingCharges)                                                                   // the cashier worklist
	b.GET("/charges", httpx.RequireAnyPermission("payment.charge", "payment.collect", "billing.manage"), h.PatientCharges) // ?patient=
	// Asking the bank about a claimed transfer is part of taking the payment, so it
	// carries the same permission as taking it.
	b.POST("/verify-payment", collect, h.VerifyPayment)
	b.GET("/verify-payment/status", collect, h.PaymentVerificationStatus)

	b.POST("/charges/:id/settle", collect, h.SettleCharge)
	b.POST("/checkout", collect, h.SettleVisit) // one-click visit checkout (settle all a patient's charges)
	b.GET("/payments", collect, h.Payments)     // cashier's "Paid today" list (by receipt)
	b.POST("/refund-visit", mgr, h.RefundVisit) // refund an entire receipt (manager-gated)
	// Treat now, bill later. The same authority as waiving, because deciding a
	// patient may owe the clinic money is the same class of decision as deciding they
	// never will — and the desk should have to ask someone either way.
	b.POST("/patients/:id/defer", httpx.RequirePermission("payment.waive"), h.DeferVisit)
	b.POST("/charges/:id/waive", httpx.RequirePermission("payment.waive"), h.WaiveCharge)
	b.POST("/charges/:id/void", httpx.RequirePermission("payment.waive"), h.VoidCharge) // retire a pending charge (mistake / patient left)
	b.POST("/charges/:id/refund", mgr, h.RefundCharge)                                  // reverse a settled charge (manager-gated)
	b.GET("/waiver-reasons", httpx.RequireAnyPermission("payment.collect", "payment.waive"), h.WaiverReasons)

	b.GET("/cash", mgr, h.Cash) // owner/manager finance view

	// Cash control (BILL-B): a cashier closes their own drawer; finance sees all.
	b.GET("/day-close", collect, h.DayClose)
	b.GET("/day-closes", collect, h.DayCloses)
	b.POST("/day-close", collect, h.CloseDay)
	b.GET("/reconciliations", httpx.RequireAnyPermission("payment.collect", "billing.manage"), h.Reconciliations)
}
