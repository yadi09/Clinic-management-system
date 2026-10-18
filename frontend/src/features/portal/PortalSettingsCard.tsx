// The clinic's switches for its patient portal: on or off, and what patients may see.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { getPortalSettings, savePortalSettings, type PortalSettings } from "@/features/portal/api";

const OPTIONS: { key: keyof Pick<PortalSettings, "show_money" | "show_unbilled" | "show_teeth" | "show_3d">; label: string; help: string }[] = [
  { key: "show_money", label: "Payments", help: "What the patient has paid, what is waiting for payment, and their receipts." },
  { key: "show_unbilled", label: "Treatment not billed yet", help: "Work that is done but has no bill. Some clinics prefer not to show this." },
  { key: "show_teeth", label: "Tooth chart", help: "The patient's own teeth, with what is done and what is planned." },
  { key: "show_3d", label: "3D model of the teeth", help: "The patient can turn their own teeth around. Needs the tooth chart." },
];

export function PortalSettingsCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["portal-settings"], queryFn: getPortalSettings });
  const [draft, setDraft] = useState<PortalSettings | null>(null);
  useEffect(() => { if (q.data) setDraft(q.data); }, [q.data]);

  const save = useMutation({
    mutationFn: savePortalSettings,
    onSuccess: (s) => { toast.success("Patient portal saved"); qc.setQueryData(["portal-settings"], s); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the portal settings"),
  });

  if (q.isError) return <p role="alert" className="text-sm text-destructive">Could not load the portal settings.</p>;
  if (!draft) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const link = `${window.location.origin}/p/${draft.slug ?? ""}`;
  const set = (patch: Partial<PortalSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Patient portal</CardTitle>
        <CardDescription>A page with your clinic's name where patients sign in with the card number on their patient card, and see their own treatment, payments and teeth. They can only read; nothing can be changed from it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-start gap-3 rounded-lg border p-3">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={draft.enabled} disabled={!manage} onChange={(e) => set({ enabled: e.target.checked })} />
          <span><span className="block text-sm font-medium">Turn on the patient portal</span>
            <span className="block text-xs text-muted-foreground">Until you turn it on, the link below shows nothing.</span></span>
        </label>
        {draft.enabled && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm">
            <span className="min-w-0 flex-1 break-all font-medium">{link}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(link).then(() => toast.success("Link copied")); }}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />Copy link
            </Button>
          </div>
        )}
        <fieldset className="space-y-2" disabled={!manage}>
          <legend className="mb-1 text-sm font-medium">What patients can see</legend>
          {OPTIONS.map((o) => (
            <label key={o.key} className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={draft[o.key]} onChange={(e) => set({ [o.key]: e.target.checked })} />
              <span><span className="block font-medium">{o.label}</span><span className="block text-xs text-muted-foreground">{o.help}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="space-y-1">
          <label htmlFor="portal-note" className="text-sm font-medium">A message on their home page</label>
          <Textarea id="portal-note" rows={2} maxLength={300} disabled={!manage} value={draft.welcome_note}
            placeholder="e.g. Please brush gently around a new crown for the first two days." onChange={(e) => set({ welcome_note: e.target.value })} />
        </div>
        <p className="text-xs text-muted-foreground">For now a patient signs in with the card number only. A card number is printed on the card, so anyone holding the card can open the page — a second step will be added before it is used widely.</p>
        {manage && <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? "Saving…" : "Save"}</Button>}
      </CardContent>
    </Card>
  );
}
