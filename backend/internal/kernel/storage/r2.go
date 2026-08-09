package storage

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// R2 implements Provider (and Sizer) on Cloudflare R2 via its S3-compatible API.
// Uploads are presigned PUTs (client sends the raw bytes) and delivery is a
// short-lived presigned GET, so the bucket stays private — right for PHI. R2 has
// no egress fees, which suits image-heavy dental records that are viewed often.
type R2 struct {
	client *minio.Client
	bucket string
	putTTL time.Duration
	getTTL time.Duration
}

var _ Provider = (*R2)(nil)
var _ Sizer = (*R2)(nil)

// NewR2 constructs an R2 provider. endpoint is <account>.r2.cloudflarestorage.com.
func NewR2(accountID, accessKey, secretKey, bucket string) (*R2, error) {
	endpoint := fmt.Sprintf("%s.r2.cloudflarestorage.com", accountID)
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: true,
		Region: "auto",
	})
	if err != nil {
		return nil, fmt.Errorf("r2 client: %w", err)
	}
	return &R2{client: client, bucket: bucket, putTTL: 15 * time.Minute, getTTL: time.Hour}, nil
}

func (r *R2) Name() string { return "r2" }

// SignUpload returns a presigned PUT target. R2 needs the full object key up
// front (unlike Cloudinary's server-assigned public_id), so we mint one here.
func (r *R2) SignUpload(ctx context.Context, opts UploadOptions) (UploadTarget, error) {
	name := opts.PublicID
	if name == "" {
		name = uuid.NewString()
	}
	key := name
	if folder := strings.Trim(opts.Folder, "/"); folder != "" {
		key = folder + "/" + name
	}
	u, err := r.client.PresignedPutObject(ctx, r.bucket, key, r.putTTL)
	if err != nil {
		return UploadTarget{}, fmt.Errorf("r2 presign put: %w", err)
	}
	return UploadTarget{Method: http.MethodPut, URL: u.String(), Fields: map[string]string{}, Key: key}, nil
}

// URL returns a short-lived presigned GET, forcing inline display so images render
// in the browser rather than download.
func (r *R2) URL(key string) string {
	params := url.Values{}
	params.Set("response-content-disposition", "inline")
	u, err := r.client.PresignedGetObject(context.Background(), r.bucket, key, r.getTTL, params)
	if err != nil {
		return ""
	}
	return u.String()
}

// Delete removes an object (frees the tenant's metered storage).
func (r *R2) Delete(ctx context.Context, key string) error {
	return r.client.RemoveObject(ctx, r.bucket, key, minio.RemoveObjectOptions{})
}

// Size reports the real stored byte size of an object (Sizer).
func (r *R2) Size(ctx context.Context, key string) (int64, error) {
	info, err := r.client.StatObject(ctx, r.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, err
	}
	return info.Size, nil
}
