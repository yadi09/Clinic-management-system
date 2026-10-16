// Marketplace console calls (vendor side). Same self-contained platform token as the
// rest of the console.
import type { Listing, Seller, SellerStatus } from "@/features/marketplace/api";
import { platformToken } from "@/features/platform/api";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = platformToken.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${BASE}/platform/marketplace${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `Request failed (${res.status})`);
  return (json.data ?? json) as T;
}

export interface MarketStats {
  pending_sellers: number;
  approved_sellers: number;
  active_listings: number;
  contacts_30d: number;
  empty_searches: { term: string; count: number }[];
}

export const marketStats = () => call<MarketStats>("/stats");
export const marketSellers = (status = "") => call<Seller[]>(`/sellers${status ? `?status=${status}` : ""}`);
export const setSellerStatus = (id: string, status: SellerStatus, note = "") =>
  call<void>(`/sellers/${id}/status`, "POST", { status, note });
export const marketListings = () => call<Listing[]>("/listings");
export const setListingStatus = (id: string, status: "active" | "hidden") =>
  call<void>(`/listings/${id}/status`, "POST", { status });
