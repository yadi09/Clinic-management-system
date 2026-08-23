import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { searchDrugs, sellOtc, type Drug } from "@/features/pharmacy/api";
import { EMPTY_PAYMENT, PaymentRailPicker, usePaymentRails, type PaymentChoice } from "@/features/billing/PaymentRail";

interface CartLine {
  drug: Drug;
  qty: number;
}

export function OtcSalePage() {
  const [term, setTerm] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState(0);
  const [tax, setTax] = useState(0);
  const rails = usePaymentRails();
  const [pay, setPay] = useState<PaymentChoice>(EMPTY_PAYMENT);
  useEffect(() => {
    const first = rails.data?.[0];
    if (first && !pay.railId) setPay({ railId: first.id, method: first.key, reference: "" });
  }, [rails.data, pay.railId]);

  const results = useQuery({ queryKey: ["otc-search", term], queryFn: () => searchDrugs(term), enabled: term.trim().length > 0 });

  const add = (d: Drug) => {
    setCart((c) => {
      const ex = c.find((l) => l.drug.id === d.id);
      if (ex) return c.map((l) => (l.drug.id === d.id ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { drug: d, qty: 1 }];
    });
    setTerm("");
  };
  const subtotal = cart.reduce((s, l) => s + Number(l.drug.unit_price) * l.qty, 0);
  const total = Math.max(0, subtotal - discount + tax);

  const sell = useMutation({
    mutationFn: () => sellOtc({ discount, tax, payment_method: pay.method, rail_id: pay.railId || undefined, reference: pay.reference, lines: cart.map((l) => ({ drug_id: l.drug.id, qty: l.qty })) }),
    onSuccess: () => {
      toast.success("Sale completed — stock decremented");
      setCart([]);
      setDiscount(0);
      setTax(0);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not complete the sale"),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>OTC sale</h1>
          <p className="text-sm text-muted-foreground">Counter sale</p>
        </div>
        <Button className="bg-primary" disabled={cart.length === 0} loading={sell.isPending} onClick={() => sell.mutate()}>
          Take payment
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="p-4">
          <h2 className="mb-2 text-h3">Add items</h2>
          <div className="relative">
            <Input placeholder="Search products…" value={term} onChange={(e) => setTerm(e.target.value)} />
            {term.trim() && (results.data?.length ?? 0) > 0 && (
              <div className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-background shadow-md">
                {(results.data ?? []).map((d) => (
                  <button key={d.id} onClick={() => add(d)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted">
                    <span>{d.name}</span>
                    <span className="text-xs text-muted-foreground">{d.unit_price}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-4 divide-y rounded-md border">
            {cart.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No items.</p>
            ) : (
              cart.map((l) => (
                <div key={l.drug.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span className="min-w-0 flex-1">{l.drug.name}</span>
                  <Input
                    type="number"
                    min={1}
                    className="w-16"
                    value={l.qty}
                    onChange={(e) => setCart((c) => c.map((x) => (x.drug.id === l.drug.id ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x)))}
                  />
                  <span className="w-16 text-right">{l.drug.unit_price}</span>
                  <span className="w-20 text-right font-medium">{(Number(l.drug.unit_price) * l.qty).toFixed(2)}</span>
                  <button onClick={() => setCart((c) => c.filter((x) => x.drug.id !== l.drug.id))} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="h-fit p-4">
          <h2 className="mb-3 text-h3">Summary</h2>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{subtotal.toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-muted-foreground">Discount</span>
            <Input type="number" className="w-24" value={discount} onChange={(e) => setDiscount(Math.max(0, Number(e.target.value)))} />
          </div>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-muted-foreground">Tax</span>
            <Input type="number" className="w-24" value={tax} onChange={(e) => setTax(Math.max(0, Number(e.target.value)))} />
          </div>
          <div className="mt-2 flex items-center justify-between border-t pt-2 font-semibold text-brand">
            <span>Total</span>
            <span>{total.toFixed(2)} ETB</span>
          </div>
          {/* The same picker the cashier and reception use. This counter had its own
              hand-rolled list whose third option was "Gateway", which is not a thing
              the clinic has. */}
          <div className="mt-4 space-y-1.5">
            <Label>Payment</Label>
            <PaymentRailPicker rails={rails.data} value={pay} onChange={setPay} compact />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Linked to: Walk-in</p>
        </Card>
      </div>
    </div>
  );
}
