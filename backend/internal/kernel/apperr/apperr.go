// Package apperr defines the domain error type used across the application.
// Errors carry a stable machine-readable code and an HTTP status so the HTTP
// layer can render a consistent envelope (Part 2 §7.11 / Part 4 §10.7).
package apperr

import (
	"errors"
	"fmt"
	"net/http"
)

// Error is a structured application error.
type Error struct {
	HTTPStatus int               // mapped HTTP status
	Code       string            // stable machine code, e.g. PATIENT_DUPLICATE
	Message    string            // human-readable, safe to surface
	Fields     map[string]string // optional per-field validation messages
	wrapped    error             // optional underlying cause (never surfaced)
}

func (e *Error) Error() string {
	if e.wrapped != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.wrapped)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.wrapped }

// WithField attaches a single field-level message and returns the error.
func (e *Error) WithField(field, msg string) *Error {
	if e.Fields == nil {
		e.Fields = map[string]string{}
	}
	e.Fields[field] = msg
	return e
}

// WithCause attaches an underlying cause (logged, never surfaced to clients).
func (e *Error) WithCause(err error) *Error {
	e.wrapped = err
	return e
}

// As extracts an *Error from err, if present.
func As(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// --- constructors for the standard error classes (Part 2 Table 7.4) ---

// New builds an error with an explicit status and code.
func New(status int, code, msg string) *Error {
	return &Error{HTTPStatus: status, Code: code, Message: msg}
}

// Validation -> 400.
func Validation(msg string) *Error {
	return New(http.StatusBadRequest, "VALIDATION_FAILED", orDefault(msg, "validation failed"))
}

// Unauthenticated -> 401.
func Unauthenticated(msg string) *Error {
	return New(http.StatusUnauthorized, "UNAUTHENTICATED", orDefault(msg, "authentication required"))
}

// Forbidden -> 403.
func Forbidden(code, msg string) *Error {
	return New(http.StatusForbidden, orDefault(code, "FORBIDDEN"), orDefault(msg, "forbidden"))
}

// NotFound -> 404.
func NotFound(code, msg string) *Error {
	return New(http.StatusNotFound, orDefault(code, "NOT_FOUND"), orDefault(msg, "not found"))
}

// Conflict -> 409.
func Conflict(code, msg string) *Error {
	return New(http.StatusConflict, orDefault(code, "CONFLICT"), orDefault(msg, "conflict"))
}

// ModuleDisabled -> 403 (feature flag off) per FR-TEN-03.
func ModuleDisabled(flag string) *Error {
	return New(http.StatusForbidden, "MODULE_DISABLED", fmt.Sprintf("the %s module is not enabled for this tenant", flag))
}

// RateLimited -> 429.
func RateLimited() *Error {
	return New(http.StatusTooManyRequests, "RATE_LIMITED", "too many requests")
}

// Internal -> 500. The cause is wrapped for logging but never surfaced.
func Internal(err error) *Error {
	return (&Error{HTTPStatus: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "an unexpected error occurred"}).WithCause(err)
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
