package service

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/storage"
)

// recordingStore is a storage provider that remembers what it was asked to delete.
type recordingStore struct {
	*storage.Noop
	deleted []string
}

func (r *recordingStore) Delete(_ context.Context, key string) error {
	r.deleted = append(r.deleted, key)
	return nil
}

// Deleting an image hides it from the record and from the storage allowance, but the
// file is KEPT: nothing backs the file store up, and "delete" is one tap (AUD-02).
func TestDeleteImageHidesTheRecordButKeepsTheFile(t *testing.T) {
	f := newFixture(t)
	rec := &recordingStore{Noop: storage.NewNoop()}
	f.svc.store = rec

	var img uuid.UUID
	key := f.tenant.String() + "/dental/" + f.patient.String() + "/xray-1"
	must(t, f.db.Pool.QueryRow(context.Background(),
		`INSERT INTO attachments (tenant_id, patient_id, type, storage_key, filename, mime_type, size_bytes)
		 VALUES ($1, $2, 'image', $3, 'xray.jpg', 'image/jpeg', 1234) RETURNING id`, f.tenant, f.patient, key).Scan(&img))

	must(t, f.svc.DeleteImage(f.as(f.dentist), f.patient, img))

	var hidden bool
	must(t, f.db.Pool.QueryRow(context.Background(),
		`SELECT deleted_at IS NOT NULL FROM attachments WHERE id = $1`, img).Scan(&hidden))
	if !hidden {
		t.Fatal("the image record was not hidden")
	}
	if len(rec.deleted) != 0 {
		t.Fatalf("the stored file was destroyed on delete: %v", rec.deleted)
	}
	var counted int64
	must(t, f.db.Pool.QueryRow(context.Background(),
		`SELECT coalesce(sum(size_bytes),0) FROM attachments WHERE tenant_id = $1 AND deleted_at IS NULL`, f.tenant).Scan(&counted))
	if counted != 0 {
		t.Fatalf("a deleted image still counts against the storage allowance: %d bytes", counted)
	}
	// A second delete of the same image is a clean 404, not a second destruction.
	if err := f.svc.DeleteImage(f.as(f.dentist), f.patient, img); err == nil {
		t.Fatal("deleting an already deleted image should be refused")
	}
	if len(rec.deleted) != 0 {
		t.Fatalf("the stored file was destroyed on the second delete: %v", rec.deleted)
	}
}
