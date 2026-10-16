import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, MapPin, Phone, Send, MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { conditionLabel, contactSeller, getListing, type Channel } from "@/features/marketplace/api";
import { ConditionTag, KindTag, Photo, PriceLine } from "@/features/marketplace/parts";

const CHANNELS: { id: Channel; label: string; icon: typeof Phone }[] = [
  { id: "call", label: "Call", icon: Phone },
  { id: "telegram", label: "Telegram", icon: Send },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
];

export function MarketListingPage() {
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["market-listing", id], queryFn: () => getListing(id), retry: false });
  const [shown, setShown] = useState<Partial<Record<Channel, string>>>({});
  const [photo, setPhoto] = useState(0);

  // The number is only given out by tapping, so every lead is counted.
  const contact = useMutation({
    mutationFn: (c: Channel) => contactSeller(id, c),
    onSuccess: (r) => {
      setShown((s) => ({ ...s, [r.channel]: r.phone ?? r.href }));
      window.open(r.href, r.channel === "call" ? "_self" : "_blank", "noopener");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not open the contact"),
  });

  if (q.isLoading) return <Skeleton className="h-80 w-full" />;
  if (q.isError || !q.data) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="font-semibold">This listing is no longer available</p>
        <Link to="/marketplace" className="mt-2 inline-block text-sm text-primary underline">Back to the marketplace</Link>
      </div>
    );
  }
  const l = q.data;
  const s = l.seller;
  const facts: [string, string | undefined][] = [
    ["Condition", conditionLabel(l.condition)],
    ["Category", l.category],
    ["Brand", l.brand],
    ["Available", l.quantity != null ? String(l.quantity) : undefined],
    ["Expiry", l.expiry],
    ["Warranty", l.warranty],
  ];

  return (
    <div className="space-y-4">
      <Link to="/marketplace" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All products
      </Link>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <Photo src={l.photos[photo]} alt={l.title} className="h-72 w-full rounded-xl md:h-96" />
          {l.photos.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {l.photos.map((p, i) => (
                <button key={p} onClick={() => setPhoto(i)} className={`shrink-0 overflow-hidden rounded-lg border-2 ${i === photo ? "border-primary" : "border-transparent"}`}>
                  <Photo src={p} alt="" className="h-16 w-16" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5"><ConditionTag c={l.condition} />{s && <KindTag k={s.kind} />}</div>
          <h1 className="text-2xl font-bold leading-tight">{l.title}</h1>
          <p className="text-lg"><PriceLine l={l} /></p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {facts.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
          {l.description && <p className="whitespace-pre-line text-sm">{l.description}</p>}
        </div>
      </div>

      {s && (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="font-semibold">{s.name}</h2>
          <p className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" /> {[s.subcity, s.city].filter(Boolean).join(", ")}
          </p>
          {s.about && <p className="mt-2 text-sm">{s.about}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {CHANNELS.filter((c) => s.channels?.includes(c.id)).map((c) => (
              <Button key={c.id} variant={c.id === "call" ? "default" : "outline"} loading={contact.isPending && contact.variables === c.id} onClick={() => contact.mutate(c.id)}>
                <c.icon /> {shown[c.id] && c.id === "call" ? shown[c.id] : c.label}
              </Button>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tell the seller you found this on ClinicOS. Check the condition{l.expiry ? " and expiry" : ""} before you pay.
          </p>
        </section>
      )}
    </div>
  );
}
