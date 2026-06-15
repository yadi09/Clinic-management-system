import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FlaskConical, Send, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { accession, getItem, saveResults, submitResults, validateItem, type AnalyteResult, type OrderItemDetail } from "@/features/lab/api";

const FLAG: Record<string, { label: string; cls: string }> = {
  normal: { label: "Normal", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  low: { label: "Low", cls: "border-sky-300 bg-sky-50 text-sky-700" },
  high: { label: "High", cls: "border-amber-300 bg-amber-50 text-amber-700" },
  critical: { label: "Critical", cls: "border-rose-300 bg-rose-50 text-rose-700" },
};

// previewFlag mirrors the server's reference-range check for live feedback while
// typing (critical bounds aren't sent to the client, so the server may upgrade
// "high"/"low" to "critical" on save).
function previewFlag(value: string, a: AnalyteResult): string {
  const v = parseFloat(value);
  if (!value.trim() || Number.isNaN(v)) return "normal";
  const lo = a.ref_low ? parseFloat(a.ref_low) : NaN;
  const hi = a.ref_high ? parseFloat(a.ref_high) : NaN;
  if (!Number.isNaN(lo) && v < lo) return "low";
  if (!Number.isNaN(hi) && v > hi) return "high";
  return "normal";
}

export function LabOrderItemPage() {
  const { itemId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["lab-item", itemId], queryFn: () => getItem(itemId), enabled: !!itemId });

  if (q.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading sample…</div>;
  if (q.isError || !q.data) return <div className="p-8 text-sm text-destructive">Could not load this sample.</div>;

  return <ItemInner d={q.data} onChanged={() => qc.invalidateQueries({ queryKey: ["lab-item", itemId] })} onBack={() => navigate("/lab")} />;
}

function ItemInner({ d, onChanged, onBack }: { d: OrderItemDetail; onChanged: () => void; onBack: () => void }) {
  const { can } = useAuth();
  const canValidate = can("lab.validate");
  const editable = d.status === "collected" || d.status === "in_process";
  const released = d.status === "validated";

  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    const init: Record<string, string> = {};
    for (const a of d.analytes) init[a.analyte_id] = a.value ?? "";
    setVals(init);
  }, [d]);

  const collect = useMutation({
    mutationFn: () => accession(d.id),
    onSuccess: () => { toast.success("Sample received"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not accession"),
  });
  const save = useMutation({
    mutationFn: () => saveResults(d.id, d.analytes.map((a) => ({ analyte_id: a.analyte_id, value: vals[a.analyte_id] ?? "" })).filter((r) => r.value.trim() !== "")),
    onSuccess: () => { toast.success("Results saved"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });
  const submit = useMutation({
    mutationFn: async () => {
      await saveResults(d.id, d.analytes.map((a) => ({ analyte_id: a.analyte_id, value: vals[a.analyte_id] ?? "" })).filter((r) => r.value.trim() !== ""));
      await submitResults(d.id);
    },
    onSuccess: () => { toast.success("Results submitted for validation"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not submit"),
  });
  const release = useMutation({
    mutationFn: () => validateItem(d.id),
    onSuccess: () => { toast.success("Validated & released to the ordering doctor"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not validate"),
  });

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Worklist
      </button>

      {/* Banner */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-brand px-5 py-4 text-white">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15">
          <FlaskConical className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-lg font-semibold leading-tight">{d.test_name}</p>
          <p className="text-xs text-white/70">
            Sample S-{d.sample_no} · {d.patient_name} · MRN {d.mrn}
            {d.ordered_by ? ` · ordered by ${d.ordered_by}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="border-white/30 text-white">{d.priority}</Badge>
          <Badge variant="outline" className="border-white/30 text-white">{d.status.replace("_", " ")}</Badge>
        </div>
      </div>

      {d.clinical_note && (
        <Card className="p-3 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Clinical note</span>
          <p>{d.clinical_note}</p>
        </Card>
      )}

      {/* Step 1 — accession */}
      {d.status === "ordered" && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h2 className="text-h3">Receive sample</h2>
            <p className="text-sm text-muted-foreground">
              Mark the {d.specimen || "specimen"} as collected to begin result entry.
            </p>
          </div>
          <Button className="bg-primary" loading={collect.isPending} onClick={() => collect.mutate()}>
            <Check className="h-4 w-4" /> Receive &amp; accession
          </Button>
        </Card>
      )}

      {/* Step 2/3 — results table */}
      {(editable || d.status === "resulted" || released) && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-h3">Results</h2>
            {released && (
              <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">
                <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Validated
              </Badge>
            )}
          </div>
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 font-medium">Analyte</th>
                <th className="font-medium">Reference</th>
                <th className="font-medium">Value</th>
                <th className="py-2 font-medium">Flag</th>
              </tr>
            </thead>
            <tbody>
              {d.analytes.map((a) => {
                const v = vals[a.analyte_id] ?? a.value ?? "";
                const flag = editable ? previewFlag(v, a) : a.flag || "normal";
                const ref = [a.ref_low, a.ref_high].some(Boolean) ? `${a.ref_low ?? ""}–${a.ref_high ?? ""}${a.unit ? ` ${a.unit}` : ""}` : "—";
                return (
                  <tr key={a.analyte_id} className="border-b last:border-0">
                    <td className="py-2">{a.name}</td>
                    <td className="text-xs text-muted-foreground">{ref}</td>
                    <td className="w-40">
                      {editable ? (
                        <Input
                          className="h-8 w-32"
                          value={vals[a.analyte_id] ?? ""}
                          placeholder={a.unit || ""}
                          onChange={(e) => setVals({ ...vals, [a.analyte_id]: e.target.value })}
                        />
                      ) : (
                        <span className="font-medium">{a.value || "—"}{a.value && a.unit ? ` ${a.unit}` : ""}</span>
                      )}
                    </td>
                    <td className="py-2">
                      {v.trim() ? (
                        <Badge variant="outline" className={FLAG[flag]?.cls ?? FLAG.normal.cls}>
                          {FLAG[flag]?.label ?? flag}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {editable && (
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" loading={save.isPending} onClick={() => save.mutate()}>
                Save draft
              </Button>
              <Button className="bg-primary" loading={submit.isPending} onClick={() => submit.mutate()}>
                <Send className="h-4 w-4" /> Submit for validation
              </Button>
            </div>
          )}

          {d.status === "resulted" && (
            <div className="mt-4 flex items-center justify-end gap-2">
              {canValidate ? (
                <Button className="bg-primary" loading={release.isPending} onClick={() => release.mutate()}>
                  <ShieldCheck className="h-4 w-4" /> Validate &amp; release
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">Awaiting validation by a lab supervisor.</p>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
