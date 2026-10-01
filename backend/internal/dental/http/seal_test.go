package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// clinicalSvc returns clinical data from every read the seal guards. Embedding the
// interface means any other method would panic — these tests call only these.
type clinicalSvc struct{ dental.Service }

func (clinicalSvc) Summary(context.Context, uuid.UUID) (*dental.Summary, error) {
	return &dental.Summary{
		Chart: dental.Chart{Teeth: map[string]string{"UR6": "decayed"}},
		Plans: []dental.Plan{{Title: "Root canal", Tooth: "UR6", Note: "patient anxious"}},
	}, nil
}
func (clinicalSvc) GetChart(context.Context, uuid.UUID) (*dental.Chart, error) {
	return &dental.Chart{Teeth: map[string]string{"UR6": "decayed"}}, nil
}
func (clinicalSvc) ListImages(context.Context, uuid.UUID, *uuid.UUID) ([]dental.Image, error) {
	return []dental.Image{{URL: "https://r2.example/xray.jpg"}}, nil
}
func (clinicalSvc) SessionsInRange(context.Context, string, string) ([]dental.SessionCalItem, error) {
	return []dental.SessionCalItem{{Title: "Root canal", Procedure: "Pulpectomy", Tooth: "UR6"}}, nil
}

func get(t *testing.T, perms []string, path string, h gin.HandlerFunc, route string) string {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Request = c.Request.WithContext(tenancy.WithPrincipal(c.Request.Context(),
			&tenancy.Principal{UserID: uuid.New(), TenantID: uuid.New(), Permissions: perms}))
	})
	r.GET(route, h)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("%s: status %d %s", path, w.Code, w.Body.String())
	}
	return w.Body.String()
}

// TestDeskIsSealedFromTheClinicalRecord (audit D19): the front desk's dental.read
// used to receive the tooth chart, X-ray links, a plan's tooth and note, and the
// procedure on the calendar. A clinician still gets all of it.
func TestDeskIsSealedFromTheClinicalRecord(t *testing.T) {
	h := NewHandlers(clinicalSvc{})
	pid := id.Encode(id.PrefixPatient, uuid.New())
	desk := []string{"dental.read", "payment.charge"}
	dentist := []string{"dental.read", "dental.manage"}
	clinicalBits := []string{"decayed", "xray.jpg", "patient anxious", "Pulpectomy", `"UR6"`}

	cases := []struct {
		name, route, path string
		h                 gin.HandlerFunc
	}{
		{"summary", "/p/:id/summary", "/p/" + pid + "/summary", h.Summary},
		{"chart", "/p/:id/chart", "/p/" + pid + "/chart", h.GetChart},
		{"images", "/p/:id/images", "/p/" + pid + "/images", h.ListImages},
		{"calendar", "/sessions", "/sessions?from=2026-10-01&to=2026-10-31", h.SessionsCalendar},
	}
	for _, tc := range cases {
		body := get(t, desk, tc.path, tc.h, tc.route)
		for _, bit := range clinicalBits {
			if strings.Contains(body, bit) {
				t.Errorf("%s leaks %s to the front desk: %s", tc.name, bit, body)
			}
		}
		if !json.Valid([]byte(body)) {
			t.Errorf("%s: invalid JSON", tc.name)
		}
	}
	// The dentist's view is untouched.
	if body := get(t, dentist, "/p/"+pid+"/summary", h.Summary, "/p/:id/summary"); !strings.Contains(body, "decayed") || !strings.Contains(body, "patient anxious") {
		t.Errorf("dentist lost clinical data: %s", body)
	}
}
