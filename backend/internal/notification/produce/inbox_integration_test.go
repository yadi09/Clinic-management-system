package produce

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/notification"
	"github.com/reicb/clinicsaas/internal/notification/service"
)

// The inbox the notifications page reads: paged, filtered, counted, and never
// anyone else's.
func TestIntegrationInboxPagingAndFilters(t *testing.T) {
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
	f := &fixture{t: t, ctx: ctx, db: db}

	tid := f.tenant("active")
	me := f.user(tid, "doctor", "active")
	other := f.user(tid, "doctor", "active")

	// 25 for me, a minute apart: odd ones missed visits, even ones waiting
	// patients; every third one already read.
	for i := 0; i < 25; i++ {
		kind := notification.KindPatientWaiting
		if i%2 == 1 {
			kind = notification.KindMissedVisit
		}
		f.exec(`INSERT INTO notifications (tenant_id, user_id, kind, title, body, dedupe_key, created_at, read_at)
		        VALUES ($1,$2,$3,'t','b',$4, now() - ($5 || ' minutes')::interval,
		                CASE WHEN $6 THEN now() END)`,
			tid, me, kind, fmt.Sprintf("k%d", i), fmt.Sprint(i), i%3 == 0)
	}
	var theirs uuid.UUID
	for i := 0; i < 3; i++ {
		theirs = f.id(`INSERT INTO notifications (tenant_id, user_id, kind, title, body, dedupe_key)
		               VALUES ($1,$2,'missed_visit','t','b',$3) RETURNING id`, tid, other, fmt.Sprintf("o%d", i))
	}

	svc := service.NewService(db)
	as := tenancy.WithPrincipal(ctx, &tenancy.Principal{UserID: me, TenantID: tid})

	// Page through everything, ten at a time.
	seen := map[uuid.UUID]bool{}
	var before *uuid.UUID
	pages := 0
	for {
		page, err := svc.List(as, notification.ListFilter{Limit: 10, Before: before})
		if err != nil {
			t.Fatal(err)
		}
		pages++
		for i, n := range page.Items {
			if seen[n.ID] {
				t.Fatalf("page %d shows %s twice", pages, n.ID)
			}
			seen[n.ID] = true
			if i > 0 && n.CreatedAt.After(page.Items[i-1].CreatedAt) {
				t.Fatalf("page %d is not newest first", pages)
			}
		}
		if pages == 1 {
			// Something new arrives while the user is scrolling.
			f.exec(`INSERT INTO notifications (tenant_id, user_id, kind, title, body, dedupe_key)
			        VALUES ($1,$2,'missed_visit','t','b','late')`, tid, me)
		}
		if page.Next == nil {
			break
		}
		before = page.Next
		if pages > 5 {
			t.Fatal("paging does not end")
		}
	}
	if len(seen) != 25 || pages != 3 {
		t.Fatalf("paged %d notifications over %d pages, want 25 over 3 (the late one belongs above page 1)", len(seen), pages)
	}

	// Filters.
	count := func(fl notification.ListFilter) int {
		fl.Limit = 50
		page, err := svc.List(as, fl)
		if err != nil {
			t.Fatal(err)
		}
		return len(page.Items)
	}
	// 26 now, including the late one (unread, missed visit). Of the 25: i%3==0 read = 9.
	if got := count(notification.ListFilter{Status: notification.StatusRead}); got != 9 {
		t.Errorf("read = %d, want 9", got)
	}
	if got := count(notification.ListFilter{Status: notification.StatusUnread}); got != 17 {
		t.Errorf("unread = %d, want 17", got)
	}
	if got := count(notification.ListFilter{Kind: notification.KindMissedVisit}); got != 13 {
		t.Errorf("missed visits = %d, want 13", got)
	}
	if got := count(notification.ListFilter{Kind: notification.KindPatientWaiting, Status: notification.StatusUnread}); got != 8 {
		t.Errorf("unread waiting = %d, want 8", got)
	}
	if _, err := svc.List(as, notification.ListFilter{Status: "bogus"}); err == nil {
		t.Error("an unknown status should be refused")
	}

	// Counts per kind agree with the filters.
	c, err := svc.Counts(as)
	if err != nil {
		t.Fatal(err)
	}
	if c.Unread != 17 || c.ByKind[notification.KindMissedVisit] != 9 || c.ByKind[notification.KindPatientWaiting] != 8 {
		t.Fatalf("counts = %+v, want 17 unread: 9 missed, 8 waiting", c)
	}

	// Someone else's notification as a cursor shows nothing of theirs, or mine.
	page, err := svc.List(as, notification.ListFilter{Before: &theirs})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("paging from another user's notification returned %d items", len(page.Items))
	}

	// Mark all read, one kind at a time.
	if n, err := svc.MarkAllRead(as, notification.KindMissedVisit); err != nil || n != 9 {
		t.Fatalf("mark missed visits read: n=%d err=%v, want 9", n, err)
	}
	c, _ = svc.Counts(as)
	if c.ByKind[notification.KindMissedVisit] != 0 || c.ByKind[notification.KindPatientWaiting] != 8 {
		t.Fatalf("after marking missed visits read, counts = %+v; waiting should be untouched", c)
	}
	// The other user's are untouched by all of it.
	var theirsUnread int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`, other).Scan(&theirsUnread); err != nil {
		t.Fatal(err)
	}
	if theirsUnread != 3 {
		t.Fatalf("another user's unread changed to %d", theirsUnread)
	}
}
