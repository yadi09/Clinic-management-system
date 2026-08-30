// Package reporting is the DHIS2 (Ministry of Health) reporting surface: it reads
// a clinic's seeded top-10 diseases and pushes them to the national DHIS2 dataset
// via the kernel/dhis2 client. It is tenant-scoped for the disease data; the
// DHIS2 coordinates (dataset/orgUnit/period) are fixed showcase constants.
package reporting

import (
	"context"

	"github.com/reicb/clinicsaas/internal/kernel/dhis2"
)

// Disease is one seeded top-10 disease with counts keyed by {M|F}_{ageband}.
type Disease struct {
	Rank        int
	Name        string
	DataElement string
	Counts      map[string]int
}

// Context is the fixed reporting context shown in the page header.
type Context struct {
	OrgUnit string
	// True once this clinic has chosen its own facility in DHIS2. Until then
	// OrgUnit is the clinic's own name and nothing has been linked — which the
	// header must say, because the alternative is a report that looks filed.
	OrgUnitLinked bool
	DataSet       string
	// Period is what the push actually writes to, e.g. "201812" (Ethiopian) or
	// "202608" (Gregorian) — derived from today, never a constant.
	Period      string
	PeriodLabel string
	// The Gregorian days the Ethiopian month covers, so "current month" is a
	// claim the reader can check rather than one they have to trust.
	PeriodStart string
	PeriodEnd   string
	Department  string
	Outcome     string
}

// Report is the full grid the page renders.
type Report struct {
	Configured bool // this clinic has a DHIS2 token → Push is enabled
	Context    Context
	Diseases   []Disease
}

// Config is a clinic's DHIS2 connection (never carries the token itself).
type Config struct {
	Connected      bool
	BaseURL        string
	OrgUnit        string
	OrgUnitName    string
	DataSet        string
	PeriodCalendar string // "ethiopian" | "gregorian"
}

// ConfigInput saves a clinic's DHIS2 connection. Token empty = keep the existing.
type ConfigInput struct {
	Token          string
	BaseURL        string
	OrgUnit        string
	OrgUnitName    string
	PeriodCalendar string
}

// TestResult is what a "test connection" returns: the facilities the token can
// see (to pick the clinic's org unit) and the instance's calendar.
type TestResult struct {
	Facilities []dhis2.Facility
	Calendar   string
}

// MapEntry maps one diagnosis (by lowercased description) to a DHIS2 dataElement.
type MapEntry struct {
	DiseaseKey      string
	DiseaseName     string
	DataElement     string
	DataElementName string
}

// Service is the reporting API.
type Service interface {
	GetReport(ctx context.Context) (*Report, error)
	Push(ctx context.Context) (*dhis2.ImportSummary, error)
	Submitted(ctx context.Context) ([]dhis2.DataValue, error)
	Clear(ctx context.Context) (*dhis2.ImportSummary, error)

	GetConfig(ctx context.Context) (*Config, error)
	SaveConfig(ctx context.Context, in ConfigInput) (*Config, error)
	TestConnection(ctx context.Context, token, baseURL string) (*TestResult, error)
	ListElements(ctx context.Context) ([]dhis2.Element, error)
	GetMapping(ctx context.Context) ([]MapEntry, error)
	SaveMapping(ctx context.Context, entries []MapEntry) error
}
