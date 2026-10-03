package config

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

var allKeys = []string{
	"APP_ENV", "API_HTTP_ADDR", "CORS_ALLOWED_ORIGINS", "BASE_DOMAIN", "APP_BASE_URL",
	"DATABASE_URL", "PLATFORM_DATABASE_URL", "JWT_ISSUER", "JWT_SECRET", "MFA_ENC_KEY",
	"STORAGE_PROVIDER", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET",
	"CLOUDINARY_UPLOAD_FOLDER", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
	"DEEPGRAM_API_KEY", "DEEPGRAM_MODEL", "DEEPGRAM_LANGUAGE", "NVIDIA_API_KEY", "AI_API_KEY", "AI_MODEL",
	"AI_BASE_URL", "DHIS2_TOKEN", "DHIS2_BASE_URL", "SMS_API_KEY", "SMS_BASE_URL", "SMS_COST_PER_SEGMENT",
	"VERIFYET_API_KEY", "VERIFYET_BASE_URL", "VERIFYET_WAIT_MS", "ACCESS_TOKEN_TTL", "REFRESH_TOKEN_TTL",
	"LOCKOUT_DURATION", "INVITE_TTL", "MAX_FAILED_LOGINS", "RATE_LIMIT_RPS", "RATE_LIMIT_BURST",
}

var goodMFAKey = base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))

const goodSecret = "a-perfectly-long-enough-production-secret-0123"

// baseline clears every key Load reads (an empty value reads as unset) and sets the
// three that have no default, so each test changes only what it is about.
func baseline(t *testing.T) {
	t.Helper()
	for _, k := range allKeys {
		t.Setenv(k, "")
	}
	t.Setenv("DATABASE_URL", "postgres://x@localhost/db")
	t.Setenv("JWT_SECRET", goodSecret)
	t.Setenv("MFA_ENC_KEY", goodMFAKey)
}

func mustFail(t *testing.T, wantMsgs ...string) string {
	t.Helper()
	cfg, err := Load()
	if err == nil {
		t.Fatalf("Load succeeded, want failure mentioning %q", wantMsgs)
	}
	if cfg.DatabaseURL != "" || cfg.JWTSecret != nil {
		t.Errorf("a failed Load must return the zero Config, got %+v", cfg)
	}
	msg := err.Error()
	if !strings.HasPrefix(msg, "invalid configuration:\n  - ") {
		t.Errorf("error must start with the invalid-configuration header, got %q", msg)
	}
	for _, w := range wantMsgs {
		if !strings.Contains(msg, w) {
			t.Errorf("error %q does not contain %q", msg, w)
		}
	}
	return msg
}

// Given only the three required settings, When Load runs, Then every other value takes its documented default.
func TestREG_KERNEL_CONFIG_001_DefaultsWhenUnset(t *testing.T) {
	baseline(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	checks := []struct {
		name      string
		got, want any
	}{
		{"Env", cfg.Env, EnvDev},
		{"HTTPAddr", cfg.HTTPAddr, ":8080"},
		{"CORS", strings.Join(cfg.CORSAllowedOrigins, "|"), "http://localhost:5173"},
		{"BaseDomain", cfg.BaseDomain, ""},
		{"AppBaseURL", cfg.AppBaseURL, "http://localhost:8088"},
		{"JWTIssuer", cfg.JWTIssuer, "clinicsaas"},
		{"AccessTokenTTL", cfg.AccessTokenTTL, 15 * time.Minute},
		{"RefreshTokenTTL", cfg.RefreshTokenTTL, 720 * time.Hour},
		{"LockoutDuration", cfg.LockoutDuration, 15 * time.Minute},
		{"InviteTTL", cfg.InviteTTL, 72 * time.Hour},
		{"MaxFailedLogins", cfg.MaxFailedLogins, 5},
		{"RateLimitRPS", cfg.RateLimitRPS, 20.0},
		{"RateLimitBurst", cfg.RateLimitBurst, 40},
		{"UploadFolder", cfg.Cloudinary.UploadFolder, "clinic"},
		{"DeepgramModel", cfg.Transcription.Model, "nova-3"},
		{"DeepgramLanguage", cfg.Transcription.Language, "en"},
		{"AIModel", cfg.AI.Model, "meta/llama-3.3-70b-instruct"},
		{"AIBaseURL", cfg.AI.BaseURL, "https://integrate.api.nvidia.com/v1"},
		{"DHIS2BaseURL", cfg.DHIS2.BaseURL, "https://dhis.moh.gov.et"},
		{"SMSBaseURL", cfg.SMS.BaseURL, "https://smsethiopia.com"},
		{"SMSCost", cfg.SMS.CostPerSegment, 0.25},
		{"VerifyETBaseURL", cfg.VerifyET.BaseURL, "https://verify.et"},
		{"VerifyETWaitMs", cfg.VerifyET.WaitMs, 6000},
		{"StorageProvider", cfg.StorageProvider, ""},
		{"PlatformDatabaseURL", cfg.PlatformDatabaseURL, ""},
		{"MFAKeyLen", len(cfg.MFAEncKey), 32},
		{"JWTSecret", string(cfg.JWTSecret), goodSecret},
		{"IsProd", cfg.IsProd(), false},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}
	for name, on := range map[string]bool{
		"Transcription": cfg.Transcription.Configured(), "AI": cfg.AI.Configured(), "DHIS2": cfg.DHIS2.Configured(),
		"SMS": cfg.SMS.Configured(), "VerifyET": cfg.VerifyET.Configured(), "Cloudinary": cfg.Cloudinary.Configured(),
		"R2": cfg.R2.Configured(),
	} {
		if on {
			t.Errorf("%s reports Configured with no credentials", name)
		}
	}
}

// Given every setting overridden, When Load runs, Then each override is honoured exactly (trimmed/lowercased where documented).
func TestREG_KERNEL_CONFIG_002_OverridesHonoured(t *testing.T) {
	baseline(t)
	env := map[string]string{
		"APP_ENV": "staging", "API_HTTP_ADDR": ":9999", "CORS_ALLOWED_ORIGINS": " https://a.test , ,https://b.test ",
		"BASE_DOMAIN": "  clinicos.cc  ", "APP_BASE_URL": "https://app.test", "PLATFORM_DATABASE_URL": "postgres://p",
		"JWT_ISSUER": "iss", "STORAGE_PROVIDER": "  R2 ", "CLOUDINARY_UPLOAD_FOLDER": "f",
		"DEEPGRAM_API_KEY": "dg", "DEEPGRAM_MODEL": "m", "DEEPGRAM_LANGUAGE": "am",
		"AI_MODEL": "x/y", "AI_BASE_URL": "https://ai.test", "DHIS2_TOKEN": "tok", "DHIS2_BASE_URL": "https://d.test",
		"SMS_API_KEY": "s", "SMS_BASE_URL": "https://s.test", "SMS_COST_PER_SEGMENT": " 0.4 ",
		"VERIFYET_API_KEY": "v", "VERIFYET_BASE_URL": "https://v.test", "VERIFYET_WAIT_MS": " 1500 ",
		"ACCESS_TOKEN_TTL": "5m", "REFRESH_TOKEN_TTL": "24h", "LOCKOUT_DURATION": "90s", "INVITE_TTL": "1h30m",
		"MAX_FAILED_LOGINS": "3", "RATE_LIMIT_RPS": "2.5", "RATE_LIMIT_BURST": "7",
	}
	for k, v := range env {
		t.Setenv(k, v)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Env != EnvStaging || cfg.HTTPAddr != ":9999" || cfg.AppBaseURL != "https://app.test" || cfg.JWTIssuer != "iss" {
		t.Errorf("basic overrides wrong: %+v", cfg)
	}
	if got := strings.Join(cfg.CORSAllowedOrigins, "|"); got != "https://a.test|https://b.test" {
		t.Errorf("CORS = %q, want trimmed, blanks dropped", got)
	}
	if cfg.BaseDomain != "clinicos.cc" {
		t.Errorf("BaseDomain = %q, want trimmed", cfg.BaseDomain)
	}
	if cfg.StorageProvider != "r2" {
		t.Errorf("StorageProvider = %q, want trimmed lower-case r2", cfg.StorageProvider)
	}
	if cfg.PlatformDatabaseURL != "postgres://p" || cfg.Cloudinary.UploadFolder != "f" {
		t.Errorf("platform/cloudinary overrides wrong")
	}
	if cfg.Transcription != (TranscriptionConfig{"dg", "m", "am"}) || !cfg.Transcription.Configured() {
		t.Errorf("Transcription = %+v", cfg.Transcription)
	}
	if cfg.AI.Model != "x/y" || cfg.AI.BaseURL != "https://ai.test" {
		t.Errorf("AI = %+v", cfg.AI)
	}
	if cfg.DHIS2 != (DHIS2Config{"tok", "https://d.test"}) || !cfg.DHIS2.Configured() {
		t.Errorf("DHIS2 = %+v", cfg.DHIS2)
	}
	if cfg.SMS != (SMSConfig{"s", "https://s.test", 0.4}) || !cfg.SMS.Configured() {
		t.Errorf("SMS = %+v", cfg.SMS)
	}
	if cfg.VerifyET != (VerifyETConfig{"v", "https://v.test", 1500}) || !cfg.VerifyET.Configured() {
		t.Errorf("VerifyET = %+v", cfg.VerifyET)
	}
	if cfg.AccessTokenTTL != 5*time.Minute || cfg.RefreshTokenTTL != 24*time.Hour || cfg.LockoutDuration != 90*time.Second || cfg.InviteTTL != 90*time.Minute {
		t.Errorf("durations wrong: %v %v %v %v", cfg.AccessTokenTTL, cfg.RefreshTokenTTL, cfg.LockoutDuration, cfg.InviteTTL)
	}
	if cfg.MaxFailedLogins != 3 || cfg.RateLimitRPS != 2.5 || cfg.RateLimitBurst != 7 {
		t.Errorf("numbers wrong: %d %v %d", cfg.MaxFailedLogins, cfg.RateLimitRPS, cfg.RateLimitBurst)
	}
}

// Given an unknown APP_ENV, When Load runs, Then it fails naming the allowed values and the bad one.
func TestREG_KERNEL_CONFIG_003_UnknownEnvRejected(t *testing.T) {
	baseline(t)
	t.Setenv("APP_ENV", "production")
	mustFail(t, `APP_ENV must be one of dev|staging|prod, got "production"`)
}

// Given no DATABASE_URL, When Load runs, Then it fails with "DATABASE_URL is required".
func TestREG_KERNEL_CONFIG_004_DatabaseURLRequired(t *testing.T) {
	baseline(t)
	t.Setenv("DATABASE_URL", "")
	mustFail(t, "DATABASE_URL is required")
}

// Given a JWT secret shorter than 32 bytes (or none), When Load runs, Then it fails stating the byte count; exactly 32 is accepted.
func TestREG_KERNEL_CONFIG_005_JWTSecretLength(t *testing.T) {
	baseline(t)
	t.Setenv("JWT_SECRET", strings.Repeat("x", 31))
	mustFail(t, "JWT_SECRET must be at least 32 bytes (got 31)")
	t.Setenv("JWT_SECRET", "")
	mustFail(t, "JWT_SECRET must be at least 32 bytes (got 0)")
	t.Setenv("JWT_SECRET", strings.Repeat("x", 32))
	if _, err := Load(); err != nil {
		t.Fatalf("a 32-byte secret must be accepted: %v", err)
	}
}

// Given a bad MFA key (missing, not base64, wrong length), When Load runs, Then each case fails with its own message.
func TestREG_KERNEL_CONFIG_006_MFAKeyValidation(t *testing.T) {
	baseline(t)
	t.Setenv("MFA_ENC_KEY", "")
	mustFail(t, "MFA_ENC_KEY is required")
	t.Setenv("MFA_ENC_KEY", "not base64!!")
	mustFail(t, "MFA_ENC_KEY must be base64:")
	t.Setenv("MFA_ENC_KEY", base64.StdEncoding.EncodeToString(make([]byte, 16)))
	mustFail(t, "MFA_ENC_KEY must decode to 32 bytes (got 16)")
}

// Given malformed durations, When Load runs, Then each offending key is named as "must be a duration".
func TestREG_KERNEL_CONFIG_007_BadDurations(t *testing.T) {
	baseline(t)
	for _, k := range []string{"ACCESS_TOKEN_TTL", "REFRESH_TOKEN_TTL", "LOCKOUT_DURATION", "INVITE_TTL"} {
		t.Setenv(k, "15") // no unit — a classic typo
	}
	mustFail(t, "ACCESS_TOKEN_TTL must be a duration", "REFRESH_TOKEN_TTL must be a duration",
		"LOCKOUT_DURATION must be a duration", "INVITE_TTL must be a duration")
}

// Given non-numeric integer/float settings, When Load runs, Then each is reported as must be an integer/number.
func TestREG_KERNEL_CONFIG_008_BadNumbers(t *testing.T) {
	baseline(t)
	t.Setenv("MAX_FAILED_LOGINS", "five")
	t.Setenv("RATE_LIMIT_BURST", "4.5")
	t.Setenv("RATE_LIMIT_RPS", "fast")
	mustFail(t, "MAX_FAILED_LOGINS must be an integer", "RATE_LIMIT_BURST must be an integer", "RATE_LIMIT_RPS must be a number")
}

// Given several problems at once, When Load runs, Then all are reported together, one per line, so an operator fixes them in one pass.
func TestREG_KERNEL_CONFIG_009_AllErrorsReportedTogether(t *testing.T) {
	baseline(t)
	t.Setenv("APP_ENV", "qa")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("JWT_SECRET", "short")
	t.Setenv("MFA_ENC_KEY", "")
	msg := mustFail(t, "APP_ENV", "DATABASE_URL", "JWT_SECRET", "MFA_ENC_KEY")
	if n := strings.Count(msg, "\n  - "); n != 4 {
		t.Errorf("want 4 bulleted errors, got %d in %q", n, msg)
	}
}

// Given prod with a dev placeholder JWT secret, When Load runs, Then it refuses to start.
func TestREG_KERNEL_CONFIG_010_ProdRejectsDevJWTSecret(t *testing.T) {
	baseline(t)
	t.Setenv("APP_ENV", "prod")
	t.Setenv("R2_ACCOUNT_ID", "a")
	t.Setenv("R2_ACCESS_KEY_ID", "b")
	t.Setenv("R2_SECRET_ACCESS_KEY", "c")
	t.Setenv("R2_BUCKET", "d")
	t.Setenv("JWT_SECRET", "dev-only-secret-change-me-0123456789abcdef")
	mustFail(t, "JWT_SECRET is a dev placeholder in production")
	// The same placeholder is fine outside production.
	t.Setenv("APP_ENV", "staging")
	if _, err := Load(); err != nil {
		t.Errorf("staging must accept a dev placeholder secret: %v", err)
	}
}

// Given prod with no storage provider (or only partial credentials), When Load runs, Then it refuses to start.
func TestREG_KERNEL_CONFIG_011_ProdRequiresStorage(t *testing.T) {
	baseline(t)
	t.Setenv("APP_ENV", "prod")
	mustFail(t, "an object-storage provider (Cloudinary or R2) must be configured in production")
	// Three of four R2 values is not configured.
	t.Setenv("R2_ACCOUNT_ID", "a")
	t.Setenv("R2_ACCESS_KEY_ID", "b")
	t.Setenv("R2_SECRET_ACCESS_KEY", "c")
	mustFail(t, "object-storage provider")
	// Two of three Cloudinary values is not configured either.
	t.Setenv("CLOUDINARY_CLOUD_NAME", "n")
	t.Setenv("CLOUDINARY_API_KEY", "k")
	mustFail(t, "object-storage provider")
}

// Given prod with full Cloudinary or full R2 credentials and a real secret, When Load runs, Then it starts and reports IsProd.
func TestREG_KERNEL_CONFIG_012_ProdStartsWithEitherProvider(t *testing.T) {
	baseline(t)
	t.Setenv("APP_ENV", "prod")
	t.Setenv("CLOUDINARY_CLOUD_NAME", "n")
	t.Setenv("CLOUDINARY_API_KEY", "k")
	t.Setenv("CLOUDINARY_API_SECRET", "s")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("prod with Cloudinary: %v", err)
	}
	if !cfg.IsProd() || !cfg.Cloudinary.Configured() || cfg.R2.Configured() {
		t.Errorf("IsProd=%v cloudinary=%v r2=%v", cfg.IsProd(), cfg.Cloudinary.Configured(), cfg.R2.Configured())
	}

	baseline(t)
	t.Setenv("APP_ENV", "prod")
	t.Setenv("R2_ACCOUNT_ID", "a")
	t.Setenv("R2_ACCESS_KEY_ID", "b")
	t.Setenv("R2_SECRET_ACCESS_KEY", "c")
	t.Setenv("R2_BUCKET", "d")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("prod with R2: %v", err)
	}
	if cfg.R2 != (R2Config{"a", "b", "c", "d"}) || !cfg.R2.Configured() {
		t.Errorf("R2 = %+v", cfg.R2)
	}
}

// Given a mistyped or negative SMS price or VerifyET wait, When Load runs, Then the default is used and startup is NOT blocked.
func TestREG_KERNEL_CONFIG_013_LenientOptionalNumbersFallBack(t *testing.T) {
	baseline(t)
	for _, v := range []string{"cheap", "-1", "   "} {
		t.Setenv("SMS_COST_PER_SEGMENT", v)
		t.Setenv("VERIFYET_WAIT_MS", "soon")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("SMS_COST_PER_SEGMENT=%q must not block startup: %v", v, err)
		}
		if cfg.SMS.CostPerSegment != 0.25 {
			t.Errorf("SMS_COST_PER_SEGMENT=%q → %v, want default 0.25", v, cfg.SMS.CostPerSegment)
		}
		if cfg.VerifyET.WaitMs != 6000 {
			t.Errorf("VERIFYET_WAIT_MS=soon → %d, want default 6000", cfg.VerifyET.WaitMs)
		}
	}
	t.Setenv("SMS_COST_PER_SEGMENT", "0")
	if cfg, _ := Load(); cfg.SMS.CostPerSegment != 0 {
		t.Errorf("a zero price is a real price, got %v", cfg.SMS.CostPerSegment)
	}
}

// Given NVIDIA_API_KEY and/or AI_API_KEY, When Load runs, Then NVIDIA wins and AI_API_KEY is the fallback.
func TestREG_KERNEL_CONFIG_014_AIKeyPrecedence(t *testing.T) {
	baseline(t)
	t.Setenv("AI_API_KEY", "generic")
	cfg, err := Load()
	if err != nil || cfg.AI.APIKey != "generic" || !cfg.AI.Configured() {
		t.Fatalf("AI_API_KEY fallback: %v / %+v", err, cfg.AI)
	}
	t.Setenv("NVIDIA_API_KEY", "nv")
	if cfg, _ := Load(); cfg.AI.APIKey != "nv" {
		t.Errorf("NVIDIA_API_KEY must win, got %q", cfg.AI.APIKey)
	}
}

// Given whitespace-only keys for SMS/VerifyET, When Configured is asked, Then they are not treated as configured.
func TestREG_KERNEL_CONFIG_015_WhitespaceKeysAreNotConfigured(t *testing.T) {
	if (SMSConfig{APIKey: "  "}).Configured() || (VerifyETConfig{APIKey: "\t"}).Configured() {
		t.Error("whitespace-only key reported as configured")
	}
	if !(CloudinaryConfig{"n", "k", "s", ""}).Configured() {
		t.Error("UploadFolder is optional for Cloudinary")
	}
}

// Given an empty CORS list, When split, Then it is nil (not a list with an empty origin).
func TestREG_KERNEL_CONFIG_016_SplitCSVEmpty(t *testing.T) {
	if got := splitCSV(""); got != nil {
		t.Errorf("splitCSV(\"\") = %#v, want nil", got)
	}
	if got := splitCSV(" , ,"); len(got) != 0 {
		t.Errorf("splitCSV of blanks = %#v, want empty", got)
	}
}

// Given the exact placeholders shipped in .env.example, When Load runs in prod, Then neither can reach production.
func TestREG_KERNEL_CONFIG_017_EnvExamplePlaceholdersBlockedInProd(t *testing.T) {
	baseline(t)
	t.Setenv("APP_ENV", "prod")
	t.Setenv("CLOUDINARY_CLOUD_NAME", "n")
	t.Setenv("CLOUDINARY_API_KEY", "k")
	t.Setenv("CLOUDINARY_API_SECRET", "s")
	t.Setenv("JWT_SECRET", "dev-only-change-me-please-32bytes-min-xxxxxxxx")
	mustFail(t, "JWT_SECRET is a dev placeholder in production")
	t.Setenv("JWT_SECRET", goodSecret)
	t.Setenv("MFA_ENC_KEY", "dev-only-change-me-base64-32-bytes-aaaaaaaaaaa=")
	mustFail(t, "MFA_ENC_KEY must be base64")
}
