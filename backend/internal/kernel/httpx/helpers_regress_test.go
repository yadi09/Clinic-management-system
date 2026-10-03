package httpx_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// envelope mirrors the wire shape of both success and error envelopes.
type envelope struct {
	Data  json.RawMessage `json:"data"`
	Meta  map[string]any  `json:"meta"`
	Error *struct {
		Code      string            `json:"code"`
		Message   string            `json:"message"`
		RequestID string            `json:"request_id"`
		Details   map[string]string `json:"details"`
	} `json:"error"`
}

func decode(t *testing.T, w *httptest.ResponseRecorder) envelope {
	t.Helper()
	var e envelope
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
		t.Fatalf("response is not JSON: %v; body=%q", err, w.Body.String())
	}
	return e
}

// expectError asserts status, error code and (optionally) message of an error envelope.
func expectError(t *testing.T, w *httptest.ResponseRecorder, status int, code, msg string) envelope {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status = %d want %d; body=%s", w.Code, status, w.Body.String())
	}
	e := decode(t, w)
	if e.Error == nil {
		t.Fatalf("no error envelope; body=%s", w.Body.String())
	}
	if e.Error.Code != code {
		t.Fatalf("error.code = %q want %q", e.Error.Code, code)
	}
	if msg != "" && e.Error.Message != msg {
		t.Fatalf("error.message = %q want %q", e.Error.Message, msg)
	}
	return e
}

func do(r http.Handler, req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func okHandler(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
