import { apiFetch, sendFile } from "@/lib/api-client";
import { compressImage } from "@/lib/image";

export type Condition = "new" | "like_new" | "used_good" | "used_fair" | "for_parts";
export type SellerKind = "supplier" | "clinic" | "individual";
export type SellerStatus = "pending" | "approved" | "rejected" | "suspended";
export type Channel = "call" | "telegram" | "whatsapp";

export const CATEGORIES = [
  "Restorative", "Endodontics", "Orthodontics", "Consumables & PPE", "Equipment",
  "Imaging", "Sterilization", "Implants", "Instruments", "Other",
];

export const CONDITIONS: { id: Condition; label: string; hint: string }[] = [
  { id: "new", label: "Brand new", hint: "Sealed, never used" },
  { id: "like_new", label: "Like new", hint: "Used a few times" },
  { id: "used_good", label: "Used – good", hint: "Works fully" },
  { id: "used_fair", label: "Used – fair", hint: "Works, visible wear" },
  { id: "for_parts", label: "For parts / not working", hint: "Say what is wrong" },
];

export const KINDS: { id: SellerKind; label: string }[] = [
  { id: "supplier", label: "Supplier / wholesaler" },
  { id: "clinic", label: "Clinic selling items" },
  { id: "individual", label: "Individual" },
];

export const conditionLabel = (c: Condition) => CONDITIONS.find((x) => x.id === c)?.label ?? c;
export const kindLabel = (k: SellerKind) => ({ supplier: "Supplier", clinic: "Clinic", individual: "Individual" })[k];

export interface SellerBrief {
  id: string;
  kind: SellerKind;
  name: string;
  city: string;
  subcity?: string;
  about?: string;
  slug: string;
  channels?: Channel[];
}

export interface Listing {
  id: string;
  title: string;
  brand?: string;
  category: string;
  description?: string;
  condition: Condition;
  price_etb?: number;
  negotiable: boolean;
  quantity?: number;
  expiry?: string;
  warranty?: string;
  photos: string[];
  photo_keys?: string[];
  status: "active" | "sold" | "hidden";
  created_at: string;
  seller?: SellerBrief;
}

export interface Seller {
  id: string;
  kind: SellerKind;
  name: string;
  phone: string;
  telegram?: string;
  city: string;
  subcity?: string;
  about?: string;
  slug: string;
  slug_changed: boolean;
  status: SellerStatus;
  status_note?: string;
  created_at: string;
  approved_at?: string;
  listings: number;
}

export interface Session { token: string; seller: Seller }
export interface ListingPage { items: Listing[]; total: number }
export interface ContactLink { channel: Channel; href: string; phone?: string }
export interface SellerStats { listings: number; active: number; contacts_30d: number; visits_30d: number }
export interface Store { seller: SellerBrief; total: number; categories: { category: string; count: number }[] }

export interface ListingInput {
  title: string;
  brand: string;
  category: string;
  description: string;
  condition: Condition | "";
  price_etb: number | null;
  negotiable: boolean;
  quantity: number | null;
  expiry: string;
  warranty: string;
  photos: string[];
  status: "active" | "sold" | "hidden";
}

export interface SignupInput {
  kind: SellerKind;
  name: string;
  phone: string;
  telegram: string;
  city: string;
  subcity: string;
  about: string;
  password: string;
  website: string;
}

// ---- the seller's own session ------------------------------------------------
// Kept apart from the clinic login: a seller is not clinic staff and must never
// pick up a clinic's token, or the other way round.
const KEY = "clinicos_mp_token";
export const sellerToken = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (t: string) => { try { localStorage.setItem(KEY, t); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(KEY); } catch { /* private mode */ } },
};
const mine = () => ({ auth: false as const, headers: { "X-Marketplace-Token": sellerToken.get() ?? "" } });
const pub = { auth: false as const };

// ---- public ------------------------------------------------------------------
export interface Filters { q?: string; category?: string; condition?: string; city?: string; seller?: string; offset?: number }

export function browse(f: Filters) {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.category) p.set("category", f.category);
  if (f.condition) p.set("condition", f.condition);
  if (f.city) p.set("city", f.city);
  if (f.seller) p.set("seller", f.seller);
  if (f.offset) p.set("offset", String(f.offset));
  return apiFetch<ListingPage>(`/marketplace/listings?${p}`, pub);
}
export const getStore = (slug: string) => apiFetch<Store>(`/marketplace/stores/${encodeURIComponent(slug)}`, pub);
export const getListing = (id: string) => apiFetch<Listing>(`/marketplace/listings/${id}`, pub);
export const contactSeller = (id: string, channel: Channel) =>
  apiFetch<ContactLink>(`/marketplace/listings/${id}/contact`, { ...pub, method: "POST", body: { channel } });

// ---- seller ------------------------------------------------------------------
export const signUp = (b: SignupInput) => apiFetch<Session>("/marketplace/sellers/signup", { ...pub, method: "POST", body: b });
export const login = (phone: string, password: string) =>
  apiFetch<Session>("/marketplace/sellers/login", { ...pub, method: "POST", body: { phone, password } });
export const getMe = () => apiFetch<Seller>("/marketplace/me", mine());
export const updateMe = (b: Partial<SignupInput>) => apiFetch<Seller>("/marketplace/me", { ...mine(), method: "PUT", body: b });
export const changeSlug = (slug: string) => apiFetch<Seller>("/marketplace/my/slug", { ...mine(), method: "PUT", body: { slug } });
export const myStats = () => apiFetch<SellerStats>("/marketplace/my/stats", mine());
export const myListings = () => apiFetch<Listing[]>("/marketplace/my/listings", mine());
export const saveListing = (id: string | null, b: ListingInput) =>
  apiFetch<Listing>(id ? `/marketplace/my/listings/${id}` : "/marketplace/my/listings", { ...mine(), method: id ? "PUT" : "POST", body: b });
export const deleteListing = (id: string) => apiFetch<void>(`/marketplace/my/listings/${id}`, { ...mine(), method: "DELETE" });

interface UploadTarget { method: string; url: string; fields?: Record<string, string>; key: string }

/** Compress, sign, upload straight to storage; returns the key to save on the listing. */
export async function uploadPhoto(file: File): Promise<string> {
  const small = await compressImage(file, { maxEdge: 1400, quality: 0.8 });
  const target = await apiFetch<UploadTarget>("/marketplace/my/photos/sign", { ...mine(), method: "POST" });
  if ((target.method || "POST").toUpperCase() === "PUT") {
    const res = await sendFile(target.url, { method: "PUT", body: small, headers: { "Content-Type": small.type } });
    if (!res.ok) throw new Error("Upload failed");
  } else {
    const fd = new FormData();
    Object.entries(target.fields ?? {}).forEach(([k, v]) => fd.append(k, v));
    fd.append("file", small);
    const res = await sendFile(target.url, { method: "POST", body: fd });
    if (!res.ok) throw new Error("Upload failed");
  }
  return target.key;
}

export const money = (n?: number | null) => (n == null ? null : `ETB ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

/** The full public address of a store, for copying and sharing. */
export const storeUrl = (slug: string) => `${window.location.origin}/marketplace/s/${slug}`;
