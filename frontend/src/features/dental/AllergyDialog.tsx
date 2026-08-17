// Recording an allergy from the dental workspace.
//
// Until now a dental clinic had no way to record one at all. The allergy editor
// lived on the general-clinic profile, and a dental tenant renders the dental
// workspace instead of that page — so every patient in Cure Dental read "No known
// allergies" whether or not anyone had ever asked. That is the worst kind of
// missing feature: it fails silently, and it fails as reassurance.
//
// Substance is backed by the shared allergen library (the same one drugs are tagged
// with), so "Penicillin" typed here matches "Penicillin" on a prescription rather
// than becoming a second spelling of it.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { addAllergy, removeAllergy, type Allergy } from "@/features/patients/api";
import { createAllergen, listAllergens } from "@/features/clinical/api";
import { SubstanceField } from "@/features/clinical/AllergenFields";

const SEVERITIES = [
  { value: "mild", label: "Mild" },
  { value: "moderate", label: "Moderate" },
  { value: "severe", label: "Severe" },
];

export function AllergyDialog({ patientId, allergies, onClose, onSaved }: {
  patientId: string;
  allergies: Allergy[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [substance, setSubstance] = useState("");
  const [reaction, setReaction] = useState("");
  const [severity, setSeverity] = useState("mild");
  // Shown once, so the clinician knows the two fields below were filled in for them
  // and are theirs to correct — not values the system is asserting about the patient.
  const [prefilled, setPrefilled] = useState(false);

  const allergens = useQuery({ queryKey: ["allergens"], queryFn: () => listAllergens() });
  const term = substance.trim().toLowerCase();
  const exact = (allergens.data ?? []).some((a) => a.name.toLowerCase() === term);
  const already = allergies.some((a) => a.substance.toLowerCase() === term);

  const add = useMutation({
    mutationFn: async () => {
      const name = substance.trim();
      // Keep the library as the one source of allergen names, and teach it what this
      // substance did while someone is here saying so. Already-exists is fine.
      if (name && !exact) {
        try {
          await createAllergen(name, {
            default_reaction: reaction.trim() || undefined,
            default_severity: severity || undefined,
          });
        } catch { /* already in the library */ }
      }
      return addAllergy(patientId, { substance: name, reaction: reaction.trim() || undefined, severity });
    },
    onSuccess: () => {
      toast.success("Allergy recorded");
      setSubstance(""); setReaction(""); setSeverity("mild"); setPrefilled(false);
      onSaved();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not record the allergy"),
  });

  const del = useMutation({
    mutationFn: (id: string) => removeAllergy(patientId, id),
    onSuccess: () => { toast.success("Allergy removed"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Allergies</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          What the patient reacts to, and how. This is the flag that shows on their record
          before anyone injects an anaesthetic or writes a prescription.
        </p>

        {allergies.length > 0 && (
          <ul className="divide-y rounded-md border">
            {allergies.map((a) => (
              <li key={a.id} className="flex items-center gap-3 p-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{a.substance}</span>
                  {a.reaction && <span className="text-sm text-muted-foreground"> — {a.reaction}</span>}
                </div>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize",
                  a.severity === "severe" ? "bg-destructive text-destructive-foreground"
                    : a.severity === "moderate" ? "bg-amber-500 text-white" : "bg-muted text-muted-foreground")}>
                  {a.severity}
                </span>
                <Button variant="ghost" size="icon" aria-label={`Remove ${a.substance}`}
                  disabled={del.isPending} onClick={() => del.mutate(a.id)}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3 rounded-md border border-dashed p-3">
          <div className="space-y-1.5">
            <Label htmlFor="alg-substance">Substance</Label>
            <SubstanceField
              id="alg-substance"
              value={substance}
              onChange={(v) => { setSubstance(v); setPrefilled(false); }}
              onPrefill={(d) => {
                if (d.reaction) setReaction(d.reaction);
                if (d.severity) setSeverity(d.severity);
                setPrefilled(!!(d.reaction || d.severity));
              }}
              allergens={allergens.data ?? []}
            />
            {already && <p className="text-xs text-amber-700">Already on this patient's record.</p>}
          </div>

          {prefilled && (
            <p className="text-xs text-brand">
              Filled in from the clinic's allergen library — change either if this patient reacted differently.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="alg-reaction">Reaction</Label>
              <Input id="alg-reaction" value={reaction} onChange={(e) => { setReaction(e.target.value); setPrefilled(false); }} placeholder="Rash, swelling, anaphylaxis…" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="alg-severity">Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger id="alg-severity"><SelectValue /></SelectTrigger>
                <SelectContent>{SEVERITIES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <Button className="w-full" disabled={!substance.trim() || already} loading={add.isPending} onClick={() => add.mutate()}>
            <Plus className="h-4 w-4" /> Add allergy
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
