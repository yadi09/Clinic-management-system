package service

// The anatomical chart (version 2): items recorded on teeth, their business rules,
// and tooth positions. The rules here mirror features/dental/anatomical/model.ts —
// the chart applies them as the dentist works; the server refuses any save that
// breaks them, so a stale tab or a hand-made request cannot store a mouth the chart
// could not draw (an implant on a tooth that is there, a bridge over a living tooth).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

var (
	itemKinds      = map[string]bool{"caries": true, "filling": true, "crown": true, "root_canal": true, "extraction": true, "missing": true, "implant": true, "bridge": true, "braces": true}
	braceMaterials = map[string]bool{"metal": true, "ceramic": true}
	itemStatuses   = map[string]bool{"existing": true, "planned": true, "done": true}
	fillMaterials  = map[string]bool{"composite": true, "amalgam": true}
	crownMaterials = map[string]bool{"zirconia": true, "pfm": true, "gold": true, "steel": true}
	surfaceWords   = map[string]string{"O": "top", "M": "front side", "D": "back side", "B": "cheek side", "L": "tongue side"}
	kindWords      = map[string]string{"caries": "caries", "filling": "a filling", "crown": "a crown", "root_canal": "a root canal", "extraction": "an extraction", "implant": "an implant", "bridge": "a bridge", "braces": "braces"}
	archUpAdult    = []int{18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28}
	archLoAdult    = []int{48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38}
	archUpChild    = []int{55, 54, 53, 52, 51, 61, 62, 63, 64, 65}
	archLoChild    = []int{85, 84, 83, 82, 81, 71, 72, 73, 74, 75}
)

func isUpper(t int) bool { q := t / 10; return q == 1 || q == 2 || q == 5 || q == 6 }
func isChild(t int) bool { return t/10 >= 5 }

// liveItem is a stored item, as the rules see it.
type liveItem struct {
	id                                   uuid.UUID
	tooth                                int
	kind, surface, material, status, note string
	bridgeEnd                            int
	doneOn                               *time.Time
}

func itemKey(kind, surface string) string { return kind + "|" + surface }

type mouthItems map[int]map[string]*liveItem

func (m mouthItems) has(t int, kind string) *liveItem { return m[t][itemKey(kind, "")] }

// bridges returns every bridge as its span along the arch.
type span struct {
	item  *liveItem
	units []int // end, pontics…, end, in arch order
}

func archOf(t int) []int {
	switch {
	case isChild(t) && isUpper(t):
		return archUpChild
	case isChild(t):
		return archLoChild
	case isUpper(t):
		return archUpAdult
	}
	return archLoAdult
}

func indexOf(a []int, t int) int {
	for i, x := range a {
		if x == t {
			return i
		}
	}
	return -1
}

func (m mouthItems) spans() []span { return m.spansOf("bridge") }

// spansOf returns every span of a kind (bridge or braces) along its arch.
func (m mouthItems) spansOf(kind string) []span {
	var out []span
	for _, items := range m {
		for _, it := range items {
			if it.kind != kind {
				continue
			}
			ar := archOf(it.tooth)
			i, j := indexOf(ar, it.tooth), indexOf(ar, it.bridgeEnd)
			if i < 0 || j < 0 {
				out = append(out, span{item: it})
				continue
			}
			if i > j {
				i, j = j, i
			}
			out = append(out, span{item: it, units: append([]int(nil), ar[i:j+1]...)})
		}
	}
	return out
}

func refuse(f string, a ...any) error { return apperr.Validation(fmt.Sprintf(f, a...)) }

// checkItem: one item on its own — the vocabulary, before the mouth is considered.
func checkItem(t int, in dental.ItemInput) error {
	if !itemKinds[in.Kind] {
		return refuse("Tooth %d: %q is not something the chart records.", t, in.Kind)
	}
	if !itemStatuses[in.Status] {
		return refuse("Tooth %d: record it as already in mouth, to be done or done today.", t)
	}
	surf := in.Kind == "caries" || in.Kind == "filling"
	if surf {
		if _, ok := surfaceWords[in.Surface]; !ok {
			return refuse("Tooth %d: pick the surface (top, front side, back side, cheek side or tongue side).", t)
		}
	} else if in.Surface != "" {
		return refuse("Tooth %d: %s covers the whole tooth, not one surface.", t, kindWords[in.Kind])
	}
	switch in.Kind {
	case "filling":
		if !fillMaterials[in.Material] {
			return refuse("Tooth %d: a filling is composite or amalgam.", t)
		}
	case "crown", "implant", "bridge":
		if !crownMaterials[in.Material] {
			return refuse("Tooth %d: pick the crown material (zirconia, porcelain-metal, gold or stainless steel).", t)
		}
	case "braces":
		if !braceMaterials[in.Material] {
			return refuse("Tooth %d: braces are metal or ceramic.", t)
		}
	default:
		if in.Material != "" {
			return refuse("Tooth %d: %s has no material.", t, kindWords[in.Kind])
		}
	}
	switch in.Kind {
	case "caries":
		if in.Status != "existing" {
			return refuse("Tooth %d: caries is a finding — it is recorded as already in the mouth.", t)
		}
	case "extraction":
		if in.Status == "existing" {
			return refuse("For a tooth that is already gone, use Missing. Extraction is for \"To be done\" or \"Done today\".")
		}
		if in.Status == "done" {
			return refuse("Tooth %d: a tooth taken out today is recorded as missing, done today.", t)
		}
	case "missing":
		if in.Status == "planned" {
			return refuse("Tooth %d: to plan taking a tooth out, record an extraction.", t)
		}
	}
	if in.Kind == "bridge" && in.BridgeEnd == 0 {
		return refuse("Tooth %d: a bridge needs the tooth at its other end.", t)
	}
	if in.Kind == "braces" && in.BridgeEnd == 0 {
		return refuse("Tooth %d: braces need the last tooth they reach.", t)
	}
	if in.Kind != "bridge" && in.Kind != "braces" && in.BridgeEnd != 0 {
		return refuse("Tooth %d: only a bridge or braces name another tooth.", t)
	}
	if isChild(t) && (in.Kind == "implant" || in.Kind == "bridge") {
		if in.Kind == "implant" {
			return refuse("Implants are not used for baby teeth.")
		}
		return refuse("Bridges are not used for baby teeth.")
	}
	return nil
}

// checkMouth: the rules between items, for the teeth a save touched (and every tooth
// of a bridge that reaches one of them). Teeth the save did not touch are not
// re-judged, so a record made before a rule existed never blocks unrelated work.
//
// fresh holds the items this save added or changed ("tooth|kind|surface"). Marking a
// surface on a tooth under a real crown or a bridge end is refused only for a fresh
// mark: a crown or bridge put over a tooth that already has fillings is allowed, as
// in the chart — the fillings stay on record beneath it.
func checkMouth(m mouthItems, touched map[int]bool, fresh map[string]bool) error {
	spans := m.spans()
	roleOf := func(t int) (span, string, bool) {
		for _, sp := range spans {
			for k, u := range sp.units {
				if u == t {
					if k == 0 || k == len(sp.units)-1 {
						return sp, "end", true
					}
					return sp, "pontic", true
				}
			}
		}
		return span{}, "", false
	}
	check := map[int]bool{}
	for t := range touched {
		check[t] = true
		if sp, _, ok := roleOf(t); ok {
			for _, u := range sp.units {
				check[u] = true
			}
		}
	}
	// Bridges first: their shape decides what the teeth under them may hold.
	for _, sp := range spans {
		in := false
		for _, u := range sp.units {
			in = in || check[u]
		}
		if !in && !check[sp.item.tooth] {
			continue
		}
		a, b := sp.item.tooth, sp.item.bridgeEnd
		if a == b {
			return refuse("Pick a different tooth for the other end of the bridge.")
		}
		if isChild(a) || isChild(b) {
			return refuse("Bridges are not used for baby teeth.")
		}
		if isUpper(a) != isUpper(b) || sp.units == nil {
			return refuse("A bridge has to stay in one jaw. Pick a tooth in the same jaw.")
		}
		mid := sp.units[1 : len(sp.units)-1]
		if len(mid) == 0 {
			return refuse("These teeth are next to each other. A bridge needs at least one missing tooth between its two ends.")
		}
		if len(mid) > 3 {
			return refuse("A bridge can replace at most 3 missing teeth. Pick end teeth closer together.")
		}
		for _, e := range []int{a, b} {
			if m.has(e, "missing") != nil || m.has(e, "implant") != nil {
				return refuse("Tooth %d is missing. Both ends of a bridge must be natural teeth.", e)
			}
		}
		var notGone []string
		for _, u := range mid {
			if m.has(u, "missing") == nil || m.has(u, "implant") != nil {
				notGone = append(notGone, strconv.Itoa(u))
			}
		}
		if len(notGone) == 1 {
			return refuse("A bridge fills the space of missing teeth, but %s is not missing. Mark it as Missing first.", notGone[0])
		}
		if len(notGone) > 1 {
			return refuse("A bridge fills the space of missing teeth, but %s are not missing. Mark them as Missing first.", joinComma(notGone))
		}
		for _, other := range spans {
			if other.item == sp.item {
				continue
			}
			for _, u := range other.units {
				for _, v := range sp.units {
					if u == v {
						return refuse("Some of these teeth are already part of a bridge.")
					}
				}
			}
		}
	}
	// Braces: one jaw, both ends on teeth that are there, one set per jaw. Teeth under
	// braces may be missing (they simply get no bracket).
	braces := m.spansOf("braces")
	for _, sp := range braces {
		in := check[sp.item.tooth]
		for _, u := range sp.units {
			in = in || check[u]
		}
		if !in {
			continue
		}
		a, b := sp.item.tooth, sp.item.bridgeEnd
		if a == b {
			return refuse("Pick a different tooth for the other end of the braces.")
		}
		if isUpper(a) != isUpper(b) || isChild(a) != isChild(b) || sp.units == nil {
			return refuse("Braces stay on one jaw. Pick the last tooth in the same jaw.")
		}
		for _, e := range []int{a, b} {
			if m.has(e, "missing") != nil && m.has(e, "implant") == nil {
				return refuse("Tooth %d is missing. Start and end the braces on teeth that are there.", e)
			}
		}
		for _, other := range braces {
			if other.item != sp.item && isUpper(other.item.tooth) == isUpper(a) && isChild(other.item.tooth) == isChild(a) {
				return refuse("This jaw already has braces. Remove them first (tap Braces on one of their teeth).")
			}
		}
	}
	for t := range check {
		items := m[t]
		missing, implant := m.has(t, "missing"), m.has(t, "implant")
		_, role, inBridge := roleOf(t)
		if implant != nil && missing == nil {
			return refuse("An implant replaces a missing tooth. Mark tooth %d as Missing first (or extract it).", t)
		}
		if implant != nil && inBridge {
			return refuse("Tooth %d is part of a bridge, so it cannot also have an implant.", t)
		}
		crown := m.has(t, "crown")
		realCrown := crown != nil && crown.status != "planned"
		for _, it := range items {
			switch it.kind {
			case "caries", "filling", "crown", "root_canal", "extraction":
				if missing != nil {
					return refuse("Tooth %d is missing, so it cannot have %s.", t, kindWords[it.kind])
				}
			}
			if (it.kind == "caries" || it.kind == "filling") && fresh[fmt.Sprintf("%d|%s", t, itemKey(it.kind, it.surface))] {
				if realCrown {
					return refuse("Tooth %d is covered by a crown, so its surfaces cannot be marked.", t)
				}
				if inBridge && role == "end" {
					return refuse("Tooth %d is the end of a bridge and is covered by its crown, so its surfaces cannot be marked.", t)
				}
			}
			if it.kind == "crown" && inBridge {
				return refuse("Bridge end teeth already have crowns.")
			}
			if it.kind == "caries" {
				if f := items[itemKey("filling", it.surface)]; f != nil && f.status != "planned" {
					return refuse("Tooth %d: the filling on the %s replaces the caries there. Remove one of them.", t, surfaceWords[it.surface])
				}
			}
		}
		if inBridge && role == "end" && missing != nil {
			return refuse("Tooth %d is the end of a bridge, so it cannot be missing. Clear the bridge first.", t)
		}
	}
	return nil
}

func joinComma(xs []string) string {
	out := ""
	for i, x := range xs {
		if i > 0 {
			out += ", "
		}
		out += x
	}
	return out
}

// loadItemsTx reads the patient's live items, with who made and last changed each.
func loadItemsTx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID, lock bool) ([]liveItem, []dental.ChartItem, error) {
	q := `SELECT i.id, i.tooth, i.kind, coalesce(i.surface,''), coalesce(i.material,''), i.status,
	             coalesce(i.bridge_end,0), coalesce(i.note,''), i.done_on,
	             coalesce(cu.full_name,''), i.created_at, coalesce(uu.full_name,''), i.updated_at
	        FROM dental_chart_items i
	        LEFT JOIN users cu ON cu.id = i.created_by AND cu.tenant_id = i.tenant_id
	        LEFT JOIN users uu ON uu.id = i.updated_by AND uu.tenant_id = i.tenant_id
	       WHERE i.tenant_id = $1 AND i.patient_id = $2 AND i.deleted_at IS NULL
	       ORDER BY i.tooth, i.kind, i.surface NULLS FIRST`
	if lock {
		q += ` FOR UPDATE OF i`
	}
	rows, err := tx.Query(ctx, q, tid, patientID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var live []liveItem
	var out []dental.ChartItem
	for rows.Next() {
		var l liveItem
		var c dental.ChartItem
		var tooth, end int16
		if err := rows.Scan(&l.id, &tooth, &l.kind, &l.surface, &l.material, &l.status, &end, &l.note, &l.doneOn,
			&c.CreatedBy, &c.CreatedAt, &c.UpdatedBy, &c.UpdatedAt); err != nil {
			return nil, nil, err
		}
		l.tooth, l.bridgeEnd = int(tooth), int(end)
		live = append(live, l)
		c.ID, c.Tooth, c.Kind, c.Surface, c.Material, c.Status, c.BridgeEnd, c.Note = l.id, l.tooth, l.kind, l.surface, l.material, l.status, l.bridgeEnd, l.note
		if l.doneOn != nil {
			d := l.doneOn.Format("2006-01-02")
			c.DoneOn = &d
		}
		out = append(out, c)
	}
	return live, out, rows.Err()
}

// loadPositionsTx reads tooth positions (FDI -> position).
func loadPositionsTx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID) (map[string]dental.Position, error) {
	out := map[string]dental.Position{}
	var raw []byte
	e := tx.QueryRow(ctx, `SELECT positions FROM dental_charts WHERE tenant_id = $1 AND patient_id = $2`, tid, patientID).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, nil
	}
	if e != nil {
		return nil, e
	}
	return out, json.Unmarshal(raw, &out)
}

// loadV2Tx fills the version-2 parts of a chart: items and positions.
func loadV2Tx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID, chart *dental.Chart) error {
	_, items, err := loadItemsTx(ctx, tx, tid, patientID, false)
	if err != nil {
		return err
	}
	if items == nil {
		items = []dental.ChartItem{}
	}
	chart.Items = items
	pos, err := loadPositionsTx(ctx, tx, tid, patientID)
	if err != nil {
		return err
	}
	chart.Positions = pos
	return nil
}

func validFDI(t int) bool {
	q, d := t/10, t%10
	return (q >= 1 && q <= 4 && d >= 1 && d <= 8) || (q >= 5 && q <= 8 && d >= 1 && d <= 5)
}

// ensureChartRowTx makes sure the patient has a chart row and locks it, so saves on
// one patient queue up instead of racing.
func ensureChartRowTx(ctx context.Context, tx pgx.Tx, tid, patientID uuid.UUID, actor *uuid.UUID) error {
	if _, e := tx.Exec(ctx,
		`INSERT INTO dental_charts (tenant_id, patient_id, teeth, updated_by, updated_at)
		 VALUES ($1, $2, '{}'::jsonb, $3, now()) ON CONFLICT (tenant_id, patient_id) DO NOTHING`,
		tid, patientID, actor); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `SELECT 1 FROM dental_charts WHERE tenant_id = $1 AND patient_id = $2 FOR UPDATE`, tid, patientID)
	return e
}

// SaveChartItems replaces the items of each tooth named with the list sent for it.
// An item that matches a stored one (same kind and surface) keeps its identity and
// author; a stored item not in the list is removed (kept, marked deleted); a new one
// is added. The whole save is refused, and nothing stored, if the result breaks a rule.
func (s *Service) SaveChartItems(ctx context.Context, patientID uuid.UUID, teeth map[string][]dental.ItemInput) (*dental.Chart, error) {
	tid, actor := actorOf(ctx)
	want := map[int]map[string]dental.ItemInput{}
	for k, list := range teeth {
		t, err := strconv.Atoi(k)
		if err != nil || !validFDI(t) {
			return nil, refuse("Tooth %s is not a tooth on the chart.", k)
		}
		want[t] = map[string]dental.ItemInput{}
		for _, in := range list {
			if err := checkItem(t, in); err != nil {
				return nil, err
			}
			if (in.Kind == "bridge" || in.Kind == "braces") && !validFDI(in.BridgeEnd) {
				return nil, refuse("Tooth %d: the other end of the %s is not a tooth on the chart.", t, in.Kind)
			}
			key := itemKey(in.Kind, in.Surface)
			if _, dup := want[t][key]; dup {
				return nil, refuse("Tooth %d: %s is recorded twice.", t, kindWords[in.Kind])
			}
			want[t][key] = in
		}
	}
	out := &dental.Chart{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := ensureChartRowTx(ctx, tx, tid, patientID, actor); e != nil {
			return e
		}
		live, _, e := loadItemsTx(ctx, tx, tid, patientID, true)
		if e != nil {
			return e
		}
		var today time.Time
		if e := tx.QueryRow(ctx, `SELECT (now() AT TIME ZONE 'Africa/Addis_Ababa')::date`).Scan(&today); e != nil {
			return e
		}
		mouth := mouthItems{}
		for i := range live {
			l := &live[i]
			if mouth[l.tooth] == nil {
				mouth[l.tooth] = map[string]*liveItem{}
			}
			mouth[l.tooth][itemKey(l.kind, l.surface)] = l
		}
		type change struct {
			Tooth int    `json:"tooth"`
			Item  string `json:"item"`
			From  any    `json:"from"`
			To    any    `json:"to"`
		}
		var diff []change
		desc := func(l *liveItem) map[string]any {
			if l == nil {
				return nil
			}
			return map[string]any{"material": l.material, "status": l.status, "bridge_end": l.bridgeEnd, "note": l.note}
		}
		touched := map[int]bool{}
		fresh := map[string]bool{}
		toothKeys := make([]int, 0, len(want))
		for t := range want {
			toothKeys = append(toothKeys, t)
		}
		sort.Ints(toothKeys)
		for _, t := range toothKeys {
			wanted := want[t]
			have := mouth[t]
			touched[t] = true
			// Removed.
			for key, l := range have {
				if _, keep := wanted[key]; keep {
					continue
				}
				if _, e := tx.Exec(ctx, `UPDATE dental_chart_items SET deleted_at = now(), deleted_by = $3 WHERE tenant_id = $1 AND id = $2`, tid, l.id, actor); e != nil {
					return e
				}
				diff = append(diff, change{t, key, desc(l), nil})
				if l.kind == "bridge" || l.kind == "braces" {
					touched[l.bridgeEnd] = true
				}
				delete(have, key)
			}
			if mouth[t] == nil {
				mouth[t] = map[string]*liveItem{}
			}
			keys := make([]string, 0, len(wanted))
			for k := range wanted {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, key := range keys {
				in := wanted[key]
				note := ""
				if l := mouth[t][key]; l != nil {
					note = l.note
				}
				if in.Note != nil {
					note = *in.Note
				}
				var doneOn *time.Time
				if in.Status == "done" {
					d := today
					if l := mouth[t][key]; l != nil && l.status == "done" && l.doneOn != nil {
						d = *l.doneOn // done earlier stays done on its own day
					}
					doneOn = &d
				}
				if l := mouth[t][key]; l != nil {
					if l.material == in.Material && l.status == in.Status && l.bridgeEnd == in.BridgeEnd && l.note == note {
						continue
					}
					before := desc(l)
					if _, e := tx.Exec(ctx,
						`UPDATE dental_chart_items SET material = nullif($3,''), status = $4, bridge_end = nullif($5,0), note = nullif($6,''),
						        done_on = $7, updated_by = $8, updated_at = now()
						  WHERE tenant_id = $1 AND id = $2`,
						tid, l.id, in.Material, in.Status, in.BridgeEnd, note, doneOn, actor); e != nil {
						return e
					}
					if (l.kind == "bridge" || l.kind == "braces") && l.bridgeEnd != in.BridgeEnd {
						touched[l.bridgeEnd] = true
					}
					l.material, l.status, l.bridgeEnd, l.note, l.doneOn = in.Material, in.Status, in.BridgeEnd, note, doneOn
					diff = append(diff, change{t, key, before, desc(l)})
					fresh[fmt.Sprintf("%d|%s", t, key)] = true
					continue
				}
				nl := &liveItem{id: id.New(), tooth: t, kind: in.Kind, surface: in.Surface, material: in.Material, status: in.Status, bridgeEnd: in.BridgeEnd, note: note, doneOn: doneOn}
				if _, e := tx.Exec(ctx,
					`INSERT INTO dental_chart_items (id, tenant_id, patient_id, tooth, kind, surface, material, status, bridge_end, note, done_on, created_by, updated_by)
					 VALUES ($1,$2,$3,$4,$5,nullif($6,''),nullif($7,''),$8,nullif($9,0),nullif($10,''),$11,$12,$12)`,
					nl.id, tid, patientID, t, in.Kind, in.Surface, in.Material, in.Status, in.BridgeEnd, note, doneOn, actor); e != nil {
					return e
				}
				mouth[t][key] = nl
				diff = append(diff, change{t, key, nil, desc(nl)})
				fresh[fmt.Sprintf("%d|%s", t, key)] = true
			}
			for _, l := range mouth[t] {
				if l.kind == "bridge" || l.kind == "braces" {
					touched[l.bridgeEnd] = true
				}
			}
		}
		if err := checkMouth(mouth, touched, fresh); err != nil {
			return err
		}
		if len(diff) > 0 {
			if _, e := tx.Exec(ctx, `UPDATE dental_charts SET updated_by = $3, updated_at = now() WHERE tenant_id = $1 AND patient_id = $2`, tid, patientID, actor); e != nil {
				return e
			}
			if e := s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.chart.saved",
				map[string]any{"patient_id": patientID, "items": diff}); e != nil {
				return e
			}
		}
		return s.loadChartTx(ctx, tx, tid, patientID, out)
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func validPosition(tooth string, p *dental.Position) error {
	a := dental.ToothAnatomy{Rotation: p.Rotation, Tipping: p.Tipping, BuccalLingual: p.BuccalLingual, Vertical: p.Vertical, GapMesial: p.GapMesial}
	return validAnatomy(tooth, &a)
}

// SavePositions merges tooth positions: {fdi: position}, and nil (or all zero) clears.
func (s *Service) SavePositions(ctx context.Context, patientID uuid.UUID, changes map[string]*dental.Position) (*dental.Chart, error) {
	tid, actor := actorOf(ctx)
	for k, p := range changes {
		t, err := strconv.Atoi(k)
		if err != nil || !validFDI(t) {
			return nil, refuse("Tooth %s is not a tooth on the chart.", k)
		}
		if p != nil {
			if e := validPosition(k, p); e != nil {
				return nil, e
			}
		}
	}
	out := &dental.Chart{}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := ensureChartRowTx(ctx, tx, tid, patientID, actor); e != nil {
			return e
		}
		pos, e := loadPositionsTx(ctx, tx, tid, patientID)
		if e != nil {
			return e
		}
		diff := map[string]any{}
		for k, p := range changes {
			was, had := pos[k]
			if p == nil || *p == (dental.Position{}) {
				if had {
					delete(pos, k)
					diff[k] = map[string]any{"from": was, "to": nil}
				}
				continue
			}
			if had && was == *p {
				continue
			}
			pos[k] = *p
			var from any
			if had {
				from = was
			}
			diff[k] = map[string]any{"from": from, "to": *p}
		}
		if len(diff) > 0 {
			raw, e := json.Marshal(pos)
			if e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `UPDATE dental_charts SET positions = $3, updated_by = $4, updated_at = now() WHERE tenant_id = $1 AND patient_id = $2`,
				tid, patientID, raw, actor); e != nil {
				return e
			}
			if e := s.publisher.Publish(ctx, tx, &tid, "patient", patientID, "dental.chart.saved",
				map[string]any{"patient_id": patientID, "positions": diff}); e != nil {
				return e
			}
		}
		return s.loadChartTx(ctx, tx, tid, patientID, out)
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}
