// The clinic's drug library, at the point of prescribing.
//
// Built for the general encounter (migration 00022) and left there: a per-clinic
// catalogue where each drug carries a default dose, frequency, duration and
// instructions, plus the allergen tags that make a prescription checkable against
// what the patient is allergic to. The dental prescription had none of it — free
// text, no defaults, no check — so the same clinic answered the same question two
// different ways depending on which chair the patient sat in.
//
// These two pieces are shared rather than copied. A second drug picker would drift
// from this one, and the half that drifts is the half that stops warning.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Pill, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { createAllergen, createDrug, listAllergens, searchDrugs, type Drug } from "@/features/clinical/api";

/**
 * Search the library, or type a drug that is not in it.
 *
 * Picking an entry fills the sig from its defaults — the thing a prescriber would
 * otherwise retype identically every single time — and hands back the drug so the
 * caller can send its id, which is what makes the allergy check exact rather than
 * a guess from the spelling.
 */
export function DrugSearchInput({ value, onChange, onPick, autoFocus, placeholder }: {
  value: string;
  onChange: (name: string) => void;
  onPick: (d: Drug) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const drugs = useQuery({
    queryKey: ["drug-search", value],
    queryFn: () => searchDrugs(value),
    enabled: open && value.trim().length > 0,
  });
  const results = (drugs.data ?? []).slice(0, 8);
  const exact = results.some((d) => d.name.toLowerCase() === value.trim().toLowerCase());

  if (creating !== null) {
    return (
      <CreateDrugDialog
        initialName={creating}
        onClose={() => setCreating(null)}
        onCreated={(d) => { setCreating(null); onPick(d); setOpen(false); }}
      />
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => value && setOpen(true)}
          // Closed on a delay so a click on a result lands before the list unmounts.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder ?? "Search the drug library…"}
        />
      </div>
      {open && value.trim() && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-background shadow-md">
          {results.map((d) => (
            <button key={d.id} type="button" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(d); setOpen(false); }}
              className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
              <span className="min-w-0">
                <span className="inline-flex items-center gap-1.5 font-medium"><Pill className="h-3.5 w-3.5 text-brand" />{d.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[d.default_dose, d.default_frequency, d.default_duration].filter(Boolean).join(" · ") || "no defaults saved"}
                </span>
              </span>
              {d.allergens.length > 0 && (
                <Badge variant="warning" className="shrink-0 gap-1"><AlertTriangle className="h-3 w-3" />{d.allergens.join(", ")}</Badge>
              )}
            </button>
          ))}
          {!exact && (
            <button type="button" onMouseDown={(e) => e.preventDefault()}
              onClick={() => setCreating(value.trim())}
              className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm text-primary hover:bg-muted">
              <Plus className="h-4 w-4" /> Save “{value.trim()}” to the library
            </button>
          )}
          {results.length === 0 && exact && <p className="px-3 py-2 text-xs text-muted-foreground">No matches.</p>}
        </div>
      )}
    </div>
  );
}

export function CreateDrugDialog({ initialName, onClose, onCreated }: { initialName: string; onClose: () => void; onCreated: (d: Drug) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: initialName, default_dose: "", default_frequency: "", default_duration: "", default_instructions: "" });
  const [allergenIds, setAllergenIds] = useState<string[]>([]);
  // A new allergen is described once, here, and every patient it is later recorded
  // against inherits the description instead of someone retyping it.
  const [newAllergen, setNewAllergen] = useState({ name: "", reaction: "", severity: "" });
  const allergens = useQuery({ queryKey: ["allergens"], queryFn: () => listAllergens() });

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (id: string) => setAllergenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const addAllergen = useMutation({
    mutationFn: () => createAllergen(newAllergen.name.trim(), {
      default_reaction: newAllergen.reaction.trim() || undefined,
      default_severity: newAllergen.severity || undefined,
    }),
    onSuccess: (a) => {
      setNewAllergen({ name: "", reaction: "", severity: "" });
      setAllergenIds((ids) => [...ids, a.id]);
      qc.invalidateQueries({ queryKey: ["allergens"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add allergen"),
  });
  const create = useMutation({
    mutationFn: () => createDrug({ ...form, allergen_ids: allergenIds }),
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["drug-search"] }); toast.success("Saved to the drug library"); onCreated(d); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not create the drug"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New drug in library</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Amoxicillin 500mg" autoFocus /></div>
          <div className="space-y-1.5"><Label>Default dose</Label><Input value={form.default_dose} onChange={(e) => set("default_dose", e.target.value)} placeholder="1 cap" /></div>
          <div className="space-y-1.5"><Label>Default frequency</Label><Input value={form.default_frequency} onChange={(e) => set("default_frequency", e.target.value)} placeholder="three times a day" /></div>
          <div className="space-y-1.5"><Label>Default duration</Label><Input value={form.default_duration} onChange={(e) => set("default_duration", e.target.value)} placeholder="5 days" /></div>
          <div className="col-span-2 space-y-1.5"><Label>Default instructions</Label><Input value={form.default_instructions} onChange={(e) => set("default_instructions", e.target.value)} placeholder="Complete the full course" /></div>
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Allergen tags (warns if the patient is allergic)</Label>
          <div className="flex flex-wrap gap-1.5">
            {(allergens.data ?? []).map((a) => (
              <button key={a.id} type="button" onClick={() => toggle(a.id)} className={`rounded-full border px-2.5 py-1 text-xs ${allergenIds.includes(a.id) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                {a.name}
              </button>
            ))}
            {(allergens.data?.length ?? 0) === 0 && <span className="text-xs text-muted-foreground">No allergens yet — add one below.</span>}
          </div>
          {/* Describing the allergen here is what makes recording it on a patient a
              single click later: the reaction and severity are carried with it. */}
          <div className="space-y-1.5 rounded-md border border-dashed p-2">
            <Input value={newAllergen.name} onChange={(e) => setNewAllergen((n) => ({ ...n, name: e.target.value }))}
              placeholder="New allergen (e.g. Penicillin)" className="h-8" />
            <div className="grid gap-1.5 sm:grid-cols-[1fr_9rem_auto]">
              <Input value={newAllergen.reaction} onChange={(e) => setNewAllergen((n) => ({ ...n, reaction: e.target.value }))}
                placeholder="Usual reaction (rash, swelling)" className="h-8" />
              <Select value={newAllergen.severity || "unset"}
                onValueChange={(v) => setNewAllergen((n) => ({ ...n, severity: v === "unset" ? "" : v }))}>
                <SelectTrigger className="h-8"><SelectValue placeholder="Severity" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unset">Severity —</SelectItem>
                  <SelectItem value="mild">Mild</SelectItem>
                  <SelectItem value="moderate">Moderate</SelectItem>
                  <SelectItem value="severe">Severe</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={!newAllergen.name.trim()}
                loading={addAllergen.isPending} onClick={() => addAllergen.mutate()}>Add</Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button disabled={!form.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Save &amp; use</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
