import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MapPin, MessageCircle, Phone, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { browse, contactSeller, getStore, type Channel } from "@/features/marketplace/api";
import { MarketHomePage } from "@/features/marketplace/MarketHomePage";
import { KindTag } from "@/features/marketplace/parts";

const CHANNELS: { id: Channel; label: string; icon: typeof Phone }[] = [
  { id: "call", label: "Call", icon: Phone },
  { id: "telegram", label: "Telegram", icon: Send },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
];

/** /marketplace/s/:slug — one seller's store, the page they send to their own clients. */
export function MarketStorePage() {
  const { slug = "" } = useParams();
  const q = useQuery({ queryKey: ["market-store", slug], queryFn: () => getStore(slug), retry: false });

  if (q.isLoading) return <Skeleton className="h-60 w-full" />;
  if (q.isError || !q.data) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="font-semibold">This store is not available</p>
        <Link to="/marketplace" className="mt-2 inline-block text-sm text-primary underline">Browse the marketplace</Link>
      </div>
    );
  }
  const st = q.data;
  const s = st.seller;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{s.name}</h1>
          <KindTag k={s.kind} />
        </div>
        <p className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
          <MapPin className="h-3.5 w-3.5" /> {[s.subcity, s.city].filter(Boolean).join(", ")} · {st.total} {st.total === 1 ? "product" : "products"}
        </p>
        {s.about && <p className="mt-2 text-sm">{s.about}</p>}
        <StoreContact slug={s.slug} channels={s.channels ?? []} />
      </section>
      <MarketHomePage store={st} />
      <p className="text-center text-xs text-muted-foreground">
        Listed on <Link to="/marketplace" className="underline">ClinicOS Marketplace</Link> — see all sellers →
      </p>
    </div>
  );
}

/** A store has no single product to attach a tap to, so the contact goes through the
 *  seller's newest product — the tap is still counted for the right seller. */
function StoreContact({ slug, channels }: { slug: string; channels: Channel[] }) {
  const { data } = useQuery({ queryKey: ["market-store-first", slug], queryFn: () => browse({ seller: slug }) });
  const first = data?.items[0]?.id;
  const contact = useMutation({
    mutationFn: (c: Channel) => contactSeller(first!, c),
    onSuccess: (r) => window.open(r.href, r.channel === "call" ? "_self" : "_blank", "noopener"),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not open the contact"),
  });
  if (!first) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {CHANNELS.filter((c) => channels.includes(c.id)).map((c) => (
        <Button key={c.id} variant={c.id === "call" ? "default" : "outline"} loading={contact.isPending && contact.variables === c.id} onClick={() => contact.mutate(c.id)}>
          <c.icon /> {c.label}
        </Button>
      ))}
    </div>
  );
}
