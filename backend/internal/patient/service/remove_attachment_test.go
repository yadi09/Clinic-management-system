package service

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
	"github.com/reicb/clinicsaas/internal/kernel/storage"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

type recordingStore struct {
	*storage.Noop
	deleted []string
}

func (r *recordingStore) Delete(_ context.Context, key string) error {
	r.deleted = append(r.deleted, key)
	return nil
}

// Removing an attachment hides the record; the stored file is KEPT (AUD-02): nothing
// backs the file store up, and removal is one tap.
func TestRemoveAttachmentHidesTheRecordButKeepsTheFile(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if testing.Short() || dsn == "" {
		t.Skip("set TEST_DATABASE_URL to a throwaway Postgres")
	}
	ctx := context.Background()
	sdb, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	goose.SetBaseFS(migrations.FS)
	_ = goose.SetDialect("postgres")
	if err := goose.UpContext(ctx, sdb, "."); err != nil {
		t.Fatal(err)
	}
	sdb.Close()
	db, err := kerneldb.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	var tid, uid, pid, att uuid.UUID
	slug := "ra-" + uuid.NewString()[:8]
	if err := db.Pool.QueryRow(ctx, `INSERT INTO tenants (name, slug, status, plan_id) VALUES ($1,$1,'active',(SELECT id FROM plans LIMIT 1)) RETURNING id`, slug).Scan(&tid); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `INSERT INTO users (tenant_id, email, full_name, status) VALUES ($1,$2,'Desk','active') RETURNING id`, tid, slug+"@t").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx,
		`INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender, dob) VALUES ($1,'M-1','Test','Patient','female','1990-01-01') RETURNING id`, tid).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	key := tid.String() + "/patients/" + pid.String() + "/scan-1"
	if err := db.Pool.QueryRow(ctx,
		`INSERT INTO attachments (tenant_id, patient_id, type, storage_key, filename, mime_type, size_bytes)
		 VALUES ($1,$2,'pdf',$3,'scan.pdf','application/pdf',2048) RETURNING id`, tid, pid, key).Scan(&att); err != nil {
		t.Fatal(err)
	}

	rec := &recordingStore{Noop: storage.NewNoop()}
	svc := NewService(db, rec, events.NewOutboxPublisher())
	as := tenancy.WithPrincipal(ctx, &tenancy.Principal{UserID: uid, TenantID: tid, Permissions: []string{"patient.update"}})

	if err := svc.RemoveAttachment(as, pid, att); err != nil {
		t.Fatal(err)
	}
	var hidden bool
	if err := db.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM attachments WHERE id = $1`, att).Scan(&hidden); err != nil || !hidden {
		t.Fatalf("the attachment record was not hidden (err=%v)", err)
	}
	if len(rec.deleted) != 0 {
		t.Fatalf("the stored file was destroyed on removal: %v", rec.deleted)
	}
	if err := svc.RemoveAttachment(as, pid, att); err == nil {
		t.Fatal("removing an already removed attachment should be refused")
	}
	if len(rec.deleted) != 0 {
		t.Fatalf("the stored file was destroyed on the second removal: %v", rec.deleted)
	}
}
