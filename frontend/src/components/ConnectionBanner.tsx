// The line under the top bar that says when the server cannot be reached. Everything
// else on the screen keeps working; this only stops anyone assuming a save went through.
import { WifiOff } from "lucide-react";

import { useLink } from "@/lib/connection";

export function ConnectionBanner() {
  const link = useLink();
  if (link === "ok") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-16 z-30 flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 sm:px-6"
    >
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
      {link === "down"
        ? "No connection to the server. Changes you make now may not be saved. This clears by itself when the connection is back."
        : "The server is slow to answer. Changes may take longer to save: check they went through before doing them again."}
    </div>
  );
}
