package httpx_test

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/httpx"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

func bufLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, nil)), &buf
}

// Given a handler that panics with sensitive text, When Recovery (production order:
// Recovery, then WithRequestID) catches it, Then the client gets 500 INTERNAL_ERROR with
// the request id and no panic text or stack, and the panic is logged server-side.
func TestREG_KERNEL_HTTPX_009_PanicBecomes500WithoutStack(t *testing.T) {
	log, buf := bufLogger()
	r := gin.New()
	r.Use(httpx.Recovery(log), httpx.WithRequestID())
	r.GET("/boom", func(c *gin.Context) { panic("db password=hunter2 leaked") })
	req := httptest.NewRequest(http.MethodGet, "/boom", nil)
	req.Header.Set("X-Request-Id", "rid-p1")
	w := do(r, req)
	e := expectError(t, w, http.StatusInternalServerError, "INTERNAL_ERROR", "an unexpected error occurred")
	if e.Error.RequestID != "rid-p1" {
		t.Fatalf("request_id = %q", e.Error.RequestID)
	}
	body := w.Body.String()
	for _, leak := range []string{"hunter2", "panic", "goroutine", ".go:"} {
		if strings.Contains(body, leak) {
			t.Fatalf("500 body leaks %q: %s", leak, body)
		}
	}
	if !strings.Contains(buf.String(), "hunter2") || !strings.Contains(buf.String(), "rid-p1") {
		t.Fatalf("panic not logged with request id: %s", buf.String())
	}
	// The server keeps serving after a panic.
	r.GET("/ok", okHandler)
	if w := do(r, httptest.NewRequest(http.MethodGet, "/ok", nil)); w.Code != 200 {
		t.Fatalf("server unhealthy after panic: %d", w.Code)
	}
}

// Given an incoming X-Request-Id, When a request passes WithRequestID, Then the same id is
// visible to handlers and echoed; without one a fresh UUID is generated per request.
func TestREG_KERNEL_HTTPX_010_RequestIDHonouredOrGenerated(t *testing.T) {
	r := gin.New()
	r.Use(httpx.WithRequestID())
	r.GET("/", func(c *gin.Context) { c.String(200, httpx.RequestID(c)) })

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Request-Id", "abc-123")
	w := do(r, req)
	if w.Body.String() != "abc-123" || w.Header().Get("X-Request-Id") != "abc-123" {
		t.Fatalf("incoming id not honoured: ctx=%q header=%q", w.Body.String(), w.Header().Get("X-Request-Id"))
	}

	w1 := do(r, httptest.NewRequest(http.MethodGet, "/", nil))
	w2 := do(r, httptest.NewRequest(http.MethodGet, "/", nil))
	id1 := w1.Header().Get("X-Request-Id")
	if _, err := uuid.Parse(id1); err != nil || w1.Body.String() != id1 {
		t.Fatalf("generated id %q not a UUID echoed to handler (%q)", id1, w1.Body.String())
	}
	if id1 == w2.Header().Get("X-Request-Id") {
		t.Fatal("generated ids repeat across requests")
	}

	// Without the middleware there is no id at all.
	bare := gin.New()
	bare.GET("/", func(c *gin.Context) { c.String(200, "[%s]", httpx.RequestID(c)) })
	if w := do(bare, httptest.NewRequest(http.MethodGet, "/", nil)); w.Body.String() != "[]" {
		t.Fatalf("RequestID without middleware = %q", w.Body.String())
	}
}

// Given an allow-list, When an allowed origin calls, Then credentialed CORS headers are
// echoed for that exact origin; a foreign origin or no origin gets none; OPTIONS is
// short-circuited with 204 without reaching the handler.
func TestREG_KERNEL_HTTPX_011_CORSAllowDenyAndPreflight(t *testing.T) {
	hits := 0
	r := gin.New()
	r.Use(httpx.CORS([]string{"https://app.clinicos.cc"}))
	r.Any("/x", func(c *gin.Context) { hits++; c.String(200, "ok") })

	call := func(method, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/x", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return do(r, req)
	}

	w := call(http.MethodGet, "https://app.clinicos.cc")
	if w.Code != 200 || hits != 1 {
		t.Fatalf("allowed GET: %d hits=%d", w.Code, hits)
	}
	h := w.Header()
	if h.Get("Access-Control-Allow-Origin") != "https://app.clinicos.cc" || h.Get("Access-Control-Allow-Credentials") != "true" ||
		h.Get("Vary") != "Origin" || !strings.Contains(h.Get("Access-Control-Allow-Headers"), "Authorization") ||
		!strings.Contains(h.Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatalf("allowed origin headers wrong: %v", h)
	}

	for _, origin := range []string{"https://evil.example", "https://app.clinicos.cc.evil.example", "null", ""} {
		w := call(http.MethodGet, origin)
		if w.Header().Get("Access-Control-Allow-Origin") != "" || w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatalf("origin %q got CORS headers: %v", origin, w.Header())
		}
		if w.Code != 200 {
			t.Fatalf("non-preflight from %q blocked: %d", origin, w.Code)
		}
	}

	before := hits
	pre := call(http.MethodOptions, "https://app.clinicos.cc")
	if pre.Code != http.StatusNoContent || pre.Header().Get("Access-Control-Allow-Origin") != "https://app.clinicos.cc" {
		t.Fatalf("preflight: %d %v", pre.Code, pre.Header())
	}
	bad := call(http.MethodOptions, "https://evil.example")
	if bad.Code != http.StatusNoContent || bad.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("foreign preflight: %d %v", bad.Code, bad.Header())
	}
	if hits != before {
		t.Fatal("OPTIONS reached the handler")
	}
}

// Given each apperr kind, When Fail renders it, Then status, code, message, request id and
// field details match the envelope contract and the request is aborted.
func TestREG_KERNEL_HTTPX_012_ErrorEnvelopePerKind(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
		msg    string
	}{
		{apperr.Validation("bad phone").WithField("phone", "must be 10 digits"), 400, "VALIDATION_FAILED", "bad phone"},
		{apperr.Validation(""), 400, "VALIDATION_FAILED", "validation failed"},
		{apperr.Unauthenticated(""), 401, "UNAUTHENTICATED", "authentication required"},
		{apperr.Forbidden("", ""), 403, "FORBIDDEN", "forbidden"},
		{apperr.Forbidden("BRANCH_DENIED", "not your branch"), 403, "BRANCH_DENIED", "not your branch"},
		{apperr.NotFound("PATIENT_NOT_FOUND", "patient not found"), 404, "PATIENT_NOT_FOUND", "patient not found"},
		{apperr.NotFound("", ""), 404, "NOT_FOUND", "not found"},
		{apperr.Conflict("", ""), 409, "CONFLICT", "conflict"},
		{apperr.ModuleDisabled("lab"), 403, "MODULE_DISABLED", "the lab module is not enabled for this tenant"},
		{apperr.RateLimited(), 429, "RATE_LIMITED", "too many requests"},
		{apperr.Internal(errors.New("pq: relation secret_table")), 500, "INTERNAL_ERROR", "an unexpected error occurred"},
		{apperr.New(422, "CUSTOM", "custom"), 422, "CUSTOM", "custom"},
		{fmt.Errorf("service: %w", apperr.Conflict("DUP", "duplicate")), 409, "DUP", "duplicate"},
		{errors.New("raw driver error: password=x"), 500, "INTERNAL_ERROR", "an unexpected error occurred"},
	}
	for _, c := range cases {
		t.Run(c.code+"/"+c.msg, func(t *testing.T) {
			after := false
			r := gin.New()
			r.Use(httpx.WithRequestID())
			r.GET("/", func(ctx *gin.Context) { httpx.Fail(ctx, c.err) }, func(*gin.Context) { after = true })
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("X-Request-Id", "rid-err")
			w := do(r, req)
			e := expectError(t, w, c.status, c.code, c.msg)
			if e.Error.RequestID != "rid-err" {
				t.Fatalf("request_id = %q", e.Error.RequestID)
			}
			if after {
				t.Fatal("Fail did not abort the chain")
			}
			if e.Data != nil {
				t.Fatalf("error envelope carries data: %s", e.Data)
			}
			if strings.Contains(w.Body.String(), "secret_table") || strings.Contains(w.Body.String(), "password=x") {
				t.Fatalf("cause leaked: %s", w.Body.String())
			}
		})
	}
	// Field details are surfaced only when present.
	r := gin.New()
	r.GET("/v", func(c *gin.Context) { httpx.Fail(c, apperr.Validation("x").WithField("phone", "bad")) })
	r.GET("/n", func(c *gin.Context) { httpx.Fail(c, apperr.NotFound("", "")) })
	if e := decode(t, do(r, httptest.NewRequest("GET", "/v", nil))); e.Error.Details["phone"] != "bad" {
		t.Fatalf("details = %v", e.Error.Details)
	}
	w := do(r, httptest.NewRequest("GET", "/n", nil))
	if strings.Contains(w.Body.String(), "details") || strings.Contains(w.Body.String(), "request_id") {
		t.Fatalf("empty details/request_id not omitted: %s", w.Body.String())
	}
}

// Given success helpers, When used, Then the body is {"data":...} (meta only on lists) and
// the status matches; NoContent writes 204 with an empty body.
func TestREG_KERNEL_HTTPX_013_SuccessEnvelopes(t *testing.T) {
	r := gin.New()
	r.GET("/ok", func(c *gin.Context) { httpx.OK(c, gin.H{"id": "p_1"}) })
	r.GET("/created", func(c *gin.Context) { httpx.Created(c, []int{1}) })
	r.GET("/list", func(c *gin.Context) {
		httpx.RespondMeta(c, 200, []int{1, 2}, httpx.Meta{Page: 2, PageSize: 2, Total: 9, NextCursor: "c2"})
	})
	r.GET("/list0", func(c *gin.Context) { httpx.RespondMeta(c, 200, []int{}, httpx.Meta{}) })
	r.GET("/none", func(c *gin.Context) { httpx.NoContent(c) })
	r.GET("/nil", func(c *gin.Context) { httpx.Respond(c, 202, nil) })

	cases := []struct {
		path, body string
		status     int
	}{
		{"/ok", `{"data":{"id":"p_1"}}`, 200},
		{"/created", `{"data":[1]}`, 201},
		{"/list", `{"data":[1,2],"meta":{"page":2,"page_size":2,"total":9,"next_cursor":"c2"}}`, 200},
		{"/list0", `{"data":[],"meta":{}}`, 200},
		{"/none", ``, 204},
		{"/nil", `{"data":null}`, 202},
	}
	for _, c := range cases {
		w := do(r, httptest.NewRequest("GET", c.path, nil))
		if w.Code != c.status || w.Body.String() != c.body {
			t.Errorf("%s: %d %s, want %d %s", c.path, w.Code, w.Body.String(), c.status, c.body)
		}
	}
}

// Given assorted query strings, When ParsePage runs, Then page defaults to 1 (min 1),
// page_size defaults to 20, clamps to 100, and junk falls back to defaults; Limit/Offset
// derive from them.
func TestREG_KERNEL_HTTPX_014_PaginationBoundsAndDefaults(t *testing.T) {
	cases := []struct {
		q               string
		page, size, off int
		cursor          string
	}{
		{"", 1, 20, 0, ""},
		{"page=3&page_size=10", 3, 10, 20, ""},
		{"page=0&page_size=0", 1, 20, 0, ""},
		{"page=-5&page_size=-1", 1, 20, 0, ""},
		{"page=abc&page_size=xyz", 1, 20, 0, ""},
		{"page_size=101", 1, 100, 0, ""},
		{"page_size=100&page=2", 2, 100, 100, ""},
		{"page_size=1", 1, 1, 0, ""},
		{"page=2.5&page_size=1e3", 1, 20, 0, ""},
		{"cursor=abc%3D%3D&page=9", 9, 20, 160, "abc=="},
		{"page=99999999999999999999", 1, 20, 0, ""},
	}
	for _, c := range cases {
		var got httpx.PageParams
		r := gin.New()
		r.GET("/", func(ctx *gin.Context) { got = httpx.ParsePage(ctx) })
		do(r, httptest.NewRequest("GET", "/?"+c.q, nil))
		if got.Page != c.page || got.PageSize != c.size || got.Cursor != c.cursor ||
			got.Limit() != c.size || got.Offset() != c.off {
			t.Errorf("%q: got %+v limit=%d offset=%d; want page=%d size=%d off=%d cursor=%q",
				c.q, got, got.Limit(), got.Offset(), c.page, c.size, c.off, c.cursor)
		}
	}
}

// Given AccessLog, When a request completes, Then one line carries method, route pattern,
// status, request id and — if authenticated — tenant and user ids.
func TestREG_KERNEL_HTTPX_015_AccessLogLine(t *testing.T) {
	log, buf := bufLogger()
	tid, uid := uuid.New(), uuid.New()
	r := gin.New()
	r.Use(httpx.WithRequestID(), httpx.AccessLog(log))
	r.GET("/anon/:id", func(c *gin.Context) { c.Status(418) })
	r.GET("/auth", func(c *gin.Context) {
		c.Set("principal", &tenancy.Principal{TenantID: tid, UserID: uid})
		c.Status(200)
	})
	req := httptest.NewRequest("GET", "/anon/123", nil)
	req.Header.Set("X-Request-Id", "rid-log")
	do(r, req)
	line := buf.String()
	for _, want := range []string{`"method":"GET"`, `"path":"/anon/:id"`, `"status":418`, `"request_id":"rid-log"`, `"latency_ms"`} {
		if !strings.Contains(line, want) {
			t.Fatalf("access log missing %s: %s", want, line)
		}
	}
	if strings.Contains(line, "tenant_id") {
		t.Fatalf("anonymous request logged a tenant: %s", line)
	}
	buf.Reset()
	do(r, httptest.NewRequest("GET", "/auth", nil))
	if !strings.Contains(buf.String(), tid.String()) || !strings.Contains(buf.String(), uid.String()) {
		t.Fatalf("authenticated request missing tenant/user: %s", buf.String())
	}
}
