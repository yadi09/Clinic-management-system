// The anatomical chart at work: the Adult/Child switch and the tools from the
// reference, the chart, the selected tooth's detail, and the saving behind them.
//
// Saving follows the simple chart's rules (DentalWorkspace): a debounced, optimistic
// record where the SERVER is the source of truth. Only teeth that changed are sent,
// each whole; a failed save puts the chart back to what the server last confirmed
// and says so in words; a change still waiting when the page closes is sent anyway.
// Sliders are debounced, so a drag is one save, not one per pixel.
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Maximize2, Redo2, Undo2 } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useIsLargeScreen } from "@/hooks/useMediaQuery";
import { toast } from "@/components/ui/sonner";
import { saveAnatomy, type SurfaceKey, type ToothAnatomy } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { AnatomicalChart, type ClinicMark } from "@/features/dental/anatomical/AnatomicalChart";
import { ToothDetail, type Tool } from "@/features/dental/anatomical/ToothDetail";
import { C, SETS, full, isEmpty, palmerOf, type Dentition } from "@/features/dental/anatomical/geometry";

type Map = Record<string, ToothAnatomy>;
interface Step { tooth: string; before: ToothAnatomy | undefined; after: ToothAnatomy | undefined; at: number; kind: string }

export const SAVE_DELAY_MS = 600;
const HISTORY = 30;

const normalise = (m: Map | undefined): Map => {
  const out: Map = {};
  for (const [k, v] of Object.entries(m ?? {})) if (!isEmpty(full(v))) out[k] = full(v);
  return out;
};

const TOOLS: { t: Tool; label: string; dot?: string; dashed?: boolean }[] = [
  { t: "caries", label: "Caries", dot: C.caries },
  { t: "filling", label: "Filling", dot: C.filling },
  { t: "crown", label: "Crown", dot: C.crown },
  { t: "rct", label: "Root canal", dot: C.rct },
  { t: "missing", label: "Missing", dashed: true },
  { t: "clear", label: "Clear" },
];

export function AnatomicalWorkspace({ patientId, server, editable, marks, onClearMark }: {
  patientId: string;
  /** The anatomy the server last sent (summary.chart.anatomy). */
  server: Map | undefined;
  editable: boolean;
  /** The simple chart's mark on a tooth, by Palmer code. */
  marks?: (palmer: string) => ClinicMark | null;
  /** Remove the simple chart's mark from a tooth. */
  onClearMark?: (palmer: string) => void;
}) {
  const qc = useQueryClient();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [mode, setMode] = useState<Dentition>("adult");
  const [sel, setSel] = useState<Record<Dentition, number>>({ adult: SETS.adult.sel, child: SETS.child.sel });
  const [tool, setTool] = useState<Tool>("caries");
  const [anatomy, setAnatomy] = useState<Map>(() => normalise(server));
  const [failed, setFailed] = useState<false | "undone" | "unconfirmed">(false);
  const [fullScreen, setFullScreen] = useState(false);
  const large = useIsLargeScreen();
  const [, tick] = useState(0);

  const draft = useRef<Map>(anatomy);
  const confirmed = useRef<Map>(normalise(server));
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentSeq = useRef(0);
  const ackSeq = useRef(0);
  const undoStack = useRef<Step[]>([]);
  const redoStack = useRef<Step[]>([]);

  const show = (m: Map) => { draft.current = m; setAnatomy(m); };
  const changesOf = (keys: Iterable<string>, from: Map) => {
    const out: Record<string, ToothAnatomy | null> = {};
    for (const k of keys) out[k] = from[k] ?? null;
    return out;
  };

  const save = useMutation({
    mutationFn: (v: { changes: Record<string, ToothAnatomy | null>; seq: number }) => saveAnatomy(patientId, v.changes),
    onSuccess: (res, v) => {
      if (v.seq < ackSeq.current) return; // a slower, older reply
      ackSeq.current = v.seq;
      confirmed.current = normalise(res.anatomy);
      if (timer.current === null && pending.current.size === 0) show(confirmed.current);
      qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
    },
    onError: (e) => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      pending.current.clear();
      show(confirmed.current);
      // No answer is not a refusal: the save may have landed (FE-3).
      setFailed(e instanceof AppError && e.code === "TIMEOUT" ? "unconfirmed" : "undone");
      toast.error(e instanceof AppError ? e.message : "Could not save the tooth chart — your last changes were undone");
      qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
    },
  });

  // Adopt the server's copy only when nothing of ours is outstanding: that is what
  // brings in a second clinician's work without overwriting a change still waiting.
  useEffect(() => {
    confirmed.current = normalise(server);
    if (pending.current.size === 0 && timer.current === null && !save.isPending) show(confirmed.current);
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = () => {
    timer.current = null;
    if (pending.current.size === 0) return;
    const changes = changesOf(pending.current, draft.current);
    pending.current = new Set();
    save.mutate({ changes, seq: ++sentSeq.current });
  };

  /** Put one tooth's new record on the chart, queue it, and remember how to undo it. */
  const write = (tooth: string, next: ToothAnatomy | undefined, kind: string, record = true) => {
    const before = draft.current[tooth];
    const after = next && !isEmpty(next) ? next : undefined;
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return;
    const map = { ...draft.current };
    if (after) map[tooth] = after; else delete map[tooth];
    setFailed(false);
    show(map);
    pending.current.add(tooth);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
    if (!record) return;
    // A slider drag is one step, not one per notch: the same tooth and control within
    // the save delay extends the step instead of adding another.
    const last = undoStack.current.at(-1), now = Date.now();
    if (last && last.tooth === tooth && last.kind === kind && kind.startsWith("pos:") && now - last.at < SAVE_DELAY_MS * 2) {
      last.after = after; last.at = now;
    } else {
      undoStack.current = [...undoStack.current, { tooth, before, after, at: now, kind }].slice(-HISTORY);
    }
    redoStack.current = [];
    tick((x) => x + 1);
  };

  const undo = () => {
    const s = undoStack.current.at(-1);
    if (!s) return;
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, s];
    write(s.tooth, s.before, s.kind, false);
    tick((x) => x + 1);
  };
  const redo = () => {
    const s = redoStack.current.at(-1);
    if (!s) return;
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, s];
    write(s.tooth, s.after, s.kind, false);
    tick((x) => x + 1);
  };

  // A change still waiting must not die with the page (as the simple chart).
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current.size) saveAnatomy(patientId, changesOf(pending.current, draft.current), { keepalive: true }).catch(() => {});
  }, [patientId]);
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (pending.current.size === 0) return;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      saveAnatomy(patientId, changesOf(pending.current, draft.current), { keepalive: true }).catch(() => {});
      pending.current = new Set();
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [patientId]);

  const n = sel[mode];
  const key = String(n);
  const cur = () => full(draft.current[key]);

  const pickTool = (t: Tool) => {
    setTool(t);
    if (!editable) return;
    const r = cur();
    if (t === "crown") write(key, { ...r, crown: !r.crown }, "crown");
    else if (t === "rct") write(key, { ...r, root_canal: !r.root_canal }, "rct");
    else if (t === "missing") write(key, { ...r, missing: !r.missing }, "missing");
    else if (t === "clear") write(key, undefined, "clear");
  };
  const onSurface = (s: SurfaceKey) => {
    if (tool !== "caries" && tool !== "filling") return;
    const r = cur();
    const surfaces = { ...r.surfaces };
    if (surfaces[s] === tool) delete surfaces[s]; else surfaces[s] = tool;
    write(key, { ...r, surfaces, missing: false }, `surf:${s}`);
  };
  const saving = save.isPending || pending.current.size > 0;
  const edited = undoStack.current.length > 0 || redoStack.current.length > 0;
  const palmer = palmerOf(n);
  const mark = palmer && marks ? marks(palmer) : null;

  const statusLine = editable && (
    failed ? (
      <span role="status" className="mr-1 text-xs font-medium text-destructive">
        {failed === "unconfirmed" ? "Not confirmed — reload to check what was saved" : "Not saved — changes undone"}
      </span>
    ) : edited && (
      <span role="status" className="mr-1 text-xs" style={{ color: "var(--text-secondary)" }}>{saving ? "Saving…" : "✓ Saved"}</span>
    )
  );

  const selectTooth = (t: number) => {
    setSel((s) => ({ ...s, [mode]: t }));
    // On a phone the page has no room for the chart AND the controls: picking a
    // tooth opens the full-screen editor, where both are on screen together.
    if (!fullScreen && editable && typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches) setFullScreen(true);
  };

  /** The editor. Rendered once — in the page, or in the full-screen view — so there is
   *  one record, one save and one undo history, whichever is showing. */
  const body = (where: "page" | "full") => {
    // Full screen on a wide screen: the chart takes exactly the room that is left, so
    // it always fits — no estimated header height to get wrong.
    const fill = where === "full" && large;
    return (
    <div className={`tooth-anatomy flex flex-col gap-3 ${where === "full" ? "ta-full h-full min-h-0" : ""}`} style={{ color: "var(--text-primary)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="ta-seg" role="radiogroup" aria-label="Dentition">
          {(["adult", "child"] as Dentition[]).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={mode === d} className={mode === d ? "on" : ""} onClick={() => setMode(d)}>
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

      {editable && (
        <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Chart tools">
          {TOOLS.map(({ t, label, dot, dashed }) => (
            <button key={t} type="button" className={`ta-btn ta-tool ${tool === t ? "on" : ""}`} aria-pressed={tool === t} onClick={() => pickTool(t)}>
              {dot && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: dot }} />}
              {dashed && <span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-dashed" style={{ borderColor: "var(--text-secondary)" }} />}
              {label}
            </button>
          ))}
        </div>
      )}

      {/* The chart and the selected tooth side by side on a wide screen, so moving a
          slider moves the tooth in plain sight. The chart's height is capped to what
          the screen can show; its width follows, in the reference's proportions. */}
      <div className={`grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] ${where === "full" ? "min-h-0 flex-1 max-lg:grid-rows-[auto_minmax(0,1fr)]" : ""}`}>
        <div className={`min-w-0 ${fill ? "flex min-h-0 flex-col" : ""} ${where === "full" ? "max-lg:sticky max-lg:top-0 max-lg:z-10" : ""}`}>
          <div className={`ta-chart-scroll rounded-xl px-1.5 py-2 ${fill ? "min-h-0 flex-1" : ""}`} style={{ background: "var(--surface-1)" }}>
            <AnatomicalChart dentition={mode} anatomy={anatomy} marks={marks} selected={n} onSelect={selectTooth}
              fill={fill} maxHeight={where === "full" ? undefined : "min(62dvh, 34rem)"} />
          </div>
          <p className={`mt-1.5 shrink-0 text-xs ${where === "full" ? "max-md:hidden" : ""}`} style={{ color: "var(--text-muted)" }}>
            {editable ? "Tap a tooth to select it. Caries and filling are marked on the surface diagram; crown, root canal and missing apply to the whole tooth." : "Tap a tooth to see its findings."}
          </p>
        </div>
        <div className={where === "full" ? "min-h-0 overflow-y-auto lg:pr-1" : ""}>
          <ToothDetail n={n} a={anatomy[key]} mark={mark} editable={editable} tool={tool} uid={uid}
            onSurface={onSurface}
            onPosition={(field, v) => write(key, { ...cur(), [field]: v }, `pos:${field}`)}
            onResetPosition={() => write(key, { ...cur(), rotation: 0, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 0 }, "reset")}
            onClearMark={editable && palmer && mark && onClearMark ? () => onClearMark(palmer) : undefined} />
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

