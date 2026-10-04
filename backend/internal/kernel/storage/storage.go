// Package storage abstracts object storage behind a provider-independent
// interface so the application never couples to a vendor. The initial provider
// is Cloudinary; S3/MinIO/Spaces/B2 can be added as new implementations with no
// application changes (infra override / ADR-001 conflict 5).
package storage

import (
	"context"
	"strings"
)

// UploadOptions parameterise a signed direct-upload request.
type UploadOptions struct {
	Folder       string   // logical folder/prefix (e.g. tenant/patients)
	PublicID     string   // optional desired object id (without extension)
	ResourceType string   // image | raw | video | auto
	MaxBytes     int64    // optional client-side size hint
	Tags         []string // optional tags
}

// UploadTarget tells the client how to upload directly to the provider.
type UploadTarget struct {
	Method string            `json:"method"` // usually POST
	URL    string            `json:"url"`    // provider upload endpoint
	Fields map[string]string `json:"fields"` // form fields incl. signature
	Key    string            `json:"key"`    // opaque storage key to persist on the row
}

// Provider is the storage abstraction used by the application.
type Provider interface {
	// Name identifies the provider (e.g. "cloudinary", "noop").
	Name() string
	// SignUpload returns a signed direct-upload target for the client.
	SignUpload(ctx context.Context, opts UploadOptions) (UploadTarget, error)
	// URL returns a delivery URL for a stored object key.
	URL(key string) string
	// Delete removes a stored object.
	Delete(ctx context.Context, key string) error
}

// Sizer is an optional capability: a provider that can report the real stored
// size of an object (bytes). Used to meter actual usage after a direct upload,
// so a client can't under-report its size to dodge the storage quota. Providers
// that can't (e.g. noop) simply don't implement it and the caller falls back to
// the client-declared size.
type Sizer interface {
	Size(ctx context.Context, key string) (int64, error)
}

// KeyInFolder reports whether key names an object inside folder: folder + "/" +
// something, with no empty, "." or ".." segment that could step outside it. The
// server hands out upload targets inside a clinic's own folder for one patient;
// recording an upload must check the key the client sends back is one of those,
// or a client could point a record (and a later delete) at another clinic's object
// (SEC-1).
func KeyInFolder(key, folder string) bool {
	folder = strings.Trim(folder, "/")
	if folder == "" || !strings.HasPrefix(key, folder+"/") {
		return false
	}
	for _, seg := range strings.Split(strings.TrimPrefix(key, folder+"/"), "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}
