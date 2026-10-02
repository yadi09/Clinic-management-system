// What needs doing, loudest first, each with the one button that does it.
//
// Three at most: a list of nine is a list nobody reads. An empty list is worth as
// much as a full one — it is the difference between a clinic that has checked and one
// that has not looked — but it must never stand in for a failed load, which is the
// page's job to show (an error said "Nothing needs you" once; see LoadError).
import { useState } from "react";
import { Link } from "react-router-dom";
import { CalendarX2, CheckCircle2, Clock, Coins, Send, TriangleAlert, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DashAlert } from "../api";
import { etb, num } from "../format";
import type { DashLinks } from "../links";

const ICON: Record<string, typeof Send> = {
  unbilled: Send, overdue: Coins, shift_variance: Wallet, long_wait: Clock,
  no_show: CalendarX2, missed_visit: CalendarX2,
};

const SHOWN = 3;

export function NeedsYou({ items, links, canSeeMoney }: { items: DashAlert[]; links: DashLinks; canSeeMoney: boolean }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl bg-primary/10 px-4 py-3 text-sm font-medium text-primary">
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        {canSeeMoney
          ? "Nothing needs you right now. Every treated visit is billed and nobody has owed for long."
          : "Nothing needs you right now."}
      </div>
    );
  }
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <section aria-labelledby="needs-you" className="space-y-2.5">
      <h2 id="needs-you" className="text-[15px] font-semibold text-foreground">Needs you</h2>
      <div className={cn("grid grid-cols-1 gap-2.5", shown.length >= 3 && "lg:grid-cols-3")}>
        {shown.map((a, i) => <Need key={`${a.kind}-${i}`} a={a} links={links} stacked={shown.length >= 3} />)}
      </div>
      {items.length > SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)}
          className="text-sm font-medium text-primary hover:underline">
          {all ? "Show fewer" : `${items.length - SHOWN} more`}
        </button>
      )}
    </section>
  );
}

function Need({ a, links, stacked }: { a: DashAlert; links: DashLinks; stacked: boolean }) {
  const Icon = ICON[a.kind] ?? TriangleAlert;
  const href = links.alert(a.href);
  const patientHref = a.patient_id ? links.patient(a.patient_id) : undefined;
  const danger = a.tone === "danger";
  return (
    // The words take the whole width first and the amount and button sit under them,
    // except on a wide single row where there is room beside. Side by side on a phone,
    // the words were squeezed into a column one word wide.
    <div className={cn(
      "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5 rounded-xl border border-l-4 bg-card p-3.5 shadow-sm",
      danger ? "border-l-destructive" : "border-l-warning",
    )}>
      <div className={cn("flex min-w-0 basis-full items-start gap-3", !stacked && "sm:basis-0 sm:flex-1")}>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          danger ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning")}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-semibold leading-snug">
            {patientHref ? <NameLink text={a.text} href={patientHref} /> : a.text}
          </p>
          {a.detail && <p className="mt-0.5 text-[13px] text-muted-foreground">{a.detail}</p>}
        </div>
      </div>
      <div className={cn("ml-12 flex min-w-0 flex-1 items-center justify-end gap-3", stacked ? "self-end" : "sm:ml-0 sm:flex-none")}>
        {a.amount && num(a.amount) > 0 && (
          <span className="mr-auto whitespace-nowrap font-bold tabular-nums">{etb(a.amount)}</span>
        )}
        {href && (
          <Button asChild size="sm" variant="outline" className="touch-hit shrink-0">
            <Link to={href}>{a.action || "Open"}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/** "Almaz Haile has waited 24 minutes": the name opens the patient. */
function NameLink({ text, href }: { text: string; href: string }) {
  const at = text.indexOf(" has ");
  if (at <= 0) return <>{text}</>;
  return (
    <>
      <Link to={href} className="underline decoration-border underline-offset-4 hover:decoration-current">
        {text.slice(0, at)}
      </Link>
      {text.slice(at)}
    </>
  );
}
