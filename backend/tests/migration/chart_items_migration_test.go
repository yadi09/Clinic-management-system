// Package migration tests data migrations on a copy-shaped database: a fresh
// database is taken to the version before the migration, filled with records shaped
// like production's, migrated, checked, and rolled back.
package migration

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
)

// freshDB creates an empty database next to TEST_DATABASE_URL's and returns it.
func freshDB(t *testing.T, suffix string) *sql.DB {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" || testing.Short() {
		t.Skip("set TEST_DATABASE_URL (a throwaway Postgres) to run migration tests")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := strings.TrimPrefix(u.Path, "/") + "_" + suffix
	if !strings.Contains(name, "regress") && !strings.Contains(name, "test") {
		t.Fatalf("refusing a database whose name lacks test/regress: %s", name)
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, _ = admin.Exec(`DROP DATABASE IF EXISTS ` + name)
	if _, err := admin.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		a, _ := sql.Open("pgx", dsn)
		_, _ = a.Exec(`DROP DATABASE IF EXISTS ` + name)
		a.Close()
	})
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	return db
}

type itemRow struct {
	Tooth                          int
	Kind, Surface, Material, Status string
	Note                           string
}

// TestMIGRATION_096_ChartItemsCarryVersionOneOverAndRollBack: Given anatomical-chart
// version 1 records like those in production (surfaces, a filling, a crown, a root
// canal, a missing tooth that also held findings, positions), When migration 96 runs,
// Then every finding becomes an item, materials the old chart never recorded are said
// to be unrecorded, the missing tooth keeps what it held in its note, positions move
// across, the version 1 column is unchanged — and rolling back leaves it as it was.
func TestMIGRATION_096_ChartItemsCarryVersionOneOverAndRollBack(t *testing.T) {
	ctx := context.Background()
	db := freshDB(t, "mig96")
	if err := goose.UpToContext(ctx, db, ".", 95); err != nil {
		t.Fatalf("migrate to 95: %v", err)
	}
	v1 := `{
	  "16": {"surfaces": {"O": "caries", "M": "filling"}, "crown": false, "root_canal": false, "missing": false, "rotation": 0, "tipping": 0, "buccal_lingual": 0, "vertical": 0, "gap_mesial": 0},
	  "26": {"surfaces": {}, "crown": true, "root_canal": true, "missing": false, "rotation": 0, "tipping": 0, "buccal_lingual": 0, "vertical": 0, "gap_mesial": 0},
	  "46": {"surfaces": {"O": "caries"}, "crown": true, "root_canal": false, "missing": true, "rotation": 0, "tipping": 0, "buccal_lingual": 0, "vertical": 0, "gap_mesial": 0},
	  "12": {"surfaces": {}, "crown": false, "root_canal": false, "missing": false, "rotation": 35, "tipping": -10, "buccal_lingual": 1.5, "vertical": 0, "gap_mesial": 2},
	  "54": {"surfaces": {"D": "caries"}, "crown": false, "root_canal": false, "missing": false, "rotation": 0, "tipping": 0, "buccal_lingual": 0, "vertical": 0, "gap_mesial": 1}
	}`
	var tid, pid string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(`INSERT INTO plans (code,name,audit_retention_days) VALUES ('mig96','Mig',90) RETURNING id`).Scan(new(string)))
	must(db.QueryRow(`INSERT INTO tenants (name,slug,plan_id) SELECT 'Mig','mig96',id FROM plans WHERE code='mig96' RETURNING id`).Scan(&tid))
	must(db.QueryRow(`INSERT INTO patients (tenant_id,mrn,first_name,last_name,gender) VALUES ($1,'M-1','A','B','female') RETURNING id`, tid).Scan(&pid))
	_, err := db.Exec(`INSERT INTO dental_charts (tenant_id, patient_id, teeth, anatomy) VALUES ($1,$2,'{"UR1":"decayed"}'::jsonb,$3::jsonb)`, tid, pid, v1)
	must(err)

	if err := goose.UpToContext(ctx, db, ".", 96); err != nil {
		t.Fatalf("migrate to 96: %v", err)
	}
	rows, err := db.Query(`SELECT tooth, kind, coalesce(surface,''), coalesce(material,''), status, coalesce(note,'') FROM dental_chart_items WHERE patient_id = $1 ORDER BY tooth, kind, surface`, pid)
	must(err)
	got := map[string]itemRow{}
	for rows.Next() {
		var r itemRow
		must(rows.Scan(&r.Tooth, &r.Kind, &r.Surface, &r.Material, &r.Status, &r.Note))
		got[strings.TrimSpace(strings.Join([]string{strconv.Itoa(r.Tooth), r.Kind, r.Surface}, " "))] = r
	}
	rows.Close()
	want := map[string]struct{ material, status, noteHas string }{
		"16 caries O":     {"", "existing", "Migrated"},
		"16 filling M":    {"composite", "existing", "material not recorded"},
		"26 crown":        {"zirconia", "existing", "material not recorded"},
		"26 root_canal":   {"", "existing", "Migrated"},
		"46 missing":      {"", "existing", "a crown"},
		"54 caries D":     {"", "existing", "Migrated"},
	}
	if len(got) != len(want) {
		t.Fatalf("items after migration = %v, want exactly %d", got, len(want))
	}
	for k, w := range want {
		g, ok := got[k]
		if !ok || g.Material != w.material || g.Status != w.status || !strings.Contains(g.Note, w.noteHas) {
			t.Fatalf("%s = %+v, want material %q status %q note containing %q", k, g, w.material, w.status, w.noteHas)
		}
	}
	if !strings.Contains(got["46 missing"].Note, "surfaces") {
		t.Fatalf("the missing tooth's other findings were not kept in its note: %q", got["46 missing"].Note)
	}

	var posRaw, anatRaw, teethRaw []byte
	must(db.QueryRow(`SELECT positions, anatomy, teeth FROM dental_charts WHERE patient_id = $1`, pid).Scan(&posRaw, &anatRaw, &teethRaw))
	var pos map[string]map[string]float64
	must(json.Unmarshal(posRaw, &pos))
	if len(pos) != 2 || pos["12"]["rotation"] != 35 || pos["12"]["buccal_lingual"] != 1.5 || pos["12"]["gap_mesial"] != 2 || pos["54"]["gap_mesial"] != 1 {
		t.Fatalf("positions = %v", pos)
	}
	if !sameJSON(t, anatRaw, []byte(v1)) {
		t.Fatalf("version 1's column was changed by the migration: %s", anatRaw)
	}
	if string(teethRaw) != `{"UR1": "decayed"}` {
		t.Fatalf("the simple chart's marks were changed: %s", teethRaw)
	}

	// Rollback: back to 95, version 1's record is exactly as it was.
	if err := goose.DownToContext(ctx, db, ".", 95); err != nil {
		t.Fatalf("roll back: %v", err)
	}
	must(db.QueryRow(`SELECT anatomy FROM dental_charts WHERE patient_id = $1`, pid).Scan(&anatRaw))
	if !sameJSON(t, anatRaw, []byte(v1)) {
		t.Fatalf("after rollback version 1's record differs: %s", anatRaw)
	}
	var exists bool
	must(db.QueryRow(`SELECT to_regclass('dental_chart_items') IS NOT NULL`).Scan(&exists))
	if exists {
		t.Fatal("rollback left the items table behind")
	}
	// …and forward again works (a re-deploy after a rollback).
	if err := goose.UpToContext(ctx, db, ".", 96); err != nil {
		t.Fatalf("migrate to 96 again: %v", err)
	}
}

func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	p, _ := json.Marshal(x)
	q, _ := json.Marshal(y)
	return string(p) == string(q)
}

// TestMIGRATION_096_TheProductionRecord: the one version-1 record in production on
// 2026-10-14 (its tooth findings only — no patient, no name), migrated: 10 items and
// 5 positions, the missing tooth's root canal kept in its note.
func TestMIGRATION_096_TheProductionRecord(t *testing.T) {
	ctx := context.Background()
	db := freshDB(t, "mig96prod")
	if err := goose.UpToContext(ctx, db, ".", 95); err != nil {
		t.Fatalf("migrate to 95: %v", err)
	}
	raw, err := os.ReadFile("testdata/production_anatomy_2026-10-14.json")
	if err != nil {
		t.Fatal(err)
	}
	var tid, pid string
	if err := db.QueryRow(`INSERT INTO plans (code,name,audit_retention_days) VALUES ('mig96p','Mig',90) RETURNING id`).Scan(new(string)); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`INSERT INTO tenants (name,slug,plan_id) SELECT 'Mig','mig96p',id FROM plans WHERE code='mig96p' RETURNING id`).Scan(&tid); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`INSERT INTO patients (tenant_id,mrn,first_name,last_name,gender) VALUES ($1,'M-1','A','B','female') RETURNING id`, tid).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO dental_charts (tenant_id, patient_id, teeth, anatomy) VALUES ($1,$2,'{}'::jsonb,$3::jsonb)`, tid, pid, string(raw)); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpToContext(ctx, db, ".", 96); err != nil {
		t.Fatalf("migrate to 96: %v", err)
	}
	var list string
	if err := db.QueryRow(`SELECT string_agg(tooth || ' ' || kind || coalesce(' ' || surface, ''), ', ' ORDER BY tooth, kind, surface)
	                         FROM dental_chart_items WHERE patient_id = $1`, pid).Scan(&list); err != nil {
		t.Fatal(err)
	}
	want := "11 caries B, 16 root_canal, 17 filling D, 17 filling O, 25 missing, 26 filling O, 28 filling D, 28 filling O, 35 crown, 45 filling O"
	if list != want {
		t.Fatalf("items =\n %s\nwant\n %s", list, want)
	}
	var note string
	if err := db.QueryRow(`SELECT note FROM dental_chart_items WHERE patient_id = $1 AND tooth = 25`, pid).Scan(&note); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "a root canal") {
		t.Fatalf("tooth 25's root canal was not kept: %q", note)
	}
	var keys string
	if err := db.QueryRow(`SELECT string_agg(k, ',' ORDER BY k) FROM dental_charts, jsonb_object_keys(positions) k WHERE patient_id = $1`, pid).Scan(&keys); err != nil {
		t.Fatal(err)
	}
	if keys != "17,21,31,32,38" {
		t.Fatalf("positions for %s, want 17,21,31,32,38", keys)
	}
}
