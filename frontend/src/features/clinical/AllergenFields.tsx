// Allergens, described and chosen — in one place.
//
// Four screens create or pick an allergen: the drug library dialog, the Drug
// library card in Settings, the dental allergy dialog, and the patient profile.
// They were four copies of the same form, which is why adding "reaction" and
// "severity" to the library fixed two of them and quietly left the other two
// asking for a bare name. A clinic that used Settings to build its allergen list
// got none of the benefit.
//
// So the two pieces live here and the four screens render them.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { createAllergen, type Allergen } from "@/features/clinical/api";

export const SEVERITIES = [
  { value: "mild", label: "Mild" },
  { value: "moderate", label: "Moderate" },
  { value: "severe", label: "Severe" },
];

/** The colour a severity always wears, so it means the same thing on every screen. */
export function severityClass(severity?: string) {
  return severity === "severe" ? "bg-destructive text-destructive-foreground"
    : severity === "moderate" ? "bg-amber-500 text-white"
      : severity === "mild" ? "bg-muted text-muted-foreground"
        : "bg-muted text-muted-foreground";
}

/**
 * Add an allergen to the clinic's library, with what it usually does.
 *
 * The description is the whole point of the library: it is what pre-fills the
 * patient's record later, so asking for it here is what saves the retyping there.
 * Both extra fields are optional — a clinic may know a substance is an allergen
 * long before anyone has watched it react.
 */
export function NewAllergenForm({ onAdded, compact }: {
  onAdded?: (a: Allergen) => void;
  /** Tighter layout for the drug dialog, which is already a dense form. */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", reaction: "", severity: "" });

  const add = useMutation({
    mutationFn: () => createAllergen(form.name.trim(), {
      default_reaction: form.reaction.trim() || undefined,
      default_severity: form.severity || undefined,
    }),
    onSuccess: (a) => {
      setForm({ name: "", reaction: "", severity: "" });
      qc.invalidateQueries({ queryKey: ["allergens"] });
      qc.invalidateQueries({ queryKey: ["allergens-all"] });
      onAdded?.(a);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add the allergen (it may already exist)"),
  });

  return (
    <div className={cn("space-y-1.5 rounded-md border border-dashed p-2")}>
      <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        placeholder="New allergen (e.g. Penicillin)" className={compact ? "h-8" : undefined} />
      <div className="grid gap-1.5 sm:grid-cols-[1fr_9rem_auto]">
        <Input value={form.reaction} onChange={(e) => setForm((f) => ({ ...f, reaction: e.target.value }))}
          placeholder="Usual reaction (rash, swelling)" className={compact ? "h-8" : undefined} />
        <Select value={form.severity || "unset"}
          onValueChange={(v) => setForm((f) => ({ ...f, severity: v === "unset" ? "" : v }))}>
          <SelectTrigger className={compact ? "h-8" : undefined}><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="unset">Severity —</SelectItem>
            {SEVERITIES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size={compact ? "sm" : "default"} variant="outline" disabled={!form.name.trim()}
          loading={add.isPending} onClick={() => add.mutate()}>
          Add allergen
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        The reaction and severity pre-fill the patient's record whenever this allergen is chosen.
      </p>
    </div>
  );
}

/**
 * Pick a substance for a patient's allergy record.
 *
 * Choosing a known one brings its usual reaction and severity with it, so the two
 * fields below are filled in rather than retyped. Free text is still allowed: a
 * clinic will always meet a substance its library has not.
 */
export function SubstanceField({ id, value, onChange, onPrefill, allergens, placeholder }: {
  id?: string;
  value: string;
  onChange: (name: string) => void;
  /** Called with the library's defaults when a known substance is chosen. */
  onPrefill: (d: { reaction?: string; severity?: string }) => void;
  allergens: Allergen[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const term = value.trim().toLowerCase();
  const suggestions = allergens.filter((a) => a.name.toLowerCase().includes(term)).slice(0, 8);

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        // Closed on a delay so a click on a suggestion lands before the list goes.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder ?? "Penicillin, latex, local anaesthetic…"}
      />
      {open && term && suggestions.length > 0 && (
        <div className="absolute z-30 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-background shadow-md">
          {suggestions.map((a) => (
            <button
              key={a.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(a.name);
                onPrefill({ reaction: a.default_reaction, severity: a.default_severity });
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
            >
              <span className="font-medium">{a.name}</span>
              {(a.default_reaction || a.default_severity) && (
                <span className="block text-xs text-muted-foreground">
                  {[a.default_reaction, a.default_severity].filter(Boolean).join(" · ")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
