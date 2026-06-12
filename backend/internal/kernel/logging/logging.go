// Package logging configures structured JSON logging to stdout. On a single
// VPS this is captured by Docker; a log shipper (Loki) can be added later
// without code change (ADR-001 conflict 6).
package logging

import (
	"log/slog"
	"os"
)

// New returns a JSON logger. In dev it logs at Debug; otherwise Info.
func New(env string) *slog.Logger {
	level := slog.LevelInfo
	if env == "dev" {
		level = slog.LevelDebug
	}
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	logger := slog.New(h)
	slog.SetDefault(logger)
	return logger
}
