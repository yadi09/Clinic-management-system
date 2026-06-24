import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Copy, LogOut, Plus, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import {
  getClinicModules, listClinics, platformToken, provisionClinic, reactivateClinic, setClinicModules, suspendClinic,
  type Clinic, type ProvisionResult,
} from "@/features/platform/api";

const MODULES = [
  { key: "laboratory", label: "Laboratory" },
  { key: "pharmacy", label: "Pharmacy" },
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  if (!platformToken.get()) {
    navigate("/platform/login");
    return null;
  }
  const q = useQuery({ queryKey: ["platform-clinics"], queryFn: listClinics });
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [modulesFor, setModulesFor] = useState<Clinic | null>(null);

  const setStatus = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "suspend" | "reactivate" }) =>
      action === "suspend" ? suspendClinic(id) : reactivateClinic(id),
    onSuccess: () => {
      toast.success("Clinic updated");
      qc.invalidateQueries({ queryKey: ["platform-clinics"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const clinics = q.data ?? [];
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
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
        <h1 className="mb-1 text-xl font-semibold">Clinics</h1>
        <p className="mb-5 text-sm text-zinc-400">{clinics.length} clinic{clinics.length === 1 ? "" : "s"} on the platform.</p>

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr><th className="p-3">Clinic</th><th>Workspace</th><th>Users</th><th>Patients</th><th>Status</th><th className="p-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {clinics.map((c: Clinic) => (
                <tr key={c.id} className="border-b border-zinc-800 last:border-0">
                  <td className="p-3">
                    <div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-zinc-500" /><span className="font-medium">{c.name}</span></div>
                    <div className="ml-6 text-xs text-zinc-500">{c.owner_email}</div>
                  </td>
                  <td className="font-mono text-xs text-zinc-400">{c.slug}</td>
                  <td>{c.users}</td>
                  <td>{c.patients}</td>
                  <td><Badge variant={c.status === "active" ? "success" : "destructive"}>{c.status}</Badge></td>
                  <td className="p-3 text-right">
                    <div className="flex items-center justify-end gap-3">
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
      </main>

      <CreateClinicDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(r) => { setCreating(false); setResult(r); qc.invalidateQueries({ queryKey: ["platform-clinics"] }); }}
      />
      <CredentialsDialog result={result} onClose={() => setResult(null)} />
      <ModulesDialog clinic={modulesFor} onClose={() => setModulesFor(null)} />
    </div>
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

function CreateClinicDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (r: ProvisionResult) => void }) {
  const [form, setForm] = useState({ clinic_name: "", slug: "", owner_name: "", owner_email: "" });
  const [modules, setModules] = useState<Record<string, boolean>>(() => Object.fromEntries(MODULES.map((m) => [m.key, true])));
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const slugHint = form.slug || form.clinic_name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const mut = useMutation({
    mutationFn: () => provisionClinic({ ...form, slug: form.slug || slugHint, modules }),
    onSuccess: (r) => { setForm({ clinic_name: "", slug: "", owner_name: "", owner_email: "" }); onCreated(r); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not provision"),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Provision a clinic</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Creates the clinic, its owner account, the RBAC roles, a main branch + department, and default services. A temporary owner password is generated for you to hand over.</p>
        <div className="grid gap-3">
          <div className="space-y-1.5"><Label>Clinic name</Label><Input value={form.clinic_name} onChange={(e) => set("clinic_name", e.target.value)} placeholder="Bole Family Clinic" /></div>
          <div className="space-y-1.5"><Label>Workspace (login slug)</Label><Input value={form.slug} onChange={(e) => set("slug", e.target.value)} placeholder={slugHint || "bole-family"} /><p className="text-xs text-muted-foreground">Staff sign in with this workspace. Lowercase, no spaces.</p></div>
          <div className="space-y-1.5"><Label>Owner name</Label><Input value={form.owner_name} onChange={(e) => set("owner_name", e.target.value)} placeholder="Dr. Sara Ahmed" /></div>
          <div className="space-y-1.5"><Label>Owner email</Label><Input type="email" value={form.owner_email} onChange={(e) => set("owner_email", e.target.value)} placeholder="owner@bolefamily.clinic" /></div>
          <div className="space-y-1.5">
            <Label>Modules</Label>
            {MODULES.map((m) => (
              <Toggle key={m.key} label={m.label} on={!!modules[m.key]} onChange={(v) => setModules((s) => ({ ...s, [m.key]: v }))} />
            ))}
            <p className="text-xs text-muted-foreground">What this clinic is entitled to. You can change it later.</p>
          </div>
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
