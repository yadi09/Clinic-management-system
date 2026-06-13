import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepperProps {
  steps: string[];
  /** zero-based index of the active step */
  current: number;
  className?: string;
}

/** Horizontal numbered stepper matching the onboarding / registration wizards. */
export function Stepper({ steps, current, className }: StepperProps) {
  return (
    <ol className={cn("flex items-center", className)}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className={cn("flex items-center", i < steps.length - 1 && "flex-1")}>
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary bg-primary text-primary-foreground",
                  !done && !active && "border-border bg-card text-muted-foreground",
                )}
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span className={cn("text-xs font-semibold", active || done ? "text-brand" : "text-muted-foreground")}>{label}</span>
            </div>
            {i < steps.length - 1 && <div className={cn("mx-2 h-0.5 flex-1", done ? "bg-primary" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}
