// What a screen shows when its data did not load.
//
// The money screens used to fall straight through to their empty state on a failed
// request, so a network hiccup read as an all-clear: the chair said "Nobody waiting",
// the cashier "No pending payments", the ledger "Nothing billed" (audit D26). An
// error must look like an error, and offer the way back.
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        Could not load {what}. This is not the same as there being none — check the connection and try again.
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}><RotateCw className="h-3.5 w-3.5" /> Retry</Button>
    </div>
  );
}
