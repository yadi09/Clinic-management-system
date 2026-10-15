// The selected tooth (the reference's control panel): its name and everything
// recorded on it in words; "Record as"; the tools; materials; surfaces; "Mark this
// tooth's planned work as done"; the position sliders — each with the help line the
// reference gives under it.
import type { BraceMaterial, CrownMaterial, FillMaterial, Position, SurfaceKey } from "@/features/dental/api";
import { FMT, SLIDERS, isUp, toothName } from "@/features/dental/anatomical/geometry";
import { ToothSide, ToothTop } from "@/features/dental/anatomical/Tooth";
import { SURFACES, SL, bracesOf, hasBracket, items, toothOf, toothState, type ChartState, type Status, type Tool } from "@/features/dental/anatomical/model";
import type { ClinicMark } from "@/features/dental/anatomical/AnatomicalChart";

export const STATHELP: Record<Status, string> = {
  existing: "Already in mouth: things the patient already has when they arrive, like an old filling or a missing tooth. Shown in natural colors.",
  planned: "To be done: treatment the dentist recommends. Shown in red on the tooth and added to the treatment plan (the patient's quote).",
  done: "Done today: treatment finished in this visit. The tooth number turns green and it goes to today's list (the invoice).",
};
export const TOOLHELP: Record<Tool, string> = {
  caries: "Caries: tooth decay (a cavity). Tap the surface where the decay is. It shows as a dark brown spot.",
  filling: "Filling: decay removed and the hole filled. Pick the material, then tap the surface. Composite is tooth-colored (shown with a blue outline), amalgam is silver.",
  crown: "Crown: a cap that covers the whole visible part of the tooth. Pick the material.",
  rct: "Root canal: the nerve inside the root is cleaned and sealed. Shown inside the root (orange when done, red when planned).",
  extract: 'Extraction: pulling the tooth out. Use "To be done" to plan it (tooth turns red) or "Done today" if it was removed in this visit.',
  missing: "Missing: the tooth is not in the mouth (lost or removed in the past). Tap again to bring it back.",
  implant: "Implant: a titanium screw placed in the jaw bone to replace a missing tooth, with a crown on top. Only works on a tooth marked Missing.",
  bridge: "Bridge: fake teeth that fill a gap, held in place by crowns on the healthy teeth at both ends. Select one end tooth, tap Bridge, then tap the other end tooth. The teeth in between must be marked Missing.",
  braces: "Braces: brackets glued to the teeth and joined by a wire, to move the teeth into place. Select the first tooth, tap Braces, then tap the last tooth — or tap Whole arch. A missing tooth in between simply gets no bracket. Tap Braces on a braced tooth to remove them.",
  clear: "Clear tooth: removes everything recorded on the selected tooth, including any bridge it belongs to. Braces stay: they belong to the whole jaw.",
};
const TOOLS: [Tool, string][] = [["caries", "Caries"], ["filling", "Filling"], ["crown", "Crown"], ["rct", "Root canal"], ["extract", "Extraction"], ["missing", "Missing"], ["implant", "Implant"], ["bridge", "Bridge"], ["braces", "Braces"], ["clear", "Clear tooth"]];
const STATS: [Status, string][] = [["existing", "Already in mouth"], ["planned", "To be done"], ["done", "Done today"]];
const SURF_LABEL: Record<SurfaceKey, string> = { O: "Top (occlusal)", M: "Front side (mesial)", D: "Back side (distal)", B: "Cheek side (buccal)", L: "Tongue side (lingual)" };
export const MATS = {
  filling: [["composite", "Composite (tooth-colored)"], ["amalgam", "Amalgam (silver)"]] as [FillMaterial, string][],
  crown: [["zirconia", "Zirconia"], ["pfm", "Porcelain-metal"], ["gold", "Gold"], ["steel", "Stainless steel"]] as [CrownMaterial, string][],
  braces: [["metal", "Metal (silver brackets)"], ["ceramic", "Ceramic (tooth-colored brackets)"]] as [BraceMaterial, string][],
};
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function ToothPanel(props: {
  n: number; state: ChartState; position?: Position; today: string; uid: string; editable: boolean;
  tool: Tool; stat: Status; fillMat: FillMaterial; crownMat: CrownMaterial; braceMat: BraceMaterial;
  mark?: ClinicMark | null;
  onStat: (s: Status) => void; onTool: (t: Tool) => void; onFillMat: (m: FillMaterial) => void; onCrownMat: (m: CrownMaterial) => void;
  onBraceMat: (m: BraceMaterial) => void;
  /** Braces on the selected tooth's whole jaw (offered while the Braces tool is on). */
  onWholeArch: () => void;
  onSurface: (k: SurfaceKey) => void; onComplete: () => void;
  onPosition: (field: keyof Position, v: number) => void; onResetPosition: () => void;
  onClearMark?: () => void; onConfirmNote?: (key: string) => void;
}) {
  const { n, state, position, today, uid, editable, tool, stat, fillMat, crownMat, braceMat, mark } = props;
  const it = items(state, n, today), d = toothOf(state, n), S = toothState(state, n);
  const bracket = hasBracket(state, n) ? { m: bracesOf(state, n)!.b.m, planned: bracesOf(state, n)!.b.s === "planned" } : null;
  const words = it.map((i) => `${i.t} (${i.on && i.on !== today && i.s === "existing" ? `done ${day(i.on)}` : SL[i.s]})`);
  const q = position;
  if (q?.rotation) words.push(`rotated ${Math.abs(q.rotation)}° ${q.rotation > 0 ? "clockwise" : "counterclockwise"}`);
  if (q?.tipping) words.push(`tipped ${Math.abs(q.tipping)}° ${q.tipping > 0 ? "mesially" : "distally"}`);
  if (q?.buccal_lingual) words.push(`${Math.abs(q.buccal_lingual)}mm ${q.buccal_lingual > 0 ? "buccal" : "lingual"}`);
  if (q?.vertical) words.push(`${Math.abs(q.vertical)}mm ${q.vertical > 0 ? "extruded" : "intruded"}`);
  if (q?.gap_mesial) words.push(`${q.gap_mesial}mm gap on mesial side`);
  const mk = tool === "filling" ? "filling" : tool === "crown" || tool === "implant" || tool === "bridge" ? "crown" : tool === "braces" ? "braces" : null;
  const notes = Object.entries(d.notes ?? {});
  const sliderVal = { rot: q?.rotation ?? 0, tilt: q?.tipping ?? 0, bl: q?.buccal_lingual ?? 0, vert: q?.vertical ?? 0, gap: q?.gap_mesial ?? 0 };
  const btn = (on: boolean) => `ta-btn ta-tool ${on ? "on" : ""}`;

  return (
    <div className="rounded-xl border p-3" style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
      <div className="flex items-start gap-3">
        <div className="flex shrink-0 flex-col items-center gap-1" aria-hidden>
          <svg viewBox="-12 -8 64 116" width={52} height={104}>
            {isUp(n) ? <ToothSide n={n} S={S} p={q} clipId={`${uid}bigs`} bracket={bracket} />
              : <g transform="translate(0,100) scale(1,-1)"><ToothSide n={n} S={S} p={q} clipId={`${uid}bigs`} bracket={bracket} /></g>}
          </svg>
          <svg viewBox="-8 -8 56 56" width={46} height={46}><ToothTop n={n} S={S} p={q} clipId={`${uid}bigt`} bracket={bracket} /></svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-0.5 text-[15px] font-medium" style={{ color: "var(--text-primary)" }}>Tooth {n}: {toothName(n)}</p>
          <p data-testid="tooth-info" className="text-[13px] leading-normal" style={{ color: "var(--text-secondary)" }}>
            {words.length ? words.map((s) => s[0].toUpperCase() + s.slice(1)).join(" · ") : "Healthy"}
          </p>
          {mark && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: mark.color }} />
              Marked on the simple chart: <b className="font-medium" style={{ color: "var(--text-primary)" }}>{mark.label}</b>
              {props.onClearMark && <button type="button" className="ml-1 underline" style={{ color: "var(--text-accent)" }} onClick={props.onClearMark}>Remove mark</button>}
            </p>
          )}
          {notes.map(([key, note]) => (
            <p key={key} role="note" className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]" style={{ color: "var(--text-warning)" }}>
              ⚠ {note}
              {editable && props.onConfirmNote && (
                <button type="button" className="underline" style={{ color: "var(--text-accent)" }} onClick={() => props.onConfirmNote!(key)}>It is right</button>
              )}
            </p>
          ))}
        </div>
      </div>

      {editable && (<div className="mt-3 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Record as">
          <span className="ta-cap">Record as</span>
          {STATS.map(([s, l]) => (
            <button key={s} type="button" role="radio" aria-checked={stat === s} className={btn(stat === s)} onClick={() => props.onStat(s)}>{l}</button>
          ))}
        </div>
        <p className="ta-help">{STATHELP[stat]}</p>

        <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Add">
          <span className="ta-cap">Add</span>
          {TOOLS.map(([t, l]) => (
            <button key={t} type="button" aria-pressed={tool === t} className={btn(tool === t)} onClick={() => props.onTool(t)}>{l}</button>
          ))}
        </div>
        <p className="ta-help">{TOOLHELP[tool]}</p>

        {mk && (
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Material">
            <span className="ta-cap">Material</span>
            {mk === "filling"
              ? MATS.filling.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={fillMat === k} className={btn(fillMat === k)} onClick={() => props.onFillMat(k)}>{l}</button>)
              : mk === "braces"
                ? MATS.braces.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={braceMat === k} className={btn(braceMat === k)} onClick={() => props.onBraceMat(k)}>{l}</button>)
                : MATS.crown.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={crownMat === k} className={btn(crownMat === k)} onClick={() => props.onCrownMat(k)}>{l}</button>)}
          </div>
        )}
        {tool === "braces" && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="ta-cap" />
            <button type="button" className={btn(false)} onClick={props.onWholeArch}>Whole arch</button>
          </div>
        )}
        {(tool === "caries" || tool === "filling") && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Surface">
            <span className="ta-cap">Surface</span>
            {SURFACES.map((k) => (
              <button key={k} type="button" aria-pressed={!!d.surf[k]} className={btn(!!d.surf[k])} onClick={() => props.onSurface(k)}>{SURF_LABEL[k]}</button>
            ))}
          </div>
        )}
        {it.some((i) => i.s === "planned") && (
          <button type="button" className="ta-btn ta-tool mt-1" onClick={props.onComplete}>Mark this tooth's planned work as done</button>
        )}
      </div>)}

      <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--border)" }}>
        <p className="mb-1 text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>Tooth position</p>
        {SLIDERS.map((s) => (
          <div key={s.k} className="my-1.5 grid grid-cols-[104px_minmax(0,1fr)_64px] items-center gap-2 text-[13px]">
            <label htmlFor={`${uid}-${s.k}`} style={{ color: "var(--text-secondary)" }}>{s.label}</label>
            <input id={`${uid}-${s.k}`} type="range" min={s.min} max={s.max} step={s.step} value={sliderVal[s.k]} disabled={!editable}
              className="w-full touch-pan-y" style={{ accentColor: "var(--border-accent)" }}
              onChange={(e) => props.onPosition(s.field, Number(e.target.value))} />
            <span className="text-right font-medium" style={{ color: "var(--text-primary)" }} data-testid={`out-${s.k}`}>{FMT[s.k](sliderVal[s.k])}</span>
          </div>
        ))}
        {editable && <button type="button" onClick={props.onResetPosition} className="ta-btn mt-1.5 px-2.5 py-1.5 text-[13px]">Reset position</button>}
      </div>
    </div>
  );
}
