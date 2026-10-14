// On the simple chart: what was recorded on the anatomical chart, in words. A clinic
// that switches back to the simple chart must still see every finding a dentist
// recorded — surfaces, positions, child teeth — even though squares cannot draw them.
import type { ToothAnatomy } from "@/features/dental/api";
import { findings, full, isEmpty, palmerOf, toothName } from "@/features/dental/anatomical/geometry";

export function AnatomyNote({ anatomy }: { anatomy?: Record<string, ToothAnatomy> }) {
  const rows = Object.entries(anatomy ?? {})
    .map(([k, v]) => [Number(k), full(v)] as const)
    .filter(([, v]) => !isEmpty(v))
    .sort(([a], [b]) => a - b);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Recorded on the anatomical chart" className="rounded-lg border bg-muted/40 p-3 text-sm">
      <p className="mb-1.5 font-medium">Recorded on the anatomical chart</p>
      <ul className="space-y-1 text-muted-foreground">
        {rows.map(([n, a]) => {
          const p = palmerOf(n);
          return (
            <li key={n}>
              <span className="font-medium text-foreground">{n}{p ? ` (${p})` : ""}</span> {toothName(n)}: {findings(a).join(", ")}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
