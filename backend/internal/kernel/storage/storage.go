// Package storage abstracts object storage behind a provider-independent
// interface so the application never couples to a vendor. The initial provider
// is Cloudinary; S3/MinIO/Spaces/B2 can be added as new implementations with no
// application changes (infra override / ADR-001 conflict 5).
package storage

import "context"

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
