package storage

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// ---------------------------------------------------------------------------
// Fake S3 endpoint
// ---------------------------------------------------------------------------

type s3Req struct {
	Method string
	Path   string
	Query  url.Values
	Auth   string
}

// fakeS3 speaks just enough S3 for RemoveObject (DELETE) and StatObject (HEAD).
// status maps "METHOD /bucket/key" to the status code to return (default 404).
type fakeS3 struct {
	mu     sync.Mutex
	reqs   []s3Req
	status map[string]int
	size   int64
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.reqs = append(f.reqs, s3Req{Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(), Auth: r.Header.Get("Authorization")})
	code, ok := f.status[r.Method+" "+r.URL.Path]
	f.mu.Unlock()
	if !ok {
		code = http.StatusNotFound
	}
	if code < 300 {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", strconv.FormatInt(f.size, 10))
			w.Header().Set("ETag", `"0123456789abcdef0123456789abcdef"`)
			w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
			w.Header().Set("Content-Type", "image/jpeg")
		}
		w.WriteHeader(code)
		return
	}
	s3code := map[int]string{403: "AccessDenied", 404: "NoSuchKey", 500: "InternalError"}[code]
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(code)
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>`+s3code+`</Code><Message>fake</Message></Error>`)
	}
}

func (f *fakeS3) requests() []s3Req {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]s3Req(nil), f.reqs...)
}

// newFakeR2 builds an R2 provider whose minio client points at an httptest
// server (plain HTTP, path-style, one attempt so 5xx does not back off).
func newFakeR2(t *testing.T, bucket string) (*R2, *fakeS3, *httptest.Server) {
	t.Helper()
	f := &fakeS3{status: map[string]int{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	host := strings.TrimPrefix(srv.URL, "http://")
	cl, err := minio.New(host, &minio.Options{
		Creds:        credentials.NewStaticV4("AKIDTEST", "SECRETTEST", ""),
		Secure:       false,
		Region:       "auto",
		BucketLookup: minio.BucketLookupPath,
		MaxRetries:   1,
	})
	if err != nil {
		t.Fatalf("minio client: %v", err)
	}
	return &R2{client: cl, bucket: bucket, putTTL: 15 * time.Minute, getTTL: time.Hour}, f, srv
}

// Given an R2 provider, When SignUpload is called with a folder and public id,
// Then it returns a presigned PUT for bucket/folder/id with a 15-minute expiry.
func TestREG_KERNEL_STORAGE_001_R2SignUploadPresignsPutUnderFolder(t *testing.T) {
	r, _, srv := newFakeR2(t, "clinic-bkt")
	tgt, err := r.SignUpload(context.Background(), UploadOptions{Folder: "/tenantA/patients/p1/", PublicID: "scan"})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if tgt.Method != http.MethodPut {
		t.Fatalf("method = %q, want PUT", tgt.Method)
	}
	if tgt.Key != "tenantA/patients/p1/scan" {
		t.Fatalf("key = %q, want folder slashes trimmed + id", tgt.Key)
	}
	if tgt.Fields == nil || len(tgt.Fields) != 0 {
		t.Fatalf("fields = %#v, want empty non-nil map", tgt.Fields)
	}
	u, err := url.Parse(tgt.URL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	if "http://"+u.Host != srv.URL {
		t.Fatalf("host = %q, want fake %q", u.Host, srv.URL)
	}
	if u.Path != "/clinic-bkt/tenantA/patients/p1/scan" {
		t.Fatalf("path = %q", u.Path)
	}
	q := u.Query()
	if q.Get("X-Amz-Expires") != "900" || q.Get("X-Amz-Signature") == "" || q.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" {
		t.Fatalf("presign query not a 15m SigV4 presign: %v", q)
	}
	if !strings.Contains(q.Get("X-Amz-Credential"), "AKIDTEST/") || !strings.Contains(q.Get("X-Amz-Credential"), "/auto/s3/") {
		t.Fatalf("credential scope = %q, want access key + region auto", q.Get("X-Amz-Credential"))
	}
}

// Given no public id and no folder, When SignUpload runs, Then a fresh random
// UUID becomes the whole key and two calls never collide.
func TestREG_KERNEL_STORAGE_002_R2SignUploadMintsUniqueUUIDKey(t *testing.T) {
	r, _, _ := newFakeR2(t, "bkt1")
	a, err := r.SignUpload(context.Background(), UploadOptions{})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	b, _ := r.SignUpload(context.Background(), UploadOptions{Folder: "///"})
	if len(a.Key) != 36 || strings.Contains(a.Key, "/") {
		t.Fatalf("key %q is not a bare uuid", a.Key)
	}
	if len(b.Key) != 36 || strings.Contains(b.Key, "/") {
		t.Fatalf("all-slash folder should collapse to bare uuid, got %q", b.Key)
	}
	if a.Key == b.Key {
		t.Fatal("two uploads minted the same key")
	}
}

// Given an invalid bucket name, When SignUpload/URL presign, Then SignUpload
// returns a wrapped error and URL returns "" instead of a bogus link.
func TestREG_KERNEL_STORAGE_003_R2PresignErrorsSurface(t *testing.T) {
	r, _, _ := newFakeR2(t, "")
	if _, err := r.SignUpload(context.Background(), UploadOptions{PublicID: "x"}); err == nil || !strings.Contains(err.Error(), "r2 presign put") {
		t.Fatalf("err = %v, want wrapped r2 presign put error", err)
	}
	if got := r.URL("t/x"); got != "" {
		t.Fatalf("URL with bad bucket = %q, want empty", got)
	}
}

// Given a stored key, When URL is requested, Then it is a 1-hour presigned GET
// forcing inline display for exactly that key.
func TestREG_KERNEL_STORAGE_004_R2URLIsInlinePresignedGet(t *testing.T) {
	r, _, srv := newFakeR2(t, "bkt")
	raw := r.URL("tenantA/dental/p/img 1.jpg")
	u, err := url.Parse(raw)
	if err != nil || raw == "" {
		t.Fatalf("url %q: %v", raw, err)
	}
	if "http://"+u.Host != srv.URL || u.Path != "/bkt/tenantA/dental/p/img 1.jpg" {
		t.Fatalf("url targets %s%s", u.Host, u.Path)
	}
	q := u.Query()
	if q.Get("response-content-disposition") != "inline" || q.Get("X-Amz-Expires") != "3600" || q.Get("X-Amz-Signature") == "" {
		t.Fatalf("query = %v", q)
	}
}

// Given the fake S3 returns 204 for DELETE, When Delete is called, Then one
// signed DELETE hits /bucket/key and no error is returned.
func TestREG_KERNEL_STORAGE_005_R2DeleteSendsSignedDelete(t *testing.T) {
	r, f, _ := newFakeR2(t, "bkt")
	f.status["DELETE /bkt/tenantA/x.jpg"] = http.StatusNoContent
	if err := r.Delete(context.Background(), "tenantA/x.jpg"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	reqs := f.requests()
	if len(reqs) != 1 || reqs[0].Method != http.MethodDelete || reqs[0].Path != "/bkt/tenantA/x.jpg" {
		t.Fatalf("requests = %+v", reqs)
	}
	if !strings.HasPrefix(reqs[0].Auth, "AWS4-HMAC-SHA256 Credential=AKIDTEST/") {
		t.Fatalf("delete not SigV4-signed: %q", reqs[0].Auth)
	}
}

// Given the fake S3 rejects with 403/500, When Delete is called, Then the S3
// error code and status are surfaced (not swallowed).
func TestREG_KERNEL_STORAGE_006_R2DeleteMapsErrors(t *testing.T) {
	for _, tc := range []struct {
		code int
		s3   string
	}{{403, "AccessDenied"}, {500, "InternalError"}} {
		r, f, _ := newFakeR2(t, "bkt")
		f.status["DELETE /bkt/k"] = tc.code
		err := r.Delete(context.Background(), "k")
		if err == nil {
			t.Fatalf("status %d: Delete returned nil", tc.code)
		}
		er := minio.ToErrorResponse(err)
		if er.StatusCode != tc.code || er.Code != tc.s3 {
			t.Fatalf("status %d: got %+v", tc.code, er)
		}
	}
}

// Given an object of 4321 bytes, When Size is called, Then it HEADs the key
// and returns the server-reported size (not a client-declared one).
func TestREG_KERNEL_STORAGE_007_R2SizeReturnsStoredBytes(t *testing.T) {
	r, f, _ := newFakeR2(t, "bkt")
	f.size = 4321
	f.status["HEAD /bkt/tenantA/a.png"] = http.StatusOK
	n, err := r.Size(context.Background(), "tenantA/a.png")
	if err != nil || n != 4321 {
		t.Fatalf("size = %d, %v; want 4321", n, err)
	}
	reqs := f.requests()
	if len(reqs) != 1 || reqs[0].Method != http.MethodHead {
		t.Fatalf("requests = %+v", reqs)
	}
}

// Given the object is missing (404) or forbidden (403), When Size is called,
// Then it returns 0 and an error carrying the HTTP status.
func TestREG_KERNEL_STORAGE_008_R2SizeMapsErrors(t *testing.T) {
	for _, code := range []int{404, 403} {
		r, f, _ := newFakeR2(t, "bkt")
		f.status["HEAD /bkt/gone"] = code
		n, err := r.Size(context.Background(), "gone")
		if err == nil || n != 0 {
			t.Fatalf("status %d: size=%d err=%v", code, n, err)
		}
		if got := minio.ToErrorResponse(err).StatusCode; got != code {
			t.Fatalf("status %d surfaced as %d", code, got)
		}
	}
}

// Given an unreachable endpoint, When Delete/Size run, Then they fail fast with
// an error rather than reporting success.
func TestREG_KERNEL_STORAGE_009_R2NetworkFailureIsError(t *testing.T) {
	r, _, srv := newFakeR2(t, "bkt")
	srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.Delete(ctx, "k"); err == nil {
		t.Fatal("Delete against closed server returned nil")
	}
	if _, err := r.Size(ctx, "k"); err == nil {
		t.Fatal("Size against closed server returned nil")
	}
}

// ---------------------------------------------------------------------------
// Cloudinary
// ---------------------------------------------------------------------------

// Given Cloudinary's documented example params and secret, When sign runs,
// Then it yields the documented SHA-1 signature (sorted k=v&... + secret).
func TestREG_KERNEL_STORAGE_010_CloudinarySignMatchesDocumentedVector(t *testing.T) {
	c := NewCloudinary("demo", "key", "abcd", "")
	got := c.sign(map[string]string{
		"timestamp": "1315060510",
		"public_id": "sample_image",
		"eager":     "w_400,h_300,c_pad|w_260,h_200,c_crop",
	})
	if got != "bfd09f95f331f558cbd1320e67aa8d488770583e" {
		t.Fatalf("signature = %s", got)
	}
	// Order-independent: map iteration must not change the signature.
	for i := 0; i < 20; i++ {
		if c.sign(map[string]string{"b": "2", "a": "1", "c": "3"}) != sha1hex("a=1&b=2&c=3abcd") {
			t.Fatal("signature depends on map order")
		}
	}
}

func sha1hex(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

// Given folder/public id/tags, When SignUpload runs, Then the target is a POST
// to the resource-type endpoint whose signature covers exactly
// folder,public_id,tags,timestamp (not api_key) and verifies with the secret.
func TestREG_KERNEL_STORAGE_011_CloudinarySignUploadFieldsAndSignature(t *testing.T) {
	c := NewCloudinary("acme", "K123", "S3CR3T", "default")
	if c.Name() != "cloudinary" {
		t.Fatalf("name = %q", c.Name())
	}
	tgt, err := c.SignUpload(context.Background(), UploadOptions{Folder: "tenantA/patients/", PublicID: "doc1", ResourceType: "raw", Tags: []string{"patient", "lab"}})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if tgt.Method != http.MethodPost || tgt.URL != "https://api.cloudinary.com/v1_1/acme/raw/upload" {
		t.Fatalf("target = %s %s", tgt.Method, tgt.URL)
	}
	if tgt.Key != "tenantA/patients/doc1" {
		t.Fatalf("key = %q", tgt.Key)
	}
	f := tgt.Fields
	if f["api_key"] != "K123" || f["folder"] != "tenantA/patients/" || f["public_id"] != "doc1" || f["tags"] != "patient,lab" {
		t.Fatalf("fields = %v", f)
	}
	ts, err := strconv.ParseInt(f["timestamp"], 10, 64)
	if err != nil || time.Since(time.Unix(ts, 0)) > time.Minute {
		t.Fatalf("timestamp %q not current", f["timestamp"])
	}
	want := sha1hex("folder=tenantA/patients/&public_id=doc1&tags=patient,lab&timestamp=" + f["timestamp"] + "S3CR3T")
	if f["signature"] != want {
		t.Fatalf("signature %s, want %s", f["signature"], want)
	}
	if _, leaked := f["api_secret"]; leaked || strings.Contains(tgt.URL, "S3CR3T") {
		t.Fatal("api secret leaked into upload target")
	}
}

// Given no folder/public id/type, When SignUpload runs, Then it falls back to
// the configured upload folder, resource type "auto", and the folder as key.
func TestREG_KERNEL_STORAGE_012_CloudinarySignUploadDefaults(t *testing.T) {
	c := NewCloudinary("acme", "K", "S", "clinic")
	tgt, _ := c.SignUpload(context.Background(), UploadOptions{})
	if tgt.URL != "https://api.cloudinary.com/v1_1/acme/auto/upload" || tgt.Key != "clinic" || tgt.Fields["folder"] != "clinic" {
		t.Fatalf("target = %+v", tgt)
	}
	if _, ok := tgt.Fields["public_id"]; ok {
		t.Fatal("public_id set without being requested")
	}
	if _, ok := tgt.Fields["tags"]; ok {
		t.Fatal("tags set without being requested")
	}
	if tgt.Fields["signature"] != sha1hex("folder=clinic&timestamp="+tgt.Fields["timestamp"]+"S") {
		t.Fatal("default signature wrong")
	}
	// No folder configured at all: only timestamp is signed.
	c2 := NewCloudinary("acme", "K", "S", "")
	t2, _ := c2.SignUpload(context.Background(), UploadOptions{})
	if _, ok := t2.Fields["folder"]; ok || t2.Fields["signature"] != sha1hex("timestamp="+t2.Fields["timestamp"]+"S") {
		t.Fatalf("no-folder target = %+v", t2)
	}
}

// Given a key, When URL is built, Then it is the public res.cloudinary.com
// image delivery URL for that key.
func TestREG_KERNEL_STORAGE_013_CloudinaryURL(t *testing.T) {
	c := NewCloudinary("acme", "K", "S", "")
	if got := c.URL("tenantA/p/x"); got != "https://res.cloudinary.com/acme/image/upload/tenantA/p/x" {
		t.Fatalf("url = %s", got)
	}
}

// rewriteTransport sends every request to the fake server, recording it.
type rewriteTransport struct {
	target *url.URL
	mu     sync.Mutex
	seen   []*http.Request
	forms  []url.Values
}

func (rt *rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	body, _ := io.ReadAll(r.Body)
	form, _ := url.ParseQuery(string(body))
	rt.mu.Lock()
	rt.seen = append(rt.seen, r.Clone(r.Context()))
	rt.forms = append(rt.forms, form)
	rt.mu.Unlock()
	out := r.Clone(r.Context())
	out.URL.Scheme = rt.target.Scheme
	out.URL.Host = rt.target.Host
	out.Host = rt.target.Host
	out.Body = io.NopCloser(strings.NewReader(string(body)))
	out.RequestURI = ""
	return http.DefaultTransport.RoundTrip(out)
}

func cloudinaryWithFake(t *testing.T, status int) (*Cloudinary, *rewriteTransport) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `{"result":"ok"}`)
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	rt := &rewriteTransport{target: u}
	c := NewCloudinary("acme", "K123", "S3CR3T", "")
	c.http = &http.Client{Transport: rt, Timeout: 5 * time.Second}
	return c, rt
}

// Given the destroy API answers 200, When Delete is called, Then it POSTs a
// form-encoded, correctly signed destroy request for the key and succeeds.
func TestREG_KERNEL_STORAGE_014_CloudinaryDeleteSignedDestroy(t *testing.T) {
	c, rt := cloudinaryWithFake(t, http.StatusOK)
	if err := c.Delete(context.Background(), "tenantA/p/x"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(rt.seen) != 1 {
		t.Fatalf("requests = %d", len(rt.seen))
	}
	req, form := rt.seen[0], rt.forms[0]
	if req.Method != http.MethodPost || req.URL.String() != "https://api.cloudinary.com/v1_1/acme/image/destroy" {
		t.Fatalf("request = %s %s", req.Method, req.URL)
	}
	if req.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Fatalf("content-type = %q", req.Header.Get("Content-Type"))
	}
	if form.Get("public_id") != "tenantA/p/x" || form.Get("api_key") != "K123" {
		t.Fatalf("form = %v", form)
	}
	want := sha1hex("public_id=tenantA/p/x&timestamp=" + form.Get("timestamp") + "S3CR3T")
	if form.Get("signature") != want {
		t.Fatalf("signature = %s, want %s", form.Get("signature"), want)
	}
}

// Given the destroy API answers 4xx/5xx, When Delete is called, Then the status
// is reported as an error.
func TestREG_KERNEL_STORAGE_015_CloudinaryDeleteMapsHTTPErrors(t *testing.T) {
	for _, code := range []int{401, 404, 500} {
		c, _ := cloudinaryWithFake(t, code)
		err := c.Delete(context.Background(), "k")
		if err == nil || !strings.Contains(err.Error(), "status "+strconv.Itoa(code)) {
			t.Fatalf("status %d: err = %v", code, err)
		}
	}
}

// Given a transport failure or an unbuildable request, When Delete is called,
// Then an error is returned (no silent success).
func TestREG_KERNEL_STORAGE_016_CloudinaryDeleteTransportAndRequestErrors(t *testing.T) {
	c := NewCloudinary("acme", "K", "S", "")
	boom := errors.New("boom")
	c.http = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, boom })}
	if err := c.Delete(context.Background(), "k"); !errors.Is(err, boom) {
		t.Fatalf("transport err = %v, want boom", err)
	}
	bad := NewCloudinary("bad\x7fname", "K", "S", "")
	if err := bad.Delete(context.Background(), "k"); err == nil {
		t.Fatal("invalid cloud name produced no request error")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// ---------------------------------------------------------------------------
// Noop
// ---------------------------------------------------------------------------

// Given the noop provider, When used, Then uploads are refused, URLs are the
// key unchanged, and delete succeeds without doing anything.
func TestREG_KERNEL_STORAGE_017_NoopBehaviour(t *testing.T) {
	var p Provider = NewNoop()
	if p.Name() != "noop" {
		t.Fatalf("name = %q", p.Name())
	}
	tgt, err := p.SignUpload(context.Background(), UploadOptions{Folder: "x"})
	if err == nil || err.Error() != "storage provider not configured" {
		t.Fatalf("err = %v", err)
	}
	if tgt.URL != "" || tgt.Key != "" || tgt.Method != "" {
		t.Fatalf("noop returned non-empty target %+v", tgt)
	}
	if p.URL("a/b") != "a/b" {
		t.Fatal("noop URL altered key")
	}
	if err := p.Delete(context.Background(), "a/b"); err != nil {
		t.Fatalf("noop delete: %v", err)
	}
	if _, ok := p.(Sizer); ok {
		t.Fatal("noop must not claim Sizer (callers fall back to declared size)")
	}
}
