import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Baby, CalendarClock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  const [method, setMethod] = useState<DatingMethod>("LMP");
  const [inputs, setInputs] = useState<DatingInputs>({ cycleLength: 28 });
  const [gaDate, setGaDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [result, setResult] = useState<DatingResult | null>(null);
  const set = (patch: Partial<DatingInputs>) => setInputs((p) => ({ ...p, ...patch }));

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
      <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col gap-0 p-0">
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
        <div className="mt-3 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-lg font-semibold text-brand">EDD {fmtG(dating.edd)}</span>
            {dating.gestationalAge.valid && <Badge variant="brand">{dating.gestationalAge.label} today</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{formatEthiopian(dating.edd)} EC · dated by {dating.method?.replace("_", " ").toLowerCase()}</p>
          {dating.gestationalAge.valid && dating.gestationalAge.weeks >= 41 && (
            <p className="flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="h-3 w-3" /> Post-dates — review.</p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No dating on file.</p>
      )}
      <PregnancyDatingDialog patientId={patientId} open={open} onOpenChange={setOpen} onSaved={() => q.refetch()} />
    </Card>
  );
}
