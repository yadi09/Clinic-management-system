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
  createAllergen,
  createCatalogEntry,
  createCategory,
  createDrug,
  deleteAllergen,
  deleteCatalogEntry,
  deleteDrug,
  getVitalFields,
  listAllergens,
  listDiagnosisCategories,
  saveVitalFields,
  searchCatalog,
  searchDrugs,
  updateDrug,
  type Drug,
  type VitalField,
} from "@/features/clinical/api";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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

      <VitalsFormCard manage={manage} />

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

      <DrugLibraryCard manage={manage} />
    </div>
  );
}

function DrugLibraryCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const drugs = useQuery({ queryKey: ["drugs-all", search], queryFn: () => searchDrugs(search, true) });
  const allergens = useQuery({ queryKey: ["allergens-all"], queryFn: () => listAllergens(undefined, true) });
  const [editing, setEditing] = useState<Drug | "new" | null>(null);

  const [newAllergen, setNewAllergen] = useState("");
  const addAllergen = useMutation({
    mutationFn: () => createAllergen(newAllergen.trim()),
    onSuccess: () => { setNewAllergen(""); qc.invalidateQueries({ queryKey: ["allergens-all"] }); qc.invalidateQueries({ queryKey: ["allergens"] }); },
    onError: () => toast.error("Could not add allergen (may already exist)"),
  });
  const removeAllergen = useMutation({
    mutationFn: (id: string) => deleteAllergen(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["allergens-all"] }); qc.invalidateQueries({ queryKey: ["allergens"] }); },
  });
  const removeDrug = useMutation({
    mutationFn: (id: string) => deleteDrug(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drugs-all"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Drug library</CardTitle>
        <CardDescription>Drugs the doctor picks from when prescribing — defaults auto-fill, and allergen tags trigger an allergy warning. Doctors can also add drugs while prescribing.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Allergens */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Allergens</Label>
          <div className="flex flex-wrap gap-1.5">
            {(allergens.data ?? []).map((a) => (
              <span key={a.id} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${a.is_active ? "" : "opacity-50"}`}>
                {a.name}
                {manage && <button onClick={() => removeAllergen.mutate(a.id)} className="text-muted-foreground hover:text-destructive"><Plus className="h-3 w-3 rotate-45" /></button>}
              </span>
            ))}
            {(allergens.data?.length ?? 0) === 0 && <span className="text-sm text-muted-foreground">No allergens yet.</span>}
          </div>
          {manage && (
            <div className="flex items-end gap-2 pt-1">
              <Input value={newAllergen} onChange={(e) => setNewAllergen(e.target.value)} placeholder="e.g. Penicillin" className="h-8 w-56" />
              <Button size="sm" onClick={() => addAllergen.mutate()} disabled={!newAllergen.trim()} loading={addAllergen.isPending}><Plus /> Add allergen</Button>
            </div>
          )}
        </div>

        {/* Drugs */}
        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs text-muted-foreground">Drugs</Label>
            {manage && <Button size="sm" variant="outline" onClick={() => setEditing("new")}><Plus /> Add drug</Button>}
          </div>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search drugs…" className="h-8" />
          <ul className="max-h-80 space-y-1.5 overflow-auto">
            {(drugs.data ?? []).map((d) => (
              <li key={d.id} className={`flex items-center justify-between gap-3 rounded-md border bg-background p-2 text-sm ${d.is_active ? "" : "opacity-50"}`}>
                <div className="min-w-0">
                  <span className="font-medium">{d.name}</span>
                  <span className="text-muted-foreground"> · {[d.default_dose, d.default_frequency, d.default_duration].filter(Boolean).join(" · ") || "no defaults"}</span>
                  {d.allergens.length > 0 && <span className="ml-1 text-xs text-warning">⚠ {d.allergens.join(", ")}</span>}
                </div>
                {manage && (
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => setEditing(d)} className="text-xs text-muted-foreground hover:text-foreground">Edit</button>
                    <button onClick={() => removeDrug.mutate(d.id)} className="text-xs text-muted-foreground hover:text-destructive">Remove</button>
                  </div>
                )}
              </li>
            ))}
            {(drugs.data?.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">No drugs yet.</p>}
          </ul>
        </div>
      </CardContent>

      {editing && <DrugDialog drug={editing === "new" ? null : editing} allergens={(allergens.data ?? []).filter((a) => a.is_active)} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["drugs-all"] }); }} />}
    </Card>
  );
}

function DrugDialog({ drug, allergens, onClose, onSaved }: { drug: Drug | null; allergens: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: drug?.name ?? "", default_dose: drug?.default_dose ?? "", default_frequency: drug?.default_frequency ?? "",
    default_duration: drug?.default_duration ?? "", default_instructions: drug?.default_instructions ?? "",
  });
  // Map current allergen names → ids (drug stores names; match against the library).
  const initialIds = allergens.filter((a) => (drug?.allergens ?? []).some((n) => n.toLowerCase() === a.name.toLowerCase())).map((a) => a.id);
  const [allergenIds, setAllergenIds] = useState<string[]>(initialIds);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (id: string) => setAllergenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const save = useMutation({
    mutationFn: async () => {
      if (drug) await updateDrug(drug.id, { ...form, is_active: true, allergen_ids: allergenIds });
      else await createDrug({ ...form, allergen_ids: allergenIds });
    },
    onSuccess: () => { toast.success(drug ? "Drug updated" : "Drug added"); onSaved(); },
    onError: () => toast.error("Could not save the drug (name may already exist)"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{drug ? "Edit drug" : "New drug"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Amoxicillin 500mg" /></div>
          <div className="space-y-1.5"><Label>Default dose</Label><Input value={form.default_dose} onChange={(e) => set("default_dose", e.target.value)} placeholder="1 cap" /></div>
          <div className="space-y-1.5"><Label>Default frequency</Label><Input value={form.default_frequency} onChange={(e) => set("default_frequency", e.target.value)} placeholder="three times a day" /></div>
          <div className="space-y-1.5"><Label>Default duration</Label><Input value={form.default_duration} onChange={(e) => set("default_duration", e.target.value)} placeholder="5 days" /></div>
          <div className="col-span-2 space-y-1.5"><Label>Default instructions</Label><Input value={form.default_instructions} onChange={(e) => set("default_instructions", e.target.value)} placeholder="Complete the full course" /></div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Allergen tags</Label>
          <div className="flex flex-wrap gap-1.5">
            {allergens.map((a) => (
              <button key={a.id} type="button" onClick={() => toggle(a.id)} className={`rounded-full border px-2.5 py-1 text-xs ${allergenIds.includes(a.id) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>{a.name}</button>
            ))}
            {allergens.length === 0 && <span className="text-xs text-muted-foreground">Add allergens above first.</span>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!form.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>{drug ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function VitalsFormCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["vital-fields"], queryFn: getVitalFields });
  const [fields, setFields] = useState<VitalField[]>([]);
  useEffect(() => {
    if (cfg.data) setFields(cfg.data);
  }, [cfg.data]);

  const save = useMutation({
    mutationFn: () => saveVitalFields(fields),
    onSuccess: () => {
      toast.success("Vitals form saved");
      qc.invalidateQueries({ queryKey: ["vital-fields"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the vitals form"),
  });

  const patch = (i: number, p: Partial<VitalField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const num = (v: string): number | undefined => (v === "" ? undefined : Number(v));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vitals form</CardTitle>
        <CardDescription>
          Choose which vital signs triage records, and set each field's bounds. <span className="font-medium text-foreground">Min/Max</span> reject impossible
          values at entry; <span className="font-medium text-foreground">Low/High</span> flag a reading as Low · Normal · High. Leave a box blank for "no limit".
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-2 font-medium">On</th>
                <th className="py-2 pr-2 font-medium">Field</th>
                <th className="py-2 pr-2 font-medium">Unit</th>
                <th className="py-2 px-1 font-medium text-center">Min</th>
                <th className="py-2 px-1 font-medium text-center">Low</th>
                <th className="py-2 px-1 font-medium text-center">High</th>
                <th className="py-2 px-1 font-medium text-center">Max</th>
                <th className="py-2 pl-2 font-medium text-center">Required</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {fields.map((f, i) => (
                <tr key={f.key} className={f.enabled ? "" : "opacity-50"}>
                  <td className="py-1.5 pr-2">
                    <input type="checkbox" checked={f.enabled} disabled={!manage} onChange={(e) => patch(i, { enabled: e.target.checked })} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input className="h-8 w-32" value={f.label} disabled={!manage} onChange={(e) => patch(i, { label: e.target.value })} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input className="h-8 w-16" value={f.unit} disabled={!manage} onChange={(e) => patch(i, { unit: e.target.value })} />
                  </td>
                  {(["min", "low", "high", "max"] as const).map((k) => (
                    <td key={k} className="px-1 py-1.5">
                      <Input
                        className="h-8 w-16 text-center"
                        type="number"
                        inputMode="decimal"
                        value={f[k] ?? ""}
                        disabled={!manage}
                        onChange={(e) => patch(i, { [k]: num(e.target.value) })}
                      />
                    </td>
                  ))}
                  <td className="py-1.5 pl-2 text-center">
                    <input type="checkbox" checked={f.required} disabled={!manage || !f.enabled} onChange={(e) => patch(i, { required: e.target.checked })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {manage && (
          <div className="border-t pt-4">
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={fields.length === 0}>
              Save vitals form
            </Button>
          </div>
        )}
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
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          Prices live in one place — <span className="font-medium text-foreground">Billing → Service catalog</span>. Set the registration / consultation fee there and tag it <span className="font-medium text-foreground">Default</span> so reception pre-selects it.
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Payment collection follows roles.</span> Give a receptionist the
          <span className="font-medium text-foreground"> Cashier</span> role and they collect at the desk; without it, charges
          go to the Cashier worklist for a dedicated cashier to settle. Manage this in <span className="font-medium text-foreground">Users</span>.
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
