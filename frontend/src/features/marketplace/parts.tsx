import { Link, Outlet } from "react-router-dom";
import { Store } from "lucide-react";

import { conditionLabel, kindLabel, money, type Condition, type Listing, type SellerKind } from "@/features/marketplace/api";

/** The public shell: no clinic sidebar, no login — a dentist opening this from a
 *  link has no account and should not need one to look. */
export function MarketLayout() {
  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <header className="sticky top-0 z-20 border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/marketplace" className="flex items-center gap-2 font-semibold">
            <Store className="h-5 w-5 text-primary" />
            <span>ClinicOS Marketplace</span>
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            <Link to="/marketplace" className="rounded-md px-3 py-1.5 hover:bg-accent">Browse</Link>
            <Link to="/marketplace/sell" className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground hover:bg-primary/90">Sell</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted-foreground">
        ClinicOS connects buyers and sellers. It does not inspect goods or handle payment — check the
        condition and expiry before you pay.
      </footer>
    </div>
  );
}

const TONE: Record<Condition, string> = {
  new: "bg-emerald-100 text-emerald-800",
  like_new: "bg-orange-100 text-orange-800",
  used_good: "bg-orange-100 text-orange-800",
  used_fair: "bg-orange-100 text-orange-800",
  for_parts: "bg-red-100 text-red-800",
};

/** Condition is the one fact a buyer must never miss, so it is a coloured tag, not a field. */
export function ConditionTag({ c }: { c: Condition }) {
  return <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold ${TONE[c]}`}>{conditionLabel(c)}</span>;
}

export function KindTag({ k }: { k: SellerKind }) {
  const tone = k === "clinic" ? "bg-teal-100 text-teal-800" : k === "supplier" ? "bg-indigo-100 text-indigo-800" : "bg-zinc-100 text-zinc-700";
  return <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold ${tone}`}>{kindLabel(k)}</span>;
}

export function PriceLine({ l }: { l: Pick<Listing, "price_etb" | "negotiable"> }) {
  const p = money(l.price_etb);
  return (
    <span className="font-semibold">
      {p ?? "Ask for price"}
      {p && l.negotiable && <span className="ml-1 text-xs font-normal text-muted-foreground">· negotiable</span>}
    </span>
  );
}

export function Photo({ src, alt, className = "" }: { src?: string; alt: string; className?: string }) {
  if (!src) {
    return <div className={`flex items-center justify-center bg-muted text-xs text-muted-foreground ${className}`}>No photo</div>;
  }
  return <img src={src} alt={alt} loading="lazy" className={`object-cover ${className}`} />;
}

export function ListingCard({ l }: { l: Listing }) {
  return (
    <Link to={`/marketplace/listing/${l.id}`} className="block overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md">
      <Photo src={l.photos[0]} alt={l.title} className="h-36 w-full" />
      <div className="space-y-1 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <ConditionTag c={l.condition} />
          {l.seller && <KindTag k={l.seller.kind} />}
        </div>
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{l.title}</h3>
        <p className="text-xs text-muted-foreground">
          {[l.brand, l.category, l.seller?.city].filter(Boolean).join(" · ")}
        </p>
        <p className="text-sm"><PriceLine l={l} /></p>
      </div>
    </Link>
  );
}
