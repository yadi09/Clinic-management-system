// On the simple chart: what was recorded on the anatomical chart, in words. A clinic
// that switches back to the simple chart must still see every item a dentist recorded
// — surfaces, materials, bridges, positions, child teeth — though squares cannot draw them.
import type { Chart } from "@/features/dental/api";
import { palmerOf, toothName } from "@/features/dental/anatomical/geometry";
import { SL, fromItems, items, posEmpty } from "@/features/dental/anatomical/model";

export function AnatomyNote({ chart, today }: { chart?: Chart; today: string }) {
  const state = fromItems(chart?.items);
  const pos = chart?.positions ?? {};
  const teeth = new Set<number>([...Object.keys(state.teeth).map(Number), ...state.bridges.map((b) => b.a)]);
  for (const [k, p] of Object.entries(pos)) if (!posEmpty(p)) teeth.add(Number(k));
  const rows = [...teeth].sort((a, b) => a - b).map((n) => {
    const words = items(state, n, today).map((i) => `${i.t} (${SL[i.s]})`);
    const q = pos[String(n)];
    if (q?.rotation) words.push(`rotated ${Math.abs(q.rotation)}°`);
    if (q?.tipping) words.push(`tipped ${Math.abs(q.tipping)}° ${q.tipping > 0 ? "mesially" : "distally"}`);
    if (q?.buccal_lingual) words.push(`${Math.abs(q.buccal_lingual)}mm ${q.buccal_lingual > 0 ? "buccal" : "lingual"}`);
    if (q?.vertical) words.push(`${Math.abs(q.vertical)}mm ${q.vertical > 0 ? "extruded" : "intruded"}`);
    if (q?.gap_mesial) words.push(`${q.gap_mesial}mm gap on mesial side`);
    return [n, words] as const;
  }).filter(([, w]) => w.length > 0);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Recorded on the anatomical chart" className="rounded-lg border bg-muted/40 p-3 text-sm">
      <p className="mb-1.5 font-medium">Recorded on the anatomical chart</p>
      <ul className="space-y-1 text-muted-foreground">
        {rows.map(([n, words]) => {
          const p = palmerOf(n);
          return (
            <li key={n}>
              <span className="font-medium text-foreground">{n}{p ? ` (${p})` : ""}</span> {toothName(n)}: {words.join(", ")}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
