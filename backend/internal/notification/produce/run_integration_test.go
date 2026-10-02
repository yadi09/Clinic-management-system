package produce

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/notification"
	"github.com/reicb/clinicsaas/internal/notification/service"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// fakeProducer scripts one producer's two steps.
type fakeProducer struct {
	mu                 sync.Mutex
	produced, resolved int
	produceErr         error
	resolveErr         error
	panics             bool
	passes             int
}

func (p *fakeProducer) Produce(context.Context) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.passes++
	if p.panics {
		panic("producer blew up")
	}
	return p.produced, p.produceErr
}

func (p *fakeProducer) Resolve(context.Context) (int, error) { return p.resolved, p.resolveErr }

func capture() (*slog.Logger, *bytes.Buffer, *sync.Mutex) {
	var buf bytes.Buffer
	var mu sync.Mutex
	return slog.New(slog.NewTextHandler(&lockedWriter{&buf, &mu}, nil)), &buf, &mu
}

type lockedWriter struct {
	b  *bytes.Buffer
	mu *sync.Mutex
}

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.b.Write(p)
}

// Given a producer pass, When either step reports work, fails, or panics, Then the
// pass logs what happened and never lets the failure escape — the worker's SMS and
// event loops share this process — and a failing first step does not stop the second.
func TestIntegrationProducerPassNeverEscapes(t *testing.T) {
	log, buf, mu := capture()
	ctx := context.Background()
	pass(ctx, &fakeProducer{produced: 2, resolved: 1}, "demo", log)
	pass(ctx, &fakeProducer{produceErr: errors.New("db down"), resolveErr: errors.New("still down")}, "demo", log)
	pass(ctx, &fakeProducer{panics: true}, "demo", log)
	pass(ctx, &fakeProducer{}, "quiet", log) // nothing to say: nothing logged
	mu.Lock()
	out := buf.String()
	mu.Unlock()
	for _, want := range []string{
		"demo notifications created", "demo notifications cleared",
		"demo notifications failed", "clearing handled demo notifications failed",
		"demo notifications panicked",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("log lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "quiet") {
		t.Fatalf("an idle pass logged:\n%s", out)
	}
}

// Given the producer loop, When it runs, Then it passes once at start and again on
// every tick, and stops when its context ends; the real producers' loops stop too.
func TestIntegrationProducerLoopTicksAndStops(t *testing.T) {
	log, _, _ := capture()
	p := &fakeProducer{}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	run(ctx, p, "tick", 50*time.Millisecond, log)
	if p.passes < 3 {
		t.Fatalf("want a pass at start and on ticks, got %d", p.passes)
	}
	// The real producers over a real pool, with a context that is already over: the
	// pass fails (logged, not fatal) and the loop returns without writing anything.
	dsn := testkit.RequireDB(t)
	db := testkit.SuperDB(t, dsn)
	dead, stop := context.WithCancel(context.Background())
	stop()
	NewMissedVisits(db, log).Run(dead, time.Hour)
	NewPatientWaiting(db, log).Run(dead, time.Hour)
}

// Given the inbox service, When it is called without a signed-in user, with a
// status it does not know, or while the database cannot be reached, Then it refuses
// plainly (401 / 400 / 500) instead of answering for nobody; and the unread count
// is the caller's own.
func TestIntegrationInboxServiceRefusals(t *testing.T) {
	dsn := testkit.RequireDB(t)
	db := testkit.SuperDB(t, dsn)
	f := &fixture{t: t, ctx: context.Background(), db: db}
	tid := f.tenant("active")
	me := f.user(tid, "receptionist", "active")
	other := f.user(tid, "receptionist", "active")
	for i, u := range []uuid.UUID{me, me, other} {
		f.exec(`INSERT INTO notifications (tenant_id, user_id, kind, title, dedupe_key) VALUES ($1,$2,'regress_demo','t',$3)`,
			tid, u, uuid.NewString()+string(rune('a'+i)))
	}
	svc := service.NewService(db)
	anon := context.Background()
	asMe := tenancy.WithPrincipal(context.Background(), &tenancy.Principal{TenantID: tid, UserID: me})

	n, err := svc.UnreadCount(asMe)
	if err != nil || n != 2 {
		t.Fatalf("unread count: %d %v", n, err)
	}
	wantCode := func(what string, err error, status int) {
		t.Helper()
		ae, ok := apperr.As(err)
		if !ok || ae.HTTPStatus != status {
			t.Fatalf("%s: want HTTP %d, got %v", what, status, err)
		}
	}
	_, err = svc.List(anon, notification.ListFilter{})
	wantCode("list signed out", err, 401)
	_, err = svc.Counts(anon)
	wantCode("counts signed out", err, 401)
	_, err = svc.UnreadCount(anon)
	wantCode("unread signed out", err, 401)
	wantCode("mark signed out", svc.MarkRead(anon, uuid.New()), 401)
	_, err = svc.MarkAllRead(anon, "")
	wantCode("mark all signed out", err, 401)
	_, err = svc.List(asMe, notification.ListFilter{Status: "maybe"})
	wantCode("unknown status", err, 400)
	// Limits are clamped, not refused.
	page, err := svc.List(asMe, notification.ListFilter{Limit: 500})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("clamped list: %v %v", page, err)
	}

	gone, stop := context.WithCancel(asMe)
	stop()
	_, err = svc.List(gone, notification.ListFilter{})
	wantCode("list, database unreachable", err, 500)
	_, err = svc.Counts(gone)
	wantCode("counts, database unreachable", err, 500)
	_, err = svc.UnreadCount(gone)
	wantCode("unread, database unreachable", err, 500)
	wantCode("mark, database unreachable", svc.MarkRead(gone, uuid.New()), 500)
	_, err = svc.MarkAllRead(gone, "")
	wantCode("mark all, database unreachable", err, 500)
}
