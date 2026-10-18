// Command api runs the HTTP API server for the modular monolith. Phase 0 wires
// the kernel (config, db, auth, tenancy, storage, rate limiting), the standard
// middleware chain, health/metrics endpoints, and the identity module routes.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // embed the zoneinfo DB: the runtime image is distroless

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/ai"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	"github.com/reicb/clinicsaas/internal/kernel/config"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/logging"
	"github.com/reicb/clinicsaas/internal/kernel/notify"
	"github.com/reicb/clinicsaas/internal/kernel/ratelimit"
	"github.com/reicb/clinicsaas/internal/kernel/sms"
	"github.com/reicb/clinicsaas/internal/kernel/storage"
	"github.com/reicb/clinicsaas/internal/kernel/transcribe"
	"github.com/reicb/clinicsaas/internal/kernel/verifyet"
	"github.com/reicb/clinicsaas/internal/platform"

	billinghttp "github.com/reicb/clinicsaas/internal/billing/http"
	billingservice "github.com/reicb/clinicsaas/internal/billing/service"
	campaignhttp "github.com/reicb/clinicsaas/internal/campaign/http"
	campaignservice "github.com/reicb/clinicsaas/internal/campaign/service"
	clinicalhttp "github.com/reicb/clinicsaas/internal/clinical/http"
	clinicalservice "github.com/reicb/clinicsaas/internal/clinical/service"
	crmhttp "github.com/reicb/clinicsaas/internal/crm/http"
	crmservice "github.com/reicb/clinicsaas/internal/crm/service"
	dashboardhttp "github.com/reicb/clinicsaas/internal/dashboard/http"
	dashboardservice "github.com/reicb/clinicsaas/internal/dashboard/service"
	dentalhttp "github.com/reicb/clinicsaas/internal/dental/http"
	dentalservice "github.com/reicb/clinicsaas/internal/dental/service"
	financehttp "github.com/reicb/clinicsaas/internal/finance/http"
	financeservice "github.com/reicb/clinicsaas/internal/finance/service"
	identityhttp "github.com/reicb/clinicsaas/internal/identity/http"
	identityservice "github.com/reicb/clinicsaas/internal/identity/service"
	inpatienthttp "github.com/reicb/clinicsaas/internal/inpatient/http"
	inpatientservice "github.com/reicb/clinicsaas/internal/inpatient/service"
	labhttp "github.com/reicb/clinicsaas/internal/lab/http"
	labservice "github.com/reicb/clinicsaas/internal/lab/service"
	marketplacehttp "github.com/reicb/clinicsaas/internal/marketplace/http"
	marketplaceservice "github.com/reicb/clinicsaas/internal/marketplace/service"
	maternityhttp "github.com/reicb/clinicsaas/internal/maternity/http"
	maternityservice "github.com/reicb/clinicsaas/internal/maternity/service"
	"github.com/reicb/clinicsaas/internal/messaging"
	messaginghttp "github.com/reicb/clinicsaas/internal/messaging/http"
	messagingservice "github.com/reicb/clinicsaas/internal/messaging/service"
	notificationhttp "github.com/reicb/clinicsaas/internal/notification/http"
	notificationservice "github.com/reicb/clinicsaas/internal/notification/service"
	orghttp "github.com/reicb/clinicsaas/internal/org/http"
	orgservice "github.com/reicb/clinicsaas/internal/org/service"
	patienthttp "github.com/reicb/clinicsaas/internal/patient/http"
	patientservice "github.com/reicb/clinicsaas/internal/patient/service"
	pharmacyhttp "github.com/reicb/clinicsaas/internal/pharmacy/http"
	pharmacyservice "github.com/reicb/clinicsaas/internal/pharmacy/service"
	platformhttp "github.com/reicb/clinicsaas/internal/platform/http"
	platformservice "github.com/reicb/clinicsaas/internal/platform/service"
	reportinghttp "github.com/reicb/clinicsaas/internal/reporting/http"
	reportingservice "github.com/reicb/clinicsaas/internal/reporting/service"
	schedulinghttp "github.com/reicb/clinicsaas/internal/scheduling/http"
	schedulingservice "github.com/reicb/clinicsaas/internal/scheduling/service"
	verificationhttp "github.com/reicb/clinicsaas/internal/verification/http"
	verificationservice "github.com/reicb/clinicsaas/internal/verification/service"
	portalhttp "github.com/reicb/clinicsaas/internal/portal/http"
	portalservice "github.com/reicb/clinicsaas/internal/portal/service"
)

func main() {
	cfg, cfgErr := config.Load()
	log := logging.New(string(cfg.Env))
	if cfgErr != nil {
		log.Error("config load failed", "err", cfgErr)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := connectWithRetry(ctx, cfg.DatabaseURL, 10, 2*time.Second)
	if err != nil {
		log.Error("database connect failed", "err", err)
		return
	}
	defer db.Close()

	store := buildStorage(cfg, log)
	log.Info("storage provider", "name", store.Name())

	tokens := auth.NewTokenService(cfg.JWTSecret, cfg.JWTIssuer, cfg.AccessTokenTTL)
	limiter := ratelimit.NewInProcess(cfg.RateLimitRPS, cfg.RateLimitBurst)
	publisher := events.NewOutboxPublisher()

	// Identity module.
	authSvc := identityservice.NewAuthService(db, tokens, publisher, identityservice.AuthConfig{
		AccessTTL:       cfg.AccessTokenTTL,
		RefreshTTL:      cfg.RefreshTokenTTL,
		MaxFailedLogins: cfg.MaxFailedLogins,
		LockoutDuration: cfg.LockoutDuration,
		MFAEncKey:       cfg.MFAEncKey,
		Issuer:          cfg.JWTIssuer,
	})
	userSvc := identityservice.NewUserService(db, notify.NewLogProvider(log), identityservice.UserConfig{
		AppBaseURL: cfg.AppBaseURL,
		InviteTTL:  cfg.InviteTTL,
	})
	httpx.SetAccountGuard(authSvc.CheckActive)
	identityHandlers := identityhttp.NewHandlers(authSvc, userSvc, identityhttp.Options{
		SecureCookies: cfg.IsProd(),
		CookiePath:    "/api/v1/auth",
	})

	// Org + Patient + Scheduling + Billing + Clinical modules.
	orgHandlers := orghttp.NewHandlers(orgservice.NewService(db))
	patientSvc := patientservice.NewService(db, store, publisher)
	patientHandlers := patienthttp.NewHandlers(patientSvc)
	billingSvc := billingservice.NewService(db, publisher)
	billingHandlers := billinghttp.NewHandlers(billingSvc)
	// Scheduling bills the default intake charge through billing so walk-in / check-in
	// are gated on payment (no free bypass of the cashier).
	schedulingHandlers := schedulinghttp.NewHandlers(schedulingservice.NewService(db, publisher, billingSvc), db)
	transcriber := transcribe.New(cfg.Transcription.DeepgramAPIKey, cfg.Transcription.Model, cfg.Transcription.Language)
	assistant := ai.New(cfg.AI.APIKey, cfg.AI.Model, cfg.AI.BaseURL)
	clinicalHandlers := clinicalhttp.NewHandlers(clinicalservice.NewService(db, publisher), transcriber, assistant, store)
	// DHIS2 (Ministry of Health) reporting — each clinic connects its own DHIS2
	// account in Settings; the token is stored encrypted with the MFA key.
	reportingHandlers := reportinghttp.NewHandlers(reportingservice.NewService(db, cfg.MFAEncKey))
	maternityHandlers := maternityhttp.NewHandlers(maternityservice.NewService(db, publisher))
	inpatientHandlers := inpatienthttp.NewHandlers(inpatientservice.NewService(db, publisher, billingSvc))
	dentalSvc := dentalservice.NewService(db, publisher, billingSvc, store)
	dentalHandlers := dentalhttp.NewHandlers(dentalSvc)
	// Finance reads the charge ledger, plus the two figures only dental can answer
	// (treatment delivered and never billed, and the forward book).
	financeSvc := financeservice.NewService(db, financeservice.NewDentalAdapter(db))
	financeHandlers := financehttp.NewHandlers(financeSvc)
	// Patient messaging. One platform SMS account serves every clinic, so the
	// gateway is built once here; with no key configured it is the log adapter and
	// every surface says "not connected" rather than implying patients were reached.
	// Each clinic sends through its own campaign, so the gateway is resolved per
	// clinic from a key encrypted with the same MFA key that protects TOTP secrets
	// and DHIS2 tokens.
	smsFactory := messaging.NewGatewayFactory(cfg.MFAEncKey, cfg.SMS.BaseURL, smsGatewayFor(cfg, log), log)
	messagingHandlers := messaginghttp.NewHandlers(
		messagingservice.New(db, smsFactory, cfg.MFAEncKey, cfg.SMS.CostPerSegment))
	// Lab & pharmacy bill through billing (Charger) so revenue reaches the cashier.
	pharmacyHandlers := pharmacyhttp.NewHandlers(pharmacyservice.NewService(db, publisher, billingSvc))
	labHandlers := labhttp.NewHandlers(labservice.NewService(db, publisher, billingSvc))
	// The home screen. Reads money from the finance service rather than querying for
	// it, so the dashboard and the Finance page cannot drift apart.
	dashboardHandlers := dashboardhttp.NewHandlers(dashboardservice.NewService(db, financeSvc))

	// Platform (super-admin) layer: provisions tenants across the RLS boundary via a
	// dedicated privileged connection. Disabled when PLATFORM_DATABASE_URL is unset.
	var platformHandlers *platformhttp.Handlers
	var crmHandlers *crmhttp.Handlers
	if cfg.PlatformDatabaseURL != "" {
		platformDB, perr := connectWithRetry(ctx, cfg.PlatformDatabaseURL, 10, 2*time.Second)
		if perr != nil {
			log.Error("platform db connect failed; platform surface disabled", "err", perr)
		} else {
			defer platformDB.Close()
			platformSvc := platformservice.NewService(platformDB, tokens, cfg.MFAEncKey)
			platformHandlers = platformhttp.NewHandlers(platformSvc)
			// The vendor's own sales pipeline shares the privileged connection: it is
			// business data, not clinic data, and lives above the tenant boundary.
			crmHandlers = crmhttp.NewHandlers(crmservice.NewService(platformDB))
			log.Info("platform (super-admin) surface enabled")

			// Receipt verification. The key is entered in the super-admin console and
			// stored encrypted, so it is resolved per call rather than read once here:
			// adding, rotating or clearing it takes effect without a deploy. The env
			// var stays as a fallback for a deployment that prefers it.
			billingSvc.WithVerifier(verifyet.NewResolving(
				func(c context.Context) (string, error) {
					return platformSvc.LookupSecret(c, platform.SettingVerifyETKey)
				},
				cfg.VerifyET.APIKey, cfg.VerifyET.BaseURL, log), cfg.VerifyET.WaitMs)
			log.Info("receipt verification wired", "base_url", cfg.VerifyET.BaseURL,
				"env_key_present", cfg.VerifyET.Configured())
		}
	}

	campaignHandlers := campaignhttp.New(campaignservice.New(db))
	marketplaceHandlers := marketplacehttp.New(marketplaceservice.New(db, store))
	// A paper's check: tokens are derived from the prescription and the server secret,
	// so a reprint carries the same QR. Typing a short code by hand is rate limited
	// separately from the rest of the API (a person needs a few tries, not hundreds).
	verificationHandlers := verificationhttp.New(
		verificationservice.New(db, cfg.JWTSecret), ratelimit.NewInProcess(0.2, 8))
	notificationHandlers := notificationhttp.NewHandlers(notificationservice.NewService(db))
	// The patient's own page. Signing in is limited per address: a card number is a weak
	// secret, so guessing one must be slow.
	portalHandlers := portalhttp.New(portalservice.New(db, dentalSvc, cfg.JWTSecret), ratelimit.NewInProcess(0.2, 6))

	r := newRouter(cfg, log, db, tokens, limiter, identityHandlers, orgHandlers, patientHandlers, schedulingHandlers, billingHandlers, clinicalHandlers, reportingHandlers, dashboardHandlers, maternityHandlers, inpatientHandlers, dentalHandlers, messagingHandlers, pharmacyHandlers, labHandlers, financeHandlers, platformHandlers, crmHandlers, campaignHandlers, marketplaceHandlers, notificationHandlers, verificationHandlers, portalHandlers)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("api listening", "addr", cfg.HTTPAddr, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("api shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err)
	}
}

func newRouter(
	cfg config.Config,
	log *slog.Logger,
	db *kerneldb.DB,
	tokens *auth.TokenService,
	limiter ratelimit.Limiter,
	identityHandlers *identityhttp.Handlers,
	orgHandlers *orghttp.Handlers,
	patientHandlers *patienthttp.Handlers,
	schedulingHandlers *schedulinghttp.Handlers,
	billingHandlers *billinghttp.Handlers,
	clinicalHandlers *clinicalhttp.Handlers,
	reportingHandlers *reportinghttp.Handlers,
	dashboardHandlers *dashboardhttp.Handlers,
	maternityHandlers *maternityhttp.Handlers,
	inpatientHandlers *inpatienthttp.Handlers,
	dentalHandlers *dentalhttp.Handlers,
	messagingHandlers *messaginghttp.Handlers,
	pharmacyHandlers *pharmacyhttp.Handlers,
	labHandlers *labhttp.Handlers,
	financeHandlers *financehttp.Handlers,
	platformHandlers *platformhttp.Handlers,
	crmHandlers *crmhttp.Handlers,
	campaignHandlers *campaignhttp.Handlers,
	marketplaceHandlers *marketplacehttp.Handlers,
	notificationHandlers *notificationhttp.Handlers,
	verificationHandlers *verificationhttp.Handlers,
	portalHandlers *portalhttp.Handlers,
) *gin.Engine {
	if cfg.IsProd() {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(
		httpx.Recovery(log),
		httpx.WithRequestID(),
		httpx.AccessLog(log),
		httpx.CORS(cfg.CORSAllowedOrigins),
	)

	// Operational endpoints (unauthenticated).
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/readyz", func(c *gin.Context) {
		if err := db.Healthy(c.Request.Context()); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})
	r.GET("/metrics", func(c *gin.Context) {
		c.Header("Content-Type", "text/plain; version=0.0.4")
		c.String(http.StatusOK, "# HELP app_up 1 if the app is up\n# TYPE app_up gauge\napp_up 1\n")
	})

	// Versioned API.
	v1 := r.Group("/api/v1")
	v1.Use(httpx.RateLimit(limiter))
	identityHandlers.RegisterPublic(v1) // /auth/login, /auth/refresh, /auth/mfa, /auth/logout
	if platformHandlers != nil {
		platformHandlers.Register(v1, tokens) // /platform/auth/login (public) + /platform/clinics (platform.admin)
	}
	marketplaceHandlers.Register(v1, tokens) // public /marketplace/... + seller portal + /platform/marketplace/...
	campaignHandlers.Register(v1, tokens)    // public /campaigns/:code/... + /platform/campaigns/...
	portalHandlers.RegisterPublic(v1)        // public /portal/:slug/login|me: the patient's own page
	verificationHandlers.RegisterPublic(v1)  // public /verify/t|c|logo/...: check a printed paper
	if crmHandlers != nil {
		crmHandlers.Register(v1, tokens) // /platform/crm/... (crm.work; campaigns + accounts need platform.admin)
	}
	protected := v1.Group("", httpx.RequireAuth(tokens))     // requires a valid access token
	identityHandlers.RegisterProtected(protected)            // /auth/me
	verificationHandlers.RegisterProtected(protected)        // /verify/issue
	portalHandlers.RegisterProtected(protected)              // /portal-settings
	orgHandlers.RegisterProtected(protected)                 // /org/...
	patientHandlers.RegisterProtected(protected)             // /patients/...
	schedulingHandlers.RegisterProtected(protected)          // /appointments/..., /queue/..., /worklist
	billingHandlers.RegisterProtected(protected)             // /billing/card/...
	clinicalHandlers.RegisterProtected(protected)            // /visits/..., /encounters/..., /diagnosis-*
	reportingHandlers.RegisterProtected(protected)           // /reporting/dhis2/...
	maternityHandlers.RegisterProtected(protected)           // /dating/preview, /patients/:id/dating[/history]
	inpatientHandlers.RegisterProtected(protected)           // /inpatient/wards, /beds, /board, /admissions, /report
	dentalHandlers.RegisterProtected(protected)              // /dental/patients/:id/{chart,treatments,visits,summary,charge}, /dental/outstanding
	messagingHandlers.RegisterProtected(protected)           // /messaging/{settings,usage,preview,log,test}
	pharmacyHandlers.RegisterProtected(protected)            // /pharmacy/...
	labHandlers.RegisterProtected(protected)                 // /lab/...
	dashboardHandlers.RegisterProtected(protected)           // /dashboard/today
	financehttp.Register(protected, financeHandlers, tokens) // /finance/overview, /finance/receivables
	notificationHandlers.RegisterProtected(protected)        // /notifications, /notifications/count, /notifications/:id/read

	// SSE queue stream authenticates via ?token= (EventSource can't set headers).
	v1.GET("/queue/stream", httpx.RequireAuthQuery(tokens), schedulingHandlers.QueueStream)

	return r
}

func connectWithRetry(ctx context.Context, url string, attempts int, delay time.Duration) (*kerneldb.DB, error) {
	var lastErr error
	for i := 0; i < attempts; i++ {
		db, err := kerneldb.Connect(ctx, url)
		if err == nil {
			return db, nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil, lastErr
}

// buildStorage picks the object-storage backend. STORAGE_PROVIDER forces a choice
// ("r2"/"cloudinary"); otherwise it auto-selects R2 when configured, then
// Cloudinary, then a noop that errors on upload.
func buildStorage(cfg config.Config, log *slog.Logger) storage.Provider {
	switch cfg.StorageProvider {
	case "r2":
		if r2, err := storage.NewR2(cfg.R2.AccountID, cfg.R2.AccessKey, cfg.R2.SecretKey, cfg.R2.Bucket); err == nil {
			return r2
		} else {
			log.Error("R2 storage configured but failed to init; falling back", "err", err)
		}
	case "cloudinary":
		if cfg.Cloudinary.Configured() {
			return storage.NewCloudinary(cfg.Cloudinary.CloudName, cfg.Cloudinary.APIKey, cfg.Cloudinary.APISecret, cfg.Cloudinary.UploadFolder)
		}
	}
	if cfg.R2.Configured() {
		if r2, err := storage.NewR2(cfg.R2.AccountID, cfg.R2.AccessKey, cfg.R2.SecretKey, cfg.R2.Bucket); err == nil {
			return r2
		}
	}
	if cfg.Cloudinary.Configured() {
		return storage.NewCloudinary(cfg.Cloudinary.CloudName, cfg.Cloudinary.APIKey, cfg.Cloudinary.APISecret, cfg.Cloudinary.UploadFolder)
	}
	return storage.NewNoop()
}

// smsGatewayFor picks the delivery adapter. Without a key it returns the log
// adapter, which reports Live() == false — so nothing anywhere claims a patient
// was contacted when no message left the building.
func smsGatewayFor(cfg config.Config, log *slog.Logger) sms.Gateway {
	if cfg.SMS.Configured() {
		return sms.NewEthiopiaGateway(cfg.SMS.APIKey, cfg.SMS.BaseURL, log)
	}
	log.Warn("SMS not configured — patient messages will be logged, not sent")
	return sms.NewLogGateway(log)
}
