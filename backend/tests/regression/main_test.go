// Package regression is the black-box API regression suite.
//
// It starts the real API binary (cmd/api) against a throwaway database, connected as
// the RLS-enforced clinic_app role exactly as production is, and drives it over HTTP.
// Two clinics, A and B, are provisioned once with a user in every role; tests that
// need their own data create it, so tests never depend on each other's state.
//
// Test names carry their catalogue ID: TestREG_<DOMAIN>_<NNN>_<Behaviour>. Run one
// domain with -run 'REG_PAY', one test with its ID. See TESTING.md.
package regression

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/testkit"
)

var (
	srv      *testkit.Server
	superDSN string
	super    *kerneldb.DB
	clinicA  *testkit.Clinic
	clinicB  *testkit.Clinic
)

func TestMain(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) int {
	dsn, skip, err := testkit.Prepare()
	if err != nil {
		fmt.Fprintln(os.Stderr, "regression suite:", err)
		return 1
	}
	if skip != "" {
		fmt.Println("regression suite:", skip)
		return 0
	}
	superDSN = dsn
	super, err = kerneldb.Connect(context.Background(), dsn)
	if err != nil {
		fmt.Fprintln(os.Stderr, "regression suite: connect:", err)
		return 1
	}
	defer super.Pool.Close()

	srv, err = testkit.StartAPI(dsn, testkit.AppDSNFrom(dsn))
	if err != nil {
		fmt.Fprintln(os.Stderr, "regression suite: start api:", err)
		return 1
	}
	defer srv.Stop()

	tb := &setupTB{}
	func() {
		// setupTB.Fatalf panics to stop the helper; turn that back into a message.
		defer func() { _ = recover() }()
		clinicA = testkit.NewClinic(tb, super, testkit.ClinicOpts{})
		clinicB = testkit.NewClinic(tb, super, testkit.ClinicOpts{})
	}()
	if tb.failed || clinicA == nil || clinicB == nil {
		fmt.Fprintln(os.Stderr, "regression suite: setup:", tb.msg)
		return 1
	}
	code := m.Run()
	// REGRESS_ROUTES_OUT=<file> records every route the API served during the run
	// (method + route template, from its access log): the measured API coverage.
	if out := os.Getenv("REGRESS_ROUTES_OUT"); out != "" {
		seen := map[string]bool{}
		for _, m := range routeLine.FindAllStringSubmatch(srv.Logs(), -1) {
			seen[m[1]+" "+m[2]] = true
		}
		lines := make([]string, 0, len(seen))
		for k := range seen {
			lines = append(lines, k)
		}
		sort.Strings(lines)
		_ = os.WriteFile(out, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	}
	if code != 0 {
		fmt.Fprintln(os.Stderr, "\n---- API log (last 4000 bytes) ----")
		l := srv.Logs()
		if len(l) > 4000 {
			l = l[len(l)-4000:]
		}
		fmt.Fprintln(os.Stderr, l)
	}
	return code
}

var routeLine = regexp.MustCompile(`"method":"([A-Z]+)","path":"/api/v1([^"]*)"`)

// setupTB lets TestMain use helpers that take a testing.TB.
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
func (s *setupTB) Skip(a ...any)             {}
func (s *setupTB) Skipf(f string, a ...any)  {}
func (s *setupTB) Errorf(f string, a ...any) { s.failed, s.msg = true, fmt.Sprintf(f, a...) }
func (s *setupTB) Fatal(a ...any)            { s.Fatalf("%v", fmt.Sprint(a...)) }
func (s *setupTB) Cleanup(func())            {}
func (s *setupTB) Logf(f string, a ...any)   {}
func (s *setupTB) Name() string              { return "setup" }

// newClinic gives a test a private clinic when it must not share A or B.
func newClinic(t *testing.T) *testkit.Clinic {
	t.Helper()
	return testkit.NewClinic(t, super, testkit.ClinicOpts{})
}

// uniq makes names that never collide across runs.
func uniq(prefix string) string { return prefix + uuid.NewString()[:6] }
