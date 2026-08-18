// Package dhis2 is a server-to-server client for DHIS2 (District Health
// Information Software 2), the Ethiopian Ministry of Health reporting platform
// at https://dhis.moh.gov.et. It powers the "Disease Registration" showcase:
// pushing the month's top-10 diseases (counts by age band × sex) to the national
// system in one click, replacing manual data entry into the government portal.
//
// The API token is a Personal Access Token the clinic owner creates; it is held
// server-side only, sent as "Authorization: ApiToken <token>", never logged and
// never placed in a URL. An empty token yields a client that reports
// Configured()==false and whose calls return ErrNotConfigured.
package dhis2

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Fixed showcase coordinates (verified against the live dataset). These are
// structural constants for the demo; the per-disease dataElement IDs and counts
// live in the database (editable). See the integration spec.
const (
	DataSet           = "JXiOYKPIaQ1" // Disease Registration, Monthly
	OrgUnit           = "B4BMy0ufdrd" // Harer Medium Clinic
	Period            = "202506"      // Gregorian YYYYMM (UI shows "Sene 2018")
	attrCategoryCombo = "OjWAOYgrrP2" // dataset's attribute category combo (Department × Outcome)
)

// Context labels shown in the UI header (purely cosmetic).
const (
	OrgUnitName = "Harer Medium Clinic"
	DataSetName = "Disease Registration (Monthly)"
	PeriodLabel = "Sene 2018"
	Department  = "OPD1"
	Outcome     = "Morbidity"
)

// CocByKey maps a seeded count key ({M|F}_{ageband}) to its DHIS2
// categoryOptionCombo (age × sex cell). Age bands: 1(<1), 1_4, 5_14, 15_29,
// 30_64, 65(≥65).
var CocByKey = map[string]string{
	"M_1": "OfFSKnXhaBU", "M_1_4": "ZDTa17hJpOB", "M_5_14": "UWUZ8Tr6h0m",
	"M_15_29": "CYNJysr5r93", "M_30_64": "WrECL06zVeA", "M_65": "aQNfi3OSCJB",
	"F_1": "c320cNK3wFH", "F_1_4": "X8QpQ0AUa9g", "F_5_14": "BwqbjDm3hhY",
	"F_15_29": "sOvBOGZBqa1", "F_30_64": "rUK6L6E2Toz", "F_65": "TnOFX5D5Qjo",
}

// ColumnKeys is the fixed grid column order: Male <1..≥65 then Female <1..≥65.
var ColumnKeys = []string{
	"M_1", "M_1_4", "M_5_14", "M_15_29", "M_30_64", "M_65",
	"F_1", "F_1_4", "F_5_14", "F_15_29", "F_30_64", "F_65",
}

var (
	// ErrNotConfigured is returned when no DHIS2 token is set (push disabled).
	ErrNotConfigured = errors.New("dhis2 is not configured")
	// ErrUnauthorized is returned when DHIS2 rejects the token.
	ErrUnauthorized = errors.New("dhis2 rejected the API token")
	// ErrLocked is returned when the period is locked/complete (writes rejected).
	ErrLocked = errors.New("dhis2 period is locked or marked complete")
)

// Client talks to a DHIS2 instance.
type Client struct {
	token   string
	baseURL string
	http    *http.Client

	mu      sync.Mutex
	attrOpt string // resolved attributeOptionCombo ("OPD1, Morbidity"), cached
}

// New builds a client. An empty token disables it (Configured()==false).
func New(token, baseURL string) *Client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = "https://dhis.moh.gov.et"
	}
	return &Client{
		token:   strings.TrimSpace(token),
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 75 * time.Second}, // the national instance is slow (~40s per import)
	}
}

// Configured reports whether a token is present.
func (c *Client) Configured() bool { return c != nil && c.token != "" }

// DataValue is one cell: a disease (dataElement) × age-sex (categoryOptionCombo).
// DHIS2 (this instance) does not inherit the set-level period/orgUnit, so each
// value is fully qualified when we push.
type DataValue struct {
	DataElement          string `json:"dataElement"`
	Period               string `json:"period,omitempty"`
	OrgUnit              string `json:"orgUnit,omitempty"`
	CategoryOptionCombo  string `json:"categoryOptionCombo"`
	AttributeOptionCombo string `json:"attributeOptionCombo,omitempty"`
	Value                string `json:"value"`
	Deleted              bool   `json:"deleted,omitempty"`
}

type dataValueSet struct {
	DataSet              string      `json:"dataSet"`
	Period               string      `json:"period"`
	OrgUnit              string      `json:"orgUnit"`
	AttributeOptionCombo string      `json:"attributeOptionCombo"`
	DataValues           []DataValue `json:"dataValues"`
}

// ImportSummary is the parsed result of a dataValueSets import.
type ImportSummary struct {
	Status      string     `json:"status"` // SUCCESS | WARNING | ERROR
	Description string     `json:"description,omitempty"`
	Imported    int        `json:"imported"`
	Updated     int        `json:"updated"`
	Ignored     int        `json:"ignored"`
	Deleted     int        `json:"deleted"`
	Conflicts   []Conflict `json:"conflicts,omitempty"`
}

// Conflict is one rejected value with the reason DHIS2 gave.
type Conflict struct {
	Object string `json:"object"`
	Value  string `json:"value"`
}

// importResponse covers the shapes DHIS2 2.40 returns (response wrapper +
// importCount / conflicts).
type importResponse struct {
	Status   string `json:"status"`
	Response struct {
		Status      string `json:"status"`
		Description string `json:"description"`
		ImportCount struct {
			Imported int `json:"imported"`
			Updated  int `json:"updated"`
			Ignored  int `json:"ignored"`
			Deleted  int `json:"deleted"`
		} `json:"importCount"`
		Conflicts []struct {
			Object string `json:"object"`
			Value  string `json:"value"`
		} `json:"conflicts"`
	} `json:"response"`
	// Older/flat shape:
	Description string `json:"description"`
	ImportCount struct {
		Imported int `json:"imported"`
		Updated  int `json:"updated"`
		Ignored  int `json:"ignored"`
		Deleted  int `json:"deleted"`
	} `json:"importCount"`
	HTTPStatusCode int `json:"httpStatusCode"`
}

func (r importResponse) toSummary() ImportSummary {
	s := ImportSummary{Status: r.Status}
	if r.Response.Status != "" {
		s.Status = r.Response.Status
		s.Description = r.Response.Description
		s.Imported = r.Response.ImportCount.Imported
		s.Updated = r.Response.ImportCount.Updated
		s.Ignored = r.Response.ImportCount.Ignored
		s.Deleted = r.Response.ImportCount.Deleted
		for _, c := range r.Response.Conflicts {
			s.Conflicts = append(s.Conflicts, Conflict{Object: c.Object, Value: c.Value})
		}
	} else {
		if s.Description == "" {
			s.Description = r.Description
		}
		s.Imported = r.ImportCount.Imported
		s.Updated = r.ImportCount.Updated
		s.Ignored = r.ImportCount.Ignored
		s.Deleted = r.ImportCount.Deleted
	}
	return s
}

// Submit validates (dry-run) then writes the values. It returns the write's
// import summary. A failed dry-run is returned as an error carrying the reason.
func (c *Client) Submit(ctx context.Context, orgUnit, period string, values []DataValue) (*ImportSummary, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	// Single write with CREATE_AND_UPDATE — idempotent and it reports per-value
	// conflicts in the import summary, so it is its own validation. A separate
	// dry-run pass is skipped because this national instance is slow (~40s per
	// call) and two sequential calls would risk the request/gateway timeout.
	return c.post(ctx, orgUnit, period, values, false)
}

// Clear deletes the values (re-import with deleted=true). Permanent.
func (c *Client) Clear(ctx context.Context, orgUnit, period string, values []DataValue) (*ImportSummary, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	return c.post(ctx, orgUnit, period, values, true)
}

// post builds and sends a dataValueSets import to the given facility/period.
// deleted marks every value for deletion. Retries transient 5xx.
func (c *Client) post(ctx context.Context, orgUnit, period string, values []DataValue, deleted bool) (*ImportSummary, error) {
	attr, err := c.attributeOptionCombo(ctx)
	if err != nil {
		return nil, err
	}
	set := dataValueSet{DataSet: DataSet, Period: period, OrgUnit: orgUnit, AttributeOptionCombo: attr}
	for _, v := range values {
		v.Period = period // fully qualify each value — this instance ignores set-level defaults
		v.OrgUnit = orgUnit
		v.AttributeOptionCombo = attr
		v.Deleted = deleted
		set.DataValues = append(set.DataValues, v)
	}
	body, err := json.Marshal(set)
	if err != nil {
		return nil, err
	}
	q := url.Values{"importStrategy": {"CREATE_AND_UPDATE"}}
	respBody, status, err := c.doJSON(ctx, http.MethodPost, "/api/dataValueSets?"+q.Encode(), body)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, ErrUnauthorized
	}
	if status == http.StatusConflict {
		// 409 is common for validation failures; parse the summary if we can.
		var ir importResponse
		if json.Unmarshal(respBody, &ir) == nil {
			sum := ir.toSummary()
			if isLocked(&sum) {
				return &sum, ErrLocked
			}
			return &sum, nil
		}
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("dhis2 returned %d: %s", status, snippet(respBody))
	}
	var ir importResponse
	if err := json.Unmarshal(respBody, &ir); err != nil {
		return nil, fmt.Errorf("decode dhis2 import: %w", err)
	}
	sum := ir.toSummary()
	if isLocked(&sum) {
		return &sum, ErrLocked
	}
	return &sum, nil
}

// Get reads the stored values for the given facility/period (View submitted).
func (c *Client) Get(ctx context.Context, orgUnit, period string) ([]DataValue, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	q := url.Values{"dataSet": {DataSet}, "period": {period}, "orgUnit": {orgUnit}}
	respBody, status, err := c.doJSON(ctx, http.MethodGet, "/api/dataValueSets.json?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, ErrUnauthorized
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("dhis2 returned %d: %s", status, snippet(respBody))
	}
	var out struct {
		DataValues []DataValue `json:"dataValues"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("decode dhis2 read: %w", err)
	}
	return out.DataValues, nil
}

// Facility is a DHIS2 organisation unit (the clinic's facility).
type Facility struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Element is a DHIS2 dataElement (a disease column in the dataset).
type Element struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Whoami returns the facilities the token's user is assigned to (auto-detect the
// clinic's org unit). Read-only.
func (c *Client) Whoami(ctx context.Context) ([]Facility, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	body, status, err := c.doJSON(ctx, http.MethodGet, "/api/me.json?fields=organisationUnits[id,name]", nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, ErrUnauthorized
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("dhis2 returned %d: %s", status, snippet(body))
	}
	var out struct {
		OrganisationUnits []Facility `json:"organisationUnits"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode me: %w", err)
	}
	return out.OrganisationUnits, nil
}

// Calendar returns the instance's calendar ("ethiopian" | "gregorian" | …), so we
// format reporting periods the way this DHIS2 expects. Read-only.
func (c *Client) Calendar(ctx context.Context) (string, error) {
	if !c.Configured() {
		return "", ErrNotConfigured
	}
	body, status, err := c.doJSON(ctx, http.MethodGet, "/api/system/info.json", nil)
	if err != nil {
		return "", err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "", ErrUnauthorized
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("dhis2 returned %d: %s", status, snippet(body))
	}
	var out struct {
		Calendar string `json:"calendar"`
	}
	_ = json.Unmarshal(body, &out)
	return out.Calendar, nil
}

// DatasetElements lists a dataset's dataElements (its disease columns), for the
// mapping picker. Read-only.
func (c *Client) DatasetElements(ctx context.Context, datasetID string) ([]Element, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	path := "/api/dataSets/" + url.PathEscape(datasetID) + ".json?fields=dataSetElements[dataElement[id,name]]"
	body, status, err := c.doJSON(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, ErrUnauthorized
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("dhis2 returned %d: %s", status, snippet(body))
	}
	var out struct {
		DataSetElements []struct {
			DataElement Element `json:"dataElement"`
		} `json:"dataSetElements"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode dataset: %w", err)
	}
	els := make([]Element, 0, len(out.DataSetElements))
	for _, d := range out.DataSetElements {
		els = append(els, d.DataElement)
	}
	return els, nil
}

// attributeOptionCombo resolves and caches the "OPD1, Morbidity" option combo id.
func (c *Client) attributeOptionCombo(ctx context.Context) (string, error) {
	c.mu.Lock()
	cached := c.attrOpt
	c.mu.Unlock()
	if cached != "" {
		return cached, nil
	}
	path := fmt.Sprintf("/api/categoryCombos/%s.json?fields=categoryOptionCombos[id,name]", attrCategoryCombo)
	respBody, status, err := c.doJSON(ctx, http.MethodGet, path, nil)
	if err != nil {
		return "", err
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return "", ErrUnauthorized
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("dhis2 returned %d resolving attribute combo: %s", status, snippet(respBody))
	}
	var cc struct {
		CategoryOptionCombos []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"categoryOptionCombos"`
	}
	if err := json.Unmarshal(respBody, &cc); err != nil {
		return "", fmt.Errorf("decode attribute combo: %w", err)
	}
	target := strings.ToLower(Department + ", " + Outcome) // exact "opd1, morbidity" (substring would match OPD10/11/…)
	for _, o := range cc.CategoryOptionCombos {
		if strings.TrimSpace(strings.ToLower(o.Name)) == target {
			c.mu.Lock()
			c.attrOpt = o.ID
			c.mu.Unlock()
			return o.ID, nil
		}
	}
	return "", fmt.Errorf("could not find the '%s, %s' attribute option combo in %s", Department, Outcome, attrCategoryCombo)
}

// doJSON performs one HTTP call with the ApiToken header, retrying transient 5xx.
func (c *Client) doJSON(ctx context.Context, method, path string, body []byte) (resp []byte, status int, err error) {
	const attempts = 2 // each call can take ~40s on this instance; cap total time under the gateway limit
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			case <-time.After(time.Duration(attempt) * 700 * time.Millisecond):
			}
		}
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		req, rerr := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
		if rerr != nil {
			return nil, 0, rerr
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		req.Header.Set("Authorization", "ApiToken "+c.token) // never logged
		r, derr := c.http.Do(req)
		if derr != nil {
			err = derr
			continue // network — retry
		}
		b, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		r.Body.Close()
		if r.StatusCode >= 500 {
			err = fmt.Errorf("dhis2 returned %d", r.StatusCode)
			continue // transient — retry
		}
		return b, r.StatusCode, nil
	}
	return nil, 0, err
}

func isLocked(s *ImportSummary) bool {
	// Only the conflict reasons — NOT the description (a success says "Import
	// process completed successfully", which must not read as "locked").
	var hay string
	for _, c := range s.Conflicts {
		hay += " " + strings.ToLower(c.Value)
	}
	return strings.Contains(hay, "locked") || strings.Contains(hay, "is closed") || strings.Contains(hay, "already approved")
}

func summarize(s *ImportSummary) string {
	if len(s.Conflicts) > 0 {
		return s.Conflicts[0].Value
	}
	if s.Description != "" {
		return s.Description
	}
	return s.Status
}

func snippet(b []byte) string {
	x := strings.TrimSpace(string(b))
	if len(x) > 300 {
		x = x[:300]
	}
	return x
}
