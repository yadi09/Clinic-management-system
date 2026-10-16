import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  CATEGORIES, CONDITIONS, deleteListing, myListings, myStats, saveListing, updateMe, uploadPhoto,
  type Listing, type ListingInput, type Seller,
} from "@/features/marketplace/api";
import { ConditionTag, KindTag, Photo, PriceLine } from "@/features/marketplace/parts";

const empty: ListingInput = {
  title: "", brand: "", category: "", description: "", condition: "", price_etb: null,
  negotiable: false, quantity: null, expiry: "", warranty: "", photos: [], status: "active",
};

const opt = (on: boolean) =>
  "rounded-lg border px-3 py-2 text-left text-sm transition-colors " + (on ? "border-primary bg-primary/10 font-semibold" : "bg-card hover:bg-accent");

function StatusBanner({ s }: { s: Seller }) {
  if (s.status === "approved") return null;
  const text = {
    pending: ["Waiting for our call", "We will phone you on " + s.phone + ". Once we have spoken your account is approved and your listings go public. You can prepare listings now."],
    rejected: ["Application not approved", s.status_note || "Please contact us if you think this is a mistake."],
    suspended: ["Account suspended", s.status_note || "Your listings are hidden. Please contact us."],
  }[s.status];
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-semibold">{text[0]}</p>
      <p>{text[1]}</p>
    </div>
  );
}

export function SellerPortal({ seller, onSignOut }: { seller: Seller; onSignOut: () => void }) {
  const qc = useQueryClient();
  const { ask, dialog } = useConfirmDialog();
  const [editing, setEditing] = useState<Listing | "new" | null>(null);
  const [profile, setProfile] = useState(false);
  const stats = useQuery({ queryKey: ["market-my", "stats"], queryFn: myStats });
  const list = useQuery({ queryKey: ["market-my", "listings"], queryFn: myListings });
  const refresh = () => qc.invalidateQueries({ queryKey: ["market-my"] });

  const del = useMutation({
    mutationFn: (id: string) => deleteListing(id),
    onSuccess: () => { toast.success("Listing removed"); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove it"),
  });

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{seller.name}</h1>
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><KindTag k={seller.kind} /> {seller.phone} · {seller.city}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setProfile((p) => !p)}>Edit profile</Button>
          <Button variant="outline" size="sm" onClick={onSignOut}>Sign out</Button>
        </div>
      </div>
      <StatusBanner s={seller} />
      {profile && <ProfileForm seller={seller} onDone={() => { setProfile(false); qc.invalidateQueries({ queryKey: ["market-me"] }); }} onCancel={() => setProfile(false)} />}

      <div className="grid grid-cols-3 gap-3">
        {[
          ["Listings", stats.data?.listings],
          ["Live now", seller.status === "approved" ? stats.data?.active : 0],
          ["Contacts (30 days)", stats.data?.contacts_30d],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-xl border bg-card p-3">
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className="text-2xl font-bold tabular-nums">{v ?? "–"}</p>
          </div>
        ))}
      </div>

      {editing ? (
        <ListingForm
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onDone={() => { setEditing(null); refresh(); }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">My products</h2>
            <Button onClick={() => setEditing("new")}><Plus /> Add product</Button>
          </div>
          {list.isLoading ? null : (list.data ?? []).length === 0 ? (
            <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">You have not listed anything yet.</p>
          ) : (
            <div className="divide-y rounded-xl border bg-card">
              {(list.data ?? []).map((l) => (
                <div key={l.id} className="flex items-center gap-3 p-3">
                  <Photo src={l.photos[0]} alt="" className="h-14 w-14 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{l.title}</p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <ConditionTag c={l.condition} /> <PriceLine l={l} />
                      {l.status !== "active" && <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-semibold uppercase">{l.status}</span>}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => setEditing(l)}><Pencil /></Button>
                  <Button
                    variant="ghost" size="icon" aria-label="Delete"
                    onClick={() => ask({ title: "Remove this listing?", description: l.title, confirmLabel: "Remove listing", destructive: true }, () => del.mutate(l.id))}
                  ><Trash2 /></Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ListingForm({ initial, onDone, onCancel }: { initial: Listing | null; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<ListingInput>(
    initial
      ? {
          title: initial.title, brand: initial.brand ?? "", category: initial.category, description: initial.description ?? "",
          condition: initial.condition, price_etb: initial.price_etb ?? null, negotiable: initial.negotiable,
          quantity: initial.quantity ?? null, expiry: initial.expiry ?? "", warranty: initial.warranty ?? "",
          photos: initial.photo_keys ?? [], status: initial.status,
        }
      : empty,
  );
  // Show what is already uploaded; new uploads get a local preview.
  const [previews, setPreviews] = useState<Record<string, string>>(
    Object.fromEntries((initial?.photo_keys ?? []).map((k, i) => [k, initial?.photos[i] ?? ""])),
  );
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const set = <K extends keyof ListingInput>(k: K, v: ListingInput[K]) => setF((s) => ({ ...s, [k]: v }));

  const used = f.condition !== "" && f.condition !== "new";
  const needPhotos = used && f.photos.length < 2;
  const ok = f.title.trim() && f.category && f.condition && !needPhotos;

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    setUploading(true); setErr(null);
    try {
      for (const file of Array.from(files).slice(0, 8 - f.photos.length)) {
        const key = await uploadPhoto(file);
        setPreviews((p) => ({ ...p, [key]: URL.createObjectURL(file) }));
        setF((s) => ({ ...s, photos: [...s.photos, key] }));
      }
    } catch (x) { setErr(x instanceof Error ? x.message : "Photo upload failed"); }
    finally { setUploading(false); if (file.current) file.current.value = ""; }
  };

  return (
    <form
      className="space-y-4 rounded-xl border bg-card p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try { await saveListing(initial?.id ?? null, f); toast.success(initial ? "Listing updated" : "Listing added"); onDone(); }
        catch (x) { setErr(x instanceof Error ? x.message : "Could not save"); }
        finally { setBusy(false); }
      }}
    >
      <h2 className="text-lg font-semibold">{initial ? "Edit product" : "Add a product"}</h2>
      <div><Label htmlFor="lt">Product name *</Label><Input id="lt" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Filtek Z250 composite A2" /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label htmlFor="lb">Brand</Label><Input id="lb" value={f.brand} onChange={(e) => set("brand", e.target.value)} /></div>
        <div>
          <Label htmlFor="lc">Category *</Label>
          <select id="lc" value={f.category} onChange={(e) => set("category", e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm">
            <option value="">Choose…</option>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div>
        <Label>Condition *</Label>
        <div className="mt-1 grid gap-2 sm:grid-cols-3">
          {CONDITIONS.map((c) => (
            <button type="button" key={c.id} className={opt(f.condition === c.id)} onClick={() => set("condition", c.id)}>
              {c.label}<span className="block text-xs font-normal text-muted-foreground">{c.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="lp">Price (ETB)</Label>
          <Input id="lp" inputMode="decimal" value={f.price_etb ?? ""} placeholder="Leave empty to “ask for price”"
            onChange={(e) => { const n = parseFloat(e.target.value); set("price_etb", e.target.value === "" || isNaN(n) ? null : Math.max(0, n)); }} />
          <label className="mt-1.5 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.negotiable} onChange={(e) => set("negotiable", e.target.checked)} /> Price is negotiable</label>
        </div>
        <div>
          <Label htmlFor="lq">Quantity available</Label>
          <Input id="lq" inputMode="numeric" value={f.quantity ?? ""}
            onChange={(e) => { const n = parseInt(e.target.value, 10); set("quantity", e.target.value === "" || isNaN(n) ? null : Math.max(0, n)); }} />
        </div>
        <div><Label htmlFor="le">Expiry (consumables)</Label><Input id="le" value={f.expiry} onChange={(e) => set("expiry", e.target.value)} placeholder="MM/YYYY" maxLength={10} /></div>
        <div>
          <Label htmlFor="lw">Warranty</Label>
          <select id="lw" value={f.warranty} onChange={(e) => set("warranty", e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm">
            <option value="">None</option><option>3 months</option><option>6 months</option><option>1 year</option>
          </select>
        </div>
      </div>

      <div><Label htmlFor="ld">Notes</Label><Textarea id="ld" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Age of the item, why you are selling, what is included…" /></div>

      <div>
        <Label>Photos {used && <span className="font-normal text-destructive">(at least 2 for used items)</span>}</Label>
        <div className="mt-1 flex flex-wrap gap-2">
          {f.photos.map((k) => (
            <div key={k} className="relative">
              <Photo src={previews[k]} alt="" className="h-20 w-20 rounded-lg" />
              <button type="button" aria-label="Remove photo" onClick={() => set("photos", f.photos.filter((x) => x !== k))}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background"><X className="h-3 w-3" /></button>
            </div>
          ))}
          {f.photos.length < 8 && (
            <button type="button" disabled={uploading} onClick={() => file.current?.click()}
              className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
              <ImagePlus className="h-5 w-5" />{uploading ? "Uploading…" : "Add"}
            </button>
          )}
          <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
        </div>
      </div>

      {initial && (
        <div>
          <Label htmlFor="ls">Status</Label>
          <select id="ls" value={f.status} onChange={(e) => set("status", e.target.value as ListingInput["status"])} className="flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm sm:w-48">
            <option value="active">Available</option><option value="sold">Sold</option><option value="hidden">Hidden</option>
          </select>
        </div>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy} disabled={!ok || uploading}>{initial ? "Save changes" : "Publish"}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** The seller's own details. The phone is the login, so it is shown but not editable. */
function ProfileForm({ seller, onDone, onCancel }: { seller: Seller; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({
    name: seller.name, telegram: seller.telegram ?? "", city: seller.city, subcity: seller.subcity ?? "", about: seller.about ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  return (
    <form
      className="space-y-3 rounded-xl border bg-card p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try { await updateMe(f); toast.success("Profile updated"); onDone(); }
        catch (x) { setErr(x instanceof Error ? x.message : "Could not save"); }
        finally { setBusy(false); }
      }}
    >
      <h2 className="text-lg font-semibold">Edit profile</h2>
      <div><Label htmlFor="pn">Name or business name *</Label><Input id="pn" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label>Phone (your login)</Label><Input value={seller.phone} disabled /></div>
        <div><Label htmlFor="pt">Telegram</Label><Input id="pt" value={f.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="@username" /></div>
        <div><Label htmlFor="pc">City *</Label><Input id="pc" value={f.city} onChange={(e) => set("city", e.target.value)} /></div>
        <div><Label htmlFor="ps">Sub-city / area</Label><Input id="ps" value={f.subcity} onChange={(e) => set("subcity", e.target.value)} /></div>
      </div>
      <div><Label htmlFor="pa">About</Label><Textarea id="pa" rows={2} value={f.about} onChange={(e) => set("about", e.target.value)} /></div>
      <p className="text-xs text-muted-foreground">To change your phone number, contact us — it is how we know it is you.</p>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy} disabled={!f.name.trim() || !f.city.trim()}>Save</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
