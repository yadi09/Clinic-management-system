package auth

import (
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// GenerateTOTPSecret creates a new TOTP key for the given issuer/account. The
// returned key exposes Secret() (store encrypted) and a provisioning URL/QR.
func GenerateTOTPSecret(issuer, account string) (*otp.Key, error) {
	return totp.Generate(totp.GenerateOpts{
		Issuer:      issuer,
		AccountName: account,
	})
}

// ValidateTOTP reports whether code is currently valid for secret (±1 step).
func ValidateTOTP(secret, code string) bool {
	return totp.Validate(code, secret)
}
