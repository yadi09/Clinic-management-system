import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, CheckCircle2, Eye, Link2, Trash2, Upload, Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import {
  clearDhis2,
  getDhis2Config,
  getDhis2Mapping,
  getDhis2Report,
  getDhis2Submitted,
  listDhis2Elements,
  pushDhis2,
  saveDhis2Config,
  saveDhis2Mapping,
  testDhis2,
  type Dhis2Disease,
  type Dhis2Facility,
  type Dhis2ImportSummary,
} from "@/features/reporting/api";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function Dhis2ReportPage() {
  const { ask, dialog } = useConfirmDialog();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["dhis2-report"], queryFn: getDhis2Report });
  const cfg = useQuery({ queryKey: ["dhis2-config"], queryFn: getDhis2Config });
  const [result, setResult] = useState<{ kind: "push" | "clear"; sum: Dhis2ImportSummary } | null>(null);
  const [submitted, setSubmitted] = useState<number | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

  const connected = cfg.data?.connected ?? false;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dhis2-report"] });
    qc.invalidateQueries({ queryKey: ["dhis2-config"] });
  };

  const push = useMutation({
    mutationFn: pushDhis2,
    onSuccess: (sum) => { setResult({ kind: "push", sum }); toast.success(`Pushed to DHIS2 — ${sum.imported} imported, ${sum.updated} updated`); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Push failed"),
  });
  const submittedMut = useMutation({
    mutationFn: getDhis2Submitted,
    onSuccess: (r) => { setSubmitted(r.count); toast.success(`${r.count} values currently in DHIS2 for this period`); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not read from DHIS2"),
  });
  const clear = useMutation({
    mutationFn: clearDhis2,
    onSuccess: (sum) => { setResult({ kind: "clear", sum }); setSubmitted(null); toast.success(`Cleared — ${sum.deleted} values removed from DHIS2`); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Clear failed"),
  });

  if (q.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading report…</div>;
  if (q.isError || !q.data) return <div className="p-8 text-sm text-destructive">Could not load the report.</div>;
  const rep = q.data;
  const male = rep.columns.filter((c) => c.sex === "M");
  const female = rep.columns.filter((c) => c.sex === "F");
  const unmapped = connected ? rep.diseases.filter((d) => !d.data_element).length : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-1">
      {dialog}
      <header>
        <h1 className="text-xl font-semibold text-brand">Ministry report — Disease Registration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The diseases diagnosed this month, by age and sex — pushed to the national system (DHIS2) in one click, no
          re-typing into the government portal.
        </p>
      </header>

      {/* Reporting context (mirrors the DHIS2 form header) */}
      <Card className="flex flex-wrap gap-x-8 gap-y-3 p-4">
        <Ctx label="Organisation unit" value={rep.context.org_unit} icon />
        <Ctx label="Period (current month)" value={rep.context.period_label} />
        <Ctx label="Data set" value={rep.context.data_set} />
        <Ctx label="Department" value={rep.context.department} />
        <Ctx label="Outcome" value={rep.context.outcome} />
      </Card>

      {/* Connection */}
      {connected ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              Connected to <b>{cfg.data?.org_unit_name || "DHIS2"}</b> · {cfg.data?.period_calendar === "gregorian" ? "Gregorian" : "Ethiopian"} periods
              {unmapped > 0 && <span className="ml-1 text-amber-700">· {unmapped} disease{unmapped === 1 ? "" : "s"} not mapped</span>}
            </span>
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setMapOpen(true)}><Link2 className="h-3.5 w-3.5" /> Map diseases</Button>
            <Button size="sm" variant="ghost" onClick={() => setConnectOpen(true)}>Change token</Button>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span><b>DHIS2 not connected.</b> The report below is live. Connect your clinic's DHIS2 account to enable the push.</span>
          </span>
          <Button size="sm" className="bg-primary" onClick={() => setConnectOpen(true)}><Link2 className="h-3.5 w-3.5" /> Connect DHIS2</Button>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button className="bg-primary" disabled={!connected} loading={push.isPending} onClick={() => push.mutate()}>
          <Upload className="h-4 w-4" /> Push to DHIS2
        </Button>
        <Button variant="outline" disabled={!connected} loading={submittedMut.isPending} onClick={() => submittedMut.mutate()}>
          <Eye className="h-4 w-4" /> View submitted
        </Button>
        <Button
          variant="outline"
          className="text-destructive"
          disabled={!connected}
          loading={clear.isPending}
          onClick={() => { ask({ title: "Clear this period from DHIS2?", description: "Every value already pushed for this period is removed from the national system. This is permanent.", confirmLabel: "Clear from DHIS2", destructive: true }, () => clear.mutateAsync()); }}
        >
          <Trash2 className="h-4 w-4" /> Clear
        </Button>
        {submitted !== null && <span className="text-xs text-muted-foreground">{submitted} values currently in DHIS2</span>}
      </div>

      {result && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <b>DHIS2 {result.kind === "push" ? "push" : "clear"} — {result.sum.status}.</b>{" "}
            {result.kind === "push"
              ? `${result.sum.imported} imported, ${result.sum.updated} updated, ${result.sum.ignored} ignored.`
              : `${result.sum.deleted} deleted.`}
            {result.sum.conflicts.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-amber-800">
                {result.sum.conflicts.slice(0, 5).map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Grid */}
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                <th rowSpan={2} className="sticky left-0 z-10 bg-muted/60 px-3 py-2 text-left">Disease</th>
                <th colSpan={male.length} className="border-l px-3 py-1.5 text-center text-brand">Male</th>
                <th colSpan={female.length} className="border-l px-3 py-1.5 text-center text-rose-600">Female</th>
                <th rowSpan={2} className="border-l px-3 py-2 text-center">Total</th>
              </tr>
              <tr className="bg-muted/40 text-[11px] text-muted-foreground">
                {male.map((c, i) => <th key={c.key} className={`px-2 py-1 text-center font-medium ${i === 0 ? "border-l" : ""}`}>{c.label}</th>)}
                {female.map((c, i) => <th key={c.key} className={`px-2 py-1 text-center font-medium ${i === 0 ? "border-l" : ""}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rep.diseases.length === 0 && (
                <tr><td colSpan={rep.columns.length + 2} className="px-3 py-10 text-center text-sm text-muted-foreground">No diseases diagnosed yet this month.</td></tr>
              )}
              {rep.diseases.map((d) => (
                <tr key={d.rank} className="border-t hover:bg-muted/30">
                  <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium text-foreground">
                    <span className="mr-1.5 text-muted-foreground">{d.rank}.</span>
                    {d.name}
                    {connected && !d.data_element && <Badge variant="outline" className="ml-2 text-[10px] text-amber-700">not mapped</Badge>}
                  </td>
                  {rep.columns.map((c, i) => {
                    const v = d.counts[c.key] ?? 0;
                    return (
                      <td key={c.key} className={`px-2 py-2 text-center tabular-nums ${i === 0 || i === male.length ? "border-l" : ""} ${v ? "text-foreground" : "text-muted-foreground/40"}`}>
                        {v || "·"}
                      </td>
                    );
                  })}
                  <td className="border-l px-3 py-2 text-center font-semibold tabular-nums">{d.total}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 bg-muted/40 font-semibold">
                <td className="sticky left-0 z-10 bg-muted/40 px-3 py-2">Total</td>
                {rep.columns.map((c, i) => (
                  <td key={c.key} className={`px-2 py-2 text-center tabular-nums ${i === 0 || i === male.length ? "border-l" : ""}`}>{rep.column_totals[c.key] || 0}</td>
                ))}
                <td className="border-l px-3 py-2 text-center text-brand">{rep.grand_total}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Counts are distinct patients diagnosed in {rep.context.period_label} (age taken at the visit).
        {connected ? " Only mapped diseases are sent; unmapped ones show here but are skipped." : ""}
      </p>

      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} baseUrl={cfg.data?.base_url} onSaved={refresh} />
      <MappingDialog open={mapOpen} onOpenChange={setMapOpen} diseases={rep.diseases} onSaved={refresh} />
    </div>
  );
}

function calToCalendar(cal: string): "ethiopian" | "gregorian" {
  return cal.toLowerCase().includes("ethiop") ? "ethiopian" : "gregorian";
}

function ConnectDialog({ open, onOpenChange, baseUrl, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; baseUrl?: string; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [facilities, setFacilities] = useState<Dhis2Facility[]>([]);
  const [facility, setFacility] = useState("");
  const [calendar, setCalendar] = useState<"ethiopian" | "gregorian">("ethiopian");

  useEffect(() => {
    if (!open) { setToken(""); setFacilities([]); setFacility(""); setCalendar("ethiopian"); }
  }, [open]);

  const test = useMutation({
    mutationFn: () => testDhis2(token, baseUrl),
    onSuccess: (r) => {
      setFacilities(r.facilities);
      if (r.facilities.length === 1) setFacility(r.facilities[0].id);
      if (r.calendar) setCalendar(calToCalendar(r.calendar));
      toast.success(`Connected — ${r.facilities.length} facilit${r.facilities.length === 1 ? "y" : "ies"} found${r.calendar ? `, ${r.calendar} calendar` : ""}`);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not connect"),
  });
  const save = useMutation({
    mutationFn: () => {
      const f = facilities.find((x) => x.id === facility);
      return saveDhis2Config({ token, org_unit: facility, org_unit_name: f?.name, period_calendar: calendar });
    },
    onSuccess: () => { toast.success("DHIS2 connected"); onOpenChange(false); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Connect this clinic to DHIS2</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Paste the Personal Access Token from your clinic's DHIS2 account, then Test to find your facility. The token
            is stored encrypted and never shown again.
          </p>
          <div className="space-y-1.5">
            <Label>DHIS2 API token</Label>
            <div className="flex gap-2">
              <Input type="password" placeholder="d2pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
              <Button variant="outline" disabled={!token.trim()} loading={test.isPending} onClick={() => test.mutate()}>Test</Button>
            </div>
          </div>
          {facilities.length > 0 && (
            <>
              <div className="space-y-1.5">
                <Label>Facility (organisation unit)</Label>
                <Select value={facility} onValueChange={setFacility}>
                  <SelectTrigger><SelectValue placeholder="Choose your facility…" /></SelectTrigger>
                  <SelectContent>
                    {facilities.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Reporting period calendar</Label>
                <Select value={calendar} onValueChange={(v) => setCalendar(v as "ethiopian" | "gregorian")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ethiopian">Ethiopian</SelectItem>
                    <SelectItem value="gregorian">Gregorian</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!token.trim() || !facility} loading={save.isPending} onClick={() => save.mutate()}>Save connection</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MappingDialog({ open, onOpenChange, diseases, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; diseases: Dhis2Disease[]; onSaved: () => void }) {
  const elementsQ = useQuery({ queryKey: ["dhis2-elements"], queryFn: listDhis2Elements, enabled: open });
  const mappingQ = useQuery({ queryKey: ["dhis2-mapping"], queryFn: getDhis2Mapping, enabled: open });
  const [map, setMap] = useState<Record<string, string>>({}); // diseaseName -> element id

  const elements = elementsQ.data?.elements ?? [];

  // Rows = the diseases in the report plus any already-mapped ones not seen this month.
  const rows = useMemo(() => {
    const names = new Map<string, string>(); // key -> display name
    diseases.forEach((d) => names.set(norm(d.name), d.name));
    (mappingQ.data?.entries ?? []).forEach((m) => { if (!names.has(m.disease_key)) names.set(m.disease_key, m.disease_name); });
    return [...names.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [diseases, mappingQ.data]);

  useEffect(() => {
    if (!open) return;
    const init: Record<string, string> = {};
    (mappingQ.data?.entries ?? []).forEach((m) => { init[m.disease_key] = m.data_element; });
    setMap(init);
  }, [open, mappingQ.data]);

  const autoMatch = () => {
    const byNorm = new Map(elements.map((e) => [norm(e.name), e.id]));
    setMap((prev) => {
      const next = { ...prev };
      rows.forEach((r) => {
        if (!next[r.key]) {
          const hit = byNorm.get(r.key) ?? elements.find((e) => norm(e.name).includes(r.key) || r.key.includes(norm(e.name)))?.id;
          if (hit) next[r.key] = hit;
        }
      });
      return next;
    });
    toast.success("Matched by name where possible — review, then Save");
  };

  const save = useMutation({
    mutationFn: () => {
      const entries = rows
        .filter((r) => map[r.key])
        .map((r) => {
          const el = elements.find((e) => e.id === map[r.key]);
          return { disease_key: r.key, disease_name: r.name, data_element: map[r.key], data_element_name: el?.name ?? "" };
        });
      return saveDhis2Mapping(entries);
    },
    onSuccess: () => { toast.success("Mapping saved"); onOpenChange(false); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the mapping"),
  });

  const mappedCount = rows.filter((r) => map[r.key]).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Map diseases to DHIS2</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Match each diagnosis to its DHIS2 disease element. Only mapped diseases are pushed.</p>
            <Button size="sm" variant="outline" disabled={!elements.length} onClick={autoMatch}><Wand2 className="h-3.5 w-3.5" /> Auto-match by name</Button>
          </div>
          {elementsQ.isLoading || mappingQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading DHIS2 disease list…</p>
          ) : elementsQ.isError ? (
            <p className="text-sm text-destructive">Could not load the DHIS2 disease list. Check the connection and try again.</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No diseases to map yet — they'll appear here once diagnoses are recorded this month.</p>
          ) : (
            <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
              {rows.map((r) => (
                <div key={r.key} className="grid grid-cols-[1fr_1.3fr] items-center gap-3">
                  <span className="truncate text-sm font-medium">{r.name}</span>
                  <Select value={map[r.key] ?? "none"} onValueChange={(v) => setMap((m) => ({ ...m, [r.key]: v === "none" ? "" : v }))}>
                    <SelectTrigger><SelectValue placeholder="Not mapped" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Not mapped —</SelectItem>
                      {elements.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <span className="mr-auto self-center text-xs text-muted-foreground">{mappedCount} mapped</span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save mapping</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Ctx({ label, value, icon }: { label: string; value: string; icon?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-1.5 font-medium text-foreground">
        {icon && <Building2 className="h-3.5 w-3.5 text-brand" />}
        {value}
      </div>
    </div>
  );
}
