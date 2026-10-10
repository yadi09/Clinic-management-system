// What a visit produces besides a note: prescriptions to print, and images to keep.
//
// Hoisted out of DentalWorkspace so the visit cockpit can offer them too. Until now
// they existed only inside the expandable session row of the old plan list — which
// phase 5 removes — so a dentist recording a visit in the cockpit could write the
// note but not attach the X-ray or print the script. Deleting that list before this
// move would have taken away working clinical capability.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Images, ImagePlus, Pill, Plus, Printer, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { compressImage } from "@/lib/image";
import { getPatient } from "@/features/patients/api";
import { PatientAllergyLine } from "@/features/dental/SafetyStrip";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { EmptySlot, RecordSection } from "@/features/dental/shared/RecordSection";
import { getClinic, listBranches } from "@/features/admin/api";
import { type Drug } from "@/features/clinical/api";
import { DrugSearchInput } from "@/features/clinical/DrugLibrary";
import { printPrescription } from "@/features/clinical/print";
import {
  addPrescription, deleteDentalImage, deletePrescription, uploadDentalImage,
  type DentalImage, type ImageCategory, type Prescription, type RxItem, type Session,
} from "@/features/dental/api";

/** Whole years, for the prescription header. */
function ageYears(dob: string): number | undefined {
  const d = new Date(dob);
  if (isNaN(d.getTime())) return undefined;
  return Math.abs(new Date(Date.now() - d.getTime()).getUTCFullYear() - 1970);
}

/** A session's own images cap. The per-patient plan limit is enforced server-side. */
export const MAX_SESSION_IMAGES = 12;

export function PrescriptionSection({ patientId, session, editable, onChanged }: { patientId: string; session: Session; editable: boolean; onChanged: () => void }) {
  const { user, activeBranchId } = useAuth();
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  const [adding, setAdding] = useState(false);

  const { ask, dialog } = useConfirmDialog();
  const del = useMutation({
    mutationFn: ({ rxId, reason }: { rxId: string; reason: string }) => deletePrescription(patientId, rxId, reason),
    onSuccess: () => { toast.success("Prescription withdrawn"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove"),
  });

  const print = (rx: Prescription) => {
    const clinicName = clinic.data?.name || "Clinic";
    const branch = (branches.data ?? []).find((b) => b.id === activeBranchId);
    const p = patient.data;
    const name = p ? [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") : "Patient";
    printPrescription({
      clinic: clinicName,
      clinicContact: branch ? [branch.address, branch.phone].filter(Boolean).join(" · ") || undefined : undefined,
      rxRef: `Rx ${rx.id.slice(-6)}`,
      qrData: `DRX:${rx.id}\n${clinicName}\n${name}${p ? " " + p.mrn : ""}\n${rx.created_at.slice(0, 10)}`,
      patient: name,
      mrn: p?.mrn,
      age: p ? ageYears(p.dob) : undefined,
      gender: p?.gender,
      // The author, not whoever is printing it (audit D17). Older prescriptions
      // without a recorded author fall back to the person printing.
      prescriber: rx.prescribed_by || user?.full_name,
      note: rx.note,
      allergies: (p?.allergies ?? []).map((a) => a.substance),
      when: rx.created_at,
      // What was done at the visit is the TREATMENT, not a diagnosis — it used to be
      // printed under the heading "Diagnosis".
      diagnoses: [],
      context: session.procedure ? session.procedure + (session.tooth ? ` (${session.tooth})` : "") : undefined,
      meds: rx.items,
    });
  };

  return (
    <RecordSection
      icon={Pill} tone="rx" title="Prescriptions" count={session.prescriptions.length}
      hint="Medication the patient takes home. Printed with the clinic's details."
      action={editable && (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add prescription
        </Button>
      )}
    >
      {session.prescriptions.length === 0 ? (
        <EmptySlot
          icon={Pill}
          title="No prescription for this visit"
          hint="Write one if the patient needs medication after today's treatment."
          action={editable && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Write a prescription
            </Button>
          )}
        />
      ) : (
        <div className="space-y-2">
          {session.prescriptions.map((rx) => (
            <div key={rx.id} className="rounded-md border p-2.5">
              <div className="flex items-start justify-between gap-2">
                <ol className="min-w-0 flex-1 space-y-1 text-sm">
                  {rx.items.map((it, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                      <span className="min-w-0">
                        <span className="font-medium">{it.drug_name}</span>
                        {(it.dose || it.frequency || it.duration) && <span className="text-muted-foreground"> — {[it.dose, it.frequency, it.duration].filter(Boolean).join(" · ")}</span>}
                        {it.instructions && <span className="block text-xs italic text-muted-foreground">{it.instructions}</span>}
                        {/* A prescription written over a known allergy says so
                            wherever it is read, not only where it was written. */}
                        {it.allergy_override && (
                          <span className="mt-0.5 flex items-start gap-1 text-xs font-medium text-amber-700">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            Prescribed against a recorded allergy — {it.allergy_override}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                  {rx.note && <li className="pt-1 text-xs text-muted-foreground">Note: {rx.note}</li>}
                </ol>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="outline" onClick={() => print(rx)}><Printer className="h-3.5 w-3.5" /> Print</Button>
                  {editable && <Button size="sm" variant="ghost" className="text-destructive" title="Withdraw" onClick={() => ask({
                    title: "Withdraw this prescription?",
                    description: "It disappears from this visit but is kept on the record, with your name and the reason — a printed copy may already be at a pharmacy.",
                    reason: { label: "Why?", placeholder: "Wrong drug · patient allergic · replaced", required: true },
                    confirmLabel: "Withdraw",
                    destructive: true,
                  }, (reason) => del.mutateAsync({ rxId: rx.id, reason }))}><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {dialog}
      {adding && <PrescriptionDialog patientId={patientId} sessionId={session.id} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} />}
    </RecordSection>
  );
}

const BLANK_MED: RxItem = { drug_name: "", dose: "", frequency: "", duration: "", instructions: "" };

function PrescriptionDialog({ patientId, sessionId, onClose, onSaved }: { patientId: string; sessionId: string; onClose: () => void; onSaved: () => void }) {
  const [meds, setMeds] = useState<RxItem[]>([{ ...BLANK_MED }]);
  const [note, setNote] = useState("");
  // Set when the server refuses on an allergy clash. It names the substances; the
  // prescriber either changes the drug or says why they are prescribing anyway.
  const [warn, setWarn] = useState("");
  const [reason, setReason] = useState("");
  const setMed = (i: number, patch: Partial<RxItem>) => setMeds((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const valid = meds.some((m) => m.drug_name.trim());

  const mut = useMutation({
    mutationFn: () => addPrescription(patientId, sessionId, {
      note: note.trim() || undefined,
      items: meds.filter((m) => m.drug_name.trim()).map((m) => ({
        drug_name: m.drug_name.trim(), dose: m.dose, frequency: m.frequency, duration: m.duration,
        instructions: m.instructions, drug_id: m.drug_id,
      })),
      override_reason: warn ? reason.trim() : undefined,
    }),
    onSuccess: () => { toast.success("Prescription added"); onSaved(); },
    onError: (e) => {
      // The clash is the server's call, not the client's: it holds the patient's
      // allergies and the drug's tags, and it is the thing that stores the answer.
      if (e instanceof AppError && e.code === "ALLERGY_CONFLICT") { setWarn(e.message); return; }
      toast.error(e instanceof AppError ? e.message : "Could not save the prescription");
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Full-screen on a phone: several medication lines plus an allergy override
          do not fit in a bottom sheet's letterbox. */}
      <DialogContent className="max-w-2xl" fullOnMobile>
        <DialogHeader><DialogTitle>New prescription</DialogTitle></DialogHeader>
        {/* The allergy must be visible while the drug is being chosen, not behind this dialog. */}
        <PatientAllergyLine patientId={patientId} />
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {meds.map((m, i) => (
            <MedLine key={i} index={i} med={m} onChange={(patch) => setMed(i, patch)} onRemove={meds.length > 1 ? () => setMeds((ms) => ms.filter((_, j) => j !== i)) : undefined} />
          ))}
          <Button size="sm" variant="outline" onClick={() => setMeds((ms) => [...ms, { ...BLANK_MED }])}><Plus className="h-3.5 w-3.5" /> Add another medication</Button>
          <div className="space-y-1.5"><Label>Note (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Review in one week" /></div>
        </div>

        {/* Not a block. There are real reasons to prescribe against a recorded mild
            allergy, and a prescriber who cannot proceed will write the script on
            paper where nothing records the decision at all. So: stop, name the
            substance, and keep the reason on the item. */}
        {warn && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
            <p className="flex items-start gap-2 text-sm font-medium text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {warn}
            </p>
            <Input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Reason to prescribe anyway (recorded on the prescription)" className="bg-background" />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {warn ? (
            <Button className="bg-amber-600 hover:bg-amber-600/90" disabled={!reason.trim()}
              loading={mut.isPending} onClick={() => mut.mutate()}>
              Prescribe anyway
            </Button>
          ) : (
            <Button disabled={!valid} loading={mut.isPending} onClick={() => mut.mutate()}>Save prescription</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One medication line, backed by the clinic's drug library.
//
// The picker is the shared one, so a dental prescription behaves exactly like the
// general encounter's: search the library, and choosing an entry fills the sig from
// its saved defaults instead of retyping "1 cap · three times a day · 5 days" for
// the hundredth time. A drug that is not in the library can be saved into it from
// here with its defaults and its allergen tags — which is what makes the NEXT
// prescription one click, and what gives the allergy check something to check.
function MedLine({ index, med, onChange, onRemove }: { index: number; med: RxItem; onChange: (patch: Partial<RxItem>) => void; onRemove?: () => void }) {
  const pick = (d: Drug) => onChange({
    drug_name: d.name,
    // The library's answer wins on pick. Whatever was half-typed was a guess at the
    // same fields, and quietly keeping it would make the saved defaults unreliable.
    dose: d.default_dose ?? "",
    frequency: d.default_frequency ?? "",
    duration: d.default_duration ?? "",
    instructions: d.default_instructions ?? "",
    drug_id: d.id,
    allergens: d.allergens,
  });
  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Medication {index + 1}</span>
        {med.drug_id && <Badge variant="outline" className="gap-1 text-[10px]"><Pill className="h-2.5 w-2.5" /> from library</Badge>}
        {(med.allergens?.length ?? 0) > 0 && (
          <Badge variant="warning" className="gap-1 text-[10px]">
            <AlertTriangle className="h-2.5 w-2.5" /> {med.allergens!.join(", ")}
          </Badge>
        )}
        {onRemove && <button type="button" onClick={onRemove} className="ml-auto text-muted-foreground hover:text-destructive" title="Remove"><X className="h-3.5 w-3.5" /></button>}
      </div>
      <DrugSearchInput
        value={med.drug_name}
        // Typing again unlinks the row from the library entry: the fields belong to
        // the prescriber now, and the id must not keep claiming otherwise.
        onChange={(name) => onChange({ drug_name: name, drug_id: undefined, allergens: [] })}
        onPick={pick}
        placeholder="Search the drug library, or type a new drug…"
      />
      <div className="grid gap-2 sm:grid-cols-3">
        <Input value={med.dose ?? ""} onChange={(e) => onChange({ dose: e.target.value })} placeholder="Dose (1 tab)" />
        <Input value={med.frequency ?? ""} onChange={(e) => onChange({ frequency: e.target.value })} placeholder="Frequency (twice daily)" />
        <Input value={med.duration ?? ""} onChange={(e) => onChange({ duration: e.target.value })} placeholder="Duration (5 days)" />
      </div>
      <Input value={med.instructions ?? ""} onChange={(e) => onChange({ instructions: e.target.value })} placeholder="Instructions (after food)" />
    </div>
  );
}

// --- per-session images (uses summary data; uploads/deletes refresh via onChanged) ---

const IMG_TABS: { key: "all" | ImageCategory; label: string }[] = [
  { key: "before", label: "Before" },
  { key: "after", label: "After" },
  { key: "xray", label: "X-ray" },
  { key: "all", label: "All" },
];

export function SessionImages({ patientId, session, editable, imageLimit, onChanged }: { patientId: string; session: Session; editable: boolean; imageLimit: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"all" | ImageCategory>("before");
  const all = session.images;
  const rows = tab === "all" ? all : all.filter((im) => im.category === tab);
  const tabLabel = IMG_TABS.find((t) => t.key === tab)!.label;
  const cap = imageLimit > 0 ? imageLimit : MAX_SESSION_IMAGES;
  const count = (k: "all" | ImageCategory) => (k === "all" ? all.length : all.filter((im) => im.category === k).length);
  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0 || tab === "all") return;
    setBusy(true);
    let ok = 0;
    for (const f of Array.from(files)) {
      try {
        const compressed = await compressImage(f, { maxEdge: 2000, quality: 0.8 });
        await uploadDentalImage(patientId, compressed, session.id, tab);
        ok++;
      } catch (e) {
        toast.error(e instanceof AppError ? e.message : `Could not upload ${f.name}`);
        break;
      }
    }
    setBusy(false);
    if (ok > 0) { toast.success(`${ok} ${tabLabel.toLowerCase()} image${ok > 1 ? "s" : ""} added`); onChanged(); }
  };
  const del = useMutation({
    mutationFn: (id: string) => deleteDentalImage(patientId, id),
    onSuccess: () => { toast.success("Image removed"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove the image"),
  });
  const addButton = (size: "sm" | "lg") => editable && tab !== "all" && (
    <label className={cn(
      "inline-flex cursor-pointer items-center gap-1.5 rounded-md font-medium transition-colors",
      size === "lg"
        ? "bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        : "border px-2 py-1 text-xs hover:bg-accent",
      (busy || all.length >= cap) && "pointer-events-none opacity-50",
    )}>
      <ImagePlus className={size === "lg" ? "h-4 w-4" : "h-3.5 w-3.5"} />
      {busy ? "Uploading…" : `Add ${tabLabel.toLowerCase()}`}
      <input type="file" accept="image/*" multiple className="hidden" disabled={busy || all.length >= cap}
        onChange={(e) => { void onPick(e.target.files); e.currentTarget.value = ""; }} />
    </label>
  );

  return (
    <RecordSection
      icon={Images} tone="media" title="Images" count={all.length}
      hint="Before, after and X-rays for this visit — kept against this session."
      action={addButton("sm")}
    >
      <div className="space-y-3">
        <Segmented
          size="sm"
          ariaLabel="Filter images by type"
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          options={IMG_TABS.map((t) => ({ value: t.key, label: t.label, badge: count(t.key) }))}
        />
        {rows.length === 0 ? (
          <EmptySlot
            icon={ImagePlus}
            title={tab === "all" ? "No images for this visit" : `No ${tabLabel.toLowerCase()} images yet`}
            hint={tab === "all"
              ? "Pick Before, After or X-ray to add one."
              : `Photograph the ${tabLabel.toLowerCase()} state while the patient is in the chair.`}
            action={addButton("lg")}
          />
        ) : (
          <ImageGallery images={rows} editable={editable} onDelete={(id) => del.mutate(id)} thumb />
        )}
      </div>
    </RecordSection>
  );
}

// --- patient images: every image grouped by treatment (+ a general bucket) ---

export function ImageGallery({ images, editable, onDelete, thumb }: { images: DentalImage[]; editable: boolean; onDelete: (id: string) => void; thumb?: boolean }) {
  const [idx, setIdx] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState<DentalImage | null>(null);
  const [zoom, setZoom] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const preview = idx !== null && idx < images.length ? images[idx] : null;
  const step = (d: number) => setIdx((i) => (i === null ? i : (i + d + images.length) % images.length));

  // Fit each new image, and keep the filmstrip's active thumbnail in view — on a
  // visit with a dozen X-rays the current one is otherwise off the end of the rail.
  useEffect(() => {
    setZoom(false);
    strip.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [idx]);
  return (
    <>
      <div className={cn("grid gap-2", thumb ? "grid-cols-4 sm:grid-cols-6" : "grid-cols-3 sm:grid-cols-4")}>
        {images.map((im, i) => (
          <div key={im.id} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
            <button type="button" className="block h-full w-full" title="Preview" onClick={() => setIdx(i)}>
              <img src={im.url} alt={im.filename} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
            </button>
            {/* Hover-revealed is never revealed on touch — the button shows by
                default there and desktop keeps its quiet-until-hover look. */}
            {editable && (
              <button
                className="touch-hit absolute right-1 top-1 rounded-full bg-black/55 p-1 text-white opacity-100 transition-opacity hover:bg-destructive focus-visible:opacity-100 max-md:p-2 md:opacity-0 md:group-hover:opacity-100"
                title="Remove" aria-label="Remove image" onClick={() => setConfirmDel(im)}>
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* The viewer. An intraoral photo or an X-ray is evidence being read, not a
          thumbnail being glanced at — it was opening into a 768px box with 30% of
          the screen wasted on white margin, and the only way to see the next one
          was to close it and find that one too. Full-bleed on black, with the rest
          of the visit's images along the bottom. */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setIdx(null)}>
        <DialogContent
          className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 rounded-none border-0 bg-neutral-950 p-0 text-white"
          onKeyDown={(e) => { if (e.key === "ArrowLeft") step(-1); if (e.key === "ArrowRight") step(1); }}
        >
          <DialogHeader className="shrink-0 border-b border-white/10 px-4 py-2.5">
            <DialogTitle className="flex min-w-0 items-center gap-3 pr-10 text-sm font-medium text-white">
              <span className="truncate">{preview?.filename ?? "Image"}</span>
              {preview?.category && (
                <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                  {preview.category === "xray" ? "X-ray" : preview.category}
                </span>
              )}
              {images.length > 1 && (
                <span className="shrink-0 text-xs font-normal tabular-nums text-white/60">
                  {(idx ?? 0) + 1} of {images.length}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="relative flex min-h-0 flex-1 items-center justify-center p-3">
            {images.length > 1 && (
              <button type="button" onClick={() => step(-1)} aria-label="Previous image"
                className="absolute left-3 z-10 rounded-full bg-white/10 p-2.5 text-white backdrop-blur transition-colors hover:bg-white/25">
                <ChevronLeft className="h-6 w-6" />
              </button>
            )}
            {preview && (
              // Fit by default; a tap fills the frame, because reading a lesion on
              // an X-ray means getting closer to it.
              <img
                key={preview.id}
                src={preview.url}
                alt={preview.filename}
                onClick={() => setZoom((z) => !z)}
                className={cn("max-h-full max-w-full select-none",
                  zoom ? "cursor-zoom-out object-cover" : "cursor-zoom-in object-contain")}
              />
            )}
            {images.length > 1 && (
              <button type="button" onClick={() => step(1)} aria-label="Next image"
                className="absolute right-3 z-10 rounded-full bg-white/10 p-2.5 text-white backdrop-blur transition-colors hover:bg-white/25">
                <ChevronRight className="h-6 w-6" />
              </button>
            )}
          </div>

          {/* The rest of the visit's images, so moving between them is one click
              rather than close-find-open. */}
          {images.length > 1 && (
            <div ref={strip} className="flex shrink-0 gap-2 overflow-x-auto border-t border-white/10 px-3 py-2.5">
              {images.map((im, i) => (
                <button
                  key={im.id}
                  type="button"
                  data-active={i === idx ? "1" : undefined}
                  onClick={() => setIdx(i)}
                  title={im.filename}
                  className={cn("h-14 w-14 shrink-0 overflow-hidden rounded-md border-2 transition-all",
                    i === idx ? "border-brand opacity-100" : "border-transparent opacity-55 hover:opacity-90")}
                >
                  <img src={im.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          <DialogFooter className="shrink-0 flex-row items-center justify-between gap-2 border-t border-white/10 px-4 py-2.5 sm:justify-between">
            <a href={preview?.url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-white/70 hover:text-white">
              <ExternalLink className="h-4 w-4" /> Open original
            </a>
            <span className="hidden text-xs text-white/40 sm:block">← → to move · Esc to close</span>
            {editable && preview && (
              <Button variant="ghost" className="text-red-400 hover:bg-red-500/15 hover:text-red-300"
                onClick={() => setConfirmDel(preview)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDel !== null} onOpenChange={(o) => !o && setConfirmDel(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete this image?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This permanently removes the image and frees its storage. This can't be undone.</p>
          {confirmDel && <div className="overflow-hidden rounded-md border bg-muted"><img src={confirmDel.url} alt={confirmDel.filename} className="mx-auto max-h-48 object-contain" /></div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (confirmDel) { onDelete(confirmDel.id); setConfirmDel(null); setIdx(null); } }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
