package testkit

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Server is the real API binary, started against the test database as clinic_app.
// Black-box tests talk to it over HTTP, so routing, middleware, permissions and RLS
// are all exercised exactly as in production.
type Server struct {
	BaseURL string
	cmd     *exec.Cmd
	logs    *bytes.Buffer
}

// StartAPI builds cmd/api and runs it on a free port. Call it from TestMain (pass
// a *testing.M-less helper: use MustStartAPI there) or from a test. Every external
// service is left unconfigured, so nothing real is ever contacted: SMS uses the log
// gateway, storage the no-op store, AI/DHIS2/Verify.ET are off.
func StartAPI(superDSN, appDSN string) (*Server, error) {
	bin, err := buildAPI()
	if err != nil {
		return nil, err
	}
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	logs := &bytes.Buffer{}
	cmd := exec.Command(bin)
	cmd.Env = append(cleanEnv(),
		"APP_ENV=dev",
		"API_HTTP_ADDR=127.0.0.1:"+port,
		"DATABASE_URL="+appDSN,
		"PLATFORM_DATABASE_URL="+superDSN,
		"JWT_SECRET=regression-suite-secret-0123456789abcdef", // gitleaks:allow — test-only, never a real key
		"MFA_ENC_KEY="+base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		// The suite fires hundreds of requests from one address; the limiter is
		// tested on its own terms, not as a side effect of every test.
		"RATE_LIMIT_RPS=10000", "RATE_LIMIT_BURST=20000",
		"CORS_ALLOWED_ORIGINS=http://127.0.0.1",
	)
	// REGRESS_COVER_DIR: the binary was built with -cover; it writes its coverage
	// counters there when it exits (gracefully — see Stop).
	if dir := os.Getenv("REGRESS_COVER_DIR"); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		cmd.Env = append(cmd.Env, "GOCOVERDIR="+dir)
	}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &Server{BaseURL: "http://127.0.0.1:" + port + "/api/v1", cmd: cmd, logs: logs}
	deadline := time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		r, err := http.Get("http://127.0.0.1:" + port + "/readyz")
		if err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				return s, nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	s.Stop()
	return nil, fmt.Errorf("api did not become ready:\n%s", logs.String())
}

// Stop ends the API process: SIGTERM first, so a coverage build gets to write its
// counters on the way out, then SIGKILL if it has not exited within 15 seconds.
func (s *Server) Stop() {
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	_ = s.cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() { _, _ = s.cmd.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		_ = s.cmd.Process.Kill()
		<-done
	}
}

// Logs is everything the API printed, for failure messages.
func (s *Server) Logs() string { return s.logs.String() }

// cleanEnv passes through only what a build/run needs, so a developer's shell
// (with real keys exported) can never leak into the test server.
func cleanEnv() []string {
	keep := []string{"PATH", "HOME", "TMPDIR", "GOCACHE", "GOPATH", "GOMODCACHE", "GOFLAGS"}
	out := []string{}
	for _, k := range keep {
		if v, ok := os.LookupEnv(k); ok {
			out = append(out, k+"="+v)
		}
	}
	return out
}

func buildAPI() (string, error) {
	_, file, _, _ := runtime.Caller(0)
	backend := filepath.Join(filepath.Dir(file), "..", "..")
	out := filepath.Join(os.TempDir(), fmt.Sprintf("clinicos-api-regress-%d", os.Getpid()))
	args := []string{"build", "-o", out}
	if os.Getenv("REGRESS_COVER_DIR") != "" {
		// Statement coverage of every internal package, measured from the running API.
		args = append(args, "-cover", "-coverpkg=./internal/...,./cmd/api" /* main must be listed, or nothing is written */)
	}
	cmd := exec.Command("go", append(args, "./cmd/api")...)
	cmd.Dir = backend
	cmd.Env = os.Environ()
	if b, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("build api: %v\n%s", err, b)
	}
	return out, nil
}

func freePort() (string, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer l.Close()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port, nil
}

// ---- client -------------------------------------------------------------

// Client is one signed-in user (or an anonymous caller when Token is empty).
type Client struct {
	t     testing.TB
	base  string
	Token string
	http  *http.Client
}

// Resp is a decoded API response. Data is the "data" envelope; Code/Message come
// from the "error" envelope.
type Resp struct {
	Status  int
	Header  http.Header
	Data    json.RawMessage
	Code    string
	Message string
	Raw     string
}

// Anon is an unauthenticated client.
func (s *Server) Anon(t testing.TB) *Client {
	jar, _ := cookiejar.New(nil)
	return &Client{t: t, base: s.BaseURL, http: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
}

// Login signs in a user and returns their client. Fails the test on failure.
func (s *Server) Login(t testing.TB, workspace, email string) *Client {
	t.Helper()
	c := s.Anon(t)
	r := c.Do("POST", "/auth/login", map[string]any{"workspace": workspace, "email": email, "password": StaffPassword})
	if r.Status != 200 {
		t.Fatalf("login %s@%s: %d %s %s", email, workspace, r.Status, r.Code, r.Message)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	r.Decode(t, &tok)
	if tok.AccessToken == "" {
		t.Fatalf("login %s: no access token in %s", email, r.Raw)
	}
	c.Token = tok.AccessToken
	return c
}

// As signs in a clinic's staff member by role ("owner" for the owner).
func (s *Server) As(t testing.TB, c *Clinic, role string) *Client {
	t.Helper()
	if role == "owner" {
		return s.Login(t, c.Slug, c.Owner.Email)
	}
	st, ok := c.Staff[role]
	if !ok {
		t.Fatalf("clinic has no %s", role)
	}
	return s.Login(t, c.Slug, st.Email)
}

// Do sends a request; body is JSON-encoded when not nil.
func (c *Client) Do(method, path string, body any) Resp {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.t.Fatalf("encode: %v", err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, c.base+path, rd)
	if err != nil {
		c.t.Fatalf("request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := Resp{Status: res.StatusCode, Header: res.Header, Raw: string(raw)}
	var env struct {
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &env) == nil {
		out.Data = env.Data
		if env.Error != nil {
			out.Code, out.Message = env.Error.Code, env.Error.Message
		}
	}
	return out
}

// Decode unmarshals Data into v, failing the test with the raw body on error.
func (r Resp) Decode(t testing.TB, v any) {
	t.Helper()
	if err := json.Unmarshal(r.Data, v); err != nil {
		t.Fatalf("decode %T: %v\nbody: %s", v, err, r.Raw)
	}
}

// Expect fails the test unless the status matches, printing what came back.
func (r Resp) Expect(t testing.TB, status int, what string) Resp {
	t.Helper()
	if r.Status != status {
		t.Fatalf("%s: want HTTP %d, got %d (%s %s)\n%s", what, status, r.Status, r.Code, r.Message, trim(r.Raw))
	}
	return r
}

func trim(s string) string {
	if len(s) > 600 {
		return s[:600] + "…"
	}
	return strings.TrimSpace(s)
}
