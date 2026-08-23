// How the money arrived — asked the same way everywhere it is asked.
//
// Three surfaces take payment (reception, the cashier, the pharmacy counter) and each
// carried its own copy of the same four words: cash, card, mobile, transfer. Two of
// those are not payment methods but categories. "Mobile" is Telebirr or M-Pesa or CBE
// Birr, and a clinic cannot hold "Mobile — 4,200 ETB" against any statement, because
// no bank issues a statement called Mobile.
//
// A rail is one real way THIS clinic is paid, configured in Settings. When it is a
// transfer or a wallet, the desk records the transaction reference — the evidence
// that used to be discarded, which is what makes a disputed payment answerable and a
// day's takings reconcilable. It is also, later, what a receipt-verification service
// checks.
import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listPaymentRails, type PaymentRail } from "@/features/admin/api";

export type { PaymentRail };

/** What the desk collected: which rail, and the reference if it has one. */
export interface PaymentChoice {
  railId: string;
  /** Legacy free-text value, still sent so an unconfigured clinic keeps working. */
  method: string;
  reference: string;
}

export const EMPTY_PAYMENT: PaymentChoice = { railId: "", method: "cash", reference: "" };

export function usePaymentRails() {
  return useQuery({ queryKey: ["payment-rails"], queryFn: () => listPaymentRails() });
}

/** Does this choice still need something before it can be submitted? */
export function paymentIncomplete(rails: PaymentRail[] | undefined, choice: PaymentChoice): boolean {
  const rail = rails?.find((r) => r.id === choice.railId);
  return !!rail?.needs_reference && choice.reference.trim() === "";
}

export function PaymentRailPicker({ rails, value, onChange, disabled, compact }: {
  rails: PaymentRail[] | undefined;
  value: PaymentChoice;
  onChange: (v: PaymentChoice) => void;
  disabled?: boolean;
  /** Tighter spacing for the reception rail, where the panel is narrow. */
  compact?: boolean;
}) {
  const list = rails ?? [];
  const rail = list.find((r) => r.id === value.railId);
  // Cash has nothing to reference; a card machine's slip is not a transaction we can
  // look up. Only a wallet or a bank transfer carries one.
  const takesReference = rail ? rail.kind === "wallet" || rail.kind === "bank" : false;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <Select
        value={value.railId}
        disabled={disabled || list.length === 0}
        onValueChange={(id) => {
          const r = list.find((x) => x.id === id);
          onChange({ railId: id, method: r?.key ?? value.method, reference: "" });
        }}
      >
        <SelectTrigger aria-label="Payment method"><SelectValue placeholder="How are they paying?" /></SelectTrigger>
        <SelectContent>
          {list.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.label}
              {r.account_number && <span className="ml-1.5 text-xs text-muted-foreground">{r.account_number}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {takesReference && (
        <div className="space-y-1">
          <Label htmlFor="pay-ref" className="text-xs text-muted-foreground">
            Transaction reference{rail?.needs_reference ? "" : " (optional)"}
          </Label>
          <Input
            id="pay-ref"
            value={value.reference}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, reference: e.target.value })}
            placeholder={rail?.bank_key === "telebirr" ? "e.g. CH7K2M9QRS" : "From the patient's SMS or receipt"}
            autoComplete="off"
            spellCheck={false}
          />
          {/* Said once, here, rather than discovered when the reference is refused. */}
          <p className="text-[11px] text-muted-foreground">
            Recorded on the receipt. The same reference cannot pay twice.
          </p>
        </div>
      )}
    </div>
  );
}
