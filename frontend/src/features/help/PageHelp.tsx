import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { HelpCircle } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { helpForPath } from "@/features/help/content";

// PageHelp renders a "How this works" button for the current route (nothing if the
// route has no help yet). Mounted once in the app header.
export function PageHelp() {
  const { pathname } = useLocation();
  const entry = helpForPath(pathname);
  const [open, setOpen] = useState(false);
  if (!entry) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="How this page works"
        className="flex items-center gap-1.5 rounded-md border border-white/20 px-2.5 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10 hover:text-white"
      >
        <HelpCircle className="h-4 w-4" /> How this works
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{entry.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{entry.purpose}</p>

          {entry.sections?.length ? (
            <div className="space-y-2.5">
              {entry.sections.map((s) => (
                <div key={s.h}>
                  <p className="text-sm font-medium">{s.h}</p>
                  <p className="text-sm text-muted-foreground">{s.body}</p>
                </div>
              ))}
            </div>
          ) : null}

          {entry.columns?.length ? (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What the columns mean</p>
              <dl className="divide-y rounded-md border text-sm">
                {entry.columns.map((c) => (
                  <div key={c.name} className="flex gap-3 px-3 py-1.5">
                    <dt className="w-28 shrink-0 font-medium">{c.name}</dt>
                    <dd className="text-muted-foreground">{c.desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {entry.tips?.length ? (
            <ul className="list-disc space-y-1 rounded-md bg-muted/50 px-5 py-3 text-sm text-muted-foreground">
              {entry.tips.map((t) => <li key={t}>{t}</li>)}
            </ul>
          ) : null}

          <Link to="/help" onClick={() => setOpen(false)} className="text-sm font-medium text-primary hover:underline">
            Open the Help Center →
          </Link>
        </DialogContent>
      </Dialog>
    </>
  );
}
