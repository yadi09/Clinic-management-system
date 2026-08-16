// The parts of a visit record, told apart at a glance.
//
// The form used to be one flat column: teeth, procedure, notes, prescriptions and
// images all at the same weight, separated by nothing but a hairline. A dentist
// glancing down at it with gloved hands could not tell where the note ended and the
// prescription began, and "Prescriptions" — a whole clinical act — read as quietly
// as a field label. Everything looked equally important, which is the same as
// nothing looking important.
//
// Each part is now its own surface with an icon, a title, its own count, and its own
// primary action in the top-right where the eye already is. The form behind them is
// tinted so the cards lift off it; that contrast is doing the work, not decoration.
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function RecordSection({
  icon: Icon, title, hint, count, action, children, tone = "default",
}: {
  icon: LucideIcon;
  title: string;
  /** One line under the title. Say what the section is for, not what it contains. */
  hint?: string;
  /** Shown as a pill next to the title when there is something to count. */
  count?: number;
  /** The section's own primary action, top-right. */
  action?: ReactNode;
  children: ReactNode;
  tone?: "default" | "clinical" | "rx" | "media";
}) {
  const tint = {
    default: "bg-muted text-muted-foreground",
    clinical: "bg-brand/10 text-brand",
    rx: "bg-emerald-100 text-emerald-700",
    media: "bg-violet-100 text-violet-700",
  }[tone];
  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <header className="flex flex-wrap items-start gap-3 border-b px-4 py-3">
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", tint)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold leading-tight">
            {title}
            {count !== undefined && count > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-muted-foreground">
                {count}
              </span>
            )}
          </h3>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * What an empty section says.
 *
 * "No prescriptions yet." in grey 12px told the dentist nothing they could act on.
 * An empty state is an invitation: name the thing, say when you would want it, and
 * put the action in the middle where it is unmissable.
 */
export function EmptySlot({ icon: Icon, title, hint, action }: {
  icon: LucideIcon; title: string; hint?: string; action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed px-4 py-7 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-2.5 text-sm font-medium">{title}</p>
      {hint && <p className="mt-0.5 max-w-xs text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
