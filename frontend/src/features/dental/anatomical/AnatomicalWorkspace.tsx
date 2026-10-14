// The anatomical chart at work: Adult/Child, the arches, the message line, the
// selected tooth, and the "Treatment plan" and "Done today" lists — section 4 of
// dental-chart-reference_3d.html, with the saving behind it.
//
// Saving follows the simple chart's rules (DentalWorkspace): optimistic, and the
// SERVER is the source of truth. Only teeth that changed are sent (each tooth's full
// list of items); positions go separately, debounced so a slider drag is one save.
// When the server refuses — its rules are the chart's rules — the chart goes back to
// what the server holds and says why, in the server's own words. A change still
// waiting when the page closes is sent anyway.
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Redo2, Undo2 } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useIsLargeScreen } from "@/hooks/useMediaQuery";
import { toast } from "@/components/ui/sonner";
import { saveChartItems, savePositions, type Chart, type CrownMaterial, type FillMaterial, type ItemInput, type Position, type SurfaceKey } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { AnatomicalChart, type ClinicMark } from "@/features/dental/anatomical/AnatomicalChart";
import { ToothPanel } from "@/features/dental/anatomical/ToothPanel";
import { SETS, palmerOf, type Dentition } from "@/features/dental/anatomical/geometry";
import {
  NO_POS, changedTeeth, completeAction, confirmNote, fromItems, planAndDone, posEmpty, surfaceAction, toItems, toolAction, tryBridge,
  type ChartState, type Ctx, type Outcome, type Status, type Tool,
} from "@/features/dental/anatomical/model";

type Positions = Record<string, Position>;
interface Snap { chart: ChartState; positions: Positions }
interface Step { before: Snap; after: Snap; at: number; key: string }

export const SAVE_DELAY_MS = 400;
export const SLIDER_DELAY_MS = 600;
const HISTORY = 40;

const cleanPositions = (p: Positions | undefined): Positions => {
  const out: Positions = {};
  for (const [k, v] of Object.entries(p ?? {})) if (!posEmpty(v)) out[k] = { ...NO_POS, ...v };
  return out;
};

export function AnatomicalWorkspace({ patientId, server, editable, today, marks, onClearMark }: {
  patientId: string;
  /** The chart the server last sent (summary.chart). */
  server: Chart | undefined;
  editable: boolean;
  /** The clinic day, YYYY-MM-DD. */
  today: string;
  /** The simple chart's mark on a tooth, by Palmer code. */
  marks?: (palmer: string) => ClinicMark | null;
  /** Remove the simple chart's mark from a tooth. */
  onClearMark?: (palmer: string) => void;
}) {
  const qc = useQueryClient();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const large = useIsLargeScreen();
  const [mode, setMode] = useState<Dentition>("adult");
  const [sel, setSel] = useState<Record<Dentition, number>>({ adult: SETS.adult.sel, child: SETS.child.sel });
  const [tool, setTool] = useState<Tool>("caries");
  const [stat, setStat] = useState<Status>("existing");
  const [fillMat, setFillMat] = useState<FillMaterial>("composite");
  const [crownMat, setCrownMat] = useState<CrownMaterial>("zirconia");
  const [bridgeStart, setBridgeStart] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean }>({ text: "" });
  const [failed, setFailed] = useState<false | "undone" | "unconfirmed">(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [chart, setChart] = useState<ChartState>(() => fromItems(server?.items));
  const [positions, setPositions] = useState<Positions>(() => cleanPositions(server?.positions));
  const [, tick] = useState(0);

  const draft = useRef<Snap>({ chart, positions });
  const confirmed = useRef<Snap>({ chart: fromItems(server?.items), positions: cleanPositions(server?.positions) });
  const pendingTeeth = useRef<Set<number>>(new Set());
  const pendingPos = useRef<Set<string>>(new Set());
  const noteClears = useRef<Map<number, Set<string>>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentSeq = useRef(0);
  const ackSeq = useRef(0);
  const undoStack = useRef<Step[]>([]);
  const redoStack = useRef<Step[]>([]);

  const show = (s: Snap) => { draft.current = s; setChart(s.chart); setPositions(s.positions); };
  const say = (text: string, err?: boolean) => setMsg({ text, err });
  const anyPending = () => pendingTeeth.current.size > 0 || pendingPos.current.size > 0;

  /** What is waiting, as the two requests the server takes. */
  const takePending = () => {
    const teeth: Record<string, ItemInput[]> = {};
    for (const n of pendingTeeth.current) {
      const clear = noteClears.current.get(n);
      teeth[String(n)] = toItems(draft.current.chart, n).map((i) => (clear?.has(`${i.kind}|${i.surface ?? ""}`) ? { ...i, note: "" } : i));
    }
    const pos: Record<string, Position | null> = {};
    for (const k of pendingPos.current) pos[k] = draft.current.positions[k] ?? null;
    pendingTeeth.current = new Set();
    pendingPos.current = new Set();
    noteClears.current = new Map();
    return { teeth, pos };
  };

  const save = useMutation({
    mutationFn: async (v: { teeth: Record<string, ItemInput[]>; pos: Record<string, Position | null>; seq: number }) => {
      let res: Chart | undefined;
      if (Object.keys(v.teeth).length) res = await saveChartItems(patientId, v.teeth);
      if (Object.keys(v.pos).length) res = await savePositions(patientId, v.pos);
      return res!;
    },
    onSuccess: (res, v) => {
      if (v.seq < ackSeq.current) return; // a slower, older reply
      ackSeq.current = v.seq;
      confirmed.current = { chart: fromItems(res.items), positions: cleanPositions(res.positions) };
      if (timer.current === null && !anyPending()) show(confirmed.current);
      qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
    },
    onError: (e) => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      pendingTeeth.current = new Set(); pendingPos.current = new Set(); noteClears.current = new Map();
      show(confirmed.current);
      const refused = e instanceof AppError && e.status === 400;
      // A refusal is the chart's own rule, said by the server: show it where the chart
      // speaks. No answer is not a refusal: the save may have landed (FE-3).
      if (refused) { say(e.message, true); setFailed("undone"); }
      else {
        setFailed(e instanceof AppError && e.code === "TIMEOUT" ? "unconfirmed" : "undone");
        toast.error(e instanceof AppError ? e.message : "Could not save the tooth chart — your last changes were undone");
      }
      qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
    },
  });

  // Adopt the server's copy only when nothing of ours is outstanding.
  useEffect(() => {
    confirmed.current = { chart: fromItems(server?.items), positions: cleanPositions(server?.positions) };
    if (!anyPending() && timer.current === null && !save.isPending) show(confirmed.current);
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = () => {
    timer.current = null;
    if (!anyPending()) return;
    save.mutate({ ...takePending(), seq: ++sentSeq.current });
  };

  /** Put a new chart/positions on screen, queue what changed, remember how to undo it. */
  const commit = (next: Snap, key: string, record = true) => {
    const before = draft.current;
    const teeth = changedTeeth(before.chart, next.chart);
    const posKeys = [...new Set([...Object.keys(before.positions), ...Object.keys(next.positions)])]
      .filter((k) => JSON.stringify(before.positions[k] ?? null) !== JSON.stringify(next.positions[k] ?? null));
    const notesChanged = JSON.stringify(before.chart.teeth) !== JSON.stringify(next.chart.teeth) && teeth.length === 0;
    if (!teeth.length && !posKeys.length && !notesChanged) return;
    setFailed(false);
    show(next);
    teeth.forEach((n) => pendingTeeth.current.add(n));
    posKeys.forEach((k) => pendingPos.current.add(k));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, key.startsWith("pos:") ? SLIDER_DELAY_MS : SAVE_DELAY_MS);
    if (!record) return;
    // A slider drag is one step, not one per notch.
    const last = undoStack.current.at(-1), now = Date.now();
    if (last && last.key === key && key.startsWith("pos:") && now - last.at < SLIDER_DELAY_MS * 2) { last.after = next; last.at = now; }
    else undoStack.current = [...undoStack.current, { before, after: next, at: now, key }].slice(-HISTORY);
    redoStack.current = [];
    tick((x) => x + 1);
  };

  const undo = () => {
    const s = undoStack.current.at(-1);
    if (!s) return;
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, s];
    commit(s.before, s.key, false);
    say("");
    tick((x) => x + 1);
  };
  const redo = () => {
    const s = redoStack.current.at(-1);
    if (!s) return;
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, s];
    commit(s.after, s.key, false);
    say("");
    tick((x) => x + 1);
  };

  // A change still waiting must not die with the page.
  const sendNow = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!anyPending()) return;
    const { teeth, pos } = takePending();
    if (Object.keys(teeth).length) saveChartItems(patientId, teeth, { keepalive: true }).catch(() => {});
    if (Object.keys(pos).length) savePositions(patientId, pos, { keepalive: true }).catch(() => {});
  };
  useEffect(() => () => sendNow(), [patientId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!anyPending()) return;
      sendNow();
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [patientId]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = sel[mode];
  const ctx = (over: Partial<Ctx> = {}): Ctx => ({ sel: n, tool, stat, fillMat, crownMat, dentition: mode, ...over });
  const apply = (o: Outcome, key: string) => {
    if (!o.err && o.state !== draft.current.chart) commit({ ...draft.current, chart: o.state }, key);
    say(o.msg, o.err);
  };

  const selectTooth = (t: number) => {
    if (bridgeStart != null && editable) {
      const o = tryBridge(draft.current.chart, bridgeStart, t, ctx());
      apply(o, "bridge");
      setBridgeStart(null);
    } else say("");
    setSel((s) => ({ ...s, [mode]: t }));
    // On a phone the page has no room for the chart AND the controls.
    if (!fullScreen && editable && typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches) setFullScreen(true);
  };
  const pickTool = (t: Tool) => {
    setTool(t);
    setBridgeStart(null);
    const o = toolAction(draft.current.chart, ctx({ tool: t }));
    if (o.bridgeStart != null) setBridgeStart(o.bridgeStart);
    apply(o, `tool:${t}`);
  };
  const pickMode = (d: Dentition) => {
    setMode(d);
    setBridgeStart(null);
    say("");
    if (d === "child" && (tool === "implant" || tool === "bridge")) setTool("caries");
  };
  const onPosition = (field: keyof Position, v: number) => {
    const k = String(n), cur = { ...NO_POS, ...draft.current.positions[k], [field]: v };
    const next = { ...draft.current.positions };
    if (posEmpty(cur)) delete next[k]; else next[k] = cur;
    commit({ ...draft.current, positions: next }, `pos:${n}:${field}`);
  };
  const onConfirmNote = (key: string) => {
    const set = noteClears.current.get(n) ?? new Set<string>();
    set.add(key);
    noteClears.current.set(n, set);
    pendingTeeth.current.add(n);
    commit({ ...draft.current, chart: confirmNote(draft.current.chart, n, key) }, "note");
    if (!timer.current) timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };

  const saving = save.isPending || anyPending();
  const edited = undoStack.current.length > 0 || redoStack.current.length > 0;
  const palmer = palmerOf(n);
  const mark = palmer && marks ? marks(palmer) : null;
  const lists = planAndDone(chart, today, mode);

  const statusLine = editable && (
    failed ? (
      <span role="status" className="mr-1 text-xs font-medium text-destructive">
        {failed === "unconfirmed" ? "Not confirmed — reload to check what was saved" : "Not saved — changes undone"}
      </span>
    ) : edited && (
      <span role="status" className="mr-1 text-xs" style={{ color: "var(--text-secondary)" }}>{saving ? "Saving…" : "✓ Saved"}</span>
    )
  );

  /** The editor. Rendered once — in the page, or in the full-screen view. */
  const body = (where: "page" | "full") => {
    const fill = where === "full" && large;
    return (
      <div className={`tooth-anatomy flex flex-col gap-3 ${where === "full" ? "ta-full h-full min-h-0" : ""}`} style={{ color: "var(--text-primary)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="ta-seg" role="radiogroup" aria-label="Dentition">
            {(["adult", "child"] as Dentition[]).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={mode === d} className={mode === d ? "on" : ""} onClick={() => pickMode(d)}>
                {SETS[d].label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {statusLine}
            {editable && (<>
              <button type="button" className="ta-btn px-2 py-1" aria-label="Undo" disabled={undoStack.current.length === 0} onClick={undo}><Undo2 className="h-4 w-4" /></button>
              <button type="button" className="ta-btn px-2 py-1" aria-label="Redo" disabled={redoStack.current.length === 0} onClick={redo}><Redo2 className="h-4 w-4" /></button>
            </>)}
            {where === "page" && (
              <button type="button" className="ta-btn flex items-center gap-1.5 px-2.5 py-1 text-[13px]" onClick={() => setFullScreen(true)}>
                <Maximize2 className="h-4 w-4" /> Full screen
              </button>
            )}
          </div>
        </div>

        <div className={`grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] ${where === "full" ? "min-h-0 flex-1 max-lg:grid-rows-[auto_minmax(0,1fr)]" : ""}`}>
          {/* The chart stays in view while the controls beside it scroll: moving a
              slider far down the panel still moves a tooth you can see. */}
          <div className={`min-w-0 ${fill ? "flex min-h-0 flex-col" : ""} ${where === "full" ? "max-lg:sticky max-lg:top-0 max-lg:z-10" : "lg:sticky lg:top-20 lg:self-start"}`}>
            <div className={`ta-chart-scroll rounded-xl px-1.5 py-2 ${fill ? "min-h-0 flex-1" : ""}`} style={{ background: "var(--surface-1)" }}>
              <AnatomicalChart dentition={mode} state={chart} positions={positions} today={today} marks={marks} selected={n} onSelect={selectTooth}
                fill={fill} maxHeight={where === "full" ? undefined : "min(62dvh, 34rem)"} />
            </div>
            <p className={`mt-1.5 shrink-0 text-xs ${where === "full" ? "max-md:hidden" : ""}`} style={{ color: "var(--text-muted)" }}>
              Tap a tooth to select it. Rows from top: upper side view, upper top view, lower top view, lower side view.
            </p>
            <p role="status" aria-live="polite" className="min-h-[1.25rem] shrink-0 text-[13px]" style={{ color: msg.err ? "var(--text-danger)" : "var(--text-accent)" }}>{msg.text}</p>
          </div>
          <div className={`space-y-3 ${where === "full" ? "min-h-0 overflow-y-auto lg:pr-1" : ""}`}>
            <ToothPanel n={n} state={chart} position={positions[String(n)]} today={today} uid={uid} editable={editable}
              tool={tool} stat={stat} fillMat={fillMat} crownMat={crownMat} mark={mark}
              onStat={setStat} onTool={pickTool} onFillMat={setFillMat} onCrownMat={setCrownMat}
              onSurface={(k: SurfaceKey) => apply(surfaceAction(draft.current.chart, ctx(), k), `surf:${n}:${k}`)}
              onComplete={() => apply(completeAction(draft.current.chart, n), `complete:${n}`)}
              onPosition={onPosition}
              onResetPosition={() => { const next = { ...draft.current.positions }; delete next[String(n)]; commit({ ...draft.current, positions: next }, `reset:${n}`); }}
              onClearMark={editable && palmer && mark && onClearMark ? () => onClearMark(palmer) : undefined}
              onConfirmNote={editable ? onConfirmNote : undefined} />
            <div className="grid gap-3 sm:grid-cols-2">
              <section aria-label="Treatment plan" className="rounded-xl p-3" style={{ background: "var(--surface-1)" }}>
                <p className="mb-1.5 text-sm font-medium" style={{ color: "var(--text-danger)" }}>Treatment plan (to be done)</p>
                <div className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {lists.plan.length ? lists.plan.map((l) => <div key={l}>{l}</div>) : <div style={{ color: "var(--text-muted)" }}>No planned treatment</div>}
                </div>
              </section>
              <section aria-label="Done today" className="rounded-xl p-3" style={{ background: "var(--surface-1)" }}>
                <p className="mb-1.5 text-sm font-medium" style={{ color: "var(--text-success)" }}>Done today</p>
                <div className="text-[13px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  {lists.done.length ? lists.done.map((l) => <div key={l}>{l}</div>) : <div style={{ color: "var(--text-muted)" }}>Nothing yet</div>}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {fullScreen ? (
        <div className="tooth-anatomy rounded-xl border p-4 text-sm" style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}>
          The tooth chart is open in full screen.{" "}
          <button type="button" className="font-medium underline" style={{ color: "var(--text-accent)" }} onClick={() => setFullScreen(true)}>Show it</button>
        </div>
      ) : body("page")}
      <Dialog open={fullScreen} onOpenChange={setFullScreen}>
        <DialogContent fullOnMobile aria-describedby={undefined}
          className="flex flex-col gap-3 overflow-hidden p-3 sm:inset-0 sm:left-0 sm:top-0 sm:h-[100dvh] sm:max-h-[100dvh] sm:w-screen sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-none sm:p-5">
          <DialogTitle className="pr-10 text-base">Tooth chart</DialogTitle>
          <div className="min-h-0 flex-1">{body("full")}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}
