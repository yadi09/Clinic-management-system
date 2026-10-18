import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, ShieldCheck, Building2, MapPin, Workflow, Wallet, Stethoscope, ClipboardList, Pill, Printer, Smartphone, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { getDentalSettings, saveDentalSettings, type ChartStyle } from "@/features/dental/api";
import { createProcedure, deleteProcedure, listProcedures, reorderProcedures, updateProcedure,
  createToothStatus, deleteToothStatus, listToothStatuses, reorderToothStatuses, updateToothStatus } from "@/features/dental/api";
import { changeEmailApi, changePasswordApi } from "@/features/auth/api";
import { ActiveSessions } from "@/features/auth/ActiveSessions";
import {
  branchUsage,
  createBranch,
  createDepartment,
  createPaymentRail,
  deleteBranch,
  deleteDepartment,
  deletePaymentRail,
  getBranchModules,
  getClinic,
  getSettings,
  getWorkspace,
  listBranches,
  listDepartments,
  listPaymentRails,
  saveClinic,
  saveSettings,
  setBranchModules,
  planUsage,
  updateBranch,
  updateDepartment,
  updatePaymentRail,
  updateWorkspace,
  type Branch,
  type ClinicSettings,
  type Department,
  type PaymentRail,
} from "@/features/admin/api";
import {
  createCatalogEntry,
  createCategory,
  createDrug,
  deleteAllergen,
  deleteCatalogEntry,
  deleteCategory,
  deleteDrug,
  getVitalFields,
  listAllergens,
  listDiagnosisCategories,
  saveVitalFields,
  searchCatalog,
  searchDrugs,
  updateCatalogEntry,
  updateCategory,
  updateDrug,
  type CatalogEntry,
  type DiagnosisCategory,
  type Drug,
  type VitalField,
} from "@/features/clinical/api";
import { NewAllergenForm, severityClass } from "@/features/clinical/AllergenFields";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { RegistrationFeeCard } from "@/features/billing/RegistrationFeeCard";
import { HomePaymentsCard, PortalSettingsCard } from "@/features/portal/PortalSettingsCard";
import { PrintingSettings } from "@/features/printing/PrintingSettings";
import { AppError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type SectionKey = "portal" | "account" | "profile" | "printing" | "locations" | "flow" | "payments" | "vitals" | "diagnoses" | "drugs" | "procedures" | "toothchart" | "toothconditions";
// flag: shown only with it. hideWhen: hidden with it — a dental clinic has no
// triage (so no vitals form) and its examination's diagnosis is free text, not the
// general clinic's catalogue.
const SECTIONS: { group: string; items: { key: SectionKey; label: string; icon: LucideIcon; flag?: string; hideWhen?: string }[] }[] = [
  {
    group: "General",
    items: [
      { key: "account", label: "Account & security", icon: ShieldCheck },
      { key: "profile", label: "Clinic profile", icon: Building2 },
      { key: "printing", label: "Printing", icon: Printer },
      { key: "locations", label: "Branches & departments", icon: MapPin },
    ],
  },
  {
    group: "Patient flow",
    items: [
      { key: "flow", label: "Visit flow", icon: Workflow },
      { key: "payments", label: "Payment methods", icon: Wallet },
      { key: "portal", label: "Patient portal", icon: Smartphone, flag: "dental" },
    ],
  },
  {
    group: "Clinical library",
    items: [
      { key: "vitals", label: "Vitals form", icon: Stethoscope, hideWhen: "dental" },
      { key: "diagnoses", label: "Diagnosis catalog", icon: ClipboardList, hideWhen: "dental" },
      { key: "drugs", label: "Drugs & allergens", icon: Pill },
      // Dental only: the list of what this practice does. Hidden elsewhere by
      // the same flag that hides the chart and the treatment plan.
      { key: "procedures", label: "Dental procedures", icon: Stethoscope, flag: "dental" },
      { key: "toothchart", label: "Tooth chart", icon: Stethoscope, flag: "dental" },
      { key: "toothconditions", label: "Tooth conditions", icon: ClipboardList, flag: "dental" },
    ],
  },
];

// Branch/department management is temporarily hidden — flip to true to bring the
// "Branches & departments" settings tab back. (Multi-branch is on hold for now.)
const BRANCHES_ENABLED = false;

export function SettingsPage() {
  const { can, flagOn } = useAuth();
  const manage = can("clinic.manage");
  // ?section= so a prompt elsewhere in the app can send someone straight here —
  // "configure your payment methods" is useless as advice if it does not arrive
  // at the screen that does it.
  const [params, setParams] = useSearchParams();
  const active = (params.get("section") as SectionKey) || "account";
  const setActive = (k: SectionKey) => setParams(k === "account" ? {} : { section: k }, { replace: true });

  return (
    <div className="space-y-6">
      <h1>Settings</h1>
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Section rail */}
        <nav className="shrink-0 lg:w-56">
          {SECTIONS.map((g) => (
            <div key={g.group} className="mb-2">
              <p className="px-3 pb-1 pt-3 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">{g.group}</p>
              {g.items.filter((it) => (it.key !== "locations" || BRANCHES_ENABLED) && (!it.flag || flagOn(it.flag)) && !(it.hideWhen && flagOn(it.hideWhen))).map((it) => (
                <button
                  key={it.key}
                  onClick={() => setActive(it.key)}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm ${
                    active === it.key ? "bg-accent font-semibold text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <it.icon className="h-4 w-4 shrink-0" />
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Active pane */}
        <div className="min-w-0 flex-1">
          {active === "account" && <AccountSecurityCard />}
          {active === "profile" && (
            <div className="space-y-6">
              <ClinicProfileCard manage={manage} />
              <PlanUsageCard />
            </div>
          )}
          {active === "locations" && <LocationsCard manage={manage} />}
          {active === "flow" && (
            <div className="space-y-6">
              <FlowSettingsCard manage={manage} />
              {/* Prices and the rule belong to billing: managers set them, everyone can read them. */}
              <RegistrationFeeCard manage={can("billing.manage")} />
            </div>
          )}
          {active === "payments" && <PaymentRailsCard manage={manage} />}
          {active === "portal" && (
            <div className="space-y-6">
              <PortalSettingsCard manage={manage} />
              <HomePaymentsCard />
            </div>
          )}
          {active === "printing" && <PrintingSettings />}
          {active === "vitals" && <VitalsFormCard manage={manage} />}
          {active === "diagnoses" && <DiagnosisCatalogCard manage={manage} />}
          {active === "drugs" && <DrugLibraryCard manage={manage} />}
          {active === "procedures" && <DentalProceduresCard manage={manage} />}
          {active === "toothchart" && <ToothChartStyleCard manage={manage} />}
          {active === "toothconditions" && <ToothConditionsCard manage={manage} />}
        </div>
      </div>
    </div>
  );
}

function ClinicProfileCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const [clinicName, setClinicName] = useState("");
  useEffect(() => {
    if (clinic.data?.name) setClinicName(clinic.data.name);
  }, [clinic.data?.name]);

  const save = useMutation({
    mutationFn: () => saveClinic({ name: clinicName }),
    onSuccess: () => {
      toast.success("Clinic profile saved");
      qc.invalidateQueries({ queryKey: ["clinic"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the clinic profile"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Clinic profile</CardTitle>
        <CardDescription>The clinic name shown across the workspace, on printed prescriptions, and on lab requests.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex max-w-md items-end gap-3">
          <div className="flex-1 space-y-1.5">
            <Label>Name</Label>
            <Input value={clinicName} onChange={(e) => setClinicName(e.target.value)} disabled={!manage} />
          </div>
          {manage && (
            <Button onClick={() => save.mutate()} disabled={!clinicName || clinicName === clinic.data?.name} loading={save.isPending}>
              Save
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function UsageBar({ label, used, limit, bytes }: { label: string; used: number; limit: number; bytes?: boolean }) {
  const unlimited = limit < 0;
  const fmt = (n: number) => (bytes ? fmtBytes(n) : n.toLocaleString());
  const pct = unlimited || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const near = !unlimited && pct >= 90;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">{fmt(used)}{unlimited ? "" : ` / ${fmt(limit)}`}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-all ${near ? "bg-destructive" : "bg-primary"}`} style={{ width: unlimited ? "0%" : `${pct}%` }} />
      </div>
    </div>
  );
}

function PlanUsageCard() {
  const q = useQuery({ queryKey: ["plan-usage"], queryFn: planUsage, retry: false });
  const u = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan &amp; usage{u ? ` — ${u.plan_name}` : ""}</CardTitle>
        <CardDescription>Your subscription limits. Patient images and files are compressed automatically; contact your provider to change your plan.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!u ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <UsageBar label="Patients" used={u.patients.used} limit={u.patients.limit} />
            <UsageBar label="Storage" used={u.storage.used} limit={u.storage.limit} bytes />
            <UsageBar label="Staff" used={u.users.used} limit={u.users.limit} />
            <UsageBar label="Branches" used={u.branches.used} limit={u.branches.limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AccountSecurityCard() {
  const { user, refresh } = useAuth();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ["workspace"], queryFn: getWorkspace, retry: false });

  // --- email ---
  const [newEmail, setNewEmail] = useState("");
  const [emailPw, setEmailPw] = useState("");
  const emailMut = useMutation({
    mutationFn: () => changeEmailApi({ new_email: newEmail.trim(), current_password: emailPw }),
    onSuccess: async () => {
      toast.success("Email updated — sign in with it next time");
      setNewEmail("");
      setEmailPw("");
      await refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the email"),
  });

  // --- password ---
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const mismatch = confirmPw.length > 0 && newPw !== confirmPw;
  const pwMut = useMutation({
    mutationFn: () => changePasswordApi({ current_password: curPw, new_password: newPw }),
    onSuccess: () => {
      toast.success("Password updated — other devices have been signed out");
      setCurPw("");
      setNewPw("");
      setConfirmPw("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the password"),
  });


  // --- workspace ---
  const [slug, setSlug] = useState("");
  useEffect(() => {
    if (ws.data?.slug) setSlug(ws.data.slug);
  }, [ws.data?.slug]);
  const wsMut = useMutation({
    mutationFn: () => updateWorkspace({ slug: slug.trim().toLowerCase() }),
    onSuccess: (d) => {
      toast.success("Workspace updated");
      qc.setQueryData(["workspace"], d);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the workspace"),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>The address you sign in with. Confirm your current password to change it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Current: <span className="font-medium text-foreground">{user?.email ?? "—"}</span>
          </div>
          <div className="grid max-w-md gap-3">
            <div className="space-y-1.5">
              <Label>New email</Label>
              <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="you@clinic.com" autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label>Current password</Label>
              <Input type="password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} autoComplete="current-password" />
            </div>
            <div>
              <Button onClick={() => emailMut.mutate()} disabled={!newEmail.trim() || !emailPw || newEmail.trim() === user?.email} loading={emailMut.isPending}>
                Update email
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Use at least 8 characters. Changing it signs you out on all other devices; you stay signed in here.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid max-w-md gap-3">
            <div className="space-y-1.5">
              <Label>Current password</Label>
              <Input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" />
            </div>
            <div className="space-y-1.5">
              <Label>New password</Label>
              <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
            </div>
            <div className="space-y-1.5">
              <Label>Confirm new password</Label>
              <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
              {mismatch && <p className="text-xs text-destructive">The new passwords don't match.</p>}
            </div>
            <div>
              <Button onClick={() => pwMut.mutate()} disabled={!curPw || newPw.length < 8 || mismatch} loading={pwMut.isPending}>
                Update password
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>Every device signed in to your account. Left yourself signed in on a shared or lost device? Sign it out here.</CardDescription>
        </CardHeader>
        <CardContent>
          <ActiveSessions />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>Your clinic's sign-in handle — what your whole team types in the “Workspace” field at login.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            Changing this changes the sign-in handle for <span className="font-medium text-foreground">everyone</span> in the clinic. Use lowercase letters, numbers, and hyphens (3–40 characters).
          </div>
          <div className="flex max-w-md items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label>Workspace</Label>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-clinic" autoCapitalize="none" autoCorrect="off" />
            </div>
            <Button onClick={() => wsMut.mutate()} disabled={!slug.trim() || slug.trim().toLowerCase() === ws.data?.slug} loading={wsMut.isPending}>
              Update
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LocationsCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const usage = useQuery({ queryKey: ["branch-usage"], queryFn: branchUsage });
  const atLimit = usage.data?.limit != null && usage.data.used >= usage.data.limit;

  const [selected, setSelected] = useState("");
  useEffect(() => {
    const list = branches.data ?? [];
    if (list.length > 0 && !list.some((b) => b.id === selected)) setSelected(list[0].id);
  }, [branches.data, selected]);
  const current = (branches.data ?? []).find((b) => b.id === selected);
  const depts = (departments.data ?? []).filter((d) => d.branch_id === selected);

  const [branchDialog, setBranchDialog] = useState<Branch | "new" | null>(null);
  const [deptDialog, setDeptDialog] = useState<Department | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "branch" | "dept"; id: string; name: string } | null>(null);

  const delBranch = useMutation({
    mutationFn: (id: string) => deleteBranch(id),
    onSuccess: () => {
      toast.success("Branch deleted");
      setConfirm(null);
      setSelected("");
      qc.invalidateQueries({ queryKey: ["branches"] });
      qc.invalidateQueries({ queryKey: ["branch-usage"] });
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete the branch"),
  });
  const delDept = useMutation({
    mutationFn: (id: string) => deleteDepartment(id),
    onSuccess: () => {
      toast.success("Department deleted");
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete the department"),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Branches &amp; departments</CardTitle>
          <CardDescription>Pick a branch, then add, edit, or remove the departments inside it.</CardDescription>
        </div>
        {manage && (
          <div className="flex flex-col items-end gap-1">
            <Button size="sm" variant="outline" onClick={() => setBranchDialog("new")} disabled={atLimit}>
              <Plus /> Add branch
            </Button>
            {usage.data && (
              <span className="text-xs text-muted-foreground">
                {usage.data.used}
                {usage.data.limit != null ? ` of ${usage.data.limit}` : ""} branch{usage.data.used === 1 ? "" : "es"} used
              </span>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Branch switcher */}
        {(branches.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No branches yet. Add your first branch to start.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(branches.data ?? []).map((b) => (
              <button
                key={b.id}
                onClick={() => setSelected(b.id)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                  selected === b.id ? "border-brand bg-brand/5 font-semibold text-brand" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {b.name}
                <span className="font-mono text-xs opacity-70">{b.code}</span>
                {!b.is_active && <Badge variant="outline">inactive</Badge>}
              </button>
            ))}
          </div>
        )}

        {/* Selected branch: toolbar + departments */}
        {current && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                Departments in <span className="font-semibold text-brand">{current.name}</span>
              </p>
              {manage && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setBranchDialog(current)}>
                    <Pencil /> Edit branch
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm({ kind: "branch", id: current.id, name: current.name })}>
                    <Trash2 /> Delete
                  </Button>
                </div>
              )}
            </div>

            <ul className="space-y-2">
              {depts.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 rounded-md border bg-background p-2.5 text-sm">
                  <span>
                    <span className="font-medium">{d.name}</span>
                    {d.specialty ? <span className="text-muted-foreground"> · {d.specialty}</span> : null}
                  </span>
                  {manage && (
                    <div className="flex shrink-0 gap-2">
                      <button onClick={() => setDeptDialog(d)} className="text-xs text-muted-foreground hover:text-foreground">Edit</button>
                      <button onClick={() => setConfirm({ kind: "dept", id: d.id, name: d.name })} className="text-xs text-muted-foreground hover:text-destructive">Remove</button>
                    </div>
                  )}
                </li>
              ))}
              {depts.length === 0 && <p className="text-sm text-muted-foreground">No departments in this branch yet.</p>}
            </ul>

            {manage && (
              <Button size="sm" variant="outline" onClick={() => setDeptDialog("new")}>
                <Plus /> Add department
              </Button>
            )}

            <BranchModules branchId={current.id} manage={manage} />
          </div>
        )}
      </CardContent>

      {branchDialog && (
        <BranchDialog
          branch={branchDialog === "new" ? null : branchDialog}
          onClose={() => setBranchDialog(null)}
          onSaved={(b) => { setBranchDialog(null); qc.invalidateQueries({ queryKey: ["branches"] }); qc.invalidateQueries({ queryKey: ["branch-usage"] }); if (b) setSelected(b.id); }}
        />
      )}
      {deptDialog && current && (
        <DepartmentDialog
          dept={deptDialog === "new" ? null : deptDialog}
          branchId={selected}
          branchName={current.name}
          onClose={() => setDeptDialog(null)}
          onSaved={() => { setDeptDialog(null); qc.invalidateQueries({ queryKey: ["departments"] }); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "branch" ? "Delete branch" : "Delete department"}
          message={
            confirm.kind === "branch"
              ? `Delete “${confirm.name}”? It stops appearing in scheduling and reception, and the departments inside it become unreachable.`
              : `Delete the “${confirm.name}” department?`
          }
          loading={confirm.kind === "branch" ? delBranch.isPending : delDept.isPending}
          onConfirm={() => (confirm.kind === "branch" ? delBranch.mutate(confirm.id) : delDept.mutate(confirm.id))}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}

const MODULE_LABELS: Record<string, string> = {
  laboratory: "Laboratory",
  pharmacy: "Pharmacy",
  inventory: "Inventory",
};

// BranchModules lets an admin turn modules (lab, pharmacy, inventory) on/off for a
// single branch, overriding the clinic-wide default. "Reset" removes the override.
function BranchModules({ branchId, manage }: { branchId: string; manage: boolean }) {
  const qc = useQueryClient();
  const mods = useQuery({ queryKey: ["branch-modules", branchId], queryFn: () => getBranchModules(branchId) });
  const save = useMutation({
    mutationFn: (next: Record<string, boolean | null>) => setBranchModules(branchId, next),
    onSuccess: () => {
      toast.success("Module updated for this branch");
      qc.invalidateQueries({ queryKey: ["branch-modules", branchId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the module"),
  });
  const list = mods.data ?? [];
  if (list.length === 0) return null;
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm">Modules in this branch</p>
      <p className="text-xs text-muted-foreground">Turn a module on or off for this branch only. Reset follows the clinic-wide default.</p>
      <ul className="space-y-2">
        {list.map((m) => (
          <li key={m.flag} className="flex items-center justify-between gap-3 rounded-md border bg-background p-2.5 text-sm">
            <span className="flex items-center gap-2">
              <span className="font-medium">{MODULE_LABELS[m.flag] ?? m.flag}</span>
              {m.overridden ? <Badge variant="outline">override</Badge> : <span className="text-xs text-muted-foreground">default</span>}
            </span>
            {manage && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant={m.enabled ? "default" : "outline"} onClick={() => save.mutate({ [m.flag]: !m.enabled })} loading={save.isPending}>
                  {m.enabled ? "On" : "Off"}
                </Button>
                {m.overridden && (
                  <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => save.mutate({ [m.flag]: null })}>
                    Reset
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BranchDialog({ branch, onClose, onSaved }: { branch: Branch | null; onClose: () => void; onSaved: (b?: Branch) => void }) {
  const [name, setName] = useState(branch?.name ?? "");
  const [code, setCode] = useState(branch?.code ?? "");
  const [active, setActive] = useState(branch?.is_active ?? true);
  const save = useMutation({
    mutationFn: () => (branch ? updateBranch(branch.id, { name, code, is_active: active }) : createBranch({ name, code })),
    onSuccess: (b) => { toast.success(branch ? "Branch updated" : "Branch added"); onSaved(b); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the branch (code may be taken)"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{branch ? "Edit branch" : "New branch"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Bole Branch" /></div>
          <div className="space-y-1.5"><Label>Code</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="BOLE" /></div>
          {branch && (
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={active ? "active" : "inactive"} onValueChange={(v) => setActive(v === "active")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || !code.trim()} loading={save.isPending} onClick={() => save.mutate()}>{branch ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DepartmentDialog({ dept, branchId, branchName, onClose, onSaved }: { dept: Department | null; branchId: string; branchName: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(dept?.name ?? "");
  const [specialty, setSpecialty] = useState(dept?.specialty ?? "");
  const save = useMutation({
    mutationFn: async () => {
      if (dept) await updateDepartment(dept.id, { branch_id: branchId, name, specialty });
      else await createDepartment({ branch_id: branchId, name, specialty });
    },
    onSuccess: () => { toast.success(dept ? "Department updated" : "Department added"); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the department"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{dept ? "Edit department" : `New department in ${branchName}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pediatrics" /></div>
          <div className="space-y-1.5"><Label>Specialty</Label><Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="pediatrics" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>{dept ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({ title, message, confirmLabel = "Delete", loading, onConfirm, onClose }: { title: string; message: string; confirmLabel?: string; loading?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{message}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DrugLibraryCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const drugs = useQuery({ queryKey: ["drugs-all", search], queryFn: () => searchDrugs(search, true) });
  const allergens = useQuery({ queryKey: ["allergens-all"], queryFn: () => listAllergens(undefined, true) });
  const [editing, setEditing] = useState<Drug | "new" | null>(null);

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
              // The description is shown, not hidden behind a hover: this card is
              // where an admin comes to check what the library actually says.
              <span key={a.id} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${a.is_active ? "" : "opacity-50"}`}>
                {a.default_severity && (
                  <span className={`h-2 w-2 shrink-0 rounded-full ${severityClass(a.default_severity)}`}
                    title={`Usually ${a.default_severity}`} />
                )}
                <span className="font-medium">{a.name}</span>
                {(a.default_reaction || a.default_severity) && (
                  <span className="text-muted-foreground">
                    {[a.default_reaction, a.default_severity].filter(Boolean).join(" · ")}
                  </span>
                )}
                {manage && <button onClick={() => removeAllergen.mutate(a.id)} aria-label={`Remove allergen ${a.name}`} className="touch-hit text-muted-foreground hover:text-destructive"><Plus className="h-3 w-3 rotate-45" /></button>}
              </span>
            ))}
            {(allergens.data?.length ?? 0) === 0 && <span className="text-sm text-muted-foreground">No allergens yet.</span>}
          </div>
          {manage && <NewAllergenForm compact />}
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

  const [catDialog, setCatDialog] = useState<DiagnosisCategory | null>(null);
  const [entryDialog, setEntryDialog] = useState<CatalogEntry | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "cat" | "entry"; id: string; name: string } | null>(null);

  const delCat = useMutation({
    mutationFn: (id: string) => deleteCategory(id),
    onSuccess: () => { toast.success("Category deleted"); setConfirm(null); qc.invalidateQueries({ queryKey: ["diag-categories"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete the category"),
  });
  const delEntry = useMutation({
    mutationFn: (id: string) => deleteCatalogEntry(id),
    onSuccess: () => { toast.success("Diagnosis deleted"); setConfirm(null); qc.invalidateQueries({ queryKey: ["diag-catalog-all"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete the diagnosis"),
  });

  // Deleting a category would orphan its diagnoses (soft-delete, no cascade), so
  // block it while any diagnosis still uses it.
  const tryDeleteCat = (c: DiagnosisCategory) => {
    const n = (entries.data ?? []).filter((e) => e.category_id === c.id).length;
    if (n > 0) {
      toast.error(`“${c.name}” still has ${n} diagnosis${n > 1 ? "es" : ""} — remove or move them first.`);
      return;
    }
    setConfirm({ kind: "cat", id: c.id, name: c.name });
  };

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
              <span key={c.id} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${c.is_active ? "" : "opacity-50"}`}>
                {c.name}
                {manage && (
                  // Phones widen the gap between the two micro-icons so their
                  // coarse-pointer hit halos stop overlapping; desktop keeps the
                  // dense gap-1.5 pill untouched.
                  <span className="inline-flex items-center gap-1.5 max-md:gap-3">
                    <button onClick={() => setCatDialog(c)} aria-label={`Edit category ${c.name}`} className="touch-hit text-muted-foreground hover:text-foreground" title="Edit category"><Pencil className="h-3 w-3" /></button>
                    <button onClick={() => tryDeleteCat(c)} aria-label={`Delete category ${c.name}`} className="touch-hit text-muted-foreground hover:text-destructive" title="Delete category"><Plus className="h-3 w-3 rotate-45" /></button>
                  </span>
                )}
              </span>
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
              <li key={e.id} className="flex items-center justify-between gap-3 rounded-md border bg-background p-2 text-sm">
                <span>
                  {e.code ? <span className="font-mono text-xs text-muted-foreground">{e.code} </span> : null}
                  {e.name} <span className="text-xs text-muted-foreground">· {e.category_name}</span>
                </span>
                {manage && (
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => setEntryDialog(e)} className="text-xs text-muted-foreground hover:text-foreground">Edit</button>
                    <button onClick={() => setConfirm({ kind: "entry", id: e.id, name: e.name })} className="text-xs text-muted-foreground hover:text-destructive">Remove</button>
                  </div>
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

      {catDialog && (
        <CategoryDialog
          category={catDialog}
          onClose={() => setCatDialog(null)}
          onSaved={() => { setCatDialog(null); qc.invalidateQueries({ queryKey: ["diag-categories"] }); qc.invalidateQueries({ queryKey: ["diag-catalog-all"] }); }}
        />
      )}
      {entryDialog && (
        <DiagnosisDialog
          entry={entryDialog}
          categories={categories.data ?? []}
          onClose={() => setEntryDialog(null)}
          onSaved={() => { setEntryDialog(null); qc.invalidateQueries({ queryKey: ["diag-catalog-all"] }); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "cat" ? "Delete category" : "Delete diagnosis"}
          message={`Delete “${confirm.name}”?`}
          loading={confirm.kind === "cat" ? delCat.isPending : delEntry.isPending}
          onConfirm={() => (confirm.kind === "cat" ? delCat.mutate(confirm.id) : delEntry.mutate(confirm.id))}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}

function CategoryDialog({ category, onClose, onSaved }: { category: DiagnosisCategory; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category.name);
  const [active, setActive] = useState(category.is_active);
  const save = useMutation({
    mutationFn: () => updateCategory(category.id, { name, sort_order: category.sort_order, is_active: active }),
    onSuccess: () => { toast.success("Category updated"); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the category (name may exist)"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit category</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dermatology" /></div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={active ? "active" : "inactive"} onValueChange={(v) => setActive(v === "active")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiagnosisDialog({ entry, categories, onClose, onSaved }: { entry: CatalogEntry; categories: DiagnosisCategory[]; onClose: () => void; onSaved: () => void }) {
  const [categoryId, setCategoryId] = useState(entry.category_id);
  const [code, setCode] = useState(entry.code ?? "");
  const [name, setName] = useState(entry.name);
  const save = useMutation({
    mutationFn: () => updateCatalogEntry(entry.id, { category_id: categoryId, code: code || undefined, name }),
    onSuccess: () => { toast.success("Diagnosis updated"); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the diagnosis (code may exist)"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit diagnosis</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[7rem_1fr] gap-3">
            <div className="space-y-1.5"><Label>ICD code</Label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="J02.9" /></div>
            <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acute pharyngitis" /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!categoryId || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                    {/* A bare checkbox is too small for a thumb, and .touch-hit's ::after
                        cannot render on an <input> — the padded label carries the halo and
                        forwards the tap; its negative margin keeps the layout untouched. */}
                    <label className="touch-hit -m-1.5 inline-flex items-center p-1.5">
                      <input type="checkbox" checked={f.enabled} disabled={!manage} onChange={(e) => patch(i, { enabled: e.target.checked })} />
                    </label>
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
                    <label className="touch-hit -m-1.5 inline-flex items-center p-1.5">
                      <input type="checkbox" checked={f.required} disabled={!manage || !f.enabled} onChange={(e) => patch(i, { required: e.target.checked })} />
                    </label>
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
  const { flagOn } = useAuth();
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
          {/* A dental clinic always goes straight to the dentist; the setting does nothing there. */}
          {!flagOn("dental") && <div className="space-y-1.5">
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
          </div>}
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

// --- how this clinic gets paid ---------------------------------------------------
//
// Until now the answer was four words hard-coded in three different files: cash,
// card, mobile, transfer. Two of them are categories, not methods — "Mobile" could be
// Telebirr or M-Pesa, and no bank issues a statement called Mobile, so a day's
// takings could never be checked against one.
//
// Here the clinic names its own: "Telebirr — 0911…", "CBE — …7441". Naming the
// account is the useful part twice over: the desk can see which account to point a
// patient at, and it is the fact a receipt-verification service will need later to
// confirm a transfer reached THIS clinic rather than someone else's.
const RAIL_KINDS = [
  { value: "cash", label: "Cash", hint: "Notes and coins. Nothing to reference." },
  { value: "card", label: "Card machine", hint: "A POS terminal. No transaction to look up." },
  { value: "wallet", label: "Mobile wallet", hint: "Telebirr, M-Pesa, CBE Birr — paid to a phone number." },
  { value: "bank", label: "Bank transfer", hint: "CBE, Awash, Dashen — paid to an account." },
];

/** The providers a rail can name — the receipt-verification vocabulary, so the
 *  clinic's configuration is already the right shape when verification arrives. */
const PROVIDERS: Record<string, { value: string; label: string }[]> = {
  wallet: [
    { value: "telebirr", label: "Telebirr" },
    { value: "mpesa", label: "M-Pesa" },
    { value: "cbebirr", label: "CBE Birr" },
    { value: "kaafiebirr", label: "Kaafi eBirr" },
  ],
  bank: [
    { value: "cbe", label: "Commercial Bank of Ethiopia" },
    { value: "boa", label: "Bank of Abyssinia" },
    { value: "dashen", label: "Dashen Bank" },
    { value: "awash", label: "Awash Bank" },
    { value: "siinqee", label: "Siinqee Bank" },
    { value: "zemen", label: "Zemen Bank" },
  ],
};

function PaymentRailsCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["payment-rails", "all"], queryFn: () => listPaymentRails(true) });
  const [editing, setEditing] = useState<PaymentRail | "new" | null>(null);
  const { ask, dialog } = useConfirmDialog();

  const del = useMutation({
    mutationFn: (id: string) => deletePaymentRail(id),
    onSuccess: () => { toast.success("Removed"); qc.invalidateQueries({ queryKey: ["payment-rails"] }); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove it"),
  });
  const toggle = useMutation({
    mutationFn: (r: PaymentRail) => updatePaymentRail(r.id, { ...r, active: !r.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payment-rails"] }),
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not change it"),
  });

  const rails = q.data ?? [];
  return (
    <Card>
      {dialog}
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Payment methods</CardTitle>
          <CardDescription>
            How this clinic takes money. Name your real accounts and the desk records which
            transfer paid which bill — so a day's takings can be checked against the statement.
          </CardDescription>
        </div>
        {manage && <Button size="sm" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add</Button>}
      </CardHeader>
      <CardContent className="space-y-2">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {rails.map((r) => (
          <div key={r.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2", !r.active && "bg-muted/40")}>
            <span className="font-medium">{r.label}</span>
            <Badge variant="outline" className="capitalize">{RAIL_KINDS.find((k) => k.value === r.kind)?.label ?? r.kind}</Badge>
            {r.account_number && <span className="font-mono text-xs text-muted-foreground">{r.account_number}</span>}
            {/* A wallet or bank with no provider is one of the four generic methods
                this clinic started with. It still takes money; it just cannot say
                which account, so nothing about it can be checked later. */}
            {(r.kind === "wallet" || r.kind === "bank") && !r.bank_key && (
              <Badge variant="warning">no account named</Badge>
            )}
            {r.needs_reference && <Badge variant="outline">reference required</Badge>}
            {!r.active && <Badge variant="outline">off</Badge>}
            {manage && (
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>{r.active ? "Switch off" : "Switch on"}</Button>
                <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Remove"
                  onClick={() => ask({
                    title: `Remove ${r.label}?`,
                    description: <>It disappears from the payment picker. A method that has already taken money cannot be removed — switch it off instead.</>,
                    confirmLabel: "Remove", destructive: true,
                  }, async () => { await del.mutateAsync(r.id); })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        ))}
        {!q.isLoading && rails.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No payment methods yet.</p>
        )}
        {rails.some((r) => (r.kind === "wallet" || r.kind === "bank") && !r.bank_key && r.active) && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <b>Name your accounts.</b> "Mobile money" and "Bank transfer" are the generic methods this
            clinic started with — they take money, but a payment recorded against them cannot be
            traced to an account or checked against a statement. Add your real ones (Telebirr, CBE…)
            and switch the generic ones off.
          </p>
        )}
      </CardContent>
      {editing && <RailDialog rail={editing === "new" ? null : editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["payment-rails"] }); }} />}
    </Card>
  );
}

function RailDialog({ rail, onClose, onSaved }: { rail: PaymentRail | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(rail?.label ?? "");
  const [kind, setKind] = useState(rail?.kind ?? "wallet");
  const [bankKey, setBankKey] = useState(rail?.bank_key ?? "");
  const [accountNumber, setAccountNumber] = useState(rail?.account_number ?? "");
  const [accountName, setAccountName] = useState(rail?.account_name ?? "");
  const [needsRef, setNeedsRef] = useState(rail?.needs_reference ?? true);
  const takesAccount = kind === "wallet" || kind === "bank";

  const save = useMutation({
    mutationFn: () => {
      const body = {
        label, kind, bank_key: takesAccount ? bankKey : "",
        account_name: takesAccount ? accountName : "",
        account_number: takesAccount ? accountNumber : "",
        needs_reference: takesAccount && needsRef,
        active: rail?.active ?? true, sort_order: rail?.sort_order ?? 10,
      };
      return rail ? updatePaymentRail(rail.id, body) : createPaymentRail(body);
    },
    onSuccess: () => { toast.success(rail ? "Saved" : "Payment method added"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save it"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{rail ? "Edit payment method" : "Add a payment method"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rail-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => { setKind(v as PaymentRail["kind"]); setBankKey(""); }}>
              <SelectTrigger id="rail-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RAIL_KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{RAIL_KINDS.find((k) => k.value === kind)?.hint}</p>
          </div>

          {takesAccount && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="rail-provider">Provider</Label>
                <Select value={bankKey} onValueChange={setBankKey}>
                  <SelectTrigger id="rail-provider"><SelectValue placeholder="Which bank or wallet?" /></SelectTrigger>
                  <SelectContent>
                    {(PROVIDERS[kind] ?? []).map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rail-account">{kind === "wallet" ? "Phone number" : "Account number"}</Label>
                <Input id="rail-account" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder={kind === "wallet" ? "0911 22 33 44" : "1000 1234 5678"} />
                <p className="text-xs text-muted-foreground">
                  The account patients pay into. Shown to whoever is taking the payment.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rail-holder">Account name <span className="text-muted-foreground">(optional)</span></Label>
                <Input id="rail-holder" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="rail-label">Name it</Label>
            <Input id="rail-label" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder={kind === "wallet" ? "Telebirr" : kind === "bank" ? "CBE" : "Cash"} />
            <p className="text-xs text-muted-foreground">What the desk sees in the payment list.</p>
          </div>

          {takesAccount && (
            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input type="checkbox" className="mt-0.5" checked={needsRef} onChange={(e) => setNeedsRef(e.target.checked)} />
              <span>
                <span className="font-medium">Require the transaction reference</span>
                <span className="block text-xs text-muted-foreground">
                  The desk cannot take the payment without it. Leave this off while staff are
                  getting used to entering one — the field is still there, just optional.
                </span>
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!label.trim() || (takesAccount && !bankKey)} loading={save.isPending}
            onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The list of what this practice does.
 *
 * It was a constant in the frontend — the same seventeen names for every clinic on
 * the platform — so a practice doing implants could not offer one, and a practice
 * doing no dentures scrolled past two kinds on every visit. A clinic's vocabulary is
 * its own.
 *
 * Retiring is offered beside deleting because they mean different things. A retired
 * procedure leaves the picker and stays legible in every visit that recorded it;
 * that is what a clinic means by "we stopped doing that". Nothing here can rewrite a
 * past visit either way: a session stores what was done as text.
 */
function DentalProceduresCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["dental-procedures-all"], queryFn: () => listProcedures(true) });
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState("");
  const done = () => {
    qc.invalidateQueries({ queryKey: ["dental-procedures-all"] });
    qc.invalidateQueries({ queryKey: ["dental-procedures"] });
  };
  const run = (fn: () => Promise<unknown>) =>
    fn().then(() => { setErr(""); done(); }).catch((e: Error) => setErr(e.message));

  const rows = q.data ?? [];
  const move = (i: number, by: number) => {
    const next = [...rows];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    run(() => reorderProcedures(next.map((r) => r.id)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dental procedures</CardTitle>
        <CardDescription>
          What this clinic offers, in the order you want to see it. This is the list the
          chairside picker shows. Changing it never alters a visit already recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-sm text-destructive">{err}</p>}

        {manage && (
          <div className="flex flex-wrap gap-2">
            <Input className="max-w-xs" placeholder="Add a procedure — e.g. Implant placement"
              value={adding} onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && adding.trim()) { run(() => createProcedure(adding)); setAdding(""); } }} />
            <Button disabled={!adding.trim()} onClick={() => { run(() => createProcedure(adding)); setAdding(""); }}>
              Add
            </Button>
          </div>
        )}

        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No procedures yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((p, i) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 p-2.5">
                {editing?.id === p.id ? (
                  <>
                    <Input className="max-w-xs" value={editing.name} autoFocus
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    <Button size="sm" onClick={() => { run(() => updateProcedure(p.id, { name: editing.name })); setEditing(null); }}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <span className={`flex-1 text-sm ${p.is_active ? "" : "text-muted-foreground line-through"}`}>{p.name}</span>
                    {!p.is_active && <Badge variant="outline">retired</Badge>}
                    {manage && (
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="px-2" title="Move up" onClick={() => move(i, -1)}>↑</Button>
                        <Button size="sm" variant="ghost" className="px-2" title="Move down" onClick={() => move(i, 1)}>↓</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ id: p.id, name: p.name })}>Rename</Button>
                        <Button size="sm" variant="ghost"
                          onClick={() => run(() => updateProcedure(p.id, { name: p.name, is_active: !p.is_active }))}>
                          {p.is_active ? "Retire" : "Bring back"}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive"
                          onClick={() => run(() => deleteProcedure(p.id))}>Remove</Button>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The conditions this clinic marks on a tooth.
 *
 * Five were compiled in — healthy, decayed, filled, extracted, crown — so a practice
 * charting "root treated" or "implant" had nowhere to put them. The order here is
 * the order a tap cycles through on the chart, which is why moving a row matters:
 * put the ones you mark most often first and charting a mouth takes fewer taps.
 *
 * A condition's internal code is fixed when it is created and never changes, so
 * renaming "Filled" to "Restored" relabels every legend and leaves every chart
 * exactly as the dentist marked it. Removing one is equally safe: a tooth already
 * marked keeps its mark.
 */
/**
 * Which tooth chart this clinic draws on. Both charts read and write the same
 * record, so switching changes the drawing and never the data: a mark made on one
 * is shown on the other.
 */
const CHART_STYLES: { value: ChartStyle; title: string; body: string }[] = [
  {
    value: "simple",
    title: "Simple",
    body: "One square per tooth, Palmer numbers (UR1), and this clinic's own tooth conditions. Quick to mark a whole mouth.",
  },
  {
    value: "anatomical",
    title: "Anatomical",
    body: "Each tooth drawn from the side and from above, FDI numbers (11), caries and fillings on each surface, crown, root canal, missing, tooth position and gaps. Adult and child teeth.",
  },
];

function ToothChartStyleCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["dental-settings"], queryFn: getDentalSettings });
  const save = useMutation({
    mutationFn: (chart_style: ChartStyle) => saveDentalSettings({ chart_style }),
    onSuccess: (res) => {
      qc.setQueryData(["dental-settings"], res);
      toast.success(`Tooth chart: ${res.chart_style === "anatomical" ? "Anatomical" : "Simple"}`);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not change the tooth chart"),
  });
  const current = q.data?.chart_style;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tooth chart</CardTitle>
        <CardDescription>
          The chart your dentists draw on. You can switch at any time: both charts keep the
          same record, so nothing a dentist recorded is lost or hidden when you change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isError && <p className="text-sm text-destructive">The current choice could not be loaded.</p>}
        <div role="radiogroup" aria-label="Tooth chart" className="grid gap-3 sm:grid-cols-2">
          {CHART_STYLES.map((o) => {
            const on = current === o.value;
            return (
              <button key={o.value} type="button" role="radio" aria-checked={on}
                disabled={!manage || q.isLoading || save.isPending}
                onClick={() => { if (!on) save.mutate(o.value); }}
                className={cn(
                  "rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed",
                  on ? "border-brand bg-brand/5 ring-1 ring-brand" : "hover:bg-accent/50",
                  !manage && !on && "opacity-60",
                )}>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{o.title}</span>
                  {on && <Badge variant="outline" className="border-brand text-brand">In use</Badge>}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">{o.body}</span>
              </button>
            );
          })}
        </div>
        {!manage && <p className="text-xs text-muted-foreground">Only the clinic's administrator can change this.</p>}
      </CardContent>
    </Card>
  );
}

function ToothConditionsCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tooth-statuses-all"], queryFn: () => listToothStatuses(true) });
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("#0a7c59");
  const [editing, setEditing] = useState<{ id: string; label: string; color: string } | null>(null);
  const [err, setErr] = useState("");
  const done = () => {
    qc.invalidateQueries({ queryKey: ["tooth-statuses-all"] });
    qc.invalidateQueries({ queryKey: ["tooth-statuses"] });
  };
  const run = (fn: () => Promise<unknown>) =>
    fn().then(() => { setErr(""); done(); }).catch((e: Error) => setErr(e.message));

  const rows = q.data ?? [];
  const move = (i: number, by: number) => {
    const next = [...rows];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    run(() => reorderToothStatuses(next.map((r) => r.id)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tooth conditions</CardTitle>
        <CardDescription>
          What you can mark on a tooth, and the colour it shows in. This order is the
          order a tap cycles through on the chart. Renaming or removing one never changes
          a tooth already marked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <p className="text-sm text-destructive">{err}</p>}

        {manage && (
          <div className="flex flex-wrap items-center gap-2">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border bg-card p-1" aria-label="Colour" />
            <Input className="max-w-xs" placeholder="Add a condition — e.g. Root treated"
              value={label} onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && label.trim()) { run(() => createToothStatus(label, color)); setLabel(""); } }} />
            <Button disabled={!label.trim()} onClick={() => { run(() => createToothStatus(label, color)); setLabel(""); }}>
              Add
            </Button>
          </div>
        )}

        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((t, i) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 p-2.5">
                {editing?.id === t.id ? (
                  <>
                    <input type="color" value={editing.color} className="h-9 w-12 cursor-pointer rounded-md border bg-card p-1"
                      onChange={(e) => setEditing({ ...editing, color: e.target.value })} aria-label="Colour" />
                    <Input className="max-w-xs" value={editing.label} autoFocus
                      onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
                    <Button size="sm" onClick={() => { run(() => updateToothStatus(t.id, { label: editing.label, color: editing.color })); setEditing(null); }}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    {/* The swatch as it appears on a tooth, not as a raw colour chip:
                        what the clinic is choosing is how a tooth will look. */}
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-xs font-semibold"
                      style={{ background: `color-mix(in srgb, ${t.color} 14%, white)`, borderColor: t.color, color: t.color }}>
                      6
                    </span>
                    <span className={`flex-1 text-sm ${t.is_active ? "" : "text-muted-foreground line-through"}`}>{t.label}</span>
                    {!t.is_active && <Badge variant="outline">retired</Badge>}
                    {manage && (
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="px-2" title="Move up" onClick={() => move(i, -1)}>↑</Button>
                        <Button size="sm" variant="ghost" className="px-2" title="Move down" onClick={() => move(i, 1)}>↓</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ id: t.id, label: t.label, color: t.color })}>Edit</Button>
                        <Button size="sm" variant="ghost"
                          onClick={() => run(() => updateToothStatus(t.id, { label: t.label, color: t.color, is_active: !t.is_active }))}>
                          {t.is_active ? "Retire" : "Bring back"}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive"
                          onClick={() => run(() => deleteToothStatus(t.id))}>Remove</Button>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
