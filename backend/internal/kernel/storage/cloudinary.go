package storage

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Cloudinary implements Provider using Cloudinary's signed upload/destroy API.
// Direct client uploads avoid proxying large medical files through the API.
type Cloudinary struct {
	cloudName    string
	apiKey       string
	apiSecret    string
	uploadFolder string
	http         *http.Client
}

// NewCloudinary constructs a Cloudinary provider.
func NewCloudinary(cloudName, apiKey, apiSecret, uploadFolder string) *Cloudinary {
	return &Cloudinary{
		cloudName:    cloudName,
		apiKey:       apiKey,
		apiSecret:    apiSecret,
		uploadFolder: uploadFolder,
		http:         &http.Client{Timeout: 15 * time.Second},
	}
}

// Name implements Provider.
func (c *Cloudinary) Name() string { return "cloudinary" }

func (c *Cloudinary) resourceType(opts UploadOptions) string {
	if opts.ResourceType != "" {
		return opts.ResourceType
	}
	return "auto"
}

// SignUpload returns a signed POST target for a direct browser upload.
func (c *Cloudinary) SignUpload(_ context.Context, opts UploadOptions) (UploadTarget, error) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	folder := opts.Folder
	if folder == "" {
		folder = c.uploadFolder
	}
	// Params that participate in the signature (alphabetical, excludes file/api_key/resource_type).
	params := map[string]string{"timestamp": ts}
	if folder != "" {
		params["folder"] = folder
	}
	if opts.PublicID != "" {
		params["public_id"] = opts.PublicID
	}
	if len(opts.Tags) > 0 {
		params["tags"] = strings.Join(opts.Tags, ",")
	}
	signature := c.sign(params)

	fields := map[string]string{"api_key": c.apiKey, "timestamp": ts, "signature": signature}
	for k, v := range params {
		fields[k] = v
	}
	key := folder
	if opts.PublicID != "" {
		key = strings.TrimSuffix(folder, "/") + "/" + opts.PublicID
	}
	return UploadTarget{
		Method: http.MethodPost,
		URL:    fmt.Sprintf("https://api.cloudinary.com/v1_1/%s/%s/upload", c.cloudName, c.resourceType(opts)),
		Fields: fields,
		Key:    key,
	}, nil
}

// URL returns the public delivery URL for a stored object key.
func (c *Cloudinary) URL(key string) string {
	return fmt.Sprintf("https://res.cloudinary.com/%s/image/upload/%s", c.cloudName, key)
}

// Delete removes an object via the destroy API.
func (c *Cloudinary) Delete(ctx context.Context, key string) error {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	params := map[string]string{"public_id": key, "timestamp": ts}
	form := url.Values{}
	form.Set("public_id", key)
	form.Set("timestamp", ts)
	form.Set("api_key", c.apiKey)
	form.Set("signature", c.sign(params))

	endpoint := fmt.Sprintf("https://api.cloudinary.com/v1_1/%s/image/destroy", c.cloudName)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("cloudinary destroy: status %d", resp.StatusCode)
	}
	return nil
}

// sign builds the Cloudinary upload signature: sha1(sorted "k=v" joined by "&" + api_secret).
func (c *Cloudinary) sign(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+params[k])
	}
	h := sha1.New()
	h.Write([]byte(strings.Join(parts, "&") + c.apiSecret))
	return hex.EncodeToString(h.Sum(nil))
}
