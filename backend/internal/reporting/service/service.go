// Package service implements the DHIS2 reporting use-cases: a live disease report
// for the current Ethiopian month (counts by age × sex from the actual diagnoses),
// a per-clinic DHIS2 connection (encrypted token + facility + disease mapping), and
// the one-click push / read-back / clear against each clinic's own DHIS2 account.
package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/dhis2"
	"github.com/reicb/clinicsaas/internal/kernel/ethiocal"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/reporting"
)

const defaultBaseURL = "https://dhis.moh.gov.et"

// liveSQL aggregates the diseases diagnosed in the reporting window into the DHIS2
// age×sex cells: distinct patients per disease per {M|F}_{ageband}. Age is taken at
// the visit date (in Ethiopian local time); only male/female patients with a known
// DOB land in a cell.
const liveSQL = `
SELECT dkey, max(name) AS name, sex || '_' || band AS colkey, count(DISTINCT patient_id) AS n
FROM (
  SELECT patient_id, dkey, name, sex,
    CASE WHEN yrs < 1 THEN '1' WHEN yrs <= 4 THEN '1_4' WHEN yrs <= 14 THEN '5_14'
         WHEN yrs <= 29 THEN '15_29' WHEN yrs <= 64 THEN '30_64' ELSE '65' END AS band
  FROM (
    SELECT d.patient_id,
      lower(btrim(d.description)) AS dkey,
      d.description AS name,
      CASE WHEN p.gender = 'male' THEN 'M' ELSE 'F' END AS sex,
      (date_part('year', e.started_at AT TIME ZONE 'Africa/Addis_Ababa') - date_part('year', p.dob)
        - CASE WHEN (date_part('month', e.started_at AT TIME ZONE 'Africa/Addis_Ababa'), date_part('day', e.started_at AT TIME ZONE 'Africa/Addis_Ababa'))
                 < (date_part('month', p.dob), date_part('day', p.dob)) THEN 1 ELSE 0 END)::int AS yrs
    FROM diagnoses d
    JOIN encounters e ON e.id = d.encounter_id AND e.tenant_id = d.tenant_id
    JOIN patients   p ON p.id = d.patient_id   AND p.tenant_id = d.tenant_id
    WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND e.deleted_at IS NULL
      AND e.started_at >= $2 AND e.started_at < $3
      AND p.gender IN ('male','female') AND p.dob IS NOT NULL
  ) a
) t
GROUP BY dkey, sex, band`

// Service implements reporting.Service. db is the tenant-scoped pool (RLS enforced
// via WithTx); encKey (the MFA key) encrypts the per-clinic DHIS2 token at rest.
type Service struct {
	db     *kerneldb.DB
	encKey []byte
}

var _ reporting.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, encKey []byte) *Service {
	return &Service{db: db, encKey: encKey}
}

func tenantID(ctx context.Context) uuid.UUID {
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		return p.TenantID
	}
	tid, _ := tenancy.TenantIDFromContext(ctx)
	return tid
}

// --- live report -----------------------------------------------------------

func countTotal(m map[string]int) int {
	t := 0
	for _, v := range m {
		t += v
	}
	return t
}

// computeLive aggregates the diseases actually diagnosed in [start, end) into the
// DHIS2 age×sex grid, ranked by patient count (most cases first).
func (s *Service) computeLive(ctx context.Context, start, end time.Time) ([]reporting.Disease, error) {
	tid := tenantID(ctx)
	byKey := map[string]*reporting.Disease{}
	var order []string
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, liveSQL, tid, start, end)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var dkey, name, colkey string
			var n int
			if e := rows.Scan(&dkey, &name, &colkey, &n); e != nil {
				return e
			}
			d := byKey[dkey]
			if d == nil {
				d = &reporting.Disease{Name: name, Counts: map[string]int{}}
				byKey[dkey] = d
				order = append(order, dkey)
			}
			d.Counts[colkey] += n
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	out := make([]reporting.Disease, 0, len(order))
	for _, k := range order {
		out = append(out, *byKey[k])
	}
	sort.SliceStable(out, func(i, j int) bool {
		ti, tj := countTotal(out[i].Counts), countTotal(out[j].Counts)
		if ti != tj {
			return ti > tj
		}
		return out[i].Name < out[j].Name
	})
	for i := range out {
		out[i].Rank = i + 1
	}
	return out, nil
}

func diseaseKey(name string) string { return strings.ToLower(strings.TrimSpace(name)) }

func (s *Service) GetReport(ctx context.Context) (*reporting.Report, error) {
	start, end, label, _, _ := ethiocal.MonthRange(time.Now())
	diseases, err := s.computeLive(ctx, start, end)
	if err != nil {
		return nil, err
	}
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return nil, err
	}
	mapping, err := s.mappingByKey(ctx)
	if err != nil {
		return nil, err
	}
	for i := range diseases {
		diseases[i].DataElement = mapping[diseaseKey(diseases[i].Name)] // "" = not mapped
	}
	orgUnitName := cfg.OrgUnitName
	if orgUnitName == "" {
		orgUnitName = dhis2.OrgUnitName
	}
	return &reporting.Report{
		Configured: cfg.Connected,
		Context: reporting.Context{
			OrgUnit:     orgUnitName,
			DataSet:     dhis2.DataSetName,
			Period:      dhis2.Period,
			PeriodLabel: label, // the live current Ethiopian month, e.g. "Hamle 2018"
			Department:  dhis2.Department,
			Outcome:     dhis2.Outcome,
		},
		Diseases: diseases,
	}, nil
}

// --- per-clinic config -----------------------------------------------------

// dbConfig is the stored connection (token still encrypted).
type dbConfig struct {
	baseURL, tokenEnc, orgUnit, orgUnitName, dataSet, periodCalendar string
}

func (s *Service) loadDBConfig(ctx context.Context) (dbConfig, error) {
	tid := tenantID(ctx)
	c := dbConfig{baseURL: defaultBaseURL, dataSet: dhis2.DataSet, periodCalendar: "ethiopian"}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx,
			`SELECT base_url, coalesce(token_enc,''), coalesce(org_unit,''), coalesce(org_unit_name,''), data_set, period_calendar
			 FROM dhis2_config WHERE tenant_id = $1`, tid)
		e := row.Scan(&c.baseURL, &c.tokenEnc, &c.orgUnit, &c.orgUnitName, &c.dataSet, &c.periodCalendar)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil // defaults
		}
		return e
	})
	if err != nil {
		return c, apperr.Internal(err)
	}
	return c, nil
}

func (s *Service) loadConfig(ctx context.Context) (reporting.Config, error) {
	c, err := s.loadDBConfig(ctx)
	if err != nil {
		return reporting.Config{}, err
	}
	return reporting.Config{
		Connected: c.tokenEnc != "", BaseURL: c.baseURL, OrgUnit: c.orgUnit,
		OrgUnitName: c.orgUnitName, DataSet: c.dataSet, PeriodCalendar: c.periodCalendar,
	}, nil
}

func (s *Service) GetConfig(ctx context.Context) (*reporting.Config, error) {
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (s *Service) SaveConfig(ctx context.Context, in reporting.ConfigInput) (*reporting.Config, error) {
	tid := tenantID(ctx)
	baseURL := strings.TrimSpace(in.BaseURL)
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	cal := in.PeriodCalendar
	if cal != "ethiopian" && cal != "gregorian" {
		cal = "ethiopian"
	}
	var tokPtr *string
	if strings.TrimSpace(in.Token) != "" {
		enc, e := auth.EncryptSecret(s.encKey, strings.TrimSpace(in.Token))
		if e != nil {
			return nil, apperr.Internal(e)
		}
		tokPtr = &enc
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO dhis2_config (tenant_id, base_url, token_enc, org_unit, org_unit_name, period_calendar, updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6, now())
			 ON CONFLICT (tenant_id) DO UPDATE SET
			   base_url = EXCLUDED.base_url,
			   token_enc = COALESCE(EXCLUDED.token_enc, dhis2_config.token_enc),
			   org_unit = EXCLUDED.org_unit,
			   org_unit_name = EXCLUDED.org_unit_name,
			   period_calendar = EXCLUDED.period_calendar,
			   updated_at = now()`,
			tid, baseURL, tokPtr, in.OrgUnit, in.OrgUnitName, cal)
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return s.GetConfig(ctx)
}

// conn builds a DHIS2 client from the clinic's saved connection (decrypting the
// token). Returns DHIS2_DISABLED if the clinic hasn't connected yet.
func (s *Service) conn(ctx context.Context) (*dhis2.Client, dbConfig, error) {
	c, err := s.loadDBConfig(ctx)
	if err != nil {
		return nil, c, err
	}
	if c.tokenEnc == "" {
		return nil, c, apperr.New(http.StatusServiceUnavailable, "DHIS2_DISABLED", "This clinic isn't connected to DHIS2 yet — add your API token in Settings")
	}
	tok, e := auth.DecryptSecret(s.encKey, c.tokenEnc)
	if e != nil {
		return nil, c, apperr.Internal(e)
	}
	return dhis2.New(tok, c.baseURL), c, nil
}

func (s *Service) TestConnection(ctx context.Context, token, baseURL string) (*reporting.TestResult, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, apperr.Validation("paste your DHIS2 API token")
	}
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultBaseURL
	}
	cl := dhis2.New(token, baseURL)
	facs, err := cl.Whoami(ctx)
	if errors.Is(err, dhis2.ErrUnauthorized) {
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_AUTH", "DHIS2 rejected the token — check it and try again")
	}
	if err != nil {
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_READ_FAILED", "Could not reach DHIS2 — check the URL and try again")
	}
	cal, _ := cl.Calendar(ctx) // best-effort
	return &reporting.TestResult{Facilities: facs, Calendar: cal}, nil
}

func (s *Service) ListElements(ctx context.Context) ([]dhis2.Element, error) {
	cl, cfg, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	els, e := cl.DatasetElements(ctx, cfg.dataSet)
	if errors.Is(e, dhis2.ErrUnauthorized) {
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_AUTH", "DHIS2 rejected the token — reconnect in Settings")
	}
	if e != nil {
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_READ_FAILED", "Could not load the DHIS2 disease list — try again")
	}
	return els, nil
}

// --- disease → dataElement mapping -----------------------------------------

func (s *Service) mappingByKey(ctx context.Context) (map[string]string, error) {
	tid := tenantID(ctx)
	out := map[string]string{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT disease_key, data_element FROM dhis2_disease_map WHERE tenant_id = $1`, tid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var k, de string
			if e := rows.Scan(&k, &de); e != nil {
				return e
			}
			out[k] = de
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) GetMapping(ctx context.Context) ([]reporting.MapEntry, error) {
	tid := tenantID(ctx)
	out := []reporting.MapEntry{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT disease_key, disease_name, data_element, data_element_name FROM dhis2_disease_map WHERE tenant_id = $1 ORDER BY disease_name`, tid)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var m reporting.MapEntry
			if e := rows.Scan(&m.DiseaseKey, &m.DiseaseName, &m.DataElement, &m.DataElementName); e != nil {
				return e
			}
			out = append(out, m)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

// SaveMapping replaces the clinic's mapping wholesale (entries with an empty
// data_element are dropped = "unmapped").
func (s *Service) SaveMapping(ctx context.Context, entries []reporting.MapEntry) error {
	tid := tenantID(ctx)
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `DELETE FROM dhis2_disease_map WHERE tenant_id = $1`, tid); e != nil {
			return e
		}
		for _, m := range entries {
			key := strings.TrimSpace(m.DiseaseKey)
			if key == "" {
				key = diseaseKey(m.DiseaseName)
			}
			if key == "" || strings.TrimSpace(m.DataElement) == "" {
				continue
			}
			if _, e := tx.Exec(ctx,
				`INSERT INTO dhis2_disease_map (tenant_id, disease_key, disease_name, data_element, data_element_name)
				 VALUES ($1,$2,$3,$4,$5)
				 ON CONFLICT (tenant_id, disease_key) DO UPDATE SET
				   disease_name = EXCLUDED.disease_name, data_element = EXCLUDED.data_element,
				   data_element_name = EXCLUDED.data_element_name, updated_at = now()`,
				tid, key, m.DiseaseName, strings.TrimSpace(m.DataElement), m.DataElementName); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// --- push / read-back / clear ----------------------------------------------

// periodFor formats the current Ethiopian month as the DHIS2 period id, matching
// the instance's calendar (Ethiopian YYYYMM, or the Gregorian month of its start).
func periodFor(calendar string, start time.Time, ey, em int) string {
	if calendar == "gregorian" {
		return start.In(ethiocal.EAT).Format("200601")
	}
	return fmt.Sprintf("%d%02d", ey, em)
}

// expand turns the live disease counts into DHIS2 data values for the mapped
// diseases only (one per non-zero age-sex cell).
func expand(diseases []reporting.Disease, mapping map[string]string) []dhis2.DataValue {
	var vals []dhis2.DataValue
	for _, d := range diseases {
		de := mapping[diseaseKey(d.Name)]
		if de == "" {
			continue // not mapped → not pushable
		}
		for _, key := range dhis2.ColumnKeys {
			if v := d.Counts[key]; v != 0 {
				vals = append(vals, dhis2.DataValue{DataElement: de, CategoryOptionCombo: dhis2.CocByKey[key], Value: strconv.Itoa(v)})
			}
		}
	}
	return vals
}

func (s *Service) pushValues(ctx context.Context) (*dhis2.Client, dbConfig, []dhis2.DataValue, string, error) {
	cl, cfg, err := s.conn(ctx)
	if err != nil {
		return nil, cfg, nil, "", err
	}
	if strings.TrimSpace(cfg.orgUnit) == "" {
		return nil, cfg, nil, "", apperr.Validation("choose this clinic's DHIS2 facility in Settings first")
	}
	start, end, _, ey, em := ethiocal.MonthRange(time.Now())
	diseases, err := s.computeLive(ctx, start, end)
	if err != nil {
		return nil, cfg, nil, "", err
	}
	mapping, err := s.mappingByKey(ctx)
	if err != nil {
		return nil, cfg, nil, "", err
	}
	return cl, cfg, expand(diseases, mapping), periodFor(cfg.periodCalendar, start, ey, em), nil
}

func (s *Service) Push(ctx context.Context) (*dhis2.ImportSummary, error) {
	cl, cfg, vals, period, err := s.pushValues(ctx)
	if err != nil {
		return nil, err
	}
	if len(vals) == 0 {
		return nil, apperr.Validation("no mapped disease counts to push for this month — map your diseases in Settings")
	}
	sum, err := cl.Submit(ctx, cfg.orgUnit, period, vals)
	return s.mapResult(sum, err, "push")
}

func (s *Service) Clear(ctx context.Context) (*dhis2.ImportSummary, error) {
	cl, cfg, vals, period, err := s.pushValues(ctx)
	if err != nil {
		return nil, err
	}
	if len(vals) == 0 {
		return nil, apperr.Validation("nothing to clear")
	}
	sum, err := cl.Clear(ctx, cfg.orgUnit, period, vals)
	return s.mapResult(sum, err, "clear")
}

func (s *Service) Submitted(ctx context.Context) ([]dhis2.DataValue, error) {
	cl, cfg, err := s.conn(ctx)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.orgUnit) == "" {
		return nil, apperr.Validation("choose this clinic's DHIS2 facility in Settings first")
	}
	start, _, _, ey, em := ethiocal.MonthRange(time.Now())
	vals, err := cl.Get(ctx, cfg.orgUnit, periodFor(cfg.periodCalendar, start, ey, em))
	if errors.Is(err, dhis2.ErrUnauthorized) {
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_AUTH", "DHIS2 rejected the token — reconnect in Settings")
	}
	if err != nil {
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_READ_FAILED", "could not read from DHIS2 — try again")
	}
	return vals, nil
}

func (s *Service) mapResult(sum *dhis2.ImportSummary, err error, op string) (*dhis2.ImportSummary, error) {
	switch {
	case errors.Is(err, dhis2.ErrUnauthorized):
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_AUTH", "DHIS2 rejected the token — reconnect in Settings")
	case errors.Is(err, dhis2.ErrLocked):
		return nil, apperr.New(http.StatusConflict, "DHIS2_LOCKED", "The reporting period is locked or complete in DHIS2 — writes are rejected")
	case err != nil:
		// err text may contain a DHIS2 validation reason; it never contains the token.
		return nil, apperr.New(http.StatusBadGateway, "DHIS2_FAILED", "DHIS2 "+op+" failed: "+err.Error())
	}
	return sum, nil
}
