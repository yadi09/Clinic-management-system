import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Baby, CalendarClock, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useDebounce } from "@/hooks/useDebounce";
import { formatEthiopian } from "@/lib/ethiopian";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import {
  getDating,
  previewDating,
  saveDating,
  type DatingInputs,
  type DatingMethod,
  type DatingResult,
} from "@/features/maternity/api";

const METHODS: { key: DatingMethod; label: string }[] = [
  { key: "LMP", label: "LMP" },
  { key: "ULTRASOUND", label: "Ultrasound" },
  { key: "KNOWN_EDD", label: "Known EDD" },
  { key: "IVF", label: "IVF" },
  { key: "CONCEPTION", label: "Conception" },
];

const WIN_LABELS: Record<string, string> = {
  ntScan: "NT scan",
  viability: "Viability",
  anatomyScan: "Anatomy scan",
  typicalAnatomy: "Anatomy (detailed)",
  glucoseScreen: "Glucose screen (GDM)",
  rhoGam: "Anti-D (RhoGAM)",
  tdap: "Tdap vaccine",
  gbsScreen: "GBS swab",
  earlyTerm: "Early term",
  fullTerm: "Full term",
  postdates: "Post-dates",
};
const WIN_ORDER = ["ntScan", "viability", "anatomyScan", "typicalAnatomy", "glucoseScreen", "rhoGam", "tdap", "gbsScreen", "earlyTerm", "fullTerm", "postdates"];

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtG = (iso?: string) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtGShort = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });

function ready(method: DatingMethod, i: DatingInputs): boolean {
  switch (method) {
    case "LMP": return !!i.firstDayOfLmp;
    case "ULTRASOUND": return !!i.ultrasoundDate && i.gaWeeks != null;
    case "KNOWN_EDD": return !!i.edd;
    case "IVF": return !!i.transferDate && !!i.embryoType;
    case "CONCEPTION": return !!i.conceptionDate;
  }
}

/** The full method → inputs → live-result form, with Save. */
export function PregnancyCalculator({ patientId, onSaved }: { patientId: string; onSaved?: () => void }) {
  // What is already on file. Without this the calculator opened blank on a patient
  // whose dating was recorded minutes earlier, so there was no way to tell an
  // unrecorded pregnancy from a recorded one except by saving again over the top.
  const existing = useQuery({ queryKey: ["dating", patientId], queryFn: () => getDating(patientId) });
  const onFile = existing.data?.dating ?? null;
  const [method, setMethod] = useState<DatingMethod>("LMP");
  const [inputs, setInputs] = useState<DatingInputs>({ cycleLength: 28 });
  const [gaDate, setGaDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [result, setResult] = useState<DatingResult | null>(null);
  const set = (patch: Partial<DatingInputs>) => setInputs((p) => ({ ...p, ...patch }));

  // Open on the method the dating was recorded with — re-entering it under LMP when it
  // was dated by ultrasound is how a redate gets triggered by accident.
  const [methodPinned, setMethodPinned] = useState(false);
  useEffect(() => {
    if (!methodPinned && onFile?.method) { setMethod(onFile.method); setMethodPinned(true); }
  }, [onFile?.method, methodPinned]);

  const isReady = ready(method, inputs);
  const debounced = useDebounce(JSON.stringify({ method, inputs, gaDate }), 300);

  useEffect(() => {
    if (!isReady) { setResult(null); return; }
    let cancelled = false;
    previewDating({ method, inputs, gaDate })
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setResult(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => saveDating(patientId, { method, inputs, gaDate, note: note || undefined }),
    onSuccess: (r) => {
      if (r.redate?.recommended) {
        toast.warning(`Redated with a ${r.redate.discrepancyDays}-day discrepancy — confirm this is intended.`);
      } else {
        toast.success("Pregnancy dating saved");
      }
      qc.invalidateQueries({ queryKey: ["dating", patientId] });
      onSaved?.();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save dating"),
  });

  return (
    <div className="space-y-4">
      {onFile && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-emerald-900">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            Dating already recorded — EDD {fmtG(onFile.edd)}
            <Badge variant="success" className="text-[10px]">{onFile.gestationalAge?.label}</Badge>
          </p>
          <p className="mt-0.5 text-xs text-emerald-800">
            By {METHODS.find((m) => m.key === onFile.method)?.label ?? onFile.method ?? "—"}
            {onFile.updatedAt && <> · saved {new Date(onFile.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</>}.
            Anything you enter below replaces it, and the change is kept in the history.
          </p>
        </div>
      )}

      {/* Method tabs */}
      <div className="flex flex-wrap gap-1 rounded-md border bg-card p-0.5">
        {METHODS.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => { setMethod(m.key); setResult(null); }}
            className={`rounded px-3 py-1 text-sm font-medium ${method === m.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Method-specific inputs */}
      <div className="space-y-3">
        {method === "LMP" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First day of last period">
              <EthiopianDateInput value={inputs.firstDayOfLmp ?? ""} onChange={(v) => set({ firstDayOfLmp: v })} showAge={false} />
            </Field>
            <Field label="Cycle length (days)">
              <Input type="number" min={20} max={45} value={inputs.cycleLength ?? 28} onChange={(e) => set({ cycleLength: Number(e.target.value) })} className="w-28" />
            </Field>
          </div>
        )}
        {method === "ULTRASOUND" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ultrasound date">
              <EthiopianDateInput value={inputs.ultrasoundDate ?? ""} onChange={(v) => set({ ultrasoundDate: v })} showAge={false} />
            </Field>
            <Field label="Gestational age at scan">
              <div className="flex items-end gap-2">
                <div><span className="mb-1 block text-xs text-muted-foreground">Weeks</span><Input type="number" min={0} max={42} className="w-20" value={inputs.gaWeeks ?? ""} onChange={(e) => set({ gaWeeks: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
                <div><span className="mb-1 block text-xs text-muted-foreground">Days</span><Input type="number" min={0} max={6} className="w-20" value={inputs.gaDays ?? ""} onChange={(e) => set({ gaDays: e.target.value === "" ? undefined : Number(e.target.value) })} /></div>
              </div>
            </Field>
          </div>
        )}
        {method === "KNOWN_EDD" && (
          <Field label="Estimated due date (EDD)">
            <EthiopianDateInput value={inputs.edd ?? ""} onChange={(v) => set({ edd: v })} showAge={false} />
          </Field>
        )}
        {method === "IVF" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Embryo transfer date">
              <EthiopianDateInput value={inputs.transferDate ?? ""} onChange={(v) => set({ transferDate: v })} showAge={false} />
            </Field>
            <Field label="Embryo age at transfer">
              <Select value={inputs.embryoType ?? ""} onValueChange={(v) => set({ embryoType: v as DatingInputs["embryoType"] })}>
                <SelectTrigger className="w-44"><SelectValue placeholder="Choose…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="day3">Day 3</SelectItem>
                  <SelectItem value="day5">Day 5 (blastocyst)</SelectItem>
                  <SelectItem value="day6">Day 6 (blastocyst)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}
        {method === "CONCEPTION" && (
          <Field label="Conception date">
            <EthiopianDateInput value={inputs.conceptionDate ?? ""} onChange={(v) => set({ conceptionDate: v })} showAge={false} />
          </Field>
        )}
      </div>

      {/* GA as-of date */}
      <Field label="Gestational age as of">
        <EthiopianDateInput value={gaDate} onChange={(v) => setGaDate(v || todayISO())} showAge={false} />
      </Field>

      {/* Results */}
      {result ? <ResultsPanel r={result} /> : <Card className="p-6 text-center text-sm text-muted-foreground">Fill in the method's fields to see the dating.</Card>}

      {/* Save */}
      <div className="flex flex-wrap items-center gap-3">
        <Input placeholder="Note (optional) — e.g. redated per ultrasound" value={note} onChange={(e) => setNote(e.target.value)} className="min-w-[12rem] flex-1" />
        <Button className="shrink-0" disabled={!isReady || !result?.gestationalAge.valid} loading={save.isPending} onClick={() => save.mutate()}>Save dating</Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ResultsPanel({ r }: { r: DatingResult }) {
  const ga = r.gestationalAge;
  return (
    <Card className="space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="Estimated due date" big={fmtG(r.edd)} sub={`${formatEthiopian(r.edd)} EC`} />
        <Metric label="Gestational age" big={ga.valid ? ga.label : "—"} sub={ga.valid ? `${ga.days} days` : "date precedes LMP"} />
        <Metric label="Conception (est.)" big={fmtG(r.estimatedConception)} sub={`${formatEthiopian(r.estimatedConception)} EC`} />
      </div>
      <div className="text-xs text-muted-foreground">
        Calculated LMP: <span className="font-medium text-foreground">{fmtG(r.calculatedLmp)}</span> · {formatEthiopian(r.calculatedLmp)} EC
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Care schedule</p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {WIN_ORDER.filter((k) => r.windows[k]).map((k) => {
            const w = r.windows[k];
            const when = w.point ? fmtGShort(w.point) : `${fmtGShort(w.start!)} – ${fmtGShort(w.end!)}`;
            return (
              <div key={k} className="flex items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm">
                <span className="text-foreground">{WIN_LABELS[k]}</span>
                <span className="tabular-nums text-muted-foreground">{when}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, big, sub }: { label: string; big: string; sub: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-brand">{big}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

/** Calculator in a dialog — used from triage and the encounter. */
export function PregnancyDatingDialog({ patientId, open, onOpenChange, onSaved }: { patientId: string; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fullOnMobile className="flex max-w-3xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2"><Baby className="h-5 w-5 text-primary" /> Pregnancy dating</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {open && <PregnancyCalculator patientId={patientId} onSaved={() => onSaved?.()} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Persistent EDD·GA card for the patient profile; opens the calculator. */
export function PregnancyDatingCard({ patientId }: { patientId: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["dating", patientId], queryFn: () => getDating(patientId) });
  const dating = q.data?.dating ?? null;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-brand"><Baby className="h-4 w-4 text-primary" /> Pregnancy dating</h3>
        <Button size="sm" variant={dating ? "outline" : "default"} onClick={() => setOpen(true)}>
          <CalendarClock className="h-3.5 w-3.5" /> {dating ? "Update" : "Set dating"}
        </Button>
      </div>
      {q.isLoading ? (
        <Skeleton className="mt-3 h-10 w-full" />
      ) : dating ? (
        (() => {
          // A pregnancy is a journey with a known length, so show the position along
          // it. "19w 0d" is precise and means nothing at a glance; a bar between
          // conception and term, marked by trimester, is read without thinking.
          const w = dating.gestationalAge.weeks;
          const pct = Math.max(0, Math.min(100, (dating.gestationalAge.days / 280) * 100));
          const tri = w < 14 ? "First trimester" : w < 28 ? "Second trimester" : "Third trimester";
          const post = dating.gestationalAge.valid && w >= 41;
          const term = dating.gestationalAge.valid && w >= 37 && w < 41;
          const daysToGo = Math.max(0, 280 - dating.gestationalAge.days);
          return (
            <div className="mt-3 space-y-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-2xl font-bold leading-none text-brand">{dating.gestationalAge.label}</span>
                <Badge variant={post ? "destructive" : term ? "success" : "brand"}>
                  {post ? "Post-dates" : term ? "Term" : tri}
                </Badge>
              </div>
              {dating.gestationalAge.valid && (
                <div>
                  <div className="relative h-2 overflow-hidden rounded-full bg-muted">
                    {/* term window, 37–40 weeks */}
                    <span className="absolute inset-y-0 bg-emerald-500/25"
                      style={{ left: `${(259 / 280) * 100}%`, right: 0 }} />
                    <span className={cn("absolute inset-y-0 left-0 rounded-full",
                      post ? "bg-destructive" : "bg-brand")} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                    <span>0w</span><span>14w</span><span>28w</span><span>40w</span>
                  </div>
                </div>
              )}
              <p className="text-sm">
                <span className="text-muted-foreground">Due </span>
                <span className="font-semibold">{fmtG(dating.edd)}</span>
                {dating.gestationalAge.valid && !post && (
                  <span className="text-muted-foreground"> · {daysToGo} days to go</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatEthiopian(dating.edd)} EC · dated by {dating.method?.replace("_", " ").toLowerCase()}
              </p>
              {post && (
                <p className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs font-medium text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Past 41 weeks — review today.
                </p>
              )}
            </div>
          );
        })()
      ) : (
        <div className="mt-3 rounded-md border border-dashed px-3 py-3 text-center">
          <p className="text-sm font-medium">No dating on file</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Set it once and every visit shows the gestational age and due date.
          </p>
        </div>
      )}
      <PregnancyDatingDialog patientId={patientId} open={open} onOpenChange={setOpen} onSaved={() => q.refetch()} />
    </Card>
  );
}
