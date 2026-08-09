import { useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, Eye, FileDown, FileUp, ListChecks, UploadCloud, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { ethiopianToGregorianISO } from "@/lib/ethiopian";
import { createPatient, importHistory, importPatients, type ImportReport, type ImportRowInput } from "@/features/patients/api";

const today = new Date().toISOString().slice(0, 10);

// age → approximate DOB (Jan 1 of birth year); refine later if the exact date is known.
function ageToDob(age: string): string | null {
  const n = parseInt(age, 10);
  if (Number.isNaN(n) || n < 0 || n > 130) return null;
  return `${new Date().getFullYear() - n}-01-01`;
}

export function PatientImportPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"single" | "bulk">("single");
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1>Import old records</h1>
          <p className="text-sm text-muted-foreground">
            Bring your existing patients into ClinicOS — keeping their current card numbers. Usually a one-time task when you first set up.
          </p>
        </div>
        <Button variant="ghost" onClick={() => navigate("/patients")}><ArrowLeft /> Patients</Button>
      </div>

      <div className="flex w-fit gap-1 rounded-lg border bg-muted/40 p-1">
        <button onClick={() => setMode("single")} className={"rounded-md px-3 py-1.5 text-sm font-medium " + (mode === "single" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          Add one patient
        </button>
        <button onClick={() => setMode("bulk")} className={"rounded-md px-3 py-1.5 text-sm font-medium " + (mode === "bulk" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          Bulk import (CSV)
        </button>
      </div>

      {mode === "single" ? <SingleImport /> : <BulkImport />}
    </div>
  );
}

// ---------- Single patient ----------

function SingleImport() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({
    mrn: "", first_name: "", middle_name: "", last_name: "", gender: "unknown", dob: "", age: "", phone: "",
    record_date: today, subjective: "", objective: "", assessment: "", plan: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const dob = f.dob || (f.age ? ageToDob(f.age) ?? "" : "");
  const hasHistory = Boolean(f.subjective || f.objective || f.assessment || f.plan);
  const canSave = Boolean(f.first_name.trim() && f.last_name.trim() && dob) && !busy;

  const save = async () => {
    setErr(null);
    if (!f.first_name.trim() || !f.last_name.trim()) return setErr("First and last name are required.");
    if (!dob) return setErr("Enter a date of birth, or an age if the exact date is unknown.");
    setBusy(true);
    try {
      const res = await createPatient(
        { mrn: f.mrn.trim() || undefined, first_name: f.first_name.trim(), middle_name: f.middle_name.trim(), last_name: f.last_name.trim(), gender: f.gender, dob, phone: f.phone.trim() },
        true, // import: skip duplicate prompt (a reused card ID is still rejected server-side)
      );
      if (!res.patient) throw new Error("Could not create the patient.");
      if (f.subjective || f.objective || f.assessment || f.plan) {
        await importHistory(res.patient.id, { date: f.record_date, subjective: f.subjective, objective: f.objective, assessment: f.assessment, plan: f.plan });
      }
      toast.success(`Imported · card ${res.patient.mrn}`);
      qc.invalidateQueries({ queryKey: ["patients"] });
      navigate(`/patients/${res.patient.id}`);
    } catch (e) {
      setErr(e instanceof AppError ? e.message : "Could not import this patient.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      <Card>
        <CardHeader><CardTitle>Patient</CardTitle><CardDescription>Keep their existing card number so records stay continuous.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <Field label="Existing card ID" hint="Their current card / MRN. Leave blank to auto-generate a new one.">
            <Input value={f.mrn} onChange={(e) => set("mrn", e.target.value)} placeholder="e.g. 0087 or HRC-0087" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="First name" required><Input value={f.first_name} onChange={(e) => set("first_name", e.target.value)} /></Field>
            <Field label="Middle name"><Input value={f.middle_name} onChange={(e) => set("middle_name", e.target.value)} /></Field>
            <Field label="Last name" required><Input value={f.last_name} onChange={(e) => set("last_name", e.target.value)} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Sex">
              <Select value={f.gender} onValueChange={(v) => set("gender", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">Male</SelectItem><SelectItem value="female">Female</SelectItem>
                  <SelectItem value="other">Other</SelectItem><SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Date of birth" hint={!f.dob && f.age ? `Using ${dob} from age` : "Or enter age →"}>
              <Input type="date" value={f.dob} onChange={(e) => set("dob", e.target.value)} />
            </Field>
            <Field label="Age (if DOB unknown)">
              <Input type="number" min="0" max="130" value={f.age} onChange={(e) => set("age", e.target.value)} placeholder="yrs" disabled={!!f.dob} />
            </Field>
          </div>
          <Field label="Phone"><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Past history (as recorded)</CardTitle>
          <CardDescription>Paste each section as you have it. Fill only what applies — it's saved as a dated past visit and shows in the patient's timeline.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Record date"><Input type="date" value={f.record_date} max={today} onChange={(e) => set("record_date", e.target.value)} /></Field>
          </div>
          <Field label="History" hint="Presenting complaint, HPI, past / family / personal history."><Textarea rows={6} value={f.subjective} onChange={(e) => set("subjective", e.target.value)} /></Field>
          <Field label="Examination findings"><Textarea rows={5} value={f.objective} onChange={(e) => set("objective", e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Diagnosis / assessment"><Textarea rows={4} value={f.assessment} onChange={(e) => set("assessment", e.target.value)} /></Field>
            <Field label="Treatment / plan"><Textarea rows={4} value={f.plan} onChange={(e) => set("plan", e.target.value)} /></Field>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">{hasHistory ? "History will be saved as a past visit." : "No history entered — patient will be created without a past visit."}</span>
        <Button disabled={!canSave} loading={busy} onClick={save}><UserPlus /> Import patient</Button>
      </div>
    </div>
  );
}

// ---------- Bulk CSV ----------

/** Patient fields we can fill from a legacy sheet. Everything else in the file —
 *  payments, balances, treatment notes — is deliberately ignored. */
const FIELDS = [
  { key: "name", label: "Name", required: true, aliases: ["name", "patient name", "full name", "fullname", "patient", "patients name", "patient's name"] },
  { key: "phone", label: "Phone number", required: false, aliases: ["phone number", "phone", "phone no", "mobile", "mobile number", "tel", "telephone", "contact", "contact number"] },
  { key: "gender", label: "Sex", required: false, aliases: ["sex", "gender"] },
  { key: "age", label: "Age", required: false, aliases: ["age", "age years", "years", "yrs"] },
  { key: "visit_date", label: "Date of visit", required: false, aliases: ["date of visit", "visit date", "date", "dov", "registration date", "first visit", "first visit date"] },
  { key: "mrn", label: "Card ID (optional)", required: false, aliases: ["card id", "card no", "card", "file number", "file no", "patient number", "mrn", "chart number"] },
] as const;
type FieldKey = (typeof FIELDS)[number]["key"];

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9ሀ-፿ ]/g, " ").replace(/\s+/g, " ").trim();

/** Best-guess mapping of CSV columns onto patient fields (exact alias match first,
 *  then a contains match), so a clinic usually only has to confirm what we found. */
function detectMapping(header: string[]): Record<FieldKey, number> {
  const norm = header.map(normHeader);
  const used = new Set<number>();
  const map = {} as Record<FieldKey, number>;
  for (const f of FIELDS) {
    const aliases = f.aliases as readonly string[];
    let hit = norm.findIndex((h, i) => !used.has(i) && aliases.includes(h));
    if (hit < 0) hit = norm.findIndex((h, i) => !used.has(i) && h !== "" && aliases.some((a) => h === a || h.includes(a)));
    map[f.key] = hit;
    if (hit >= 0) used.add(hit);
  }
  return map;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function downloadCSV(filename: string, header: string[], rows: string[][]) {
  const body = [header, ...rows].map((r) => r.map((c) => csvCell(c ?? "")).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Minimal RFC-4180-ish parser (handles quoted fields with commas / doubled quotes).
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const BATCH = 300; // rows per request — keeps payloads and server memory bounded

/** Mirrors the server's date detection just closely enough to preview one cell.
 *  The server remains the authority; this only reassures staff before they commit. */
function previewDate(raw: string, calendar: "ethiopian" | "gregorian"): string | null {
  const s = raw.trim();
  let y = 0, m = 0, d = 0;
  const serial = Number(s);
  if (s !== "" && !Number.isNaN(serial)) {
    if (serial < 20000 || serial > 60000) return null;
    const g = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    [y, m, d] = [g.getUTCFullYear(), g.getUTCMonth() + 1, g.getUTCDate()];
  } else {
    const p = s.split(/[/\\.\-\s]+/).map(Number);
    if (p.length !== 3 || p.some(Number.isNaN)) return null;
    const maxMonth = calendar === "ethiopian" ? 13 : 12;
    if (p[0] > 31) [y, m, d] = p; // year first
    else {
      y = p[2]; // year last — incl. the short "13/6/17" form
      if (p[1] > maxMonth) { m = p[0]; d = p[1]; } else { d = p[0]; m = p[1]; }
    }
    if (y < 100) y += y > 50 ? 1900 : 2000; // 17 → 2017, 98 → 1998
  }
  try {
    const iso = calendar === "ethiopian" ? ethiopianToGregorianISO(y, m, d)
      : `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dt = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return null;
  }
}

function BulkImport() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [override, setOverride] = useState<Partial<Record<FieldKey, number>>>({});
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "update">("skip");
  const [calendar, setCalendar] = useState<"ethiopian" | "gregorian">("ethiopian");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<ImportReport | null>(null);
  const [showFailed, setShowFailed] = useState(false);

  const grid = useMemo(() => (text.trim() ? parseCSV(text) : []), [text]);
  const header = grid.length ? grid[0].map((h) => h.trim()) : [];
  const bodyRows = grid.slice(1);
  const detected = useMemo(() => (header.length ? detectMapping(header) : null), [header.join("")]);
  const map = useMemo(() => (detected ? { ...detected, ...override } : null), [detected, override]);

  // Only the mapped columns are read; everything else in the sheet is left alone.
  const rows: ImportRowInput[] = useMemo(() => {
    if (!map) return [];
    const cell = (r: string[], i: number | undefined) => (i !== undefined && i >= 0 ? (r[i] ?? "").trim() : "");
    return bodyRows
      .map((r, i) => ({
        row_number: i + 2, // +2 = 1-based, past the header
        name: cell(r, map.name),
        phone: cell(r, map.phone),
        gender: cell(r, map.gender),
        age: cell(r, map.age),
        visit_date: cell(r, map.visit_date),
        mrn: cell(r, map.mrn),
      }))
      .filter((r) => r.name || r.phone || r.age);
  }, [bodyRows, map]);

  const ignored = header.filter((_, i) => !map || !Object.values(map).includes(i));
  const nameMapped = !!map && map.name >= 0;

  // Show the first real date converted, so staff can confirm the calendar is right
  // before importing thousands of rows against the wrong one.
  const datePreview = useMemo(() => {
    const sample = rows.find((r) => r.visit_date)?.visit_date;
    if (!sample) return "Dates are stored as Gregorian.";
    const g = previewDate(sample, calendar);
    return g ? `"${sample}" → ${g}` : `"${sample}" isn't a date we can read.`;
  }, [rows, calendar]);

  const reset = (t: string) => { setText(t); setReport(null); setOverride({}); setShowFailed(false); };

  const onFile = async (file?: File) => {
    if (!file) return;
    reset(await file.text());
  };

  const downloadTemplate = () =>
    downloadCSV("clinicos-patient-import-template.csv",
      ["NUMBER", "Date of Visit", "Name", "Phone Number", "Sex", "Age", "Notes"],
      [["1", "13/06/2017", "Abebe Kebede", "0911223344", "M", "34", "ignored"],
       ["2", "42922", "Almaz Tesfaye Bekele", "+251912345678", "Female", "27", "ignored"]]);

  /** Runs the file in batches so memory stays flat and progress is visible.
   *  Reports are merged; a failed batch is recorded without stopping the rest. */
  const run = async (dryRun: boolean) => {
    setRunning(true);
    setShowFailed(false);
    setProgress({ done: 0, total: rows.length });
    const merged: ImportReport = {
      total: 0, imported: 0, updated: 0, duplicates: 0, failed: 0,
      missing_phone: 0, missing_gender: 0, estimated_dob: 0, dry_run: dryRun, rows: [],
    };
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);
        try {
          const rep = await importPatients({ rows: chunk, dry_run: dryRun, on_duplicate: onDuplicate, calendar });
          merged.total += rep.total; merged.imported += rep.imported; merged.updated += rep.updated;
          merged.duplicates += rep.duplicates; merged.failed += rep.failed;
          merged.missing_phone += rep.missing_phone; merged.missing_gender += rep.missing_gender;
          merged.estimated_dob += rep.estimated_dob;
          merged.rows.push(...rep.rows);
        } catch (e) {
          // A whole batch failed (network / server). Mark its rows and keep going.
          const msg = e instanceof AppError ? e.message : "Could not reach the server";
          merged.total += chunk.length;
          merged.failed += chunk.length;
          merged.rows.push(...chunk.map((r) => ({
            row_number: r.row_number, name: r.name, phone: r.phone ?? "", gender: r.gender ?? "",
            age: r.age ?? "", visit_date: r.visit_date ?? "", outcome: "failed" as const, reason: msg,
          })));
        }
        setProgress({ done: Math.min(i + BATCH, rows.length), total: rows.length });
      }
      setReport(merged);
      if (!dryRun) {
        qc.invalidateQueries({ queryKey: ["patients"] });
        toast.success(`Imported ${merged.imported} patient${merged.imported === 1 ? "" : "s"}`);
      } else {
        toast.success("Check complete — nothing was saved");
      }
    } finally {
      setRunning(false);
    }
  };

  const failedRows = report?.rows.filter((r) => r.outcome === "failed") ?? [];
  const successRate = report && report.total > 0
    ? Math.round(((report.imported + report.updated) / report.total) * 100) : 0;

  const downloadFailed = () =>
    downloadCSV("failed-rows.csv",
      ["OriginalRowNumber", "Name", "PhoneNumber", "Gender", "Age", "DateOfVisit", "FailureReason"],
      failedRows.map((r) => [String(r.row_number), r.name, r.phone, r.gender, r.age, r.visit_date, r.reason ?? ""]));

  const downloadReport = () =>
    downloadCSV("import-report.csv",
      ["OriginalRowNumber", "Name", "PhoneNumber", "Gender", "Age", "DateOfVisit", "Outcome", "CardID", "Detail"],
      (report?.rows ?? []).map((r) => [String(r.row_number), r.name, r.phone, r.gender, r.age, r.visit_date,
        r.outcome, r.mrn ?? "", r.reason || r.warning || ""]));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Bulk import from a spreadsheet</CardTitle>
          <CardDescription>
            Upload your old register as a CSV. Only patient details are read — <b>Name, Phone, Sex, Age and Date of Visit</b>.
            Payments, balances, history and any other column are ignored.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={downloadTemplate}><Download /> Download template</Button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <Button variant="outline" onClick={() => fileRef.current?.click()}><FileUp /> Choose CSV file</Button>
          </div>
          <Field label="…or paste CSV">
            <Textarea rows={4} value={text} onChange={(e) => reset(e.target.value)}
              placeholder={"NUMBER,Date of Visit,Name,Phone Number,Sex,Age\n1,13/06/2017,Abebe Kebede,0911223344,M,34"}
              className="font-mono text-xs" />
          </Field>
          {text.trim() && grid.length < 2 && (
            <Alert variant="destructive"><AlertDescription>Add a header row and at least one patient row.</AlertDescription></Alert>
          )}
        </CardContent>
      </Card>

      {header.length > 0 && map && (
        <Card>
          <CardHeader>
            <CardTitle>Column mapping</CardTitle>
            <CardDescription>We matched your headings automatically — correct anything we got wrong.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} required={f.required}>
                  <Select value={String(map[f.key])} onValueChange={(v) => setOverride((o) => ({ ...o, [f.key]: Number(v) }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="-1">— not in my file —</SelectItem>
                      {header.map((h, i) => <SelectItem key={i} value={String(i)}>{h || `Column ${i + 1}`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              ))}
            </div>
            {!nameMapped && <Alert variant="destructive"><AlertDescription>Pick the column that holds the patient's name — it's the one field we can't import without.</AlertDescription></Alert>}
            {ignored.length > 0 && (
              <p className="text-xs text-muted-foreground"><b>Ignored columns:</b> {ignored.filter(Boolean).join(", ") || "—"}</p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Dates in my file are" hint={datePreview}>
                <Select value={calendar} onValueChange={(v) => setCalendar(v as "ethiopian" | "gregorian")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ethiopian">Ethiopian (ዓ.ም)</SelectItem>
                    <SelectItem value="gregorian">Gregorian</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="If a patient is already on file" hint="Matched by phone, then name + age, then a very similar name.">
                <Select value={onDuplicate} onValueChange={(v) => setOnDuplicate(v as "skip" | "update")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">Skip them (recommended)</SelectItem>
                    <SelectItem value="update">Update their details from this file</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && map && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
            <div>
              <CardTitle>Preview</CardTitle>
              <CardDescription>{rows.length} row{rows.length === 1 ? "" : "s"} found{rows.length > 10 ? " — showing the first 10" : ""}.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" loading={running} disabled={running || !nameMapped} onClick={() => run(true)}>
                <ListChecks /> Check file
              </Button>
              <Button loading={running} disabled={running || !nameMapped} onClick={() => run(false)}>
                <UploadCloud /> Import {rows.length}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {running && <p className="mb-3 text-sm text-muted-foreground">Working… {progress.done} of {progress.total}</p>}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="p-2">Row</th><th>Name</th><th>Phone</th><th>Sex</th><th>Age</th><th className="p-2">Date of visit</th></tr>
                </thead>
                <tbody>
                  {rows.slice(0, 10).map((r) => (
                    <tr key={r.row_number} className="border-b last:border-0">
                      <td className="p-2 font-mono text-xs text-muted-foreground">{r.row_number}</td>
                      <td>{r.name || <span className="text-destructive">missing</span>}</td>
                      <td>{r.phone || "—"}</td>
                      <td>{r.gender || "—"}</td>
                      <td>{r.age || "—"}</td>
                      <td className="p-2">{r.visit_date || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {report && (
        <Card>
          <CardHeader>
            <CardTitle>{report.dry_run ? "Check results — nothing was saved" : "Import complete"}</CardTitle>
            <CardDescription>{successRate}% of {report.total} rows {report.dry_run ? "are ready to import" : "went in"}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="flex items-center gap-1.5 font-medium text-emerald-600">
                <CheckCircle2 className="h-4 w-4" /> {report.imported} {report.dry_run ? "ready to import" : "imported"}
              </span>
              {report.updated > 0 && <span className="font-medium text-brand">{report.updated} updated</span>}
              {report.duplicates > 0 && <span className="font-medium text-amber-600">{report.duplicates} already on file</span>}
              {report.failed > 0 && (
                <span className="flex items-center gap-1.5 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" /> {report.failed} row{report.failed === 1 ? "" : "s"} failed
                </span>
              )}
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span>Rows without a phone number: <b>{report.missing_phone}</b></span>
              <span>Rows without a sex: <b>{report.missing_gender}</b></span>
              <span>Birthdates estimated from age: <b>{report.estimated_dob}</b></span>
            </div>
            {report.estimated_dob > 0 && (
              <Alert>
                <AlertDescription className="text-xs">
                  Legacy sheets record an age, not a birthdate, so we stored 1 January of the implied birth year and flagged it as
                  approximate. Confirm the real date on the patient's next visit before using it for age-sensitive dosing.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              {failedRows.length > 0 && (
                <>
                  <Button variant="outline" size="sm" onClick={downloadFailed}><FileDown /> Download failed rows</Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowFailed((s) => !s)}>
                    <Eye /> {showFailed ? "Hide" : "View"} failed rows
                  </Button>
                </>
              )}
              <Button variant="outline" size="sm" onClick={downloadReport}><Download /> Download full report</Button>
            </div>

            {showFailed && failedRows.length > 0 && (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                    <tr><th className="p-2">Row</th><th>Name</th><th>Phone</th><th className="p-2">Why it failed</th></tr>
                  </thead>
                  <tbody>
                    {failedRows.map((r) => (
                      <tr key={r.row_number} className="border-b last:border-0">
                        <td className="p-2 font-mono text-xs text-muted-foreground">{r.row_number}</td>
                        <td>{r.name || <span className="italic text-muted-foreground">empty</span>}</td>
                        <td className="font-mono text-xs">{r.phone || "—"}</td>
                        <td className="p-2 text-destructive">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report.rows.some((r) => r.outcome === "duplicate") && (
              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer font-medium">Rows already on file ({report.duplicates})</summary>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {report.rows.filter((r) => r.outcome === "duplicate").slice(0, 50).map((r) => (
                    <li key={r.row_number}>Row {r.row_number} · {r.name} — {r.reason}{r.mrn ? ` (card ${r.mrn})` : ""}</li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label} {required && <span className="text-destructive">*</span>}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
