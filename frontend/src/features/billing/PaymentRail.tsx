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
import { Link } from "react-router-dom";
import { Settings2 } from "lucide-react";

import { useAuth } from "@/app/auth-context";
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

/** What the reference looks like, per provider, so nobody has to guess what to copy. */
const REF_HINT: Record<string, string> = {
  telebirr: "e.g. CH7K2M9QRS — the transaction number in the Telebirr SMS",
  mpesa: "The M-Pesa receipt number, or paste the whole SMS",
  cbebirr: "The receipt number in the CBE Birr SMS",
  kaafiebirr: "The transaction number on the receipt",
  cbe: "e.g. FT25123ABCD — the reference on the CBE receipt",
  boa: "The reference on the Abyssinia transfer receipt",
  dashen: "The reference on the Dashen transfer receipt",
  awash: "The reference on the Awash transfer receipt",
  siinqee: "The reference on the Siinqee transfer receipt",
};

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
  const { can } = useAuth();
  const list = rails ?? [];
  const rail = list.find((r) => r.id === value.railId);
  // A wallet or bank rail with no provider is one of the four generic methods every
  // clinic starts with. It takes money fine, but "Mobile money" names no account, so
  // the reference cannot be tied to anything or checked later. Say so here, where the
  // person is standing, rather than leaving the improvement to be discovered.
  const unnamed = !!rail && (rail.kind === "wallet" || rail.kind === "bank") && !rail.bank_key;
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

      {unnamed && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
          This is a generic method — it does not say which wallet or account the money went to.
          {can("clinic.manage") ? (
            <Link to="/settings?section=payments" className="ml-1 inline-flex items-center gap-1 font-semibold underline">
              <Settings2 className="h-3 w-3" /> Name your accounts
            </Link>
          ) : (
            <span className="ml-1">Ask an administrator to add your clinic's accounts.</span>
          )}
        </p>
      )}

      {takesReference && (
        <div className="space-y-1">
          <Label htmlFor="pay-ref" className="text-xs text-muted-foreground">
            Transaction reference
            {!rail?.needs_reference && <span className="ml-1 font-normal">— optional, but it is the only proof of this payment</span>}
          </Label>
          <Input
            id="pay-ref"
            value={value.reference}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, reference: e.target.value })}
            placeholder={REF_HINT[rail?.bank_key ?? ""] ?? "The transaction number on the patient's SMS"}
            autoComplete="off"
            spellCheck={false}
          />
          {/* What it is FOR, in the order it matters: it goes on the receipt, it stops
              a second bill being paid with the same transfer, and it is what a bank
              check will later be run against. */}
          <p className="text-[11px] text-muted-foreground">
            Goes on the receipt and cannot be used to pay twice — copy it from the patient's
            payment SMS.
          </p>
        </div>
      )}
    </div>
  );
}
