// Command worker runs the asynchronous side of the platform: the transactional
// outbox relay (dispatching domain events to in-process handlers) and the patient
// message dispatcher (sending queued SMS).
package main

import (
	"context"
	"log/slog"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // embed the zoneinfo DB: the runtime image is distroless

	"github.com/reicb/clinicsaas/internal/kernel/audit"
	"github.com/reicb/clinicsaas/internal/kernel/config"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/logging"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
	"github.com/reicb/clinicsaas/internal/messaging"
	"github.com/reicb/clinicsaas/internal/messaging/dispatch"
	"github.com/reicb/clinicsaas/internal/notification/produce"
)

func main() {
	cfg, err := config.Load()
	log := logging.New(string(cfg.Env))
	if err != nil {
		log.Error("config load failed", "err", err)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := kerneldb.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("database connect failed", "err", err)
		return
	}
	defer db.Close()

	// Event handlers. The audit consumer records every event (FR-AUD-01).
	reg := events.NewRegistry()
	reg.OnAny(audit.NewWriter(db).EventHandler())

	// The message dispatcher drains one queue that spans every tenant, so it needs
	// the RLS-bypassing pool the platform module also uses. Without that DSN the
	// worker still runs — events keep flowing — but nothing is sent, and it says so
	// once at startup rather than failing silently every ten seconds.
	if cfg.PlatformDatabaseURL != "" {
		privDB, perr := kerneldb.Connect(ctx, cfg.PlatformDatabaseURL)
		if perr != nil {
			log.Error("privileged database connect failed — patient messages will not be sent", "err", perr)
		} else {
			defer privDB.Close()
			// One factory, resolved per message: each clinic sends through its own
			// campaign under its own approved sender name.
			gwf := messaging.NewGatewayFactory(cfg.MFAEncKey, cfg.SMS.BaseURL, gatewayFor(cfg, log), log)
			go dispatch.New(privDB, gwf, log).Run(ctx, 10*time.Second)
			// Delivery confirmation is a separate loop on a slower beat: it is
			// background work competing with sending for the account's shared rate
			// limit, and sending is what the patient is waiting for.
			go dispatch.NewReconciler(privDB, gwf, log).Run(ctx, 30*time.Second)

			// The planner turns appointments and unpaid bills into queued messages.
			// It only writes rows — the dispatcher's gates still decide whether any
			// of them leave the building, so there is one place that sends and one
			// place that decides when.
			planner := dispatch.NewPlanner(privDB, cfg.SMS.CostPerSegment, log)
			// Two minutes, not five. Nothing here is latency-critical, but a clinic
			// that books an appointment inside the reminder window and then watches
			// the log should see it appear while they are still looking.
			go planner.Run(ctx, 2*time.Minute)

			// The welcome message is event-driven instead: the card number is useful
			// while the patient is still at the desk, and a five-minute planner would
			// reach them after they had left.
			reg.On("patient.patient.registered", dispatch.WelcomeOnRegistration(planner))

			// In-app notifications (the bell). A missed visit becomes missed when its
			// day ends, not when someone clicks, so a timer finds it. Five minutes is
			// plenty: staff read these when they sign in, not to the second.
			go produce.NewMissedVisits(privDB, log).Run(ctx, 5*time.Minute)
			// A waiting patient is now, not tomorrow: every five seconds, over an
			// index that holds only the entries waiting right now.
			go produce.NewPatientWaiting(privDB, log).Run(ctx, 5*time.Second)

			log.Info("worker started: dispatcher, delivery reconciler, reminder planner and notifications")
		}
	} else {
		log.Warn("PLATFORM_DATABASE_URL unset — patient messages will not be sent")
	}

	// Built after the handlers are registered, so the welcome handler is in place
	// before the first event is drained.
	relay := events.NewRelay(db, reg, log)
	log.Info("worker started: outbox relay polling")
	relay.Run(ctx, time.Second)
	log.Info("worker stopped")
}

// gatewayFor picks the delivery adapter. Without a key it is the log adapter,
// which reports Live() == false — the dispatcher then records messages as skipped
// rather than sent, so the clinic's log never claims a patient was contacted when
// nothing left the building.
func gatewayFor(cfg config.Config, log *slog.Logger) sms.Gateway {
	if cfg.SMS.Configured() {
		log.Info("sms gateway configured", "gateway", "smsethiopia")
		return sms.NewEthiopiaGateway(cfg.SMS.APIKey, cfg.SMS.BaseURL, log)
	}
	log.Warn("SMS_API_KEY unset — queued messages will be skipped as not configured")
	return sms.NewLogGateway(log)
}
