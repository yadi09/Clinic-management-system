// "My teeth": the patient's own mouth as a 2D chart or a 3D model they can turn, open and
// look into. Three separate views — today, planned, done — each showing only its own
// work. The page is read-only; tapping a tooth only explains it.
import { Suspense, useMemo, useState } from "react";

import { lazyWithReload } from "@/app/chunkRecovery";
import { AnatomicalChart } from "@/features/dental/anatomical/AnatomicalChart";
import { toothName } from "@/features/dental/anatomical/geometry";
import { fromItems, items as toothItems } from "@/features/dental/anatomical/model";
import type { View3D } from "@/features/dental/anatomical/three/Dental3D";
import type { PortalMe } from "@/features/portal/api";
import { countFor, itemsFor, teethWith, type Look } from "@/features/portal/teethView";
import type { Lang, T } from "@/features/portal/text";

const Dental3D = lazyWithReload(() => import("@/features/dental/anatomical/three/Dental3D"));
type Words = (typeof T)[Lang];

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00+03:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Addis_Ababa" });
const VIEWS: [Exclude<View3D, "custom">, keyof Words][] = [["front", "vFront"], ["open", "vOpen"], ["upper", "vUpper"], ["lower", "vLower"], ["side", "vSide"]];

function Seg<K extends string>({ value, options, onChange, label }: { value: K; options: { k: K; label: string }[]; onChange: (k: K) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="grid auto-cols-fr grid-flow-col overflow-hidden rounded-xl border border-[#dbe5ee] bg-white text-[13px] md:text-sm">
      {options.map((o) => (
        <button key={o.k} type="button" aria-pressed={value === o.k} onClick={() => onChange(o.k)}
          className={`px-2.5 py-2 text-center md:px-4 ${value === o.k ? "bg-[#E6F1FB] font-bold text-[#1F4E79]" : "text-[#617085] hover:bg-[#F2F7FB]"}`}>{o.label}</button>
      ))}
    </div>
  );
}

export function PortalTeeth({ me, t }: { me: PortalMe; t: Words }) {
  const rows = useMemo(() => me.chart?.items ?? [], [me.chart]);
  const positions = me.chart?.positions ?? {};
  const [look, setLook] = useState<Look>("now");
  const [dim, setDim] = useState<"2d" | "3d">("2d");
  const [n, setN] = useState(0);
  const [view, setView] = useState<View3D>("front");
  const [preset, setPreset] = useState<Exclude<View3D, "custom">>("front");
  const [recenter, setRecenter] = useState(0);
  const [roots, setRoots] = useState(false);
  const [nums, setNums] = useState(true);

  const shown = useMemo(() => itemsFor(rows, look), [rows, look]);
  const state = useMemo(() => fromItems(shown), [shown]);
  const withWork = useMemo(() => teethWith(shown.filter((i) => i.kind !== "missing")), [shown]);
  const child = rows.some((i) => i.tooth >= 50) && !rows.some((i) => i.tooth < 50);
  const mode = child ? "child" : "adult";
  const show3d = me.settings.show_3d;

  const LOOKS: { k: Look; label: string; help: string; empty: string }[] = [
    { k: "now", label: t.lookNow, help: t.lookNowHelp, empty: t.emptyNow },
    { k: "planned", label: t.lookPlanned, help: t.lookPlannedHelp, empty: t.emptyPlanned },
    { k: "done", label: t.lookDone, help: t.lookDoneHelp, empty: t.emptyDone },
  ];
  const cur = LOOKS.find((l) => l.k === look)!;

  // Work the clinic did carries its date, even once it has become part of the mouth.
  const badge = (s: string, on?: string) => (s === "planned" ? t.badgePlanned : on || s === "done" ? `${t.badgeDone}${on ? ` · ${day(on)}` : ""}` : t.badgeNow);
  const tone = (s: string, on?: string) => (s === "planned" ? "bg-[#FCEBEB] text-[#A32D2D]" : on || s === "done" ? "bg-[#EAF3DE] text-[#3B6D11]" : "bg-[#E6F1FB] text-[#185FA5]");
  const lines = (tooth: number) => toothItems(state, tooth, me.today);

  return (
    <div className="tooth-anatomy grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2 md:gap-3">
          <Seg value={look} label={cur.label} onChange={(k) => { setLook(k); setN(0); }}
            options={LOOKS.map((l) => ({ k: l.k, label: `${l.label}${l.k === "now" ? "" : ` (${countFor(rows, l.k)})`}` }))} />
          {show3d && <Seg value={dim} label="2D / 3D" onChange={setDim} options={[{ k: "2d", label: "2D" }, { k: "3d", label: "3D 🦷" }]} />}
        </div>
        <p className="mb-3 text-[13px] text-[#617085] md:text-sm">{cur.help}</p>

        {dim === "3d" && show3d && (
          <div role="toolbar" aria-label="3D" className="mb-3 flex flex-wrap gap-1.5">
            {VIEWS.map(([v, k]) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); setPreset(v); setRecenter((x) => x + 1); }}
                className={`rounded-lg border px-3 py-1.5 text-[13px] ${view === v ? "border-[#148F77] bg-[#F0FAF7] font-bold text-[#0f6e5b]" : "border-[#dbe5ee] bg-white text-[#617085] hover:bg-[#F2F7FB]"}`}>{t[k]}</button>
            ))}
            <button type="button" disabled={view !== "custom"} onClick={() => { setView(preset); setRecenter((x) => x + 1); }}
              className="rounded-lg border border-[#dbe5ee] bg-white px-3 py-1.5 text-[13px] text-[#617085] disabled:opacity-40">{t.recenter}</button>
            <button type="button" aria-pressed={roots} onClick={() => setRoots((x) => !x)} className={`rounded-lg border px-3 py-1.5 text-[13px] ${roots ? "border-[#148F77] bg-[#F0FAF7] font-bold text-[#0f6e5b]" : "border-[#dbe5ee] bg-white text-[#617085]"}`}>{t.roots}</button>
            <button type="button" aria-pressed={nums} onClick={() => setNums((x) => !x)} className={`rounded-lg border px-3 py-1.5 text-[13px] ${nums ? "border-[#148F77] bg-[#F0FAF7] font-bold text-[#0f6e5b]" : "border-[#dbe5ee] bg-white text-[#617085]"}`}>{t.numbers}</button>
          </div>
        )}

        <div data-no-swipe className="rounded-2xl bg-white p-2 ring-1 ring-[#dbe5ee] md:p-3">
          {dim === "2d" || !show3d ? (
            <div className="ta-chart-scroll"><AnatomicalChart dentition={mode} state={state} positions={positions} today={me.today} selected={n} onSelect={setN} maxHeight="min(70dvh, 38rem)" /></div>
          ) : (
            <Suspense fallback={<p className="p-8 text-center text-sm text-[#617085]">{t.loading3d}</p>}>
              <Dental3D state={state} positions={positions} sel={n} today={me.today} mode={mode} xray={roots} nums={nums} view={view} recenterToken={recenter}
                onSelect={setN} onCustomView={() => setView("custom")} height="clamp(320px, 56dvh, 620px)" />
            </Suspense>
          )}
        </div>
        {dim === "3d" && <p className="mt-2 text-xs text-[#617085]">{t.rotateHint}</p>}
        {withWork.length === 0 && <p className="mt-3 rounded-xl bg-white p-3 text-sm text-[#617085]" role="status">{cur.empty}</p>}
      </div>

      <aside className="min-w-0 space-y-4">
        <div className="rounded-2xl bg-white p-4 shadow-sm" aria-live="polite">
          <h3 className="mb-2 text-[12.5px] font-semibold text-[#617085]">{t.selectedTooth}</h3>
          {n === 0 ? <><b className="block">{t.tapTooth}</b><span className="text-sm text-[#617085]">{t.tapHelp}</span></> : (
            <>
              <b className="block">{t.tooth} {n} · {toothName(n)}</b>
              {lines(n).length ? (
                <ul className="mt-2 space-y-1.5">
                  {lines(n).map((l) => (
                    <li key={l.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">{l.t}
                      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${tone(l.s, l.on)}`}>{badge(l.s, l.on)}</span></li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-sm text-[#617085]">{t.nothingOnTooth}</p>}
            </>
          )}
        </div>
        {withWork.length > 0 && (
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <h3 className="mb-2 text-[12.5px] font-semibold text-[#617085]">{t.inThisView}</h3>
            <ul className="divide-y divide-dashed divide-[#dbe5ee]">
              {withWork.map((tooth) => (
                <li key={tooth}>
                  <button type="button" onClick={() => setN(tooth)} aria-pressed={n === tooth}
                    className={`flex w-full items-start justify-between gap-3 py-2 text-left text-sm ${n === tooth ? "font-bold text-[#1F4E79]" : ""}`}>
                    <span className="shrink-0">{t.tooth} {tooth}</span>
                    <span className="text-right text-[#617085]">{lines(tooth).map((l) => l.t).join(", ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
