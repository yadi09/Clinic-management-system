import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, MoreVertical, Pencil, Plus, Stethoscope, Trash2, UserRound, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { AppError } from "@/lib/api-client";
import { createService, deleteService, getServiceProviders, listServices, setServiceActive, setServiceDefault, setServiceProviders, updateService, type ServiceItem } from "@/features/billing/api";
import { listUsers } from "@/features/admin/api";

// Who may put a service on a patient.
//
// This is a real rule, not a hint: the server checks it whenever a charge is
// raised, so a front desk cannot quietly sell a root canal by using a different
// screen. It lives per service rather than per role because clinics disagree —
// a small practice wants the desk to add a cleaning, a large one wants every
// clinical item to come from the chair.
const ASSIGNABLE = {
  either: { label: "Anyone", hint: "The front desk or the clinician can add it", cls: "border-slate-200 bg-slate-50 text-muted-foreground" },
  clinician: { label: "Clinician", hint: "Only clinical staff can add it to a patient", cls: "border-indigo-200 bg-indigo-50 text-indigo-700" },
  reception: { label: "Front desk", hint: "Added at reception, not from the chair", cls: "border-sky-200 bg-sky-50 text-sky-700" },
} as const;
type Assignable = keyof typeof ASSIGNABLE;
const ASSIGN_ORDER: Assignable[] = ["either", "clinician", "reception"];
function assignOf(s: ServiceItem): Assignable {
  return (s.assignable_by in ASSIGNABLE ? s.assignable_by : "either") as Assignable;
}

/** Providers-pill tone: unknown is quiet, zero staff is a problem, staffed is healthy. */
function providerPillCls(n: number | undefined) {
  return n === undefined ? "border-slate-200 bg-slate-50 text-muted-foreground"
    : n === 0 ? "border-rose-200 bg-rose-50 text-rose-700"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
}

/** The body an update needs — every field, because the endpoint replaces the row. */
function bodyOf(s: ServiceItem, over: Partial<{ assignable_by: string }> = {}) {
  return { code: s.code, name: s.name, category: s.category, price: parseFloat(s.price) || 0, assignable_by: assignOf(s), ...over };
}

export function ServiceCatalogPage() {
  const { ask, dialog } = useConfirmDialog();
  const { can, flagOn } = useAuth();
  const qc = useQueryClient();
  const services = useQuery({ queryKey: ["services-all"], queryFn: () => listServices(false) });
  const [editing, setEditing] = useState<ServiceItem | null>(null);
  const [assigning, setAssigning] = useState<ServiceItem | null>(null);
  const [creating, setCreating] = useState(false);
  // Two lists, because they answer to different people. A dentist maintains the
  // procedures they perform; an administrator maintains what the clinic bills for.
  const dentalOn = flagOn("dental");
  const [tab, setTab] = useState<"general" | "dental">(
    dentalOn && !can("billing.manage") ? "dental" : "general");
  const onDental = dentalOn && tab === "dental";
  const mayEdit = onDental ? can("dental.manage") || can("billing.manage") : can("billing.manage");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["services-all"] });
    qc.invalidateQueries({ queryKey: ["service-provider-counts"] });
  };

  const all = services.data ?? [];
  const isDental = (s: ServiceItem) => s.category.trim().toLowerCase() === "dental";
  const svcList = all.filter((s) => (onDental ? isDental(s) : !isDental(s)));
  // How many staff provide each service — powers the "Providers" column so a
  // manager sees at a glance which services can't be sent straight to a doctor.
  const counts = useQuery({
    queryKey: ["service-provider-counts", svcList.map((s) => s.id).join(",")],
    enabled: svcList.length > 0 && !onDental,
    queryFn: async () => {
      const entries = await Promise.all(svcList.map(async (s) => [s.id, (await getServiceProviders(s.id)).length] as const));
      return Object.fromEntries(entries) as Record<string, number>;
    },
  });

  const toggle = useMutation({
    mutationFn: (s: ServiceItem) => setServiceActive(s.id, !s.is_active),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });
  const toggleDefault = useMutation({
    mutationFn: (s: ServiceItem) => setServiceDefault(s.id, !s.is_default),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });
  // Clicking the badge cycles the rule. Three values, one click each — a dropdown
  // for three mutually-exclusive words is more machinery than the choice deserves.
  const cycleAssign = useMutation({
    mutationFn: (s: ServiceItem) => {
      const next = ASSIGN_ORDER[(ASSIGN_ORDER.indexOf(assignOf(s)) + 1) % ASSIGN_ORDER.length];
      return updateService(s.id, bodyOf(s, { assignable_by: next }));
    },
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });
  // On a phone the cycling pill is a silent edit: no hover title warns that a tap
  // rewrites who may bill the service, so "Anyone" becomes "Front desk" by accident.
  // The mobile card therefore names the target rule instead of asking for "next".
  const setAssign = useMutation({
    mutationFn: ({ s, next }: { s: ServiceItem; next: Assignable }) => updateService(s.id, bodyOf(s, { assignable_by: next })),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteService(id),
    onSuccess: () => { toast.success("Service removed"); refresh(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not delete"),
  });
  // One confirm for both layouts, so what "remove" means can never drift between
  // the table row and the phone card.
  const confirmDelete = (s: ServiceItem) =>
    ask({ title: `Remove "${s.name}"?`, description: "It can no longer be charged. Charges already raised are unaffected.", confirmLabel: "Remove service", destructive: true }, () => del.mutateAsync(s.id));

  return (
    <div className="space-y-6">
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Service catalog</h1>
          <p className="text-sm text-muted-foreground">
            {onDental
              ? <>The procedures this clinic performs, priced once. A treatment plan picks from here, so the same work costs the same for every patient.</>
              : <>What the clinic bills for, and how much. Prices feed the charges patients pay at the cashier. <span className="font-medium text-foreground">Default</span> services are pre-selected at reception (e.g. a registration fee).</>}
          </p>
        </div>
        {mayEdit && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New {onDental ? "procedure" : "service"}</Button>}
      </div>

      {dentalOn && (
        <Segmented
          ariaLabel="Catalog"
          value={tab}
          onChange={setTab}
          options={[
            { value: "general", label: "General services", badge: all.filter((s) => !isDental(s)).length || undefined },
            { value: "dental", label: "Dental procedures", badge: all.filter(isDental).length || undefined },
          ]}
        />
      )}

      <div className="rounded-md border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm text-muted-foreground">
        {onDental ? (
          <>The <span className="font-medium text-foreground">one true price</span> for each procedure. A treatment plan built from this list carries the price with it, so the same crown costs the same for every patient — and the finance report can finally say how many were done. The dentist can add to this list.</>
        ) : (
          <><span className="font-medium text-foreground">Providers</span> are the staff who perform each service. Reception can only send a patient <span className="font-medium text-foreground">straight to a doctor</span> for staff assigned here — use the <span className="font-medium text-foreground">Providers</span> column to assign them.</>
        )}
      </div>

      <Card className="overflow-hidden">
        {/* Below md the eight-column table lost the viewport fight: the row actions sat
            entirely off-screen, "Assigned by" clipped mid-word, and prices wrapped
            between currency and amount. Same data, same mutations — stacked as cards.
            The table is untouched from md up. */}
        <div className="divide-y md:hidden">
          {svcList.map((s) => {
            const n = counts.data?.[s.id];
            const a = assignOf(s);
            return (
              <div key={s.id} className="space-y-2.5 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {s.code}
                      {!onDental && s.category && <span className="capitalize"> · {s.category}</span>}
                    </p>
                  </div>
                  <span className="whitespace-nowrap pt-px font-mono text-sm tabular-nums">{s.currency} {s.price}</span>
                  {(mayEdit || !onDental) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        {/* The table reveals actions on hover; a thumb has no hover, so one
                            kebab holds them all. Explicit 44px — size="icon" relaxes to
                            40px above sm, and these cards live all the way to md. The
                            negative margin keeps the header line from inflating. */}
                        <Button variant="ghost" size="icon" className="-my-2.5 -mr-2 h-11 w-11 shrink-0 text-muted-foreground" aria-label={`Actions for ${s.name}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {mayEdit && !onDental && <DropdownMenuItem onSelect={() => setAssigning(s)}><Users /> Assign staff</DropdownMenuItem>}
                        {mayEdit && <DropdownMenuItem onSelect={() => setEditing(s)}><Pencil /> Edit</DropdownMenuItem>}
                        {!onDental && (
                          <DropdownMenuItem onSelect={() => toggleDefault.mutate(s)}>
                            {s.is_default ? "Unset reception default" : "Make reception default"}
                          </DropdownMenuItem>
                        )}
                        {mayEdit && <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => confirmDelete(s)}><Trash2 /> Delete</DropdownMenuItem>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {mayEdit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-xs font-medium ${ASSIGNABLE[a].cls}`}>
                          {a === "clinician" ? <Stethoscope className="h-3 w-3" /> : a === "reception" ? <UserRound className="h-3 w-3" /> : null}
                          {ASSIGNABLE[a].label}
                          <ChevronDown className="h-3 w-3 opacity-60" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-64">
                        {ASSIGN_ORDER.map((v) => (
                          <DropdownMenuItem key={v} onSelect={() => v !== a && setAssign.mutate({ s, next: v })}>
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{ASSIGNABLE[v].label}</span>
                              <span className="block text-xs text-muted-foreground">{ASSIGNABLE[v].hint}</span>
                            </span>
                            {v === a && <Check className="shrink-0 text-primary" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <span className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-xs font-medium ${ASSIGNABLE[a].cls}`} title={ASSIGNABLE[a].hint}>
                      {a === "clinician" ? <Stethoscope className="h-3 w-3" /> : a === "reception" ? <UserRound className="h-3 w-3" /> : null}
                      {ASSIGNABLE[a].label}
                    </span>
                  )}
                  {!onDental && (
                    <button
                      onClick={() => setAssigning(s)}
                      className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-xs font-medium ${providerPillCls(n)}`}
                    >
                      <Users className="h-3 w-3" />
                      {n === undefined ? "…" : n === 0 ? "None — assign" : `${n} staff`}
                    </button>
                  )}
                  <button
                    onClick={() => toggle.mutate(s)}
                    className={`min-h-9 rounded-full border px-3 text-xs font-medium ${s.is_active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-muted-foreground"}`}
                  >
                    {s.is_active ? "Available" : "Off"}
                  </button>
                  {/* Default is state worth seeing without opening the kebab (where it is toggled). */}
                  {!onDental && s.is_default && (
                    <span className="inline-flex min-h-9 items-center rounded-full border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary">Default</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <table className="hidden w-full text-sm md:table">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Code</th>
              <th className="font-medium">Service</th>
              {!onDental && <th className="font-medium">Category</th>}
              <th className="font-medium">Price</th>
              <th className="font-medium">Assigned by</th>
              {!onDental && <th className="font-medium">Providers</th>}
              <th className="font-medium">Available</th>
              {!onDental && <th className="font-medium">Default</th>}
              <th className="p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {svcList.map((s) => {
              const n = counts.data?.[s.id];
              return (
              <tr key={s.id} className="group border-b last:border-0">
                <td className="p-3 font-mono text-xs text-muted-foreground">{s.code}</td>
                <td className="font-medium">{s.name}</td>
                {!onDental && <td className="text-muted-foreground capitalize">{s.category}</td>}
                <td className="font-mono">{s.currency} {s.price}</td>
                <td>
                  <button
                    onClick={() => mayEdit && cycleAssign.mutate(s)}
                    disabled={!mayEdit}
                    title={`${ASSIGNABLE[assignOf(s)].hint}${mayEdit ? " — click to change" : ""}`}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${ASSIGNABLE[assignOf(s)].cls} ${mayEdit ? "" : "cursor-default"}`}
                  >
                    {assignOf(s) === "clinician" ? <Stethoscope className="h-3 w-3" />
                      : assignOf(s) === "reception" ? <UserRound className="h-3 w-3" /> : null}
                    {ASSIGNABLE[assignOf(s)].label}
                  </button>
                </td>
                {!onDental && <td>
                  <button
                    onClick={() => setAssigning(s)}
                    title="Assign the staff who provide this service"
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${providerPillCls(n)}`}
                  >
                    <Users className="h-3 w-3" />
                    {n === undefined ? "…" : n === 0 ? "None — assign" : `${n} staff`}
                  </button>
                </td>}
                <td>
                  <button
                    onClick={() => toggle.mutate(s)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${s.is_active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-muted-foreground"}`}
                  >
                    {s.is_active ? "Available" : "Off"}
                  </button>
                </td>
                {!onDental && <td>
                  <button
                    onClick={() => toggleDefault.mutate(s)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${s.is_default ? "border-primary/30 bg-primary/10 text-primary" : "border-slate-200 bg-slate-50 text-muted-foreground"}`}
                    title={s.is_default ? "Pre-selected at reception — click to unset" : "Not pre-selected — click to make a reception default"}
                  >
                    {s.is_default ? "Default" : "—"}
                  </button>
                </td>}
                <td className="p-3">
                  <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100">
                    {!mayEdit && <span className="text-xs text-muted-foreground">View only</span>}
                    {mayEdit && !onDental && <button onClick={() => setAssigning(s)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Assign staff"><Users className="h-4 w-4" /></button>}
                    {mayEdit && <button onClick={() => setEditing(s)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Edit"><Pencil className="h-4 w-4" /></button>}
                    {mayEdit && <button onClick={() => confirmDelete(s)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" title="Delete"><Trash2 className="h-4 w-4" /></button>}
                  </div>
                </td>
              </tr>
            );})}
          </tbody>
        </table>
        {svcList.length === 0 && <p className="p-10 text-center text-sm text-muted-foreground">
          {onDental ? "No dental procedures priced yet — add the ones you perform, and every treatment plan can start from them."
            : "No services yet — add the ones your clinic bills for."}
        </p>}
      </Card>

      <ServiceDialog dental={onDental} open={creating} onOpenChange={setCreating} onDone={refresh} />
      <ServiceDialog dental={onDental} svc={editing ?? undefined} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} onDone={refresh} />
      <AssignStaffDialog svc={assigning ?? undefined} open={!!assigning} onOpenChange={(o) => !o && setAssigning(null)} onDone={refresh} />
    </div>
  );
}

function AssignStaffDialog({ svc, open, onOpenChange, onDone }: { svc?: ServiceItem; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [staff, setStaff] = useState<Record<string, boolean>>({});
  const users = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: open });

  useEffect(() => {
    if (open && svc) {
      getServiceProviders(svc.id).then((ids) => setStaff(Object.fromEntries(ids.map((i) => [i, true])))).catch(() => setStaff({}));
    }
  }, [open, svc]);

  const mut = useMutation({
    mutationFn: () => setServiceProviders(svc!.id, Object.keys(staff).filter((k) => staff[k])),
    onSuccess: () => { toast.success("Providers updated"); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });

  const active = (users.data ?? []).filter((u) => u.status === "active");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Assign staff{svc ? ` — ${svc.name}` : ""}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          Tick the staff who provide this service. Reception can send a patient <span className="font-medium text-foreground">straight to a doctor</span> only for people ticked here.
        </p>
        <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-1">
          {active.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
              <input type="checkbox" checked={!!staff[u.id]} onChange={(e) => setStaff({ ...staff, [u.id]: e.target.checked })} />
              <span className="flex-1">{u.full_name}</span>
              <span className="text-xs capitalize text-muted-foreground">{(u.roles?.[0] ?? "").replace(/_/g, " ")}</span>
            </label>
          ))}
          {active.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No active staff yet — invite them in Settings → Users first.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={mut.isPending} onClick={() => mut.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServiceDialog({ svc, dental, open, onOpenChange, onDone }: {
  svc?: ServiceItem; dental: boolean; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void;
}) {
  const editing = !!svc;
  const [form, setForm] = useState({ code: "", name: "", category: "general", price: "", assignable_by: "either" as string });
  const [staff, setStaff] = useState<Record<string, boolean>>({});
  const users = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: open });

  useEffect(() => {
    if (!open) return;
    setForm(svc
      ? { code: svc.code, name: svc.name, category: svc.category, price: svc.price, assignable_by: assignOf(svc) }
      // A new dental procedure is clinical by default: it is added from the chair,
      // by the person who decided the patient needs it.
      : dental
        ? { code: "", name: "", category: "dental", price: "", assignable_by: "clinician" }
        : { code: "", name: "", category: "general", price: "", assignable_by: "either" });
    if (svc) {
      getServiceProviders(svc.id).then((ids) => setStaff(Object.fromEntries(ids.map((i) => [i, true])))).catch(() => setStaff({}));
    } else {
      setStaff({});
    }
  }, [open, svc, dental]);

  const isDental = form.category.trim().toLowerCase() === "dental";

  const mut = useMutation({
    mutationFn: async () => {
      const body = {
        code: form.code, name: form.name, category: form.category,
        price: parseFloat(form.price) || 0, assignable_by: form.assignable_by,
      };
      const id = editing && svc ? (await updateService(svc.id, body), svc.id) : (await createService(body)).id;
      // Dental procedures are not routed from reception, so there is nobody to
      // assign — and sending an empty list would wipe a general service's staff.
      if (!isDental) await setServiceProviders(id, Object.keys(staff).filter((k) => staff[k]));
    },
    onSuccess: () => { onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the service"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit" : "New"} {isDental ? "procedure" : "service"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={isDental ? "RCT-MOLAR" : "CONSULT"} /></div>
          {isDental ? (
            <div className="space-y-1.5">
              <Label>Price (ETB)</Label>
              <Input type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="4500" />
            </div>
          ) : (
            <div className="space-y-1.5"><Label>Category</Label><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="consultation" /></div>
          )}
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={isDental ? "Root canal — molar" : "Consultation"} /></div>
          {!isDental && (
            <div className="space-y-1.5"><Label>Price (ETB)</Label><Input type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="100" /></div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Who can add this to a patient</Label>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {ASSIGN_ORDER.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setForm({ ...form, assignable_by: v })}
                className={`rounded-md border px-3 py-2 text-left text-xs ${
                  form.assignable_by === v ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:bg-muted"
                }`}
              >
                <span className="block text-sm font-medium">{ASSIGNABLE[v].label}</span>
                <span className="block text-muted-foreground">{ASSIGNABLE[v].hint}</span>
              </button>
            ))}
          </div>
        </div>

        {!isDental && (
          <div className="space-y-1.5">
            <Label>Staff who provide this</Label>
            <p className="text-xs text-muted-foreground">Reception can only assign the patient to staff listed here for the chosen service(s).</p>
            <div className="max-h-44 space-y-1 overflow-auto rounded-md border p-1">
              {(users.data ?? []).filter((u) => u.status === "active").map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                  <input type="checkbox" checked={!!staff[u.id]} onChange={(e) => setStaff({ ...staff, [u.id]: e.target.checked })} />
                  <span className="flex-1">{u.full_name}</span>
                  <span className="text-xs capitalize text-muted-foreground">{(u.roles?.[0] ?? "").replace(/_/g, " ")}</span>
                </label>
              ))}
              {(users.data?.length ?? 0) === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No staff yet.</p>}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!form.code.trim() || !form.name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>{editing ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
