// One surface for the record, instead of six stacked cards.
//
// The page used to be a filing cabinet: tooth chart, balance, examinations, treatment
// plans, payment history and a second copy of the images, each a full-width card, each
// always open. A three-plan patient ran to about seven screens, most of it not what
// the clinician came for — and the images were rendered twice, with two delete buttons
// for the same file.
//
// The cockpit above answers "what is happening now". Everything here is reference:
// one panel at a time, chosen from a rail that shows what each one holds so you can
// tell whether it is worth opening. The choice is remembered per patient, because a
// dentist who works from the chart wants the chart, every time.
import { useEffect, useState, type ReactNode } from "react";
import { CalendarRange, ClipboardList, FileCheck2, Images, Receipt, Grid3x3, MessageSquare, Stethoscope } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface ShelfPanel {
  key: string;
  label: string;
  icon: typeof Receipt;
  /** Shown on the rail — the count, or a dot for "there is something here". */
  badge?: ReactNode;
  render: () => ReactNode;
}

export const SHELF_ICONS = { CalendarRange, ClipboardList, FileCheck2, Images, Receipt, Grid3x3, MessageSquare, Stethoscope };

export function RecordShelf({ patientId, panels }: { patientId: string; panels: ShelfPanel[] }) {
  const storeKey = `dental-shelf:${patientId}`;
  const [active, setActive] = useState(() => panels[0]?.key ?? "");

  // Per patient, not global: the panel you want for the patient mid-root-canal is not
  // the one you want for the new registration you open next.
  //
  // A link that names a panel (?panel=money, from the dashboard's "who owes you")
  // wins over the remembered one: the person clicked through to see exactly that.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("panel");
    const saved = asked && panels.some((p) => p.key === asked) ? asked : sessionStorage.getItem(storeKey);
    if (saved && panels.some((p) => p.key === saved)) setActive(saved);
  }, [storeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (k: string) => { setActive(k); sessionStorage.setItem(storeKey, k); };
  // Panels stay mounted once opened, hidden rather than unmounted.
  //
  // Rendering only the active panel destroyed anything in progress inside the others:
  // switching to the chart to check a tooth mid-examination threw the half-written
  // examination away, silently, with no warning and no draft. Keeping visited panels
  // alive is cheaper than teaching every panel to persist its own form.
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  // A panel can disappear (images revoked, examinations hidden from the desk); never
  // render a blank shelf because the remembered choice no longer exists.
  const current = panels.find((p) => p.key === active) ?? panels[0];
  useEffect(() => { if (current) setVisited((v) => (v.has(current.key) ? v : new Set(v).add(current.key))); }, [current?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!current) return null;

  return (
    <Card className="overflow-clip">
      <div className="flex flex-col lg:flex-row">
        <nav
          aria-label="Patient record"
          className="scrollbar-none flex shrink-0 gap-1 overflow-x-auto border-b p-2 lg:w-56 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r"
        >
          {panels.map((p) => {
            const on = p.key === current.key;
            const Icon = p.icon;
            return (
              <button
                key={p.key}
                type="button"
                aria-current={on ? "page" : undefined}
                onClick={() => pick(p.key)}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors lg:w-full",
                  on ? "bg-brand/10 text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="whitespace-nowrap">{p.label}</span>
                {/* At every width: hiding badges below lg dropped the Money "!"
                    and failed-message count exactly where the desk works by phone. */}
                {p.badge != null && (
                  <span className={cn("ml-auto rounded-full px-1.5 text-xs tabular-nums",
                    on ? "bg-brand/15" : "bg-muted-foreground/10")}>
                    {p.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <CardContent className="min-w-0 flex-1 p-4">
          {panels.filter((p) => visited.has(p.key) || p.key === current.key).map((p) => (
            <div key={p.key} hidden={p.key !== current.key} aria-hidden={p.key !== current.key}>
              {p.render()}
            </div>
          ))}
        </CardContent>
      </div>
    </Card>
  );
}

/**
 * Card chrome that a shelf panel does not want.
 *
 * These components each render as a standalone Card elsewhere in the app. Inside the
 * shelf they are already in one, and nesting a bordered card in a bordered card is
 * the visual noise this whole surface exists to remove. `bare` swaps the wrapper for
 * a plain element and drops the duplicated padding.
 */
export function PanelCard({ bare, children, className }: { bare?: boolean; children: ReactNode; className?: string }) {
  if (bare) return <div className={className}>{children}</div>;
  return <Card className={className}>{children}</Card>;
}
export function PanelHeader({ bare, children, className }: { bare?: boolean; children: ReactNode; className?: string }) {
  if (bare) return <div className={cn("mb-3 flex flex-wrap items-center justify-between gap-2", className)}>{children}</div>;
  return <CardHeader className={className}>{children}</CardHeader>;
}
export function PanelBody({ bare, children, className }: { bare?: boolean; children: ReactNode; className?: string }) {
  if (bare) return <div className={className}>{children}</div>;
  return <CardContent className={className}>{children}</CardContent>;
}
