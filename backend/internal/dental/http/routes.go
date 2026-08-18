package http

import (
	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/httpx"
)

// RegisterProtected mounts the dental routes (bearer-authenticated group), all
// behind the per-clinic "dental" module flag. Permissions are split three ways:
//
//   - dental.manage — the clinical record: tooth chart, plans, visit notes, images.
//     The dentist only.
//   - dental.read   — view the chart, plans, session dates and balance. The front
//     desk needs this to answer "when do I come back?" and "what do I owe?".
//   - payment.charge — put a session's fee on the cashier's queue. Reception can do
//     this so a patient can pay for sessions without waiting for the dentist.
//     Settling the money is still payment.collect (the cashier).
func (h *Handlers) RegisterProtected(rg *gin.RouterGroup) {
	d := rg.Group("/dental", httpx.RequireFlag("dental"))

	// --- read: clinician or front desk ---
	view := d.Group("", httpx.RequireAnyPermission("dental.manage", "dental.read"))
	view.GET("/outstanding", h.Outstanding)
	view.GET("/patients/:id/summary", h.Summary)
	view.GET("/patients/:id/chart", h.GetChart)
	view.GET("/patients/:id/plans", h.ListPlans)
	view.GET("/patients/:id/images", h.ListImages)

	// Clinic calendar overlay: dental sessions in a date range — also useful to
	// whoever books appointments.
	d.GET("/sessions", httpx.RequireAnyPermission("appointment.manage", "dental.manage", "dental.read"), h.SessionsCalendar)

	// Treatment given and never billed — clinic-wide. This is the control that
	// replaced the rule requiring payment before a visit could be recorded, so it
	// follows the money permissions, plus the dentist who has to confirm what was
	// actually done.
	d.GET("/unbilled", httpx.RequireAnyPermission("payment.charge", "payment.collect", "dental.manage"), h.UnbilledTreatment)

	// --- billing a session: the dentist or the front desk ---
	bill := d.Group("", httpx.RequireAnyPermission("dental.manage", "payment.charge"))
	bill.POST("/patients/:id/sessions/:sid/collect", h.CollectSession)
	bill.POST("/patients/:id/sessions/:sid/uncollect", h.UncollectSession)
	// Take payment for several sessions at once (e.g. the patient settles the whole
	// treatment plan at the desk).
	bill.POST("/patients/:id/collect-sessions", h.CollectSessions)
	// --- forgiving a fee: payment.waive, the same as everywhere else ---
	//
	// These shipped inside the `bill` group (dental.manage OR payment.charge), which
	// handed the power to extinguish a fee to every dentist and receptionist. The
	// product already has one permission for that act — payment.waive, held by the
	// cashier, the branch manager and the owner — and POST /billing/charges/:id/waive
	// is gated on it. A dental write-off is the same act by another door, so it uses
	// the same key. If a clinic wants its dentists to forgive fees, that is a role
	// grant somebody makes on purpose, not something dental.manage quietly implies.
	waive := d.Group("", httpx.RequirePermission("payment.waive"))
	waive.POST("/patients/:id/sessions/:sid/write-off", h.WriteOffSession)
	waive.POST("/patients/:id/sessions/:sid/undo-write-off", h.UndoWriteOff)

	// --- rescheduling a session: the dentist or whoever books appointments ---
	// Moving a session is a scheduling act, not a clinical one, so appointment.manage
	// is enough — the receptionist role already carries it. The route takes a date and
	// nothing else, so this cannot become a back door into the clinical record; the
	// full UpdateSession below stays dental.manage.
	sched := d.Group("", httpx.RequireAnyPermission("dental.manage", "appointment.manage"))
	sched.POST("/patients/:id/sessions/:sid/reschedule", h.RescheduleSession)

	// --- write: the clinical record, dentist only ---
	g := d.Group("", httpx.RequirePermission("dental.manage"))
	g.PUT("/patients/:id/chart", h.SaveChart)

	// Medical history is clinical and sensitive — read AND write sit with the
	// clinician, and it is deliberately absent from Summary so the front desk's
	// read access can never surface it.
	g.GET("/patients/:id/medical-history", h.GetMedicalHistory)
	g.PUT("/patients/:id/medical-history", h.SaveMedicalHistory)

	// Examinations — the clinical assessment (complaint, findings, diagnosis).
	// Clinician only, and absent from Summary, for the same reason as medical
	// history: the front desk's read access must never reach the clinical record.
	g.GET("/patients/:id/exams", h.ListExams)
	g.POST("/patients/:id/exams", h.CreateExam)
	g.PUT("/patients/:id/exams/:eid", h.UpdateExam)
	g.DELETE("/patients/:id/exams/:eid", h.DeleteExam)

	// Treatment plans (scheduled, milestone sessions).
	g.POST("/patients/:id/plans", h.CreatePlan)
	g.PUT("/patients/:id/plans/:pid", h.UpdatePlan)
	g.DELETE("/patients/:id/plans/:pid", h.DeletePlan)
	// A course that overruns gains a visit; one that seals early is closed. Both are
	// clinical decisions about the treatment, so they sit with the dentist.
	g.POST("/patients/:id/plans/:pid/sessions", h.AddSession)
	g.POST("/patients/:id/plans/:pid/finish", h.FinishCourse)

	g.PUT("/patients/:id/sessions/:sid", h.UpdateSession)
	// Changing a visit's price re-spreads the course, so it sits with the dentist who
	// decides the work — the same permission as recording it.
	g.POST("/patients/:id/sessions/:sid/reprice", h.RepriceSession)
	g.POST("/patients/:id/sessions/:sid/pay-later", h.SetPayLater)
	// Extras: an X-ray taken at visit 3, a filling decided at the chair. Clinical,
	// because deciding the patient needs it is a clinical act — the price attached
	// to it comes from the clinic's list, not from whoever is typing.
	g.POST("/patients/:id/sessions/:sid/extras", h.AddExtra)
	g.DELETE("/patients/:id/extras/:exid", h.RemoveExtra)

	// Prescriptions (printable) attached to a session.
	g.POST("/patients/:id/sessions/:sid/prescriptions", h.AddPrescription)
	g.DELETE("/patients/:id/prescriptions/:rxid", h.DeletePrescription)

	g.POST("/patients/:id/images/sign", h.SignImageUpload)
	g.POST("/patients/:id/images", h.RecordImage)
	g.DELETE("/patients/:id/images/:aid", h.DeleteImage)
}
