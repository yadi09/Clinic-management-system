import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, EyeOff, Eye, Pause, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { conditionLabel, kindLabel, money, type Seller, type SellerStatus } from "@/features/marketplace/api";
import {
  marketListings, marketSellers, marketStats, setListingStatus, setSellerStatus,
} from "@/features/platform/marketplace";

const box = "rounded-lg border border-zinc-800 bg-zinc-900/40 p-4";
const pill = (on: boolean) =>
  "rounded-md px-3 py-1.5 text-sm " + (on ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200");

const STATUS_TONE: Record<SellerStatus, string> = {
  pending: "bg-amber-500/20 text-amber-300",
  approved: "bg-emerald-500/20 text-emerald-300",
  rejected: "bg-red-500/20 text-red-300",
  suspended: "bg-red-500/20 text-red-300",
};

/** The vendor's side of the marketplace: phone each new seller, then approve them here. */
export function MarketplaceAdmin() {
  const qc = useQueryClient();
  const { ask, dialog } = useConfirmDialog();
  const [view, setView] = useState<"pending" | "all" | "listings">("pending");
  const stats = useQuery({ queryKey: ["mp-admin", "stats"], queryFn: marketStats });
  const sellers = useQuery({ queryKey: ["mp-admin", "sellers", view], queryFn: () => marketSellers(view === "pending" ? "pending" : ""), enabled: view !== "listings" });
  const listings = useQuery({ queryKey: ["mp-admin", "listings"], queryFn: marketListings, enabled: view === "listings" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["mp-admin"] });

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: SellerStatus; note?: string }) => setSellerStatus(v.id, v.status, v.note),
    onSuccess: () => { toast.success("Saved"); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });
  const setListing = useMutation({
    mutationFn: (v: { id: string; status: "active" | "hidden" }) => setListingStatus(v.id, v.status),
    onSuccess: () => { toast.success("Saved"); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save"),
  });

  const st = stats.data;
  return (
    <div className="space-y-4">
      {dialog}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ["Waiting for your call", st?.pending_sellers],
          ["Approved sellers", st?.approved_sellers],
          ["Live listings", st?.active_listings],
          ["Contacts (30 days)", st?.contacts_30d],
        ].map(([k, v]) => (
          <div key={String(k)} className={box}>
            <p className="text-xs text-zinc-400">{k}</p>
            <p className="text-2xl font-bold tabular-nums">{v ?? "–"}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-1">
        <button className={pill(view === "pending")} onClick={() => setView("pending")}>Pending{st?.pending_sellers ? ` (${st.pending_sellers})` : ""}</button>
        <button className={pill(view === "all")} onClick={() => setView("all")}>All sellers</button>
        <button className={pill(view === "listings")} onClick={() => setView("listings")}>Listings</button>
      </div>

      {view !== "listings" && (
        sellers.isLoading ? <Skeleton className="h-32 w-full" /> :
        (sellers.data ?? []).length === 0 ? <p className="text-sm text-zinc-500">{view === "pending" ? "Nobody is waiting." : "No sellers yet."}</p> :
        <div className="space-y-2">
          {(sellers.data ?? []).map((s: Seller) => (
            <div key={s.id} className={`${box} flex flex-wrap items-center justify-between gap-3`}>
              <div className="min-w-0">
                <p className="font-semibold">{s.name} <span className="ml-1 text-xs font-normal text-zinc-400">{kindLabel(s.kind)}</span></p>
                <p className="text-sm text-zinc-300">
                  <a href={`tel:${s.phone}`} className="underline">{s.phone}</a>
                  {s.telegram && <> · @{s.telegram}</>} · {[s.subcity, s.city].filter(Boolean).join(", ")}
                </p>
                {s.about && <p className="text-sm text-zinc-400">{s.about}</p>}
                <p className="text-xs text-zinc-500">{s.listings} listing{s.listings === 1 ? "" : "s"} · applied {new Date(s.created_at).toLocaleDateString()}{s.status_note ? ` · ${s.status_note}` : ""}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${STATUS_TONE[s.status]}`}>{s.status}</span>
                {s.status !== "approved" && (
                  <Button size="sm" onClick={() => setStatus.mutate({ id: s.id, status: "approved" })}><Check /> Approve</Button>
                )}
                {s.status === "pending" && (
                  <Button size="sm" variant="outline" onClick={() => ask({ title: `Reject ${s.name}?`, reason: { label: "Reason (shown to the seller)", required: true }, confirmLabel: "Reject", destructive: true }, (why) => setStatus.mutate({ id: s.id, status: "rejected", note: why }))}><X /> Reject</Button>
                )}
                {s.status === "approved" && (
                  <Button size="sm" variant="outline" onClick={() => ask({ title: `Suspend ${s.name}?`, description: "Their listings disappear and they are signed out.", reason: { label: "Reason", required: true }, confirmLabel: "Suspend", destructive: true }, (why) => setStatus.mutate({ id: s.id, status: "suspended", note: why }))}><Pause /> Suspend</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === "listings" && (
        listings.isLoading ? <Skeleton className="h-32 w-full" /> :
        <div className="space-y-2">
          {(listings.data ?? []).map((l) => (
            <div key={l.id} className={`${box} flex flex-wrap items-center justify-between gap-3`}>
              <div className="min-w-0">
                <p className="font-semibold">{l.title}</p>
                <p className="text-sm text-zinc-400">{conditionLabel(l.condition)} · {money(l.price_etb) ?? "ask for price"} · {l.seller?.name} · {l.status}</p>
              </div>
              {l.status === "hidden"
                ? <Button size="sm" variant="outline" onClick={() => setListing.mutate({ id: l.id, status: "active" })}><Eye /> Restore</Button>
                : <Button size="sm" variant="outline" onClick={() => setListing.mutate({ id: l.id, status: "hidden" })}><EyeOff /> Take down</Button>}
            </div>
          ))}
          {(listings.data ?? []).length === 0 && <p className="text-sm text-zinc-500">No listings yet.</p>}
        </div>
      )}

      <div className={box}>
        <p className="font-semibold">Searches that found nothing (30 days)</p>
        <p className="mb-2 text-xs text-zinc-400">What people look for and cannot find — the suppliers to recruit.</p>
        {(st?.empty_searches ?? []).length === 0 ? <p className="text-sm text-zinc-500">None yet.</p> : (
          <ul className="flex flex-wrap gap-2">
            {st?.empty_searches.map((t) => <li key={t.term} className="rounded-full bg-zinc-800 px-3 py-1 text-sm">{t.term} <span className="text-zinc-400">×{t.count}</span></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
