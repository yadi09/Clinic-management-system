import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CalendarClock, ExternalLink, FileText, Pencil, Plus, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import {
  addAllergy,
  addCondition,
  getPatient,
  removeAllergy,
  removeCondition,
} from "@/features/patients/api";
import { patientCharges, refundCharge, type ChargeRow } from "@/features/billing/api";
import { listAllergens, createAllergen } from "@/features/clinical/api";
import { printReceipt } from "@/features/billing/print";
import { getClinic } from "@/features/admin/api";
import { AppError } from "@/lib/api-client";
import { formatEthiopian } from "@/lib/ethiopian";
import { PregnancyDatingCard } from "@/features/maternity/PregnancyCalculator";
import { DentalWorkspace } from "@/features/dental/DentalWorkspace";
import { PatientEditDialog } from "@/features/patients/components/PatientEditDialog";
import { StickyAlertBar, useScrolledPast, type ClinicalAlert } from "@/features/patients/components/StickyAlertBar";
import { listHistory } from "@/features/clinical/api";

function age(dob: string) {
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  return `${Math.abs(new Date(diff).getUTCFullYear() - 1970)}y`;
}

export function PatientProfilePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, flagOn } = useAuth();
  const editable = can("patient.update");
  const [editingPatient, setEditingPatient] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const scrolledPast = useScrolledPast(bannerRef);

  const { data, isLoading, isError } = useQuery({ queryKey: ["patient", id], queryFn: () => getPatient(id) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["patient", id] });

  // Dental clinics get a dedicated workspace in place of the general-medical
  // profile. All hooks above have already run, so this render-time branch is safe.
  // The
  // ONE dental patient page for both roles.
  //
  // There were two — a 745-line clinical page and a 474-line desk page showing the
  // same patient — and they drifted: the same session read "Due" on one screen and
  // "Unpaid" on the other, and every fix had to be made twice. The shared page
  // branches on `dental.manage` internally: the clinician gets the chart,
  // examinations and images; the desk gets the money strip and the missed-visit list.
  //
  // What makes this safe is that the seal is no longer the UI's job. sessionDTO
  // withholds notes, procedure, tooth, prescriptions and image URLs from anyone
  // without dental.manage, proved by reception_seal_e2e.sh — so the desk cannot see
  // the clinical record even though it now runs the clinical page's code.
  if (flagOn("dental")) return <DentalWorkspace patientId={id} />;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-48 lg:col-span-1" />
          <Skeleton className="h-48 lg:col-span-2" />
        </div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">Patient not found.</p>
        <Button variant="outline" onClick={() => navigate("/patients")}>
          <ArrowLeft /> Back to patients
        </Button>
      </div>
    );
  }

  const fullName = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(" ");

  // Severe/moderate allergies lead; active conditions follow. Mild allergies stay
  // in the banner only — putting everything in the sticky bar would dilute it.
  const alerts: ClinicalAlert[] = [
    ...data.allergies
      .filter((a) => a.severity !== "mild")
      .map((a) => ({ key: "alg" + a.id, level: "danger" as const, text: `Allergy: ${a.substance}` })),
    ...data.conditions
      .filter((c) => c.status === "active")
      .map((c) => ({ key: "cnd" + c.id, level: "warn" as const, text: c.description })),
  ];

  return (
    <div className="space-y-6">
      <StickyAlertBar alerts={alerts} show={scrolledPast} patientName={fullName} />

      <button onClick={() => navigate("/patients")} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Patients
      </button>

      {/* Patient banner (clinical-safety: allergies always visible) */}
      <div ref={bannerRef} className="flex flex-wrap items-center gap-4 rounded-lg bg-brand p-5 text-brand-foreground shadow-card">
        <Avatar className="h-12 w-12 bg-white/15">
          <AvatarFallback className="bg-transparent text-base text-brand-foreground">
            {(data.first_name[0] ?? "") + (data.last_name[0] ?? "")}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h2 leading-tight">{fullName}</h2>
            {editable && (
              <button onClick={() => setEditingPatient(true)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25">
                <Pencil className="h-3 w-3" /> Edit details
              </button>
            )}
            <button onClick={() => navigate(`/patients/${id}/schedule`)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25">
                <CalendarClock className="h-3 w-3" /> Schedule
              </button>
          </div>
          <p className="text-sm text-brand-foreground/80 tabular-nums">
            MRN {data.mrn} · {age(data.dob)} · <span className="capitalize">{data.gender}</span>
            {data.blood_group ? ` · ${data.blood_group}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.allergies.length === 0 ? (
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs">No known allergies</span>
          ) : (
            data.allergies.map((a) => (
              <span key={a.id} className="flex items-center gap-1 rounded-full bg-destructive px-3 py-1 text-xs font-semibold text-destructive-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Allergy: {a.substance}
              </span>
            ))
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Demographics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Phone" value={data.phone} />
            <Row label="Email" value={data.email} />
            <Row label="National ID" value={data.national_id} />
            <Row label="Passport" value={data.passport_no} />
            <Row label="Date of birth" value={data.dob ? `${data.dob} · ${formatEthiopian(data.dob)} EC` : undefined} />
          </CardContent>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          {flagOn("maternity") && data.gender === "female" && <PregnancyDatingCard patientId={id} />}
          <SectionCard
            title="Allergies"
            action={editable && <AllergyDialog patientId={id} onSaved={invalidate} />}
            empty={data.allergies.length === 0 ? "No known allergies." : undefined}
          >
            {data.allergies.map((a) => (
              <RowItem
                key={a.id}
                main={a.substance}
                sub={a.reaction}
                badge={<Badge variant={a.severity === "severe" ? "destructive" : a.severity === "moderate" ? "warning" : "default"}>{a.severity}</Badge>}
                onRemove={editable ? () => removeAllergy(id, a.id).then(invalidate) : undefined}
              />
            ))}
          </SectionCard>

          <SectionCard
            title="Conditions"
            action={editable && <ConditionDialog patientId={id} onSaved={invalidate} />}
            empty={data.conditions.length === 0 ? "No recorded conditions." : undefined}
          >
            {data.conditions.map((c) => (
              <RowItem
                key={c.id}
                main={c.description}
                sub={c.icd_code}
                badge={<Badge variant={c.status === "active" ? "success" : "outline"}>{c.status}</Badge>}
                onRemove={editable ? () => removeCondition(id, c.id).then(invalidate) : undefined}
              />
            ))}
          </SectionCard>

          {can("encounter.manage") && <VisitHistorySection patientId={id} />}

          <DocumentsSection attachments={data.attachments} />

          {(can("payment.collect") || can("payment.charge") || can("billing.manage")) && (
            <BillingSection patientId={id} patientName={fullName} mrn={data.mrn} canRefund={can("billing.manage")} />
          )}
        </div>
      </div>

      {editingPatient && (
        <PatientEditDialog patient={data} onClose={() => setEditingPatient(false)} onSaved={invalidate} />
      )}
    </div>
  );
}

const REFUND_REASONS = ["Service not provided", "Overcharged", "Duplicate payment", "Patient cancelled", "Billing error"];

function BillingSection({ patientId, patientName, mrn, canRefund }: { patientId: string; patientName: string; mrn?: string; canRefund: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["patient-charges", patientId], queryFn: () => patientCharges(patientId) });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const [refunding, setRefunding] = useState<ChargeRow | null>(null);
  const [reason, setReason] = useState("");
  const receipt = (c: ChargeRow) =>
    printReceipt({
      clinic: clinic.data?.name || "Clinic", receiptNo: c.receipt_no, patient: patientName, mrn,
      description: c.description, amount: c.amount, currency: c.currency, method: c.payment_method,
      cashier: c.settled_by || undefined,
      when: c.settled_at || c.created_at, refund: c.source === "refund",
    });
  const mut = useMutation({
    mutationFn: () => refundCharge(refunding!.id, reason),
    onSuccess: () => {
      toast.success("Refund recorded");
      setRefunding(null); setReason("");
      qc.invalidateQueries({ queryKey: ["patient-charges", patientId] });
      qc.invalidateQueries({ queryKey: ["cash"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not refund"),
  });
  const rows = q.data?.rows ?? [];
  return (
    <SectionCard title="Billing" empty={rows.length === 0 ? "No charges yet." : undefined}>
      {rows.map((c) => {
        const negative = parseFloat(c.amount) < 0;
        const refundable = canRefund && c.status === "paid" && c.source !== "refund" && !negative;
        return (
          <div key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div className="min-w-0">
              <span className="font-medium">{c.description}</span>
              <Badge variant="outline" className="ml-2 capitalize">{c.source}</Badge>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={c.status === "paid" ? "success" : c.status === "pending" ? "warning" : "outline"} className="capitalize">{c.status}</Badge>
              <span className={`font-mono ${negative ? "text-rose-600" : ""}`}>{c.currency} {c.amount}</span>
              {c.receipt_no != null && <Button size="sm" variant="ghost" onClick={() => receipt(c)}>Receipt</Button>}
              {refundable && <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => setRefunding(c)}>Refund</Button>}
            </div>
          </div>
        );
      })}
      <Dialog open={!!refunding} onOpenChange={(o) => { if (!o) { setRefunding(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Refund charge</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Posts a reversing entry dated now; the original payment stays on record. This nets against collected totals in Finance.</p>
          {refunding && <p className="text-sm">{refunding.description} · {refunding.currency} {refunding.amount}</p>}
          <div className="space-y-1.5">
            <Label>Reason (required)</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger><SelectValue placeholder="Why refund?" /></SelectTrigger>
              <SelectContent>{REFUND_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRefunding(null); setReason(""); }}>Cancel</Button>
            <Button variant="destructive" disabled={!reason} loading={mut.isPending} onClick={() => mut.mutate()}>Refund</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

/**
 * Past visits, on the patient page at last. The endpoint already existed — it was
 * only ever called from inside the encounter workspace, so a clinician opening a
 * patient could not see what happened last time without leaving the page.
 */
function VisitHistorySection({ patientId }: { patientId: string }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["history", patientId], queryFn: () => listHistory(patientId) });
  const rows = q.data ?? [];
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 5);

  return (
    <SectionCard
      title="Visit history"
      action={rows.length > 5 && (
        <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>
          {all ? "Show recent" : `All ${rows.length}`}
        </Button>
      )}
      empty={!q.isLoading && rows.length === 0 ? "No recorded visits yet." : undefined}
    >
      {q.isLoading ? (
        <p className="px-1 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : (
        shown.map((h) => (
          <button
            key={h.id}
            onClick={() => navigate(`/encounter/${h.id}`)}
            className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left hover:bg-accent"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-brand">
              <Stethoscope className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {h.primary_dx || "No diagnosis recorded"}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {new Date(h.started_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                {" · "}{formatEthiopian(h.started_at.slice(0, 10))} EC
                {h.provider_name ? ` · ${h.provider_name}` : ""}
              </span>
            </span>
            <Badge variant={h.status === "closed" ? "outline" : "warning"}>{h.status}</Badge>
          </button>
        ))
      )}
    </SectionCard>
  );
}

/** Attachments are already typed in the database; showing them as one flat list
 *  makes a referral letter and an X-ray look identical. Group and label them. */
const DOC_GROUPS: { key: string; label: string }[] = [
  { key: "image", label: "Images" },
  { key: "scan", label: "Scans & X-rays" },
  { key: "report", label: "Reports" },
  { key: "pdf", label: "Documents" },
];

function DocumentsSection({ attachments }: { attachments: { id: string; type: string; url: string; filename: string; created_at: string }[] }) {
  const groups = useMemo(() => {
    const known = DOC_GROUPS.map((g) => ({ ...g, items: attachments.filter((a) => a.type === g.key) }));
    const other = attachments.filter((a) => !DOC_GROUPS.some((g) => g.key === a.type));
    return [...known, { key: "other", label: "Other", items: other }].filter((g) => g.items.length > 0);
  }, [attachments]);

  return (
    <SectionCard
      title={`Documents${attachments.length ? ` (${attachments.length})` : ""}`}
      empty={attachments.length === 0 ? "No documents uploaded." : undefined}
    >
      {groups.map((g) => (
        <div key={g.key} className="py-1">
          <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {g.label} <span className="font-normal">({g.items.length})</span>
          </p>
          {g.items.map((a) => (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-md px-1 py-1.5 hover:bg-accent"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{a.filename}</span>
                <span className="block text-xs text-muted-foreground">
                  {new Date(a.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                </span>
              </span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </a>
          ))}
        </div>
      ))}
    </SectionCard>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value || "—"}</span>
    </div>
  );
}

function SectionCard({ title, action, empty, children }: { title: string; action?: React.ReactNode; empty?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>
        {empty ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="space-y-2">{children}</ul>}
      </CardContent>
    </Card>
  );
}

function RowItem({ main, sub, badge, onRemove }: { main: string; sub?: string; badge?: React.ReactNode; onRemove?: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border bg-background p-2.5 text-sm">
      <span className="min-w-0">
        <span className="font-medium">{main}</span>
        {sub ? <span className="text-muted-foreground"> — {sub}</span> : null} {badge}
      </span>
      {onRemove && (
        <button className="shrink-0 text-xs text-destructive hover:underline" onClick={onRemove}>
          Remove
        </button>
      )}
    </li>
  );
}

function AllergyDialog({ patientId, onSaved }: { patientId: string; onSaved: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [substance, setSubstance] = useState("");
  const [reaction, setReaction] = useState("");
  const [severity, setSeverity] = useState("mild");
  const [showSug, setShowSug] = useState(false);

  // Substance is backed by the shared allergen library (the same one drugs are
  // tagged with) so matching is reliable; a new one is added to the library on save.
  const allergens = useQuery({ queryKey: ["allergens"], queryFn: () => listAllergens(), enabled: open });
  const term = substance.trim().toLowerCase();
  const suggestions = (allergens.data ?? []).filter((a) => a.name.toLowerCase().includes(term)).slice(0, 8);
  const exact = (allergens.data ?? []).some((a) => a.name.toLowerCase() === term);

  const mut = useMutation({
    mutationFn: async () => {
      const name = substance.trim();
      // Ensure the allergen exists in the library (one source). Ignore "already exists".
      if (name && !exact) {
        try {
          await createAllergen(name);
        } catch {
          /* already in the library — fine */
        }
      }
      return addAllergy(patientId, { substance: name, reaction, severity });
    },
    onSuccess: () => {
      toast.success("Allergy added");
      setSubstance("");
      setReaction("");
      setSeverity("mild");
      qc.invalidateQueries({ queryKey: ["allergens"] });
      onSaved();
      setOpen(false);
    },
    onError: () => toast.error("Could not add allergy"),
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus /> Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add allergy</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative space-y-1.5">
            <Label>Substance</Label>
            <Input
              value={substance}
              onChange={(e) => { setSubstance(e.target.value); setShowSug(true); }}
              onFocus={() => setShowSug(true)}
              placeholder="Search or add an allergen…"
            />
            {showSug && term && suggestions.length > 0 && (
              <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-background shadow-md">
                {suggestions.map((a) => (
                  <button key={a.id} type="button" onClick={() => { setSubstance(a.name); setShowSug(false); }} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted">
                    {a.name}
                  </button>
                ))}
              </div>
            )}
            {term && !exact && <p className="text-xs text-muted-foreground">New — will be added to the allergen library.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Reaction</Label>
            <Input value={reaction} onChange={(e) => setReaction(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mild">Mild</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="severe">Severe</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!substance} loading={mut.isPending} onClick={() => mut.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConditionDialog({ patientId, onSaved }: { patientId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [icd, setIcd] = useState("");
  const [status, setStatus] = useState("active");
  const mut = useMutation({
    mutationFn: () => addCondition(patientId, { description, icd_code: icd, status }),
    onSuccess: () => {
      toast.success("Condition added");
      setDescription("");
      setIcd("");
      setStatus("active");
      onSaved();
      setOpen(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus /> Add
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add condition</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>ICD-10 code</Label>
            <Input value={icd} onChange={(e) => setIcd(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!description} loading={mut.isPending} onClick={() => mut.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
