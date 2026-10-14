// The selected tooth, as in the reference's detail panel: enlarged side and top
// views, its name and findings in words, the 5-surface diagram (labels flipped per
// quadrant), and the position sliders with "Reset position".
import type { SurfaceKey, ToothAnatomy } from "@/features/dental/api";
import { C, FMT, SLIDERS, findings, isUp, mir, pos, toothName } from "@/features/dental/anatomical/geometry";
import { ToothSide, ToothTop } from "@/features/dental/anatomical/Tooth";
import type { ClinicMark } from "@/features/dental/anatomical/AnatomicalChart";

export type Tool = "caries" | "filling" | "crown" | "rct" | "missing" | "clear";

/** The 5-surface diagram's shapes and label points, flipped per quadrant (render()). */
function surfaceDiagram(n: number) {
  const m = mir(n), u = isUp(n);
  const poly: Partial<Record<SurfaceKey, string>> = {}, lab: Partial<Record<SurfaceKey, [number, number]>> = {};
  poly[u ? "B" : "L"] = "0,0 120,0 80,40 40,40";
  poly[u ? "L" : "B"] = "40,80 80,80 120,120 0,120";
  poly[m ? "D" : "M"] = "0,0 40,40 40,80 0,120";
  poly[m ? "M" : "D"] = "120,0 120,120 80,80 80,40";
  lab[u ? "B" : "L"] = [60, 22];
  lab[u ? "L" : "B"] = [60, 104];
  lab[m ? "D" : "M"] = [18, 64];
  lab[m ? "M" : "D"] = [102, 64];
  lab.O = [60, 64];
  return { poly, lab };
}

const SURF_NAME: Record<SurfaceKey, string> = { O: "Occlusal", M: "Mesial", D: "Distal", B: "Buccal", L: "Lingual" };

export function ToothDetail({ n, a, mark, editable, tool, onSurface, onPosition, onResetPosition, onClearMark, uid }: {
  n: number;
  a?: ToothAnatomy;
  /** The simple chart's mark on this tooth, if any. */
  mark?: ClinicMark | null;
  editable: boolean;
  tool: Tool;
  onSurface: (s: SurfaceKey) => void;
  onPosition: (field: (typeof SLIDERS)[number]["field"], value: number) => void;
  onResetPosition: () => void;
  /** Remove the simple chart's mark (offered only to someone who can edit). */
  onClearMark?: () => void;
  uid: string;
}) {
  const f = findings(a), q = pos(a);
  const { poly, lab } = surfaceDiagram(n);
  const surfFill = (k: SurfaceKey) => { const c = a?.surfaces?.[k]; return c ? C[c] : "var(--surface-1)"; };
  const surfaceTool = tool === "caries" || tool === "filling";

  return (
    <div className="rounded-xl border p-3" style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center gap-1.5">
          <svg viewBox="-12 -8 64 116" width={64} height={130} aria-hidden>
            {isUp(n)
              ? <ToothSide n={n} a={a} clipId={`${uid}bigs`} />
              : <g transform="translate(0,100) scale(1,-1)"><ToothSide n={n} a={a} clipId={`${uid}bigs`} /></g>}
          </svg>
          <svg viewBox="-8 -8 56 56" width={60} height={60} aria-hidden><ToothTop n={n} a={a} clipId={`${uid}bigt`} /></svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-0.5 text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>Tooth {n}</p>
          <p data-testid="tooth-info" className="mb-2 text-[13px] leading-normal" style={{ color: "var(--text-secondary)" }}>
            {toothName(n)}. {f.length ? f.join(", ") : "Healthy"}
          </p>
          {mark && (
            <p className="mb-2 flex items-center gap-1.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: mark.color }} />
              Marked on the simple chart: <b className="font-medium" style={{ color: "var(--text-primary)" }}>{mark.label}</b>
              {onClearMark && (
                <button type="button" className="ml-1 underline" style={{ color: "var(--text-accent)" }} onClick={onClearMark}>Remove mark</button>
              )}
            </p>
          )}
          <svg viewBox="-2 -2 124 124" width={110} height={110} role="group" aria-label="Tooth surfaces">
            {(Object.keys(poly) as SurfaceKey[]).map((k) => (
              <polygon key={k} data-s={k} points={poly[k]} className="ta-surf" style={{ fill: surfFill(k), cursor: editable && surfaceTool ? "pointer" : "default" }}
                role={editable ? "button" : undefined} aria-label={`${SURF_NAME[k]}${a?.surfaces?.[k] ? `: ${a.surfaces[k]}` : ""}`}
                tabIndex={editable && surfaceTool ? 0 : -1}
                onClick={() => editable && onSurface(k)}
                onKeyDown={(e) => { if (editable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSurface(k); } }} />
            ))}
            <rect data-s="O" x={40} y={40} width={40} height={40} className="ta-surf" style={{ fill: surfFill("O"), cursor: editable && surfaceTool ? "pointer" : "default" }}
              role={editable ? "button" : undefined} aria-label={`${SURF_NAME.O}${a?.surfaces?.O ? `: ${a.surfaces.O}` : ""}`}
              tabIndex={editable && surfaceTool ? 0 : -1}
              onClick={() => editable && onSurface("O")}
              onKeyDown={(e) => { if (editable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSurface("O"); } }} />
            {(Object.keys(lab) as SurfaceKey[]).map((k) => (
              <text key={k} x={lab[k]![0]} y={lab[k]![1]} textAnchor="middle" style={{ fontSize: 13, fill: "var(--text-primary)", pointerEvents: "none" }}>{k}</text>
            ))}
          </svg>
        </div>
      </div>
      <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--border)" }}>
        <p className="mb-1 text-sm font-medium" style={{ color: "var(--text-primary)" }}>Tooth position</p>
        {SLIDERS.map((s) => (
          <div key={s.k} className="my-1.5 grid grid-cols-[104px_minmax(0,1fr)_64px] items-center gap-2 text-[13px]">
            <label htmlFor={`${uid}-${s.k}`} style={{ color: "var(--text-secondary)" }}>{s.label}</label>
            <input id={`${uid}-${s.k}`} type="range" min={s.min} max={s.max} step={s.step} value={q[s.k]} disabled={!editable}
              className="w-full touch-pan-y" style={{ accentColor: "var(--border-accent)" }}
              onChange={(e) => onPosition(s.field, Number(e.target.value))} />
            <span className="text-right font-medium" style={{ color: "var(--text-primary)" }} data-testid={`out-${s.k}`}>{FMT[s.k](q[s.k])}</span>
          </div>
        ))}
        {editable && (
          <button type="button" onClick={onResetPosition}
            className="ta-btn mt-1.5 px-2.5 py-1.5 text-[13px]">Reset position</button>
        )}
      </div>
    </div>
  );
}
