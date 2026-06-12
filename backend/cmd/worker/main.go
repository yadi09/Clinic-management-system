// Command worker runs the asynchronous side of the platform: the transactional
// outbox relay (dispatching domain events to in-process handlers) and, in later
// phases, scheduled jobs (reminders, near-expiry alerts, report generation).
package main

import (
	"context"
	"os/signal"
	"syscall"
	"time"

	"github.com/reicb/clinicsaas/internal/kernel/audit"
	"github.com/reicb/clinicsaas/internal/kernel/config"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/logging"
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

	relay := events.NewRelay(db, reg, log)
	log.Info("worker started: outbox relay polling")
	relay.Run(ctx, time.Second)
	log.Info("worker stopped")
}
