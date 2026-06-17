import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import {
  createBranch,
  createDepartment,
  getClinic,
  getSettings,
  listBranches,
  listDepartments,
  saveClinic,
  saveSettings,
  type ClinicSettings,
} from "@/features/admin/api";
import {
  createCatalogEntry,
  createCategory,
  deleteCatalogEntry,
  listDiagnosisCategories,
  searchCatalog,
} from "@/features/clinical/api";

export function SettingsPage() {
  const { can } = useAuth();
  const manage = can("clinic.manage");
  const qc = useQueryClient();

  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });

  const [clinicName, setClinicName] = useState("");
  useEffect(() => {
    if (clinic.data?.name) setClinicName(clinic.data.name);
  }, [clinic.data?.name]);

  const saveClinicMut = useMutation({
    mutationFn: () => saveClinic({ name: clinicName }),
    onSuccess: () => {
      toast.success("Clinic profile saved");
      qc.invalidateQueries({ queryKey: ["clinic"] });
    },
  });

  const [branchName, setBranchName] = useState("");
  const [branchCode, setBranchCode] = useState("");
  const addBranchMut = useMutation({
    mutationFn: () => createBranch({ name: branchName, code: branchCode }),
    onSuccess: () => {
      toast.success("Branch added");
      setBranchName("");
      setBranchCode("");
      qc.invalidateQueries({ queryKey: ["branches"] });
    },
    onError: () => toast.error("Could not add branch (code may be taken)"),
  });

  const [deptName, setDeptName] = useState("");
  const [deptBranch, setDeptBranch] = useState("");
  const [deptSpecialty, setDeptSpecialty] = useState("");
  const addDeptMut = useMutation({
    mutationFn: () => createDepartment({ branch_id: deptBranch, name: deptName, specialty: deptSpecialty }),
    onSuccess: () => {
      toast.success("Department added");
      setDeptName("");
      setDeptSpecialty("");
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
  });

  return (
    <div className="space-y-6">
      <h1>Clinic settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Clinic profile</CardTitle>
          <CardDescription>The clinic name shown across the workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-md items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label>Name</Label>
              <Input value={clinicName} onChange={(e) => setClinicName(e.target.value)} disabled={!manage} />
            </div>
            {manage && (
              <Button onClick={() => saveClinicMut.mutate()} disabled={!clinicName} loading={saveClinicMut.isPending}>
                Save
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <FlowSettingsCard manage={manage} />

      <Card>
        <CardHeader>
          <CardTitle>Branches</CardTitle>
          <CardDescription>Physical locations of the clinic.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {(branches.data ?? []).map((b) => (
              <li key={b.id} className="flex items-center justify-between rounded-md border bg-background p-2.5 text-sm">
                <span>
                  <span className="font-medium">{b.name}</span>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{b.code}</span>
                </span>
                <Badge variant={b.is_active ? "success" : "outline"}>{b.is_active ? "active" : "inactive"}</Badge>
              </li>
            ))}
            {branches.data?.length === 0 && <p className="text-sm text-muted-foreground">No branches yet.</p>}
          </ul>
          {manage && (
            <div className="flex flex-wrap items-end gap-3 border-t pt-4">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input value={branchCode} onChange={(e) => setBranchCode(e.target.value)} />
              </div>
              <Button onClick={() => addBranchMut.mutate()} disabled={!branchName || !branchCode} loading={addBranchMut.isPending}>
                <Plus /> Add branch
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Departments</CardTitle>
          <CardDescription>Specialty units within a branch.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {(departments.data ?? []).map((d) => (
              <li key={d.id} className="rounded-md border bg-background p-2.5 text-sm">
                <span className="font-medium">{d.name}</span>
                {d.specialty ? <span className="text-muted-foreground"> · {d.specialty}</span> : null}
              </li>
            ))}
            {departments.data?.length === 0 && <p className="text-sm text-muted-foreground">No departments yet.</p>}
          </ul>
          {manage && (branches.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-end gap-3 border-t pt-4">
              <div className="w-48 space-y-1.5">
                <Label>Branch</Label>
                <Select value={deptBranch} onValueChange={setDeptBranch}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(branches.data ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={deptName} onChange={(e) => setDeptName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Specialty</Label>
                <Input value={deptSpecialty} onChange={(e) => setDeptSpecialty(e.target.value)} />
              </div>
              <Button onClick={() => addDeptMut.mutate()} disabled={!deptBranch || !deptName} loading={addDeptMut.isPending}>
                <Plus /> Add department
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <DiagnosisCatalogCard manage={manage} />
    </div>
  );
}

function DiagnosisCatalogCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const categories = useQuery({ queryKey: ["diag-categories"], queryFn: listDiagnosisCategories });
  const entries = useQuery({ queryKey: ["diag-catalog-all"], queryFn: () => searchCatalog({ all: true }) });

  const [catName, setCatName] = useState("");
  const addCat = useMutation({
    mutationFn: () => createCategory({ name: catName }),
    onSuccess: () => {
      toast.success("Category added");
      setCatName("");
      qc.invalidateQueries({ queryKey: ["diag-categories"] });
    },
    onError: () => toast.error("Could not add category (name may exist)"),
  });

  const [entry, setEntry] = useState({ category_id: "", code: "", name: "" });
  const addEntry = useMutation({
    mutationFn: () => createCatalogEntry({ category_id: entry.category_id, code: entry.code || undefined, name: entry.name }),
    onSuccess: () => {
      toast.success("Diagnosis added");
      setEntry({ category_id: entry.category_id, code: "", name: "" });
      qc.invalidateQueries({ queryKey: ["diag-catalog-all"] });
    },
    onError: () => toast.error("Could not add diagnosis (code may exist)"),
  });
  const removeEntry = useMutation({
    mutationFn: (id: string) => deleteCatalogEntry(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diag-catalog-all"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Diagnosis catalog</CardTitle>
        <CardDescription>Disease categories and the diagnoses doctors pick from during a consultation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Categories */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Categories</Label>
          <div className="flex flex-wrap gap-2">
            {(categories.data ?? []).map((c) => (
              <Badge key={c.id} variant="outline">{c.name}</Badge>
            ))}
            {categories.data?.length === 0 && <span className="text-sm text-muted-foreground">No categories yet.</span>}
          </div>
          {manage && (
            <div className="flex items-end gap-2 pt-1">
              <div className="space-y-1.5">
                <Label>New category</Label>
                <Input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="e.g. Dermatology" />
              </div>
              <Button onClick={() => addCat.mutate()} disabled={!catName.trim()} loading={addCat.isPending}>
                <Plus /> Add
              </Button>
            </div>
          )}
        </div>

        {/* Entries */}
        <div className="space-y-2 border-t pt-4">
          <Label className="text-xs text-muted-foreground">Diagnoses</Label>
          <ul className="max-h-72 space-y-1.5 overflow-auto">
            {(entries.data ?? []).map((e) => (
              <li key={e.id} className="flex items-center justify-between rounded-md border bg-background p-2 text-sm">
                <span>
                  {e.code ? <span className="font-mono text-xs text-muted-foreground">{e.code} </span> : null}
                  {e.name} <span className="text-xs text-muted-foreground">· {e.category_name}</span>
                </span>
                {manage && (
                  <button onClick={() => removeEntry.mutate(e.id)} className="text-xs text-muted-foreground hover:text-destructive">
                    Remove
                  </button>
                )}
              </li>
            ))}
            {entries.data?.length === 0 && <p className="text-sm text-muted-foreground">No diagnoses yet.</p>}
          </ul>
          {manage && (categories.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-end gap-3 border-t pt-4">
              <div className="w-44 space-y-1.5">
                <Label>Category</Label>
                <Select value={entry.category_id} onValueChange={(v) => setEntry({ ...entry, category_id: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(categories.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-28 space-y-1.5">
                <Label>ICD code</Label>
                <Input value={entry.code} onChange={(e) => setEntry({ ...entry, code: e.target.value })} placeholder="J02.9" />
              </div>
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={entry.name} onChange={(e) => setEntry({ ...entry, name: e.target.value })} placeholder="Acute pharyngitis" />
              </div>
              <Button onClick={() => addEntry.mutate()} disabled={!entry.category_id || !entry.name.trim()} loading={addEntry.isPending}>
                <Plus /> Add diagnosis
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function FlowSettingsCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: false });

  const [form, setForm] = useState<ClinicSettings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      saveSettings({
        card_fee_enabled: form!.card_fee_enabled,
        card_fee_amount: Number(form!.card_fee_amount) || 0,
        card_currency: form!.card_currency || "ETB",
        free_window_days: form!.free_window_days,
        triage_required: form!.triage_required,
        doctor_assignment: form!.doctor_assignment,
        payment_mode: form!.payment_mode || "reception",
      }),
    onSuccess: () => {
      toast.success("Flow settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: () => toast.error("Could not save settings"),
  });

  if (!form) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Patient flow</CardTitle>
          <CardDescription>Card fee, triage, and doctor assignment.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {settings.isError ? "Save the clinic profile first to configure the flow." : "Loading…"}
          </p>
        </CardContent>
      </Card>
    );
  }

  const set = <K extends keyof ClinicSettings>(k: K, v: ClinicSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const disabled = !manage;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Patient flow</CardTitle>
        <CardDescription>How patients are charged and routed. Walk-ins always pay; a doctor-booked follow-up is free within its window.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Card / consultation fee</Label>
            <Select value={form.card_fee_enabled ? "on" : "off"} onValueChange={(v) => set("card_fee_enabled", v === "on")}>
              <SelectTrigger disabled={disabled}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on">Charged</SelectItem>
                <SelectItem value="off">Not charged</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Fee amount</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={form.card_fee_amount}
              onChange={(e) => set("card_fee_amount", e.target.value)}
              disabled={disabled || !form.card_fee_enabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Currency</Label>
            <Input value={form.card_currency} onChange={(e) => set("card_currency", e.target.value)} disabled={disabled} />
          </div>
          <div className="space-y-1.5">
            <Label>Follow-up free window (days)</Label>
            <Input
              type="number"
              value={form.free_window_days}
              onChange={(e) => set("free_window_days", Number(e.target.value))}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Triage step</Label>
            <Select value={form.triage_required ? "on" : "off"} onValueChange={(v) => set("triage_required", v === "on")}>
              <SelectTrigger disabled={disabled}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on">Required (default)</SelectItem>
                <SelectItem value="off">Optional</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Doctor assignment</Label>
            <Select value={form.doctor_assignment} onValueChange={(v) => set("doctor_assignment", v)}>
              <SelectTrigger disabled={disabled}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual (reception/nurse)</SelectItem>
                <SelectItem value="auto">Auto (next available)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Payment collection</Label>
            <Select value={form.payment_mode || "reception"} onValueChange={(v) => set("payment_mode", v)}>
              <SelectTrigger disabled={disabled}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reception">Reception collects (inline)</SelectItem>
                <SelectItem value="cashier">Separate cashier (pay then proceed)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {manage && (
          <div className="border-t pt-4">
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save flow settings
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
