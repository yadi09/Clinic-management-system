// The clinic's own list of procedures, at the point of choosing one.
//
// Before this, "what treatment is this?" was a free-text box, and a live clinic
// answered it four different ways: "Root canel" at 50,000, "Root Canal" at 45,000,
// "root canal" at 5,000, and "rct" at nothing. Every one of those is the same job.
// Nobody was careless — the price simply had to be remembered, per patient, by
// whoever happened to be at the chair.
//
// So the price is remembered once, by the clinic, and the picker puts it on the
// plan. The dentist can still charge something else; what changes is that the
// difference is now a decision on the record instead of a typo nobody can see.
//
// The dentist can also add to the list from here. Sending them to Settings to name
// a procedure they are about to perform is how a shared list stops being used.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { createService, listServices, type ServiceItem } from "@/features/billing/api";
import { birr, num } from "@/features/dental/money";

/** The clinic's dental procedures, priced. Shared by every surface that picks one. */
export function useDentalServices() {
  const q = useQuery({ queryKey: ["services-all"], queryFn: () => listServices(false) });
  return {
    ...q,
    items: (q.data ?? []).filter((s) => s.is_active && s.category.trim().toLowerCase() === "dental"),
  };
}

export interface PickedService {
  id: string;
  name: string;
  /** The catalogue price, as text. "" when the picker is cleared. */
  price: string;
}

/**
 * Choose a procedure from the clinic's list — or type one that is not on it.
 *
 * `value` is the name shown, which is deliberately not the same thing as the
 * selected id: a course may be named for a procedure the clinic has never
 * catalogued, and refusing to let it be typed would just push people back to
 * inventing prices somewhere else.
 */
export function ServicePicker({ value, selectedId, onPick, onFreeText, placeholder }: {
  value: string;
  selectedId?: string;
  /** A catalogue entry was chosen (or cleared, with null). */
  onPick: (s: PickedService | null) => void;
  /** The name was typed rather than chosen. */
  onFreeText: (name: string) => void;
  placeholder?: string;
}) {
  const { can } = useAuth();
  const { items, isLoading } = useDentalServices();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value || placeholder || "Choose a procedure"}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search the clinic's list…" value={term} onValueChange={setTerm} />
            <CommandList>
              {!isLoading && items.length === 0 && (
                <CommandEmpty>
                  <span className="block px-2 py-3 text-xs text-muted-foreground">
                    No priced procedures yet. Add the ones you perform and every plan can start from them.
                  </span>
                </CommandEmpty>
              )}
              <CommandGroup>
                {items
                  .filter((s) => (s.name + " " + s.code).toLowerCase().includes(term.trim().toLowerCase()))
                  .map((s) => (
                    <CommandItem key={s.id} value={s.id} onSelect={() => {
                      onPick({ id: s.id, name: s.name, price: s.price });
                      setOpen(false);
                    }}>
                      <Check className={cn("h-4 w-4", selectedId === s.id ? "opacity-100" : "opacity-0")} />
                      <span className="flex-1 truncate">{s.name}</span>
                      <span className="tabular-nums text-xs text-muted-foreground">{birr(s.price)}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
              <div className="border-t p-1">
                {term.trim() && (
                  <button type="button"
                    className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => { onFreeText(term.trim()); onPick(null); setOpen(false); }}>
                    Use “<span className="font-medium">{term.trim()}</span>” without a price
                  </button>
                )}
                {can("dental.manage") && (
                  <button type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-primary hover:bg-muted"
                    onClick={() => { setOpen(false); setAdding(true); }}>
                    <Plus className="h-4 w-4" /> Add a procedure to the clinic's list
                  </button>
                )}
              </div>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {adding && (
        <NewProcedureDialog
          name={term.trim() || value}
          onClose={() => setAdding(false)}
          onCreated={(s) => { setAdding(false); onPick({ id: s.id, name: s.name, price: s.price }); }}
        />
      )}
    </>
  );
}

/**
 * The list price, next to the price actually being charged.
 *
 * It belongs beside the amount field rather than under the picker: a list price on
 * its own is trivia, and the same sentence printed twice on one dialog reads as a
 * bug. What matters is the gap between the two, which only the amount field knows.
 */
function ListPriceNote({ list, charging }: { list: string; charging?: string }) {
  const l = num(list);
  const c = charging === undefined ? l : num(charging);
  const gap = c - l;
  if (l <= 0) return <p className="text-xs text-muted-foreground">No price on the clinic's list for this one.</p>;
  if (Math.abs(gap) < 0.5) return <p className="text-xs text-muted-foreground">List price {birr(list)}.</p>;
  return (
    <p className="text-xs">
      <span className="text-muted-foreground">List price {birr(list)} — </span>
      <span className={gap < 0 ? "font-medium text-emerald-700" : "font-medium text-amber-700"}>
        {gap < 0 ? `${birr(String(-gap))} discount` : `${birr(String(gap))} above list`}
      </span>
    </p>
  );
}

/** The same note, for a caller that already knows both numbers. */
export function PriceAgainstList({ list, charging }: { list?: string; charging: string }) {
  if (!list || num(list) <= 0) return null;
  return <ListPriceNote list={list} charging={charging} />;
}

/**
 * Add a procedure to the clinic's list, from the chair.
 *
 * No approval step: the dentist is the one who knows a molar root canal is not an
 * incisor's, and a list they cannot add to is a list they will work around.
 */
function NewProcedureDialog({ name, onClose, onCreated }: {
  name: string; onClose: () => void; onCreated: (s: ServiceItem) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name, price: "" });
  const create = useMutation({
    mutationFn: () => createService({
      // The code is derived rather than asked for: it is a reporting handle, and one
      // more required field at the chair is one more reason to skip the list.
      code: codeFor(form.name),
      name: form.name.trim(),
      category: "dental",
      price: parseFloat(form.price) || 0,
      assignable_by: "clinician",
    }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["services-all"] });
      toast.success(`${s.name} added to the clinic's list`);
      onCreated(s);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add it to the list"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm space-y-3 rounded-lg border bg-background p-4 shadow-lg">
        <div>
          <h3 className="text-sm font-semibold">Add a procedure</h3>
          <p className="text-xs text-muted-foreground">It joins the clinic's list, priced once for every patient after this one.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proc-name">Procedure</Label>
          <Input id="proc-name" value={form.name} autoFocus
            onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Root canal — molar" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="proc-price">Price (ETB)</Label>
          <Input id="proc-price" type="number" min={0} step="0.01" value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="4500" />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!form.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Add to list
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A short, stable handle from the name: "Root canal — molar" → "ROOT-CANAL-MOLAR". */
function codeFor(name: string) {
  const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  return base || "PROCEDURE";
}
