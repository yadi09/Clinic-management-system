import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { browse, CATEGORIES, type Listing, type Store } from "@/features/marketplace/api";
import { ListingCard } from "@/features/marketplace/parts";

const CONDITION_FILTERS = [
  { id: "", label: "Any condition" },
  { id: "new", label: "Brand new" },
  { id: "used", label: "Used" },
];

const chip = (on: boolean) =>
  "whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors " +
  (on ? "border-primary bg-primary/10 font-semibold text-primary" : "bg-card hover:bg-accent");

/** The marketplace home — and, with `store` set, one seller's storefront: the same
 *  search and filters, limited to that seller's products. */
export function MarketHomePage({ store }: { store?: Store } = {}) {
  const seller = store?.seller.slug;
  const categories = store ? store.categories.map((c) => c.category) : CATEGORIES;
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState("");
  const [city, setCity] = useState("");
  const [extra, setExtra] = useState<Listing[]>([]);

  // Search as they type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => { setExtra([]); }, [q, category, condition, city]);

  const key = ["market", seller ?? "", q, category, condition, city];
  const res = useQuery({ queryKey: key, queryFn: () => browse({ q, category, condition, city, seller }) });
  const more = useQuery({
    queryKey: [...key, "more", extra.length],
    queryFn: async () => {
      const r = await browse({ q, category, condition, city, seller, offset: (res.data?.items.length ?? 0) + extra.length });
      setExtra((e) => [...e, ...r.items]);
      return r;
    },
    enabled: false,
  });

  const items = [...(res.data?.items ?? []), ...extra];
  const total = res.data?.total ?? 0;

  return (
    <div className="space-y-4">
      {!store && (
        <div>
          <h1 className="text-2xl font-bold">Dental supplies from sellers near you</h1>
          <p className="text-sm text-muted-foreground">Search for a product, see who sells it, and call them.</p>
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={store ? `Search ${store.seller.name}'s products` : "Search products — composite, autoclave, apex locator…"}
          className="h-12 pl-9 text-base"
          aria-label="Search products"
        />
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        <button className={chip(category === "")} onClick={() => setCategory("")}>All</button>
        {categories.map((c) => (
          <button key={c} className={chip(category === c)} onClick={() => setCategory(category === c ? "" : c)}>{c}</button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CONDITION_FILTERS.map((f) => (
          <button key={f.id} className={chip(condition === f.id)} onClick={() => setCondition(f.id)}>{f.label}</button>
        ))}
        {!store && <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" className="h-9 w-32" aria-label="City" />}
      </div>

      {res.isLoading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-60 w-full" />)}
        </div>
      ) : res.isError ? (
        <p className="rounded-lg border bg-card p-6 text-center text-sm text-destructive">Could not load the marketplace. Check your connection and try again.</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="font-semibold">{q || category || condition || city ? "Nothing matches yet" : "No products listed yet"}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {q ? `No seller has listed “${q}”. We note what people look for so we can bring sellers in.` : "Be the first to list a product."}
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{total} {total === 1 ? "product" : "products"}</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {items.map((l) => <ListingCard key={l.id} l={l} />)}
          </div>
          {items.length < total && (
            <div className="text-center">
              <Button variant="outline" loading={more.isFetching} onClick={() => more.refetch()}>Show more</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
