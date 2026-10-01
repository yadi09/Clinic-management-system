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
	"github.com/reicb/clinicsaas/internal/patient"
)

// TestRegisterWithOnlyAFirstName (clinic feedback, 2026-10-01): reception may know
// only a first name. Such a patient registers, reads back with no date of birth,
// and does not break patient search for everyone else.
func TestRegisterWithOnlyAFirstName(t *testing.T) {
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

	var tid, uid uuid.UUID
	slug := "fn-" + uuid.NewString()[:8]
	if err := db.Pool.QueryRow(ctx, `INSERT INTO tenants (name, slug, status, plan_id) VALUES ($1,$1,'active',(SELECT id FROM plans LIMIT 1)) RETURNING id`, slug).Scan(&tid); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `INSERT INTO users (tenant_id, email, full_name, status) VALUES ($1,$2,'Desk','active') RETURNING id`, tid, slug+"@t").Scan(&uid); err != nil {
		t.Fatal(err)
	}
	as := tenancy.WithPrincipal(ctx, &tenancy.Principal{UserID: uid, TenantID: tid, Permissions: []string{"patient.create", "patient.read", "patient.search"}})
	svc := NewService(db, storage.NewNoop(), events.NewOutboxPublisher())

	p, dups, err := svc.Create(as, patient.PatientInput{FirstName: "Abebe"})
	if err != nil || len(dups) != 0 || p == nil {
		t.Fatalf("first name only: p=%v dups=%v err=%v", p, dups, err)
	}
	got, err := svc.Get(as, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.DOB != "" || got.LastName != "" {
		t.Fatalf("read back dob=%q last=%q, want both empty", got.DOB, got.LastName)
	}
	// Someone with an age, alongside: search must list both.
	if _, _, err := svc.Create(as, patient.PatientInput{FirstName: "Almaz", DOB: "1986-10-01", DOBEstimated: true}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Create(as, patient.PatientInput{FirstName: "  "}); err == nil {
		t.Fatal("a blank first name was accepted")
	}
	if _, _, err := svc.Create(as, patient.PatientInput{FirstName: "Future", DOB: "2999-01-01"}); err == nil {
		t.Fatal("a date of birth in the future was accepted")
	}
	res, total, err := searchAll(svc, as)
	if err != nil {
		t.Fatalf("search with a no-DOB patient in the list: %v", err)
	}
	if total != 2 || len(res) != 2 {
		t.Fatalf("search found %d (%d rows), want 2", total, len(res))
	}
}

func searchAll(svc *Service, ctx context.Context) ([]patient.Summary, int, error) {
	r, err := svc.Search(ctx, patient.SearchFilter{}, 1, 50)
	if err != nil {
		return nil, 0, err
	}
	return r.Items, r.Total, nil
}
