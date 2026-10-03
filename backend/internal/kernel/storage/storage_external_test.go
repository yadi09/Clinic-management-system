package storage_test

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/reicb/clinicsaas/internal/kernel/storage"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Given account credentials, When NewR2 is constructed, Then it targets
// https://<account>.r2.cloudflarestorage.com and implements Provider+Sizer.
func TestREG_KERNEL_STORAGE_018_NewR2TargetsAccountEndpoint(t *testing.T) {
	r, err := storage.NewR2("acct123", "AK", "SK", "clinicos-attachments")
	if err != nil {
		t.Fatalf("NewR2: %v", err)
	}
	if r.Name() != "r2" {
		t.Fatalf("name = %q", r.Name())
	}
	var p storage.Provider = r
	if _, ok := p.(storage.Sizer); !ok {
		t.Fatal("R2 must implement Sizer so uploads are metered by real size")
	}
	// Presigning is local (no network); assert the endpoint/bucket/TLS.
	tgt, err := r.SignUpload(context.Background(), storage.UploadOptions{Folder: "t1/patients/p1", PublicID: "a"})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	u, _ := url.Parse(tgt.URL)
	if u.Scheme != "https" {
		t.Fatalf("scheme = %q, PHI uploads must use TLS", u.Scheme)
	}
	if !strings.HasPrefix(u.Host, "acct123.r2.cloudflarestorage.com") && !strings.HasPrefix(u.Host, "clinicos-attachments.acct123.r2.cloudflarestorage.com") {
		t.Fatalf("host = %q", u.Host)
	}
	if !strings.HasSuffix(u.Path, "t1/patients/p1/a") {
		t.Fatalf("path = %q", u.Path)
	}
}

// Given an account id that makes an invalid endpoint, When NewR2 runs, Then it
// returns a wrapped construction error instead of a half-built provider.
func TestREG_KERNEL_STORAGE_019_NewR2RejectsInvalidEndpoint(t *testing.T) {
	r, err := storage.NewR2("bad/acct", "AK", "SK", "b")
	if err == nil || r != nil || !strings.Contains(err.Error(), "r2 client") {
		t.Fatalf("r=%v err=%v; want wrapped r2 client error", r, err)
	}
}

// Given tenant A's folder, When keys are minted for normal ids, Then every key
// stays under "tenantA/" and never under tenant B's prefix.
func TestREG_KERNEL_STORAGE_020_R2KeysStayUnderTenantPrefix(t *testing.T) {
	r, _ := storage.NewR2("acct", "AK", "SK", "bkt")
	for _, opts := range []storage.UploadOptions{
		{Folder: "tenantA/patients/p1"},
		{Folder: "/tenantA/dental/p2/", PublicID: "img"},
		{Folder: "tenantA", PublicID: "x"},
	} {
		tgt, err := r.SignUpload(context.Background(), opts)
		if err != nil {
			t.Fatalf("sign %+v: %v", opts, err)
		}
		if !strings.HasPrefix(tgt.Key, "tenantA/") || strings.HasPrefix(tgt.Key, "tenantB/") {
			t.Fatalf("key %q escaped tenant prefix", tgt.Key)
		}
	}
}

// Given a public id containing "../tenantB", When SignUpload builds the key,
// Then the storage layer should reject or neutralise the traversal so the key
// cannot name another tenant's prefix. (Today callers only pass server-built
// UUID folders and never PublicID, so this is defence-in-depth only.)
func TestREG_KERNEL_STORAGE_021_R2RejectsPathTraversalInKey(t *testing.T) {
	r, _ := storage.NewR2("acct", "AK", "SK", "bkt")
	tgt, err := r.SignUpload(context.Background(), storage.UploadOptions{Folder: "tenantA/patients", PublicID: "../../tenantB/patients/x"})
	present := err == nil && strings.Contains(tgt.Key, "..")
	testkit.KnownBug(t, "NEW-KERNEL-STORAGE-1", present,
		"R2.SignUpload concatenates Folder+PublicID without rejecting '..' segments: key "+tgt.Key)
}

// Given a raw (non-image) upload on Cloudinary, When its delivery URL is built,
// Then it should use the raw delivery path; today URL() hard-codes image/upload,
// so PDFs/raw attachments get a URL Cloudinary will not serve.
func TestREG_KERNEL_STORAGE_022_CloudinaryURLIgnoresResourceType(t *testing.T) {
	c := storage.NewCloudinary("acme", "K", "S", "")
	tgt, _ := c.SignUpload(context.Background(), storage.UploadOptions{Folder: "t/p", PublicID: "report", ResourceType: "raw"})
	got := c.URL(tgt.Key)
	present := strings.Contains(got, "/image/upload/")
	testkit.KnownBug(t, "NEW-KERNEL-STORAGE-2", present,
		"Cloudinary.URL/Delete hard-code the image resource type; raw uploads get "+got+" and destroy targets image/destroy")
}
