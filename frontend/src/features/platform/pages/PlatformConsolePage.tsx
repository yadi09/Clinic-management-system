import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Copy, LogOut, Plus, ShieldCheck, Handshake, CreditCard, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import {
  clinicUsage, createPlan, getClinicModules, impersonateOwner, listClinics, listPartnerLeads, listPlans, platformToken,
  provisionClinic, reactivateClinic, setClinicModules, setClinicPlan, setLeadStatus, suspendClinic, updatePlan,
  type Clinic, type PartnerLead, type Plan, type UsageLine, type ProvisionResult,
} from "@/features/platform/api";

const MODULES = [
  { key: "laboratory", label: "Laboratory" },
  { key: "pharmacy", label: "Pharmacy" },
];

// Clinic types drive a feature-flag preset at provisioning. A "general" clinic runs
// the standard reception → triage → encounter flow; a "dental" clinic runs the
// dental workspace (tooth chart + treatment plan + installment balance) and turns
// off the general-medical satellites it doesn't use. The `modules` sent for each
// type must match the backend preset so the toggles don't fight it.
const CLINIC_TYPES = [
  { key: "general", label: "General / Medium clinic", modules: { laboratory: true, pharmacy: true } as Record<string, boolean> },
  { key: "dental", label: "Dental clinic", modules: { dental: true, laboratory: false, pharmacy: false, inventory: false } as Record<string, boolean> },
];

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm">
      <span>{label}</span>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-emerald-500" : "bg-zinc-600"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-4" : "left-0.5"}`} />
      </span>
    </button>
  );
}

export function PlatformConsolePage() {
  const { ask, dialog } = useConfirmDialog();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { signIn } = useAuth();
  // Not signed in → bounce to login. Redirect in an effect (never during render),
  // and keep all hooks below unconditional so the hook order is stable.
  const hasToken = !!platformToken.get();
  useEffect(() => {
    if (!hasToken) navigate("/platform/login", { replace: true });
  }, [hasToken, navigate]);

  const q = useQuery({ queryKey: ["platform-clinics"], queryFn: listClinics, enabled: hasToken });
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [modulesFor, setModulesFor] = useState<Clinic | null>(null);
  const [planFor, setPlanFor] = useState<Clinic | null>(null);
  const [tab, setTab] = useState<"clinics" | "plans" | "leads">("clinics");

  const setStatus = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "suspend" | "reactivate" }) =>
      action === "suspend" ? suspendClinic(id) : reactivateClinic(id),
    onSuccess: () => {
      toast.success("Clinic updated");
      qc.invalidateQueries({ queryKey: ["platform-clinics"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  // Sign in as the clinic's owner: mint a tenant token, hand it to the app auth,
  // then jump into the app (client-side, so the in-memory token survives).
  const impersonate = (c: Clinic) => ask(
    {
      title: `Sign in as the owner of "${c.name}"?`,
      description:
        "You will be acting as them inside a live clinic, with their patients' records in front of you. Anything you change is real and is recorded against their account.",
      confirmLabel: "Sign in as owner",
      destructive: true,
    },
    async () => {
      try {
        const res = await impersonateOwner(c.id);
        await signIn(res.access_token, res.user);
        toast.success(`Signed in as ${res.user.full_name || res.user.email}`);
        navigate("/");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not sign in as owner");
      }
    },
  );

  // An expired/invalid token is cleared on a 401 by the API client — bounce to login.
  useEffect(() => {
    if (q.isError && !platformToken.get()) navigate("/platform/login", { replace: true });
  }, [q.isError, navigate]);

  if (!hasToken) return null;

  const clinics = q.data ?? [];
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {dialog}
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-emerald-400" />
          <span className="font-semibold">Platform Console</span>
          <Badge variant="outline" className="border-zinc-700 text-zinc-400">super-admin</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New clinic</Button>
          <Button size="sm" variant="ghost" className="text-zinc-400" onClick={() => { platformToken.clear(); navigate("/platform/login"); }}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex w-fit gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
          <button onClick={() => setTab("clinics")} className={"flex items-center gap-2 rounded-md px-3 py-1.5 text-sm " + (tab === "clinics" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200")}><Building2 className="h-4 w-4" /> Clinics</button>
          <button onClick={() => setTab("plans")} className={"flex items-center gap-2 rounded-md px-3 py-1.5 text-sm " + (tab === "plans" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200")}><CreditCard className="h-4 w-4" /> Plans</button>
          <button onClick={() => setTab("leads")} className={"flex items-center gap-2 rounded-md px-3 py-1.5 text-sm " + (tab === "leads" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200")}><Handshake className="h-4 w-4" /> Partner leads</button>
        </div>

        {tab === "plans" && <PlansView />}
        {tab === "leads" && <PartnerLeadsView />}
        {tab === "clinics" && (<>
        <h1 className="mb-1 text-xl font-semibold">Clinics</h1>
        <p className="mb-5 text-sm text-zinc-400">{clinics.length} clinic{clinics.length === 1 ? "" : "s"} on the platform.</p>

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr><th className="p-3">Clinic</th><th>Workspace</th><th>Plan</th><th>Users</th><th>Patients</th><th>Status</th><th className="p-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {clinics.map((c: Clinic) => (
                <tr key={c.id} className="border-b border-zinc-800 last:border-0">
                  <td className="p-3">
                    <div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-zinc-500" /><span className="font-medium">{c.name}</span></div>
                    <div className="ml-6 text-xs text-zinc-500">{c.owner_email}</div>
                  </td>
                  <td className="font-mono text-xs text-zinc-400">{c.slug}</td>
                  <td><Badge variant="outline" className="border-zinc-700 text-zinc-300">{c.plan_name ?? "—"}</Badge></td>
                  <td>{c.users}</td>
                  <td>{c.patients}</td>
                  <td><Badge variant={c.status === "active" ? "success" : "destructive"}>{c.status}</Badge></td>
                  <td className="p-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button className="text-xs text-emerald-300 hover:underline" onClick={() => impersonate(c)}>Sign in as owner</button>
                      <button className="text-xs text-sky-300 hover:underline" onClick={() => setPlanFor(c)}>Plan</button>
                      <button className="text-xs text-zinc-300 hover:underline" onClick={() => setModulesFor(c)}>Modules</button>
                      {c.status === "active" ? (
                        <button className="text-xs text-rose-400 hover:underline" onClick={() => setStatus.mutate({ id: c.id, action: "suspend" })}>Suspend</button>
                      ) : (
                        <button className="text-xs text-emerald-400 hover:underline" onClick={() => setStatus.mutate({ id: c.id, action: "reactivate" })}>Reactivate</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {clinics.length === 0 && !q.isLoading && <p className="p-8 text-center text-sm text-zinc-500">No clinics yet. Provision the first one.</p>}
          {q.isLoading && <p className="p-8 text-center text-sm text-zinc-500">Loading…</p>}
        </div>
        </>)}
      </main>

      <CreateClinicDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(r) => { setCreating(false); setResult(r); qc.invalidateQueries({ queryKey: ["platform-clinics"] }); }}
      />
      <CredentialsDialog result={result} onClose={() => setResult(null)} />
      <ModulesDialog clinic={modulesFor} onClose={() => setModulesFor(null)} />
      <ClinicPlanDialog clinic={planFor} onClose={() => setPlanFor(null)} onSaved={() => { setPlanFor(null); qc.invalidateQueries({ queryKey: ["platform-clinics"] }); }} />
    </div>
  );
}

const LEAD_AUDIENCE: Record<string, string> = {
  influencer: "Influencer", clinic_owner: "Clinic owner", professional: "Professional", sales: "Sales / marketing", other: "Other",
};
const LEAD_STATUSES = ["new", "contacted", "signed", "archived"];

function PartnerLeadsView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["platform-leads"], queryFn: listPartnerLeads });
  const mut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => setLeadStatus(id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform-leads"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update lead"),
  });
  const leads: PartnerLead[] = q.data ?? [];
  const newCount = leads.filter((l) => l.status === "new").length;
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Partner leads</h1>
      <p className="mb-5 text-sm text-zinc-400">
        {leads.length} registration{leads.length === 1 ? "" : "s"}
        {newCount > 0 && <> · <span className="text-amber-400">{newCount} new</span></>}.
      </p>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr><th className="p-3">Name / contact</th><th>Who</th><th>Clinics</th><th>Source</th><th>When</th><th className="p-3">Status</th></tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className="border-b border-zinc-800 align-top last:border-0">
                <td className="p-3">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-xs text-zinc-400">{[l.phone, l.email].filter(Boolean).join(" · ") || "—"}</div>
                  {l.region && <div className="text-xs text-zinc-500">{l.region}</div>}
                  {l.goal && <div className="mt-1 max-w-xs text-xs italic text-zinc-500">“{l.goal}”</div>}
                </td>
                <td className="text-zinc-300">{LEAD_AUDIENCE[l.audience ?? ""] ?? l.audience ?? "—"}</td>
                <td className="text-zinc-300">{l.clinics_estimate || "—"}</td>
                <td className="max-w-[10rem] truncate font-mono text-xs text-zinc-500" title={l.source}>{l.source || "—"}</td>
                <td className="whitespace-nowrap text-xs text-zinc-400">{new Date(l.created_at).toLocaleDateString()}</td>
                <td className="p-3">
                  <select
                    value={l.status}
                    onChange={(e) => mut.mutate({ id: l.id, status: e.target.value })}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                  >
                    {LEAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {leads.length === 0 && !q.isLoading && <p className="p-8 text-center text-sm text-zinc-500">No leads yet. They'll appear here as people register on the partner pages.</p>}
        {q.isLoading && <p className="p-8 text-center text-sm text-zinc-500">Loading…</p>}
      </div>
    </>
  );
}

function ModulesDialog({ clinic, onClose }: { clinic: Clinic | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["clinic-modules", clinic?.id], queryFn: () => getClinicModules(clinic!.id), enabled: !!clinic });
  const [state, setState] = useState<Record<string, boolean>>({});
  const [forId, setForId] = useState<string | null>(null);
  if (clinic && q.data && forId !== clinic.id) {
    setForId(clinic.id);
    setState(Object.fromEntries(q.data.map((m) => [m.key, m.enabled])));
  }
  const mut = useMutation({
    mutationFn: () => setClinicModules(clinic!.id, state),
    onSuccess: () => {
      toast.success("Modules updated — takes effect on the clinic's next login");
      qc.invalidateQueries({ queryKey: ["clinic-modules", clinic?.id] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update"),
  });
  return (
    <Dialog open={!!clinic} onOpenChange={(o) => { if (!o) { setForId(null); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Modules — {clinic?.name}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Turn modules on or off for this clinic. A change applies on the clinic's next login (~15 min). Disabled modules disappear from their staff's menu and are blocked.</p>
        <div className="space-y-2">
          {(q.data ?? MODULES.map((m) => ({ ...m, enabled: false }))).map((m) => (
            <Toggle key={m.key} label={m.label} on={!!state[m.key]} onChange={(v) => setState((s) => ({ ...s, [m.key]: v }))} />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setForId(null); onClose(); }}>Cancel</Button>
          <Button loading={mut.isPending} onClick={() => mut.mutate()}>Save modules</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const limLabel = (n: number | null) => (n == null ? "Unlimited" : n.toLocaleString());
const PLAN_TYPES = [{ v: "all", l: "All clinic types" }, { v: "general", l: "General" }, { v: "dental", l: "Dental" }];
const typeLabel = (t: string) => PLAN_TYPES.find((x) => x.v === t)?.l ?? t;
const numOrNull = (s: string): number | null => { const t = s.trim(); if (t === "") return null; const n = Number(t); return isNaN(n) ? null : n; };
const nStr = (n: number | null | undefined) => (n == null ? "" : String(n));
function fmtBytesShort(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function PlansView() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["platform-plans"], queryFn: listPlans });
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const plans = q.data ?? [];
  return (
    <>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Plans</h1>
          <p className="text-sm text-zinc-400">{plans.length} plan{plans.length === 1 ? "" : "s"}. Limits apply to every clinic on the plan.</p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> New plan</Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr><th className="p-3">Plan</th><th>Type</th><th>Patients</th><th>Storage</th><th>Users</th><th>Branches</th><th>Price/mo</th><th>Clinics</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className="border-b border-zinc-800 last:border-0">
                <td className="p-3"><span className="font-medium">{p.name}</span> <span className="font-mono text-xs text-zinc-500">{p.code}</span></td>
                <td><Badge variant="outline" className="border-zinc-700 text-zinc-300">{typeLabel(p.clinic_type)}</Badge></td>
                <td>{limLabel(p.patient_limit)}</td>
                <td>{p.storage_gb == null ? "Unlimited" : `${p.storage_gb} GB`}</td>
                <td>{limLabel(p.user_limit)}</td>
                <td>{limLabel(p.branch_limit)}</td>
                <td className="tabular-nums">{Number(p.price_monthly || 0).toLocaleString()} ETB</td>
                <td>{p.in_use}</td>
                <td className="p-3 text-right"><button className="text-xs text-sky-300 hover:underline" onClick={() => setEditing(p)}><Pencil className="mr-1 inline h-3 w-3" />Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {plans.length === 0 && !q.isLoading && <p className="p-8 text-center text-sm text-zinc-500">No plans yet.</p>}
      </div>
      <PlanEditDialog plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["platform-plans"] }); }} />
    </>
  );
}

function PlanEditDialog({ plan, onClose, onSaved }: { plan: Plan | "new" | null; onClose: () => void; onSaved: () => void }) {
  const editing = plan != null && plan !== "new";
  const p = editing ? (plan as Plan) : null;
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [clinicType, setClinicType] = useState("all");
  const [patients, setPatients] = useState("");
  const [storage, setStorage] = useState("");
  const [users, setUsers] = useState("");
  const [branches, setBranches] = useState("");
  const [images, setImages] = useState("8");
  const [price, setPrice] = useState("");
  const [forId, setForId] = useState<string | null>(null);
  const key = plan === "new" ? "new" : p?.id ?? null;
  if (plan && forId !== key) {
    setForId(key);
    setCode(p?.code ?? ""); setName(p?.name ?? ""); setClinicType(p?.clinic_type ?? "all");
    setPatients(nStr(p?.patient_limit)); setStorage(nStr(p?.storage_gb));
    setUsers(nStr(p?.user_limit)); setBranches(nStr(p?.branch_limit));
    setImages(p ? nStr(p.images_per_patient) : "8");
    setPrice(p ? String(Number(p.price_monthly || 0)) : "");
  }
  const mut = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), clinic_type: clinicType, patient_limit: numOrNull(patients), storage_gb: numOrNull(storage), user_limit: numOrNull(users), branch_limit: numOrNull(branches), images_per_patient: numOrNull(images), price_monthly: price.trim() || "0" };
      if (editing) await updatePlan((plan as Plan).id, body);
      else await createPlan({ code: code.trim(), ...body });
    },
    onSuccess: () => { toast.success(editing ? "Plan updated" : "Plan created"); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the plan"),
  });
  return (
    <Dialog open={!!plan} onOpenChange={(o) => { if (!o) { setForId(null); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? `Edit ${p?.name}` : "New plan"}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Leave a limit blank for <b>unlimited</b>. Storage is in GB.</p>
        <div className="grid gap-3">
          {!editing && <div className="space-y-1.5"><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="starter" /></div>}
          <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Starter" /></div>
          <div className="space-y-1.5">
            <Label>Clinic type</Label>
            <Select value={clinicType} onValueChange={setClinicType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PLAN_TYPES.map((t) => <SelectItem key={t.v} value={t.v}>{t.l}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Which clinics this plan is offered to. "All clinic types" = universal.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Patients</Label><Input type="number" min={0} value={patients} onChange={(e) => setPatients(e.target.value)} placeholder="Unlimited" /></div>
            <div className="space-y-1.5"><Label>Storage (GB)</Label><Input type="number" min={0} value={storage} onChange={(e) => setStorage(e.target.value)} placeholder="Unlimited" /></div>
            <div className="space-y-1.5"><Label>Users</Label><Input type="number" min={0} value={users} onChange={(e) => setUsers(e.target.value)} placeholder="Unlimited" /></div>
            <div className="space-y-1.5"><Label>Branches</Label><Input type="number" min={0} value={branches} onChange={(e) => setBranches(e.target.value)} placeholder="Unlimited" /></div>
            <div className="space-y-1.5"><Label>Images / patient</Label><Input type="number" min={0} value={images} onChange={(e) => setImages(e.target.value)} placeholder="Unlimited" /></div>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">Images / patient applies to dental clinics (X-rays, before/after).</p>
          <div className="space-y-1.5"><Label>Price / month (ETB)</Label><Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setForId(null); onClose(); }}>Cancel</Button>
          <Button disabled={(!editing && !code.trim()) || !name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>{editing ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UsageRow({ label, line, bytes }: { label: string; line: UsageLine; bytes?: boolean }) {
  const fmt = (n: number) => (bytes ? fmtBytesShort(n) : n.toLocaleString());
  const cap = line.limit < 0 ? "∞" : fmt(line.limit);
  const over = line.limit >= 0 && line.used > line.limit;
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${over ? "font-semibold text-rose-600" : ""}`}>{fmt(line.used)} / {cap}</span>
    </div>
  );
}

const OVERRIDES: [string, string][] = [["patient_limit", "Patients"], ["storage_gb", "Storage (GB)"], ["user_limit", "Users"], ["branch_limit", "Branches"]];

function ClinicPlanDialog({ clinic, onClose, onSaved }: { clinic: Clinic | null; onClose: () => void; onSaved: () => void }) {
  const plans = useQuery({ queryKey: ["platform-plans"], queryFn: listPlans, enabled: !!clinic });
  const usage = useQuery({ queryKey: ["clinic-usage", clinic?.id], queryFn: () => clinicUsage(clinic!.id), enabled: !!clinic });
  const [planId, setPlanId] = useState("");
  const [ov, setOv] = useState<Record<string, string>>({});
  const [forId, setForId] = useState<string | null>(null);
  // A clinic is only offered plans for its type (or universal 'all').
  const eligible = (plans.data ?? []).filter((p) => p.clinic_type === "all" || p.clinic_type === clinic?.clinic_type);
  if (clinic && usage.data && plans.data && forId !== clinic.id) {
    setForId(clinic.id);
    const cur = eligible.find((p) => p.code === clinic.plan_code);
    setPlanId(cur?.id ?? eligible[0]?.id ?? "");
    const toStr = (n: number | null) => (n == null ? "" : n < 0 ? "unlimited" : String(n));
    setOv({
      storage_gb: toStr(usage.data.storage_gb_override),
      patient_limit: toStr(usage.data.patient_limit_override),
      user_limit: toStr(usage.data.user_limit_override),
      branch_limit: toStr(usage.data.branch_limit_override),
    });
  }
  const mut = useMutation({
    mutationFn: () => {
      const parse = (s: string): number | null => { const t = (s || "").trim().toLowerCase(); if (t === "") return null; if (t === "unlimited" || t === "∞") return -1; const n = Number(t); return isNaN(n) ? null : n; };
      return setClinicPlan(clinic!.id, {
        plan_id: planId,
        storage_gb_override: parse(ov.storage_gb),
        patient_limit_override: parse(ov.patient_limit),
        user_limit_override: parse(ov.user_limit),
        branch_limit_override: parse(ov.branch_limit),
      });
    },
    onSuccess: () => { toast.success("Plan updated for this clinic"); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the plan"),
  });
  const u = usage.data;
  return (
    <Dialog open={!!clinic} onOpenChange={(o) => { if (!o) { setForId(null); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Plan — {clinic?.name}</DialogTitle></DialogHeader>
        {u && (
          <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-xs">
            <UsageRow label="Patients" line={u.patients} />
            <UsageRow label="Storage" line={u.storage} bytes />
            <UsageRow label="Users" line={u.users} />
            <UsageRow label="Branches" line={u.branches} />
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Plan</Label>
          <Select value={planId} onValueChange={setPlanId}>
            <SelectTrigger><SelectValue placeholder="Choose a plan" /></SelectTrigger>
            <SelectContent>{eligible.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.clinic_type !== "all" ? "" : " · universal"}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Per-clinic overrides <span className="text-xs font-normal text-muted-foreground">(blank = use plan · "unlimited" · or a number)</span></Label>
          <div className="grid grid-cols-2 gap-3">
            {OVERRIDES.map(([k, lbl]) => (
              <div key={k} className="space-y-1"><Label className="text-xs text-muted-foreground">{lbl}</Label><Input value={ov[k] ?? ""} onChange={(e) => setOv((s) => ({ ...s, [k]: e.target.value }))} placeholder="Use plan" /></div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setForId(null); onClose(); }}>Cancel</Button>
          <Button disabled={!planId} loading={mut.isPending} onClick={() => mut.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateClinicDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: ProvisionResult) => void }) {
  const [form, setForm] = useState({ clinic_name: "", slug: "", owner_name: "", owner_email: "" });
  const [clinicType, setClinicType] = useState("general");
  // For a general clinic the operator can toggle the individual medical modules;
  // a dental clinic's modules are fixed by its preset (dental on, lab/pharmacy off).
  const [modules, setModules] = useState<Record<string, boolean>>(() => Object.fromEntries(MODULES.map((m) => [m.key, true])));
  const isDental = clinicType === "dental";
  const [planCode, setPlanCode] = useState("");
  const plans = useQuery({ queryKey: ["platform-plans"], queryFn: listPlans, enabled: open });
  // Only offer plans for the chosen clinic type (or universal 'all').
  const availablePlans = (plans.data ?? []).filter((p) => p.clinic_type === "all" || p.clinic_type === clinicType);
  // Default (or re-default) the plan whenever the type changes or plans load.
  useEffect(() => {
    if (!open) return;
    if (!availablePlans.some((p) => p.code === planCode)) setPlanCode(availablePlans[0]?.code ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clinicType, plans.data]);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const chooseType = (t: string) => {
    setClinicType(t);
    // Reset the module toggles to the type's preset so what's sent matches the backend.
    const preset = CLINIC_TYPES.find((c) => c.key === t)?.modules ?? {};
    setModules(Object.fromEntries(MODULES.map((m) => [m.key, preset[m.key] ?? false])));
  };
  const slugHint = form.slug || form.clinic_name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const reset = () => { setForm({ clinic_name: "", slug: "", owner_name: "", owner_email: "" }); setClinicType("general"); setPlanCode(""); setModules(Object.fromEntries(MODULES.map((m) => [m.key, true]))); };
  const mut = useMutation({
    mutationFn: () => {
      // A dental clinic sends its preset verbatim (incl. dental:true); a general
      // clinic sends whatever the operator toggled.
      const mods = isDental ? { ...(CLINIC_TYPES.find((c) => c.key === "dental")?.modules ?? {}) } : modules;
      return provisionClinic({ ...form, slug: form.slug || slugHint, clinic_type: clinicType, plan_code: planCode, modules: mods });
    },
    onSuccess: (r) => { reset(); onCreated(r); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not provision"),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Provision a clinic</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Creates the clinic, its owner account, the RBAC roles, a main branch + department, and default services. A temporary owner password is generated for you to hand over.</p>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>Clinic type</Label>
            <Select value={clinicType} onValueChange={chooseType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CLINIC_TYPES.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{isDental ? "Dental clinics get a tooth chart, a treatment plan and installment billing — no triage/encounter flow." : "The standard reception → triage → encounter → cashier flow."}</p>
          </div>
          <div className="space-y-1.5"><Label>Clinic name</Label><Input value={form.clinic_name} onChange={(e) => set("clinic_name", e.target.value)} placeholder="Bole Family Clinic" /></div>
          <div className="space-y-1.5"><Label>Workspace (login slug)</Label><Input value={form.slug} onChange={(e) => set("slug", e.target.value)} placeholder={slugHint || "bole-family"} /><p className="text-xs text-muted-foreground">Staff sign in with this workspace. Lowercase, no spaces.</p></div>
          <div className="space-y-1.5"><Label>Owner name</Label><Input value={form.owner_name} onChange={(e) => set("owner_name", e.target.value)} placeholder="Dr. Sara Ahmed" /></div>
          <div className="space-y-1.5"><Label>Owner email</Label><Input type="email" value={form.owner_email} onChange={(e) => set("owner_email", e.target.value)} placeholder="owner@bolefamily.clinic" /></div>
          <div className="space-y-1.5">
            <Label>Plan</Label>
            <Select value={planCode} onValueChange={setPlanCode}>
              <SelectTrigger><SelectValue placeholder="Choose a plan" /></SelectTrigger>
              <SelectContent>{availablePlans.map((p) => <SelectItem key={p.code} value={p.code}>{p.name}{p.price_monthly && Number(p.price_monthly) > 0 ? ` · ${Number(p.price_monthly).toLocaleString()} ETB/mo` : ""}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Sets the clinic's limits. You can change it or customize per-clinic later.</p>
          </div>
          {isDental ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Dental module on · Lab, pharmacy and inventory off. You can adjust modules later.</div>
          ) : (
            <div className="space-y-1.5">
              <Label>Modules</Label>
              {MODULES.map((m) => (
                <Toggle key={m.key} label={m.label} on={!!modules[m.key]} onChange={(v) => setModules((s) => ({ ...s, [m.key]: v }))} />
              ))}
              <p className="text-xs text-muted-foreground">What this clinic is entitled to. You can change it later.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!form.clinic_name || !(form.slug || slugHint) || !form.owner_name || !form.owner_email} loading={mut.isPending}
            onClick={() => mut.mutate()}>
            Provision clinic
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CredentialsDialog({ result, onClose }: { result: ProvisionResult | null; onClose: () => void }) {
  const copy = (s: string) => { void navigator.clipboard?.writeText(s); toast.success("Copied"); };
  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Clinic ready — hand these to the owner</DialogTitle></DialogHeader>
        {result && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">Share these credentials securely. The owner should change the password after first login.</p>
            <Field label="Workspace" value={result.workspace_slug} onCopy={copy} />
            <Field label="Owner email" value={result.owner_email} onCopy={copy} />
            <Field label="Temporary password" value={result.temp_password ?? "(set by you)"} onCopy={copy} mono />
          </div>
        )}
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onCopy, mono }: { label: string; value: string; onCopy: (s: string) => void; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div><div className="text-xs text-muted-foreground">{label}</div><div className={mono ? "font-mono" : "font-medium"}>{value}</div></div>
      <Button size="icon" variant="ghost" onClick={() => onCopy(value)}><Copy className="h-4 w-4" /></Button>
    </div>
  );
}
