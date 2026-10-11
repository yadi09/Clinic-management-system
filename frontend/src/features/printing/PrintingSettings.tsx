// Settings → Printing: how this clinic's papers look.
//
// Drawn from the catalog (catalog.ts), so every kind of paper gets the same options
// without its own screen: identity once, then for each paper a layout, a size, the
// parts it shows, the words on it. A preview on the right is the real template
// printing made-up data, so the clinic sees its own paper before a patient does.
import { cloneElement, isValidElement, useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Plus, RotateCcw, Save, Trash2 } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { AppError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { getClinic, listBranches } from "@/features/admin/api";
import { getPrintSettings, savePrintSettings } from "@/features/printing/api";
import type { PrintCtx } from "@/features/printing/blocks";
import { CATALOG, docInfo, type DocInfo } from "@/features/printing/catalog";
import { build, pageHtml } from "@/features/printing/engine";
import { LABELS } from "@/features/printing/labels";
import { PaperFrame } from "@/features/printing/PrintHost";
import { sampleFor } from "@/features/printing/samples";
import {
  DEFAULT_SETTINGS, PAPERS, resolveSettings, type DocId, type PaperId, type PrintSettings,
} from "@/features/printing/settings";

type Tab = "identity" | "look" | "language" | "reprints" | "branches" | DocId;

/** Resize a chosen image to a sensible logo and return it as a data URL. */
async function toLogoDataUrl(file: File): Promise<string> {
  const src = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("read"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("image"));
    i.src = src;
  });
  const max = 480;
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.width * k));
  c.height = Math.max(1, Math.round(img.height * k));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  const png = c.toDataURL("image/png");
  // A photographic logo can be heavy as PNG; fall back to JPEG to stay under the cap.
  return png.length < 380_000 ? png : c.toDataURL("image/jpeg", 0.88);
}

function Toggle({ checked, onChange, label, help, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; help?: string; disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-start gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50", disabled && "opacity-60")}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]" checked={checked}
        disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-medium">{label}</span>{help && <span className="block text-xs text-muted-foreground">{help}</span>}</span>
    </label>
  );
}

/** A labelled control. A single input or text box inside is tied to its label, so it
 *  has an accessible name; a group of choices names itself. */
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  const id = useId();
  const single = isValidElement(children) && (children.type === Input || children.type === Textarea);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={single ? id : undefined} className="text-xs text-muted-foreground">{label}</Label>
      {single ? cloneElement(children as React.ReactElement<{ id?: string }>, { id }) : children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Choice<T extends string>({ value, onChange, options, ariaLabel, disabled }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; ariaLabel: string; disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn("rounded-md border px-2.5 py-1 text-sm font-medium disabled:opacity-60",
            value === o.value ? "border-brand bg-brand text-brand-foreground" : "bg-card hover:bg-accent")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PrintingSettings() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can("clinic.manage");
  const stored = useQuery({ queryKey: ["print-settings"], queryFn: getPrintSettings, retry: false });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });

  const [draft, setDraft] = useState<PrintSettings>(DEFAULT_SETTINGS);
  const [logo, setLogo] = useState("");
  const [logoChanged, setLogoChanged] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("identity");
  const [asReprint, setAsReprint] = useState(false);

  useEffect(() => {
    if (!stored.data || dirty) return;
    setDraft(resolveSettings(stored.data.settings));
    setLogo(stored.data.logo ?? "");
  }, [stored.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (fn: (d: PrintSettings) => PrintSettings) => { setDraft((d) => fn(d)); setDirty(true); };
  const setIdentity = <K extends keyof PrintSettings["identity"]>(k: K, v: PrintSettings["identity"][K]) =>
    edit((d) => ({ ...d, identity: { ...d.identity, [k]: v } }));
  const setLook = <K extends keyof PrintSettings["look"]>(k: K, v: PrintSettings["look"][K]) =>
    edit((d) => ({ ...d, look: { ...d.look, [k]: v } }));
  const setLocale = <K extends keyof PrintSettings["locale"]>(k: K, v: PrintSettings["locale"][K]) =>
    edit((d) => ({ ...d, locale: { ...d.locale, [k]: v } }));
  const setDoc = (doc: DocId, patch: Partial<NonNullable<PrintSettings["docs"][DocId]>>) =>
    edit((d) => ({ ...d, docs: { ...d.docs, [doc]: { ...d.docs[doc], ...patch } } }));
  const setShow = (doc: DocId, id: string, v: boolean) =>
    setDoc(doc, { show: { ...draft.docs[doc]?.show, [id]: v } });
  const setText = (doc: DocId, id: string, v: string) =>
    setDoc(doc, { text: { ...draft.docs[doc]?.text, [id]: v } });
  const setLabel = (key: string, v: string) =>
    edit((d) => {
      const labels = { ...d.labels };
      if (v.trim()) labels[key] = v; else delete labels[key];
      return { ...d, labels };
    });

  const save = useMutation({
    mutationFn: () => savePrintSettings({ settings: draft, logo: logoChanged ? logo : undefined }),
    onSuccess: () => {
      toast.success("Printing settings saved");
      setDirty(false); setLogoChanged(false);
      qc.invalidateQueries({ queryKey: ["print-settings"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the printing settings"),
  });

  const pickLogo = async (f: File | undefined) => {
    if (!f) return;
    try {
      setLogo(await toLogoDataUrl(f));
      setLogoChanged(true); setDirty(true);
    } catch {
      toast.error("That file could not be read as an image. Use a PNG, JPEG or WebP.");
    }
  };

  const previewDoc: DocId = (CATALOG.some((d) => d.id === tab) ? tab : "receipt") as DocId;
  const ctx: PrintCtx = useMemo(() => ({
    settings: draft, logo, clinicName: clinic.data?.name ?? "Your clinic", branch: null,
  }), [draft, logo, clinic.data]);
  const preview = useMemo(() => {
    const sample = sampleFor(previewDoc);
    if (!sample) return null;
    const dup = asReprint ? { count: 1, firstBy: "Hana Desta", firstAt: new Date().toISOString() } : null;
    const b = build(sample, ctx, { duplicate: dup });
    return { html: pageHtml(b, ctx), paper: b.paper };
  }, [previewDoc, ctx, asReprint]);

  if (stored.isLoading) return <Skeleton className="h-96 w-full" />;
  if (stored.isError) {
    return <Card><CardContent className="p-6 text-sm text-destructive">Could not load the printing settings.</CardContent></Card>;
  }

  const id = draft.identity;
  const tabs: { key: Tab; label: string }[] = [
    { key: "identity", label: "Clinic identity" },
    { key: "look", label: "Look" },
    { key: "language", label: "Language & dates" },
    ...CATALOG.map((d) => ({ key: d.id as Tab, label: d.label })),
    { key: "reprints", label: "Footer & reprints" },
    ...((branches.data?.length ?? 0) > 1 ? [{ key: "branches" as Tab, label: "Branches" }] : []),
  ];
  const info: DocInfo | undefined = docInfo(tab as DocId);
  const ro = !manage;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-h3">Printing</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set your clinic's details once and every printed paper uses them. Choose a layout and paper for each kind of
          paper, decide what shows on it, and see the result before anything is printed.
          {ro && " You can look, but only a clinic manager can change these."}
        </p>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none" role="tablist" aria-label="Printing settings">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={cn("shrink-0 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium",
              tab === t.key ? "border-brand bg-brand text-brand-foreground" : "bg-card hover:bg-accent")}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <Card><CardContent className="space-y-4 p-4">
          {tab === "identity" && (
            <>
              <Field label="Logo" hint="PNG, JPEG or WebP. It is shrunk to fit; keep it simple so it prints clearly on a thermal receipt.">
                <div className="flex items-center gap-3">
                  <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
                    {logo ? <img src={logo} alt="Clinic logo" className="h-full w-full object-contain" />
                      : <ImagePlus className="h-5 w-5 text-muted-foreground" />}
                  </div>
                  {!ro && (
                    <div className="flex gap-2">
                      <label className="inline-flex cursor-pointer items-center rounded-md border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent">
                        {logo ? "Replace" : "Upload"}
                        <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Logo file"
                          onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = ""; }} />
                      </label>
                      {logo && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => { setLogo(""); setLogoChanged(true); setDirty(true); }}>
                          <Trash2 className="h-4 w-4" /> Remove
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Clinic name (English)" hint={`Left empty it uses "${clinic.data?.name ?? "the clinic name"}".`}>
                  <Input value={id.nameEn} disabled={ro} onChange={(e) => setIdentity("nameEn", e.target.value)} placeholder={clinic.data?.name} />
                </Field>
                <Field label="Clinic name (Amharic)">
                  <Input value={id.nameAm} disabled={ro} onChange={(e) => setIdentity("nameAm", e.target.value)} />
                </Field>
                <Field label="Tagline or motto">
                  <Input value={id.tagline} disabled={ro} onChange={(e) => setIdentity("tagline", e.target.value)} />
                </Field>
                <Field label="Email">
                  <Input value={id.email} disabled={ro} onChange={(e) => setIdentity("email", e.target.value)} />
                </Field>
                <Field label="Website">
                  <Input value={id.website} disabled={ro} onChange={(e) => setIdentity("website", e.target.value)} />
                </Field>
                <Field label="Tax identification number (TIN)">
                  <Input value={id.tin} disabled={ro} onChange={(e) => setIdentity("tin", e.target.value)} />
                </Field>
                <Field label="VAT number">
                  <Input value={id.vatNo} disabled={ro} onChange={(e) => setIdentity("vatNo", e.target.value)} />
                </Field>
                <Field label="Licence or registration number">
                  <Input value={id.licenseNo} disabled={ro} onChange={(e) => setIdentity("licenseNo", e.target.value)} />
                </Field>
              </div>
              <Field label="Address (up to 3 lines)">
                <Textarea rows={3} disabled={ro} value={id.addressLines.join("\n")}
                  onChange={(e) => setIdentity("addressLines", e.target.value.split("\n").slice(0, 3))} />
              </Field>
              <Field label="Phone numbers (one per line, up to 3)">
                <Textarea rows={3} disabled={ro} value={id.phones.join("\n")}
                  onChange={(e) => setIdentity("phones", e.target.value.split("\n").slice(0, 3))} />
              </Field>
              <Field label="Extra lines (up to 3)" hint={'For example "Bank: CBE 1000123456789" or "Open 8:00–18:00".'}>
                <div className="space-y-2">
                  {id.extras.map((x, i) => (
                    <div key={i} className="flex gap-2">
                      <Input className="w-32" placeholder="Label" value={x.label} disabled={ro}
                        onChange={(e) => setIdentity("extras", id.extras.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} />
                      <Input placeholder="Text" value={x.value} disabled={ro}
                        onChange={(e) => setIdentity("extras", id.extras.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
                      {!ro && (
                        <Button type="button" variant="ghost" size="sm" aria-label="Remove line"
                          onClick={() => setIdentity("extras", id.extras.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                      )}
                    </div>
                  ))}
                  {!ro && id.extras.length < 3 && (
                    <Button type="button" variant="outline" size="sm"
                      onClick={() => setIdentity("extras", [...id.extras, { label: "", value: "" }])}>
                      <Plus className="h-4 w-4" /> Add a line
                    </Button>
                  )}
                </div>
              </Field>
            </>
          )}

          {tab === "look" && (
            <>
              <Field label="Header">
                <Choice ariaLabel="Header" value={draft.look.header} disabled={ro} onChange={(v) => setLook("header", v)}
                  options={[
                    { value: "full", label: "Full" }, { value: "compact", label: "Compact" },
                    { value: "name", label: "Name only" }, { value: "letterhead", label: "My own letterhead" },
                  ]} />
              </Field>
              {draft.look.header === "letterhead" && (
                <Field label={`Blank space at the top: ${draft.look.letterheadMm} mm`} hint="Measure your printed letterhead and leave that much room.">
                  <input type="range" min={0} max={80} value={draft.look.letterheadMm} disabled={ro} className="w-full"
                    aria-label="Letterhead space" onChange={(e) => setLook("letterheadMm", Number(e.target.value))} />
                </Field>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Logo position" hint="On a till slip, Left and Right put the logo beside the name; Centre puts it above.">
                  <Choice ariaLabel="Logo position" value={draft.look.logoPosition} disabled={ro} onChange={(v) => setLook("logoPosition", v)}
                    options={[{ value: "left", label: "Left" }, { value: "center", label: "Centre" }, { value: "right", label: "Right" }, { value: "none", label: "None" }]} />
                </Field>
                <Field label="Logo size">
                  <Choice ariaLabel="Logo size" value={draft.look.logoSize} disabled={ro} onChange={(v) => setLook("logoSize", v)}
                    options={[{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]} />
                </Field>
                <Field label="Logo shape" hint="Rounded and Circle crop the picture to fit; Square shows it whole.">
                  <Choice ariaLabel="Logo shape" value={draft.look.logoShape} disabled={ro} onChange={(v) => setLook("logoShape", v)}
                    options={[{ value: "square", label: "Square" }, { value: "rounded", label: "Rounded" }, { value: "circle", label: "Circle" }]} />
                </Field>
                <Field label="Text size">
                  <Choice ariaLabel="Text size" value={draft.look.textSize} disabled={ro} onChange={(v) => setLook("textSize", v)}
                    options={[{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]} />
                </Field>
                <Field label="Typeface">
                  <Choice ariaLabel="Typeface" value={draft.look.font} disabled={ro} onChange={(v) => setLook("font", v)}
                    options={[{ value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }, { value: "mono", label: "Typewriter" }]} />
                </Field>
                <Field label="Accent colour">
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Accent colour" value={draft.look.accent} disabled={ro}
                      onChange={(e) => setLook("accent", e.target.value)} className="h-9 w-12 cursor-pointer rounded border bg-card" />
                    <Input className="w-28 font-mono" value={draft.look.accent} disabled={ro}
                      onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && setLook("accent", e.target.value)} />
                  </div>
                </Field>
              </div>
              <Toggle checked={draft.look.rule} disabled={ro} onChange={(v) => setLook("rule", v)} label="A line under the header" />
            </>
          )}

          {tab === "language" && (
            <>
              <Field label="Language of fixed words" hint="You can rewrite any single word under each paper's Wording.">
                <Choice ariaLabel="Language" value={draft.locale.language} disabled={ro} onChange={(v) => setLocale("language", v)}
                  options={[{ value: "en", label: "English" }, { value: "am", label: "አማርኛ" }, { value: "both", label: "Both" }]} />
              </Field>
              <Field label="Dates">
                <Choice ariaLabel="Dates" value={draft.locale.dates} disabled={ro} onChange={(v) => setLocale("dates", v)}
                  options={[{ value: "gregorian", label: "Gregorian" }, { value: "ethiopian", label: "Ethiopian" }, { value: "both", label: "Both" }]} />
              </Field>
              <Field label="Time">
                <Choice ariaLabel="Time" value={draft.locale.time24 ? "24" : "12"} disabled={ro} onChange={(v) => setLocale("time24", v === "24")}
                  options={[{ value: "12", label: "12-hour (9:41 AM)" }, { value: "24", label: "24-hour (09:41)" }]} />
              </Field>
              <Field label="Currency label" hint='What prints before an amount: "ETB", "Birr", "Br".'>
                <Input className="w-32" value={draft.locale.currency} disabled={ro} onChange={(e) => setLocale("currency", e.target.value)} />
              </Field>
              <Toggle checked={draft.locale.thousands} disabled={ro} onChange={(v) => setLocale("thousands", v)} label="Thousands separator (1,500.00)" />
            </>
          )}

          {tab === "reprints" && (
            <>
              <Field label="Footer line on every paper" hint="For example your address on a second line, a slogan, or an opening-hours note.">
                <Textarea rows={2} disabled={ro} value={draft.footer.text}
                  onChange={(e) => edit((d) => ({ ...d, footer: { text: e.target.value } }))} />
              </Field>
              <div className="space-y-1">
                <Toggle checked={draft.signature.showName} disabled={ro}
                  onChange={(v) => edit((d) => ({ ...d, signature: { showName: v } }))}
                  label="Print the signer's name under signature lines"
                  help="Switch off when several people work from one account, so the line is left for whoever signs. Each paper has its own switch that can override this." />
              </div>
              <div className="space-y-1">
                <Toggle checked={draft.integrity.duplicateMark} disabled={ro}
                  onChange={(v) => edit((d) => ({ ...d, integrity: { ...d.integrity, duplicateMark: v } }))}
                  label="Mark a reprint" help="A paper printed a second time says so. The count is kept on the server, the same on every computer." />
                <Toggle checked={draft.integrity.showReprintLine} disabled={ro || !draft.integrity.duplicateMark}
                  onChange={(v) => edit((d) => ({ ...d, integrity: { ...d.integrity, showReprintLine: v } }))}
                  label="Say who printed it first, and when" />
              </div>
              <Field label="Wording of the mark">
                <Input className="w-56" value={draft.integrity.duplicateText} disabled={ro || !draft.integrity.duplicateMark}
                  onChange={(e) => edit((d) => ({ ...d, integrity: { ...d.integrity, duplicateText: e.target.value } }))} />
              </Field>
            </>
          )}

          {tab === "branches" && (
            <>
              <p className="text-sm text-muted-foreground">
                Leave a branch empty to use the clinic's details. Fill in only what differs for that branch.
              </p>
              {(branches.data ?? []).map((b) => {
                const o = draft.branches[b.id] ?? {};
                const patch = (p: Partial<typeof o>) =>
                  edit((d) => ({ ...d, branches: { ...d.branches, [b.id]: { ...d.branches[b.id], ...p } } }));
                return (
                  <div key={b.id} className="space-y-2 rounded-md border p-3">
                    <p className="font-medium">{b.name}</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label="Address lines">
                        <Textarea rows={2} disabled={ro} value={(o.addressLines ?? []).join("\n")}
                          onChange={(e) => patch({ addressLines: e.target.value.split("\n").slice(0, 3) })} />
                      </Field>
                      <Field label="Phone numbers">
                        <Textarea rows={2} disabled={ro} value={(o.phones ?? []).join("\n")}
                          onChange={(e) => patch({ phones: e.target.value.split("\n").slice(0, 3) })} />
                      </Field>
                      <Field label="Email"><Input disabled={ro} value={o.email ?? ""} onChange={(e) => patch({ email: e.target.value })} /></Field>
                      <Field label="TIN"><Input disabled={ro} value={o.tin ?? ""} onChange={(e) => patch({ tin: e.target.value })} /></Field>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {info && <DocOptions info={info} draft={draft} ro={ro}
            onTemplate={(t, paper) => setDoc(info.id, { template: t, paper })}
            onPaper={(p) => setDoc(info.id, { paper: p })}
            onShow={(k, v) => setShow(info.id, k, v)}
            onText={(k, v) => setText(info.id, k, v)}
            onLabel={setLabel}
            onReset={() => setDoc(info.id, { template: undefined, paper: undefined, show: {}, text: {} })} />}
        </CardContent></Card>

        <div className="space-y-2 xl:sticky xl:top-4 xl:self-start">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">Preview · {docInfo(previewDoc)?.label}</p>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--brand))]" checked={asReprint}
                onChange={(e) => setAsReprint(e.target.checked)} /> As a reprint
            </label>
          </div>
          <div className="max-h-[70vh] overflow-auto rounded-md border bg-muted/40 p-3">
            {preview ? <PaperFrame html={preview.html} paper={preview.paper} /> : <p className="text-sm text-muted-foreground">No preview for this paper yet.</p>}
          </div>
          <p className="text-xs text-muted-foreground">Sample data. Your patients' details are never used here.</p>
        </div>
      </div>

      {!ro && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
          {dirty && <span className="mr-auto text-xs font-medium text-amber-700">Unsaved changes</span>}
          <Button type="button" variant="outline" disabled={!dirty}
            onClick={() => { setDraft(resolveSettings(stored.data?.settings)); setLogo(stored.data?.logo ?? ""); setLogoChanged(false); setDirty(false); }}>
            <RotateCcw className="h-4 w-4" /> Discard changes
          </Button>
          <Button type="button" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            <Save className="h-4 w-4" /> Save printing settings
          </Button>
        </div>
      )}
    </div>
  );
}

function DocOptions({ info, draft, ro, onTemplate, onPaper, onShow, onText, onLabel, onReset }: {
  info: DocInfo; draft: PrintSettings; ro: boolean;
  onTemplate: (id: string, paper: PaperId | undefined) => void;
  onPaper: (p: PaperId) => void;
  onShow: (id: string, v: boolean) => void;
  onText: (id: string, v: string) => void;
  onLabel: (key: string, v: string) => void;
  onReset: () => void;
}) {
  const o = draft.docs[info.id] ?? {};
  const t = info.templates.find((x) => x.id === o.template) ?? info.templates[0];
  const paper = o.paper && t.papers.includes(o.paper) ? o.paper : t.paper;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{info.purpose}</p>
      <Field label="Layout">
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Layout">
          {info.templates.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={x.id === t.id} disabled={ro}
              onClick={() => onTemplate(x.id, undefined)}
              className={cn("rounded-md border p-3 text-left text-sm disabled:opacity-60", x.id === t.id ? "border-brand bg-brand/5" : "hover:bg-accent")}>
              <span className="font-semibold">{x.label}</span>
              <span className="block text-xs text-muted-foreground">{x.description}</span>
            </button>
          ))}
        </div>
      </Field>
      <Field label="Paper">
        <Choice ariaLabel="Paper" value={paper} disabled={ro} onChange={onPaper}
          options={t.papers.map((p) => ({ value: p, label: PAPERS[p].label }))} />
      </Field>
      <Field label="What shows on it">
        <div className="grid gap-x-4 sm:grid-cols-2">
          {info.toggles.map((x) => (
            <Toggle key={x.id} label={x.label} help={x.help} disabled={ro}
              checked={o.show?.[x.id] ?? x.fallback?.(draft) ?? x.default} onChange={(v) => onShow(x.id, v)} />
          ))}
        </div>
      </Field>
      {info.texts.map((x) => (
        <Field key={x.id} label={x.label} hint={x.help}>
          {x.multiline
            ? <Textarea rows={2} disabled={ro} value={o.text?.[x.id] ?? x.default} onChange={(e) => onText(x.id, e.target.value)} />
            : <Input disabled={ro} value={o.text?.[x.id] ?? x.default} onChange={(e) => onText(x.id, e.target.value)} />}
        </Field>
      ))}
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-semibold">Wording</summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Rewrite any fixed word on this paper. Leave a box empty to keep the standard word.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {info.labels.map((k) => (
            <Field key={k} label={LABELS[k]?.en ?? k}>
              <Input disabled={ro} value={draft.labels[k] ?? ""} placeholder={LABELS[k]?.en}
                onChange={(e) => onLabel(k, e.target.value)} />
            </Field>
          ))}
        </div>
      </details>
      {!ro && <Button type="button" variant="ghost" size="sm" onClick={onReset}><RotateCcw className="h-4 w-4" /> Back to standard for this paper</Button>}
    </div>
  );
}
