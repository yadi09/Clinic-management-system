// Package config loads and validates typed application configuration from the
// environment. The process fails fast on missing or invalid configuration
// (NFR-14: no secrets in code; per-environment overrides via env).
package config

import (
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Env identifies the deployment environment.
type Env string

const (
	EnvDev     Env = "dev"
	EnvStaging Env = "staging"
	EnvProd    Env = "prod"
)

// Config is the fully-validated application configuration.
type Config struct {
	Env                Env
	HTTPAddr           string
	CORSAllowedOrigins []string
	BaseDomain         string // tenant subdomain base; empty disables subdomain resolution
	AppBaseURL         string // public web URL, used to build invite/accept links
	InviteTTL          time.Duration

	DatabaseURL string
	// PlatformDatabaseURL is a privileged (RLS-bypassing) DSN used only by the
	// platform/super-admin module to provision tenants across the boundary. When
	// empty, the platform surface is disabled.
	PlatformDatabaseURL string

	JWTSecret       []byte
	JWTIssuer       string
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
	MaxFailedLogins int
	LockoutDuration time.Duration
	MFAEncKey       []byte // 32 bytes (AES-256) for at-rest TOTP secret encryption

	// StorageProvider selects the object-storage backend: "r2" | "cloudinary" |
	// "" (auto: r2 if configured, else cloudinary, else noop).
	StorageProvider string
	Cloudinary      CloudinaryConfig
	R2              R2Config

	Transcription TranscriptionConfig

	AI AIConfig

	DHIS2 DHIS2Config
	SMS   SMSConfig

	RateLimitRPS   float64
	RateLimitBurst int
}

// TranscriptionConfig holds the Deepgram speech-to-text credentials used for voice
// dictation. When the API key is empty the dictation endpoint is disabled.
type TranscriptionConfig struct {
	DeepgramAPIKey string
	Model          string
	Language       string
}

// Configured reports whether a Deepgram key is present.
func (t TranscriptionConfig) Configured() bool { return t.DeepgramAPIKey != "" }

// AIConfig holds credentials for the clinical decision-support co-pilot ("ClinicOS
// Assist") — an OpenAI-compatible chat API (NVIDIA build by default). When the API
// key is empty the Assist endpoint is disabled.
type AIConfig struct {
	APIKey  string
	Model   string
	BaseURL string
}

// Configured reports whether an AI co-pilot key is present.
func (a AIConfig) Configured() bool { return a.APIKey != "" }

// DHIS2Config holds the credentials for the DHIS2 (Ministry of Health) reporting
// showcase. Token is a Personal Access Token the clinic owner creates in DHIS2;
// an empty token disables the push. The token is never logged and never placed
// in a URL.
type DHIS2Config struct {
	Token   string
	BaseURL string
}

// Configured reports whether a DHIS2 token is present.
func (d DHIS2Config) Configured() bool { return d.Token != "" }

// SMSConfig holds the patient-messaging gateway credentials (SMSEthiopia).
//
// One key serves every clinic: the gateway bills per message against a single
// platform account, so per-clinic spend is capped by the plan rather than by
// separate credentials. CostPerSegment is what a segment costs us, used to show
// a clinic the price of a send before it happens — it is a display figure, not
// an invoice, so an approximate value is fine and a wrong one is only cosmetic.
type SMSConfig struct {
	APIKey         string
	BaseURL        string
	CostPerSegment float64
}

// Configured reports whether messages can actually be delivered. When false the
// module still works end to end against the log gateway, and every surface says
// so rather than implying patients were contacted.
func (s SMSConfig) Configured() bool { return strings.TrimSpace(s.APIKey) != "" }

// CloudinaryConfig holds the Cloudinary storage-provider credentials.
type CloudinaryConfig struct {
	CloudName    string
	APIKey       string
	APISecret    string
	UploadFolder string
}

// Configured reports whether Cloudinary credentials are present.
func (c CloudinaryConfig) Configured() bool {
	return c.CloudName != "" && c.APIKey != "" && c.APISecret != ""
}

// R2Config holds the Cloudflare R2 (S3-compatible) storage credentials.
type R2Config struct {
	AccountID string // Cloudflare account id → endpoint <account>.r2.cloudflarestorage.com
	AccessKey string
	SecretKey string
	Bucket    string
}

// Configured reports whether R2 credentials are present.
func (c R2Config) Configured() bool {
	return c.AccountID != "" && c.AccessKey != "" && c.SecretKey != "" && c.Bucket != ""
}

// IsProd reports whether the environment is production.
func (c Config) IsProd() bool { return c.Env == EnvProd }

// Load reads configuration from the environment and validates it.
func Load() (Config, error) {
	var errs []string
	fail := func(format string, a ...any) { errs = append(errs, fmt.Sprintf(format, a...)) }

	cfg := Config{
		Env:                 Env(getenv("APP_ENV", "dev")),
		HTTPAddr:            getenv("API_HTTP_ADDR", ":8080"),
		CORSAllowedOrigins:  splitCSV(getenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")),
		BaseDomain:          strings.TrimSpace(os.Getenv("BASE_DOMAIN")),
		AppBaseURL:          getenv("APP_BASE_URL", "http://localhost:8088"),
		DatabaseURL:         os.Getenv("DATABASE_URL"),
		PlatformDatabaseURL: os.Getenv("PLATFORM_DATABASE_URL"),
		JWTIssuer:           getenv("JWT_ISSUER", "clinicsaas"),
		StorageProvider:     strings.ToLower(strings.TrimSpace(os.Getenv("STORAGE_PROVIDER"))),
		Cloudinary: CloudinaryConfig{
			CloudName:    os.Getenv("CLOUDINARY_CLOUD_NAME"),
			APIKey:       os.Getenv("CLOUDINARY_API_KEY"),
			APISecret:    os.Getenv("CLOUDINARY_API_SECRET"),
			UploadFolder: getenv("CLOUDINARY_UPLOAD_FOLDER", "clinic"),
		},
		R2: R2Config{
			AccountID: os.Getenv("R2_ACCOUNT_ID"),
			AccessKey: os.Getenv("R2_ACCESS_KEY_ID"),
			SecretKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
			Bucket:    os.Getenv("R2_BUCKET"),
		},
		Transcription: TranscriptionConfig{
			DeepgramAPIKey: os.Getenv("DEEPGRAM_API_KEY"),
			Model:          getenv("DEEPGRAM_MODEL", "nova-3"),
			Language:       getenv("DEEPGRAM_LANGUAGE", "en"),
		},
		AI: AIConfig{
			APIKey:  getenv("NVIDIA_API_KEY", os.Getenv("AI_API_KEY")),
			Model:   getenv("AI_MODEL", "meta/llama-3.3-70b-instruct"),
			BaseURL: getenv("AI_BASE_URL", "https://integrate.api.nvidia.com/v1"),
		},
		DHIS2: DHIS2Config{
			Token:   os.Getenv("DHIS2_TOKEN"),
			BaseURL: getenv("DHIS2_BASE_URL", "https://dhis.moh.gov.et"),
		},
		SMS: SMSConfig{
			APIKey:         os.Getenv("SMS_API_KEY"),
			BaseURL:        getenv("SMS_BASE_URL", "https://smsethiopia.com"),
			CostPerSegment: getenvFloat("SMS_COST_PER_SEGMENT", 0.25),
		},
	}

	switch cfg.Env {
	case EnvDev, EnvStaging, EnvProd:
	default:
		fail("APP_ENV must be one of dev|staging|prod, got %q", cfg.Env)
	}

	if cfg.DatabaseURL == "" {
		fail("DATABASE_URL is required")
	}

	cfg.JWTSecret = []byte(os.Getenv("JWT_SECRET"))
	if len(cfg.JWTSecret) < 32 {
		fail("JWT_SECRET must be at least 32 bytes (got %d)", len(cfg.JWTSecret))
	}

	if key := os.Getenv("MFA_ENC_KEY"); key != "" {
		dec, err := base64.StdEncoding.DecodeString(key)
		if err != nil {
			fail("MFA_ENC_KEY must be base64: %v", err)
		} else if len(dec) != 32 {
			fail("MFA_ENC_KEY must decode to 32 bytes (got %d)", len(dec))
		} else {
			cfg.MFAEncKey = dec
		}
	} else {
		fail("MFA_ENC_KEY is required")
	}

	cfg.AccessTokenTTL = mustDuration("ACCESS_TOKEN_TTL", "15m", fail)
	cfg.RefreshTokenTTL = mustDuration("REFRESH_TOKEN_TTL", "720h", fail)
	cfg.LockoutDuration = mustDuration("LOCKOUT_DURATION", "15m", fail)
	cfg.InviteTTL = mustDuration("INVITE_TTL", "72h", fail)
	cfg.MaxFailedLogins = mustInt("MAX_FAILED_LOGINS", 5, fail)
	cfg.RateLimitRPS = mustFloat("RATE_LIMIT_RPS", 20, fail)
	cfg.RateLimitBurst = mustInt("RATE_LIMIT_BURST", 40, fail)

	// Production guards against dev placeholder secrets.
	if cfg.IsProd() {
		if strings.Contains(string(cfg.JWTSecret), "dev-only") {
			fail("JWT_SECRET is a dev placeholder in production")
		}
		if !cfg.Cloudinary.Configured() && !cfg.R2.Configured() {
			fail("an object-storage provider (Cloudinary or R2) must be configured in production")
		}
	}

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("invalid configuration:\n  - %s", strings.Join(errs, "\n  - "))
	}
	return cfg, nil
}

// getenvFloat reads a decimal setting, falling back when it is absent or is not a
// number — a mistyped price should not stop the API from starting.
func getenvFloat(key string, def float64) float64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		return def
	}
	return f
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func mustDuration(key, def string, fail func(string, ...any)) time.Duration {
	d, err := time.ParseDuration(getenv(key, def))
	if err != nil {
		fail("%s must be a duration: %v", key, err)
		return 0
	}
	return d
}

func mustInt(key string, def int, fail func(string, ...any)) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		fail("%s must be an integer: %v", key, err)
		return def
	}
	return n
}

func mustFloat(key string, def float64, fail func(string, ...any)) float64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		fail("%s must be a number: %v", key, err)
		return def
	}
	return f
}
