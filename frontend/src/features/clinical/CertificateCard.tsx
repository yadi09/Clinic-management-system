// Issuing and reprinting medical certificates.
//
// Three differences from a form that just opens a printable page, all of which
// matter the day an employer telephones to check one:
//
//   The clinician is NOT a text field. It is whoever is signed in. A typed name is
//   not attribution — it is the same field a forger fills in.
//
//   Every certificate is kept, numbered MC-2026-0041, and reprints identically. The
//   copy in an employer's file and the copy in the clinic are the same document.
//
//   The diagnosis is off by default. The paper goes to an employer; "unfit for work"
//   is what they are owed, and the condition is the patient's business unless the
//   patient wants it stated.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck2, Printer, ShieldX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { DualDate } from "@/components/DualDate";
import { formatEthiopian } from "@/lib/ethiopian";
import { getPatient } from "@/features/patients/api";
import { getClinic, listBranches } from "@/features/admin/api";
import { printCertificate } from "@/features/clinical/printCertificate";
import {
  issueCertificate, listCertificates, voidCertificate,
  type CertKind, type Certificate,
} from "@/features/clinical/api";

const KINDS: { value: CertKind; label: string; blurb: string; title: string }[] = [
  { value: "sick_leave", label: "Sick leave", title: "Medical Certificate", blurb: "Unfit for work or study for a stated number of days." },
  { value: "fitness", label: "Fit to return", title: "Certificate of Fitness", blurb: "Fit to resume normal duties — what an employer asks for after leave." },
  { value: "attendance", label: "Attendance only", title: "Certificate of Attendance", blurb: "Attended the clinic on this date. No rest period; usually all a school needs." },
];

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ec = (iso?: string) => { try { return iso ? formatEthiopian(iso) : undefined; } catch { return undefined; } };

export function CertificateCard({ patientId, canIssue, bare }: {
  patientId: string; canIssue: boolean; bare?: boolean;
}) {
  const qc = useQueryClient();
  const [issuing, setIssuing] = useState(false);
  const q = useQuery({ queryKey: ["certificates", patientId], queryFn: () => listCertificates(patientId) });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const { activeBranchId } = useAuth();
  const { ask, dialog } = useConfirmDialog();
  const certs = q.data?.items ?? [];

  const print = (c: Certificate) => {
    const branch = (branches.data ?? []).find((b) => b.id === activeBranchId);
    void printCertificate({
      clinic: clinic.data?.name || "Clinic",
      clinicContact: branch ? [branch.address, branch.phone].filter(Boolean).join(" · ") || undefined : undefined,
      branch: branch?.name,
      ref: c.ref, kind: c.kind,
      patient: c.patient_name, mrn: c.mrn, age: c.age, gender: c.gender,
      diagnosis: c.diagnosis, showDiagnosis: c.show_diagnosis,
      restDays: c.rest_days, restFrom: c.rest_from, restFromEc: ec(c.rest_from),
      restTo: c.rest_to, restToEc: ec(c.rest_to),
      notes: c.notes,
      issuedOn: c.issued_at.slice(0, 10), issuedOnEc: ec(c.issued_at.slice(0, 10)),
      issuedBy: c.issued_by, status: c.status, voidReason: c.void_reason,
    });
  };

  const voidIt = useMutation({
    mutationFn: ({ c, reason }: { c: Certificate; reason: string }) => voidCertificate(c.id, reason),
    onSuccess: () => { toast.success("Certificate voided"); qc.invalidateQueries({ queryKey: ["certificates", patientId] }); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not void it"),
  });
  const askVoid = (c: Certificate) => ask({
    title: `Void ${c.ref}?`,
    description: (
      <>
        The number is kept and the certificate will still print, marked <b>VOID</b> — a copy may
        already be in an employer's file, and a missing number is worse than a voided one.
      </>
    ),
    reason: { label: "Why is it being voided?", placeholder: "Issued to the wrong patient", required: true },
    confirmLabel: "Void certificate",
    destructive: true,
  }, (reason) => voidIt.mutateAsync({ c, reason }));

  const Wrap = bare ? "div" : Card;
  return (
    <Wrap>
      {!bare && (
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2">
            <FileCheck2 className="h-4 w-4 text-muted-foreground" /> Medical certificates
            {certs.length > 0 && <Badge variant="outline">{certs.length}</Badge>}
          </CardTitle>
          {canIssue && <Button size="sm" onClick={() => setIssuing(true)}>Issue certificate</Button>}
        </CardHeader>
      )}
      <CardContent className={cn("space-y-2", bare && "p-0")}>
        {bare && canIssue && (
          <div className="flex justify-end"><Button size="sm" onClick={() => setIssuing(true)}>Issue certificate</Button></div>
        )}
        {q.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : certs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            None issued. A certificate is the note a patient takes to an employer or school.
          </p>
        ) : (
          certs.map((c) => (
            <div key={c.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border p-2.5",
              c.status === "void" && "opacity-60")}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{c.ref}</span>
                  <Badge variant="outline">{KINDS.find((k) => k.value === c.kind)?.label ?? c.kind}</Badge>
                  {c.status === "void" && <Badge variant="destructive">Void</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  <DualDate iso={c.issued_at.slice(0, 10)} />
                  {c.issued_by && ` · ${c.issued_by}`}
                  {c.rest_days ? ` · ${c.rest_days} day${c.rest_days === 1 ? "" : "s"} rest` : ""}
                </p>
                {c.rest_from && c.rest_to && (
                  <p className="text-xs text-muted-foreground">
                    <DualDate iso={c.rest_from} /> → <DualDate iso={c.rest_to} />
                  </p>
                )}
                {c.void_reason && <p className="text-xs italic text-destructive">Voided: {c.void_reason}</p>}
              </div>
              <Button size="sm" variant="outline" onClick={() => print(c)}>
                <Printer className="h-3.5 w-3.5" /> Print
              </Button>
              {canIssue && c.status === "active" && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => askVoid(c)}>
                  <ShieldX className="h-3.5 w-3.5" /> Void
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>

      {dialog}
      {issuing && (
        <IssueDialog
          patientId={patientId}
          onClose={() => setIssuing(false)}
          onIssued={(c) => {
            qc.invalidateQueries({ queryKey: ["certificates", patientId] });
            setIssuing(false);
            print(c); // straight to the paper — that is the whole point of issuing one
          }}
        />
      )}
    </Wrap>
  );
}

function IssueDialog({ patientId, onClose, onIssued }: {
  patientId: string; onClose: () => void; onIssued: (c: Certificate) => void;
}) {
  const { user } = useAuth();
  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  const [kind, setKind] = useState<CertKind>("sick_leave");
  const [diagnosis, setDiagnosis] = useState("");
  const [showDiagnosis, setShowDiagnosis] = useState(false);
  const [restDays, setRestDays] = useState("2");
  const [restFrom, setRestFrom] = useState(todayISO());
  const [notes, setNotes] = useState("");

  const days = Math.max(0, parseInt(restDays || "0", 10));
  // Inclusive, because that is how both a patient and an employer count leave.
  const restTo = (() => {
    if (kind !== "sick_leave" || days < 1) return undefined;
    const d = new Date(`${restFrom}T00:00:00`);
    d.setDate(d.getDate() + days - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  const issue = useMutation({
    mutationFn: () => issueCertificate(patientId, {
      kind, diagnosis: diagnosis.trim() || undefined, show_diagnosis: showDiagnosis,
      rest_days: kind === "sick_leave" ? days : undefined,
      rest_from: kind === "sick_leave" ? restFrom : undefined,
      notes: notes.trim() || undefined,
    }),
    onSuccess: (c) => { toast.success(`Certificate ${c.ref} issued`); onIssued(c); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not issue the certificate"),
  });

  const p = patient.data;
  const name = p ? [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") : "";
  const spec = KINDS.find((k) => k.value === kind) ?? KINDS[0];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl gap-3">
        <DialogHeader><DialogTitle>Issue a medical certificate</DialogTitle></DialogHeader>

        {/* Who it is for and who signs it — both facts, neither typed. */}
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="font-medium">{name || "…"}</div>
          <div className="text-xs text-muted-foreground">
            {p?.mrn}{p?.gender ? ` · ${p.gender}` : ""} · signed by <b>{user?.full_name ?? "you"}</b>
          </div>
        </div>

        {/* Left: what is being certified, and for how long. Right: the words that
            end up on the paper, with a preview under the toggle that changes them. */}
        <div className="grid items-start gap-x-6 gap-y-4 md:grid-cols-2">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">What is it for?</Label>
              <div className="grid gap-1.5">
                {KINDS.map((k) => (
                  <button key={k.value} type="button" onClick={() => setKind(k.value)}
                    className={cn("rounded-md border px-3 py-2 text-left text-sm",
                      kind === k.value ? "border-brand bg-brand/5" : "hover:bg-muted")}>
                    <span className="font-medium">{k.label}</span>
                    <span className="block text-xs text-muted-foreground">{k.blurb}</span>
                  </button>
                ))}
              </div>
            </div>

            {kind === "sick_leave" && (
              <div className="grid gap-3 sm:grid-cols-[7rem_1fr] sm:items-start">
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="cert-days">Rest days</Label>
                  <Input id="cert-days" type="number" min={1} max={365} value={restDays}
                    onChange={(e) => setRestDays(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Rest from</Label>
                  <EthiopianDateInput value={restFrom} onChange={setRestFrom} showAge={false} />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {kind !== "attendance" && (
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="cert-dx">Diagnosis / condition</Label>
                <Textarea id="cert-dx" rows={2} value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder="Acute dental pain requiring rest" />
                <label className="flex items-start gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" className="mt-0.5" checked={showDiagnosis}
                    onChange={(e) => setShowDiagnosis(e.target.checked)} />
                  {/* Off by default: the certificate goes to an employer. */}
                  <span>
                    Print the diagnosis on the certificate. Left off, the paper states the rest period only —
                    the employer sees that the patient is unfit, not what for.
                  </span>
                </label>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="cert-notes">Extra notes (optional)</Label>
              <Textarea id="cert-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Light duties on return · review if symptoms persist" />
            </div>

          </div>
        </div>

        {/* The decision this form really turns on is how much the employer gets told,
            so show the sentence rather than describing it. It belongs to both columns,
            not either one, and sits last: fill the form, read the result, then print. */}
        <div className="rounded-md border bg-muted/30 p-3 sm:flex sm:items-baseline sm:gap-5">
          <div className="shrink-0 sm:w-48">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              What the paper will say
            </div>
            <div className="text-sm font-semibold">{spec.title}</div>
          </div>
          <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted-foreground sm:mt-0">
            <p>
              Certifies that <b className="text-foreground">{name || "the patient"}</b>{" "}
              {kind === "sick_leave" && (
                <>was examined here and is <b className="text-foreground">unfit for work or study</b>
                  {days >= 1 && <>, requiring rest for <b className="text-foreground">{days} day{days === 1 ? "" : "s"}</b></>}.
                  {restTo && (
                    <> Covers <b className="text-foreground"><DualDate iso={restFrom} /></b> to{" "}
                      <b className="text-foreground"><DualDate iso={restTo} /></b>, inclusive — back the next day.</>
                  )}</>
              )}
              {kind === "fitness" && <>was examined here and is <b className="text-foreground">fit to resume normal duties</b>.</>}
              {kind === "attendance" && <><b className="text-foreground">attended this clinic</b> today and received medical attention.</>}
            </p>
            <p>
              {kind !== "attendance" && (showDiagnosis && diagnosis.trim()
                ? <>Diagnosis <b className="text-foreground">is printed</b>: “{diagnosis.trim()}”. </>
                : <>Diagnosis <b className="text-foreground">is not printed</b>. </>)}
              Carries a reference number, so the clinic can confirm it if an employer asks.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={issue.isPending}
            disabled={kind === "sick_leave" && days < 1}
            onClick={() => issue.mutate()}>
            <Printer className="h-4 w-4" /> Issue &amp; print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
