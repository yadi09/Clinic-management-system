// Command e2estack stands up the backend half of the frontend's Playwright suite:
// the guarded, migrated test database, ONE dental clinic with a user in every role,
// and the real API started as clinic_app (RLS enforced), exactly as the API
// regression suite does it (see tests/regression).
//
// It writes what the browser tests need to -out as JSON, prints READY, and then
// blocks until SIGTERM/SIGINT, when it stops the API. Playwright's globalSetup
// (frontend/e2e/global-setup.ts) runs it; nobody needs to run it by hand.
//
//	TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/clinic_regress?sslmode=disable \
//	  go run ./tests/e2estack -out /tmp/e2e-stack.json
//
// testkit.Prepare refuses any database that is not plainly a local throwaway one.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"testing"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/testkit"
)

// Stack is the JSON handed to the browser tests.
type Stack struct {
	APIBase    string            `json:"apiBase"`
	Slug       string            `json:"slug"`
	OwnerEmail string            `json:"ownerEmail"`
	Staff      map[string]string `json:"staff"` // role code -> email
	Password   string            `json:"password"`
}

func main() {
	out := flag.String("out", "", "path to write the stack JSON to (required)")
	flag.Parse()
	if *out == "" {
		fail("-out is required")
	}

	dsn, skip, err := testkit.Prepare()
	if err != nil {
		fail("%v", err)
	}
	if skip != "" {
		fail("%s", skip)
	}
	super, err := kerneldb.Connect(context.Background(), dsn)
	if err != nil {
		fail("connect: %v", err)
	}
	defer super.Pool.Close()

	tb := &setupTB{}
	clinic := provision(tb, super)
	if tb.failed || clinic == nil {
		fail("provision: %s", tb.msg)
	}

	srv, err := testkit.StartAPI(dsn, testkit.AppDSNFrom(dsn))
	if err != nil {
		fail("start api: %v", err)
	}
	defer srv.Stop()

	st := Stack{APIBase: srv.BaseURL, Slug: clinic.Slug, OwnerEmail: clinic.Owner.Email,
		Staff: map[string]string{}, Password: testkit.StaffPassword}
	for role, s := range clinic.Staff {
		st.Staff[role] = s.Email
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	if err := os.WriteFile(*out, b, 0o600); err != nil {
		srv.Stop()
		fail("write %s: %v", *out, err)
	}
	fmt.Println("READY")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	if os.Getenv("E2E_STACK_LOGS") == "1" {
		fmt.Fprintln(os.Stderr, srv.Logs())
	}
}

// provision recovers the panic setupTB.Fatalf raises, so a setup failure is reported
// rather than crashing with a stack trace.
func provision(tb *setupTB, db *kerneldb.DB) (c *testkit.Clinic) {
	defer func() {
		if r := recover(); r != nil {
			tb.failed = true
			if tb.msg == "" {
				tb.msg = fmt.Sprint(r)
			}
			c = nil
		}
	}()
	return testkit.NewClinic(tb, db, testkit.ClinicOpts{ClinicType: "dental"})
}

func fail(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "e2estack: "+f+"\n", a...)
	os.Exit(1)
}

// setupTB lets a main package use testkit helpers that take a testing.TB (the same
// adapter as tests/regression's TestMain).
type setupTB struct {
	testing.TB
	failed bool
	msg    string
}

func (s *setupTB) Helper() {}
func (s *setupTB) Fatalf(f string, a ...any) {
	s.failed, s.msg = true, fmt.Sprintf(f, a...)
	panic(s.msg)
}
func (s *setupTB) Fatal(a ...any)            { s.Fatalf("%v", fmt.Sprint(a...)) }
func (s *setupTB) Errorf(f string, a ...any) { s.failed, s.msg = true, fmt.Sprintf(f, a...) }
func (s *setupTB) Skip(a ...any)             {}
func (s *setupTB) Skipf(f string, a ...any)  {}
func (s *setupTB) Cleanup(func())            {}
func (s *setupTB) Logf(f string, a ...any)   {}
func (s *setupTB) Name() string              { return "e2estack" }
