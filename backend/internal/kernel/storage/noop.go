package storage

import (
	"context"
	"errors"
)

// Noop is a fallback provider used in dev when no storage credentials are
// configured. Upload/delete are unavailable but the app still boots.
type Noop struct{}

// NewNoop constructs a Noop provider.
func NewNoop() *Noop { return &Noop{} }

// Name implements Provider.
func (n *Noop) Name() string { return "noop" }

// SignUpload always errors — configure a real provider to upload.
func (n *Noop) SignUpload(context.Context, UploadOptions) (UploadTarget, error) {
	return UploadTarget{}, errors.New("storage provider not configured")
}

// URL returns the key unchanged.
func (n *Noop) URL(key string) string { return key }

// Delete is a no-op.
func (n *Noop) Delete(context.Context, string) error { return nil }
