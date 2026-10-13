// The tooth chart (Palmer notation: four quadrants of eight).
//
// It used to be thirty-two buttons that each cycled through the clinic's conditions
// on every tap: five taps to reach "Crown", one too many to go round again, no way to
// mark several teeth, no way to clear. It is now two ways in, sharing one bar:
//
//   Mark    pick a condition, then tap or drag across teeth — each takes it.
//           Pick nothing and a tap on a tooth opens a small menu at the tooth.
//   Select  pick teeth (taps, drags, or a shortcut such as "Upper" or "Not marked"),
//           then pick a condition and the whole group changes at once.
//
// The chart itself decides nothing about the record: it reports a set of changes
// (tooth → condition, "" clears) and the patient page saves them. Selecting is only
// ever a highlight; nothing but an applied condition touches the chart.
import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Redo2, Trash2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { useToothStatuses, type ToothStatuses } from "@/features/dental/toothStatus";
import {
  ALL_TEETH, CLEAR, LOWER_LEFT, LOWER_RIGHT, UPPER_LEFT, UPPER_RIGHT,
  capital, changesFor, glyphs, invert, neighbour, quickSelects, sameTeeth, summarize,
  type Chart,
} from "@/features/dental/chart/chartModel";

// Conditions, their colours and their order belong to the clinic — see toothStatus.
export { useToothStatuses };
export type { ToothStatuses };

// Every tooth in chart-reading order, grouped by quadrant — for the tooth picker.
export const TOOTH_QUADRANTS: { label: string; codes: string[] }[] = [
  { label: "Upper right", codes: UPPER_RIGHT },
  { label: "Upper left", codes: UPPER_LEFT },
  { label: "Lower right", codes: LOWER_RIGHT },
  { label: "Lower left", codes: LOWER_LEFT },
];

type Mode = "mark" | "select";

/** "1 tooth", "16 teeth". */
const count = (n: number) => `${n} ${n === 1 ? "tooth" : "teeth"}`;

export interface ToothChartProps {
  teeth: Chart;
  editable: boolean;
  /** One change of the record: tooth → condition ("" clears). `label` names it for the
   *  one pop-up a group change gets. */
  onApply: (changes: Chart, label: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** A save is waiting or in flight. */
  saving: boolean;
  /** The last save failed and the chart was put back to what the server holds.
   *  "unconfirmed": no answer came, so the save may or may not have landed. */
  failed?: boolean | "unconfirmed";
}

export function ToothChart({ teeth, editable: canEdit, onApply, onUndo, onRedo, canUndo, canRedo, saving, failed }: ToothChartProps) {
  const sts = useToothStatuses();
  // Read-only until the clinic's conditions have loaded (audit D12): a tap must never
  // compute a mark from a list that is not there.
  const editable = canEdit && sts.ready;

  const [mode, setMode] = useState<Mode>("mark");
  // null = nothing chosen, "" = the eraser, anything else = a condition.
  const [brush, setBrush] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [edited, setEdited] = useState(false);
  // What a drag has painted so far, shown before it is committed as ONE change.
  const [preview, setPreview] = useState<Chart | null>(null);

  const stroke = useRef<{ kind: "paint" | "add" | "remove"; codes: Set<string>; brush: string } | null>(null);
  const toothEls = useRef(new Map<string, HTMLButtonElement>());

  const shown = preview ? { ...teeth, ...preview } : teeth;
  const glyphOf = useMemo(() => glyphs(sts.list), [sts.list]);
  const labelOf = (code: string) => capital(sts.labelOf(code));
  const counts = summarize(shown, sts.list.map((s) => s.code));
  const marks = Object.values(teeth).filter(Boolean).length;

  const apply = (changes: Chart, label: string) => {
    if (Object.keys(changes).length === 0) return;
    setEdited(true);
    onApply(changes, label);
  };

  const describe = (n: number, status: string) =>
    status === CLEAR ? `Cleared ${count(n)}` : `Marked ${count(n)} ${labelOf(status)}`;

  // --- strokes: one press, optionally dragged, committed as one change -----------

  const begin = (code: string) => {
    if (mode === "mark") {
      if (brush === null) return;
      stroke.current = { kind: "paint", codes: new Set([code]), brush };
      setPreview({ [code]: brush });
      return;
    }
    // Select: the first tooth decides whether this drag selects or deselects.
    const kind = selected.has(code) ? "remove" : "add";
    stroke.current = { kind, codes: new Set([code]), brush: "" };
    setSelected((cur) => {
      const next = new Set(cur);
      if (kind === "add") next.add(code); else next.delete(code);
      return next;
    });
  };

  const extend = (code: string) => {
    const s = stroke.current;
    if (!s || s.codes.has(code)) return;
    s.codes.add(code);
    if (s.kind === "paint") {
      setPreview((p) => ({ ...p, [code]: s.brush }));
      return;
    }
    setSelected((cur) => {
      const next = new Set(cur);
      if (s.kind === "add") next.add(code); else next.delete(code);
      return next;
    });
  };

  const finish = () => {
    const s = stroke.current;
    stroke.current = null;
    if (!s) return;
    if (s.kind === "paint") {
      setPreview(null);
      const changes = changesFor(teeth, s.codes, s.brush);
      apply(changes, describe(Object.keys(changes).length, s.brush));
    }
  };

  // A drag may end anywhere — off the chart, off the window — and must still commit.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const up = () => finishRef.current();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => { window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, []);

  const toothAt = (x: number, y: number) => {
    if (typeof document.elementFromPoint !== "function") return null;
    return document.elementFromPoint(x, y)?.closest("[data-tooth]")?.getAttribute("data-tooth") ?? null;
  };

  const onPointerDown = (e: React.PointerEvent, code: string) => {
    if (!editable || e.button !== 0) return;
    begin(code);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!stroke.current) return;
    // Where the pointer is, not where the press began: a finger keeps pointing events
    // at the tooth it landed on, so the point is what says which tooth it is over now.
    const code = toothAt(e.clientX, e.clientY)
      ?? (e.target as Element).closest?.("[data-tooth]")?.getAttribute("data-tooth") ?? null;
    if (code) extend(code);
  };

  // A click is what a keyboard (or a screen reader) produces, and what opens the
  // menu. A pointer press has already been handled as a stroke, so its click — which
  // carries a count — is ignored.
  const onToothClick = (e: React.MouseEvent, code: string) => {
    if (!editable) return;
    if (mode === "mark" && brush === null) { setMenuFor(code); return; }
    if (e.detail !== 0) return;
    begin(code);
    finish();
    if (mode === "select") stroke.current = null;
  };

  // --- the bar --------------------------------------------------------------------

  const pickCondition = (status: string) => {
    if (!editable) return;
    if (mode === "select") {
      if (selected.size === 0) return;
      const changes = changesFor(teeth, selected, status);
      apply(changes, describe(Object.keys(changes).length, status));
      setSelected(new Set());
      return;
    }
    setBrush((cur) => (cur === status ? null : status));
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setBrush(null);
    setSelected(new Set());
    setMenuFor(null);
  };

  const quick = useMemo(() => quickSelects(teeth, sts.list), [teeth, sts.list]);

  const clearAll = () => {
    const changes = changesFor(teeth, ALL_TEETH.filter((c) => teeth[c]), CLEAR);
    apply(changes, `Cleared ${Object.keys(changes).length} marks`);
    setConfirmClear(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!editable) return;
    const t = e.target as HTMLElement;
    if (t.closest("[role=dialog]") || t.closest("[data-radix-popper-content-wrapper]")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) onRedo(); else onUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); onRedo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      if (brush !== null) setBrush(null);
      else if (selected.size > 0) setSelected(new Set());
      return;
    }
    if (e.key.startsWith("Arrow")) {
      const code = t.getAttribute("data-tooth");
      const to = code ? neighbour(code, e.key as "ArrowLeft") : null;
      if (to) { e.preventDefault(); toothEls.current.get(to)?.focus(); }
      return;
    }
    if (e.key === "a" || e.key === "A") {
      e.preventDefault();
      setMode("select");
      setBrush(null);
      setSelected(new Set(ALL_TEETH));
      return;
    }
    if (e.key === "0") { pickCondition(CLEAR); return; }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && sts.list[n - 1]) pickCondition(sts.list[n - 1].code);
  };

  const hint = !editable ? null
    : mode === "select"
      ? selected.size > 0 ? `${count(selected.size)} selected` : "Select teeth, then pick a condition"
      : brush === null ? "Pick a condition, then tap teeth"
        : brush === CLEAR ? "Clearing: tap or drag across teeth to remove their marks"
          : `Marking: ${labelOf(brush)} — tap teeth or drag across them`;

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      {canEdit && !sts.ready && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          <span className="min-w-0 flex-1">
            {sts.failed ? "The tooth conditions did not load — the chart is read-only until they do." : "Loading the tooth conditions…"}
          </span>
          {sts.failed && <button type="button" className="font-medium underline" onClick={sts.retry}>Retry</button>}
        </div>
      )}

      {/* The controls: above the chart on a desktop; pinned to the bottom of the screen,
          where the thumb is, on a phone. */}
      {canEdit && (
        <div className="order-1 space-y-2 max-md:order-3 max-md:sticky max-md:bottom-[calc(4rem+env(safe-area-inset-bottom))] max-md:z-30 max-md:-mx-1 max-md:rounded-lg max-md:border max-md:bg-card/95 max-md:p-2 max-md:shadow-popover max-md:backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented ariaLabel="Chart mode" size="sm" value={mode} onChange={switchMode}
              options={[{ value: "mark", label: "Mark" }, { value: "select", label: "Select" }]} />
            <div className="flex items-center gap-1.5">
              {failed ? (
                <span role="status" className="mr-1 text-xs font-medium text-destructive">
                  {failed === "unconfirmed" ? "Not confirmed — reload to check what was saved" : "Not saved — changes undone"}
                </span>
              ) : edited && (
                <span role="status" className="mr-1 text-xs text-muted-foreground">{saving ? "Saving…" : "✓ Saved"}</span>
              )}
              <Button type="button" size="sm" variant="outline" disabled={!canUndo || !editable} onClick={onUndo} aria-label="Undo">
                <Undo2 className="h-4 w-4" /><span className="max-sm:sr-only">Undo</span>
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={!canRedo || !editable} onClick={onRedo} aria-label="Redo">
                <Redo2 className="h-4 w-4" /><span className="sr-only">Redo</span>
              </Button>
            </div>
          </div>

          {hint && <p aria-live="polite" className="text-xs font-medium text-brand">{hint}</p>}

          {mode === "select" && editable && (
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none md:flex-wrap" aria-label="Quick selects" role="group">
              {quick.map((q) => (
                <button key={q.key} type="button" disabled={q.codes.length === 0}
                  aria-pressed={sameTeeth(selected, q.codes)}
                  onClick={() => setSelected(sameTeeth(selected, q.codes) ? new Set() : new Set(q.codes))}
                  className={cn("shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium touch-hit disabled:opacity-40",
                    sameTeeth(selected, q.codes) ? "border-brand bg-brand text-brand-foreground" : "bg-card hover:bg-accent")}>
                  {q.label}
                </button>
              ))}
              <button type="button" onClick={() => setSelected(new Set(invert(selected)))}
                className="shrink-0 whitespace-nowrap rounded-md border bg-card px-2.5 py-1 text-xs font-medium hover:bg-accent touch-hit">
                Invert
              </button>
              <button type="button" disabled={selected.size === 0} onClick={() => setSelected(new Set())}
                className="shrink-0 whitespace-nowrap rounded-md border bg-card px-2.5 py-1 text-xs font-medium hover:bg-accent touch-hit disabled:opacity-40">
                Clear selection
              </button>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1 scrollbar-none md:flex-wrap" role="group" aria-label="Conditions">
              {sts.list.map((s, i) => {
                const st = sts.styleOf(s.code);
                const on = mode === "mark" && brush === s.code;
                return (
                  <button key={s.code} type="button" disabled={!editable}
                    aria-pressed={on} title={`${capital(s.label)} (${i + 1})`}
                    onClick={() => pickCondition(s.code)}
                    style={on ? { background: st.borderColor, borderColor: st.borderColor, color: "#fff" } : st}
                    className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] px-3 py-1.5 text-sm font-semibold touch-hit disabled:opacity-50",
                      on && "ring-2 ring-brand/30 ring-offset-1")}>
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: on ? "#fff" : st.borderColor }} />
                    {capital(s.label)}
                  </button>
                );
              })}
              <button type="button" disabled={!editable} aria-pressed={mode === "mark" && brush === CLEAR}
                title="Clear (0)" onClick={() => pickCondition(CLEAR)}
                className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-[1.5px] px-3 py-1.5 text-sm font-semibold touch-hit disabled:opacity-50",
                  mode === "mark" && brush === CLEAR ? "border-foreground bg-foreground text-background" : "bg-muted text-muted-foreground")}>
                <Eraser className="h-3.5 w-3.5" /> Clear
              </button>
            </div>
            <Button type="button" size="sm" variant="ghost" disabled={!editable || marks === 0}
              onClick={() => setConfirmClear(true)} title="Remove every mark from this chart" className="shrink-0">
              <Trash2 className="h-4 w-4" /><span className="max-sm:sr-only">Clear all</span>
            </Button>
          </div>
        </div>
      )}

      {/* The chart. touch-action keeps a vertical swipe scrolling the page while a
          horizontal drag across a row paints or selects. */}
      <div className="order-2 max-md:order-1" onPointerMove={onPointerMove}
        style={{ touchAction: editable && (brush !== null || mode === "select") ? "pan-y" : undefined }}>
        <div className="hidden justify-around pb-1 text-[11px] text-muted-foreground md:flex" aria-hidden>
          <span>Patient's right</span><span>Patient's left</span>
        </div>
        <Arch right={UPPER_RIGHT} left={UPPER_LEFT} divider {...{ shown, editable, selected, mode, sts, glyphOf, toothEls, onPointerDown, onToothClick }} />
        <Arch right={LOWER_RIGHT} left={LOWER_LEFT} {...{ shown, editable, selected, mode, sts, glyphOf, toothEls, onPointerDown, onToothClick }} />
      </div>

      {canEdit && editable && (
        <p className="order-3 max-md:order-2 text-xs text-muted-foreground">
          {counts.marked === 0 ? "Nothing marked yet." : (
            <>{counts.marked} marked: {counts.byCondition.map((c) => `${c.count} ${labelOf(c.code)}`).join(" · ")} · {counts.unmarked} not marked</>
          )}
        </p>
      )}

      {/* Read-only viewers keep a plain key, since there is no bar to be one. */}
      {!canEdit && (
        <div className="flex flex-wrap gap-3 pt-1">
          {sts.list.map((s) => {
            const st = sts.styleOf(s.code);
            return (
              <span key={s.code} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-3 w-3 rounded-sm border" style={{ background: st.background, borderColor: st.borderColor }} />
                {capital(s.label)}
              </span>
            );
          })}
        </div>
      )}

      {/* The tooth menu: a tap with nothing chosen. Two taps, no cycling. */}
      <Popover open={menuFor !== null} onOpenChange={(o) => { if (!o) setMenuFor(null); }}>
        {menuFor && toothEls.current.get(menuFor) && (
          <PopoverAnchor virtualRef={{ current: toothEls.current.get(menuFor)! }} />
        )}
        <PopoverContent className="w-52 p-1.5" aria-label={menuFor ? `Condition for ${menuFor}` : undefined}>
          {menuFor && (
            <>
              <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                {menuFor}{shown[menuFor] ? ` · ${labelOf(shown[menuFor])}` : " · not marked"}
              </p>
              {sts.list.map((s) => {
                const st = sts.styleOf(s.code);
                return (
                  <button key={s.code} type="button" role="menuitem"
                    onClick={() => { apply(changesFor(teeth, [menuFor], s.code), `${menuFor} → ${labelOf(s.code)}`); setMenuFor(null); }}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent max-md:min-h-11">
                    <span className="h-3 w-3 rounded-sm border" style={{ background: st.background, borderColor: st.borderColor }} />
                    {capital(s.label)}
                    {teeth[menuFor] === s.code && <span className="ml-auto text-xs text-muted-foreground">current</span>}
                  </button>
                );
              })}
              <button type="button" role="menuitem" disabled={!teeth[menuFor]}
                onClick={() => { apply(changesFor(teeth, [menuFor], CLEAR), `${menuFor} cleared`); setMenuFor(null); }}
                className="mt-1 flex w-full items-center gap-2 rounded-sm border-t px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40 max-md:min-h-11">
                <Eraser className="h-3.5 w-3.5" /> Clear
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Clear the whole chart?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            This removes <b>{marks} mark{marks === 1 ? "" : "s"}</b> from this patient's tooth chart. Visit notes,
            treatments and payments are not touched. You can undo it straight afterwards, and the old marks stay in
            the audit history.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="destructive" onClick={clearAll}>Clear {marks} mark{marks === 1 ? "" : "s"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ArchProps {
  right: string[];
  left: string[];
  divider?: boolean;
  shown: Chart;
  editable: boolean;
  selected: ReadonlySet<string>;
  mode: Mode;
  sts: ToothStatuses;
  glyphOf: Record<string, string>;
  toothEls: React.MutableRefObject<Map<string, HTMLButtonElement>>;
  onPointerDown: (e: React.PointerEvent, code: string) => void;
  onToothClick: (e: React.MouseEvent, code: string) => void;
}

/** One arch: the patient's right quadrant, the midline, the patient's left. On a
 *  phone each quadrant is its own labelled row of eight. */
function Arch({ right, left, divider, ...rest }: ArchProps) {
  return (
    <div className={cn("grid grid-cols-1 gap-y-2 py-1.5 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]", divider && "md:border-b-2 md:border-foreground/25")}>
      <Quadrant codes={right} label={quadrantName(right)} align="end" {...rest} />
      <div aria-hidden className="mx-3 hidden w-0.5 rounded bg-foreground/25 md:block" />
      <Quadrant codes={left} label={quadrantName(left)} align="start" {...rest} />
    </div>
  );
}

const quadrantName = (codes: string[]) =>
  ({ UR: "Upper right", UL: "Upper left", LR: "Lower right", LL: "Lower left" } as Record<string, string>)[codes[0].slice(0, 2)];

function Quadrant({ codes, label, align, ...rest }: Omit<ArchProps, "right" | "left" | "divider"> & { codes: string[]; label: string; align: "end" | "start" }) {
  const { shown, editable, selected, mode, sts, glyphOf, toothEls, onPointerDown, onToothClick } = rest;
  return (
    <div>
      {/* Stacked one per row below md, position no longer says which quadrant a row is. */}
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground md:hidden">{label}</p>
      {/* Eight equal columns that divide whatever width exists: a fixed 40px tooth
          overflowed the 735px a desktop shelf leaves, and clipped the last tooth. */}
      <div className={cn("grid grid-cols-8 gap-1.5 md:max-w-[24rem]", align === "end" ? "md:ml-auto" : "md:mr-auto")}>
        {codes.map((code) => {
          const status = shown[code] ?? "";
          const isSel = selected.has(code);
          const g = status ? (glyphOf[status] ?? status.charAt(0).toUpperCase()) : "";
          return (
            <button
              key={code}
              ref={(el) => { if (el) toothEls.current.set(code, el); else toothEls.current.delete(code); }}
              type="button"
              data-tooth={code}
              disabled={!editable}
              aria-pressed={mode === "select" && editable ? isSel : undefined}
              onPointerDown={(e) => onPointerDown(e, code)}
              onClick={(e) => onToothClick(e, code)}
              // title= never surfaces on touch, so the status is also in the accessible
              // name — what a screen reader announces per tooth.
              title={`Palmer ${code}${status ? ` · ${capital(sts.labelOf(status))}` : ""}`}
              aria-label={`${code}${status ? ` — ${capital(sts.labelOf(status))}` : ""}`}
              style={sts.styleOf(status)}
              className={cn(
                "relative flex h-12 min-w-0 select-none flex-col items-center justify-center rounded-md border text-xs font-semibold tabular-nums leading-none transition-shadow",
                editable ? "cursor-pointer" : "cursor-default",
                isSel && "outline outline-2 outline-offset-1 outline-sky-700",
              )}
            >
              {g && <span aria-hidden className="mb-0.5 text-[10px] font-bold">{g}</span>}
              <span>{code.slice(2)}</span>
              {isSel && (
                <span aria-hidden className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-sky-700 text-[10px] text-white">✓</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
