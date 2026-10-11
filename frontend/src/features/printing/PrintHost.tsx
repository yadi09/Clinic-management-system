// The preview every printed paper goes through: see it, change the template or the
// paper for this one print, then send it to the printer.
import { useEffect, useMemo, useRef, useState } from "react";
import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { docInfo } from "@/features/printing/catalog";
import { paperPx, previewHtml, type PrintJob } from "@/features/printing/engine";
import { printNow, registerPreview } from "@/features/printing/request";
import { PAPERS, type PaperId } from "@/features/printing/settings";
import type { PrintCtx } from "@/features/printing/blocks";

type Job = PrintJob & { ctx: PrintCtx };

export function PrintHost() {
  const [job, setJob] = useState<Job | null>(null);
  const [template, setTemplate] = useState<string | undefined>();
  const [paper, setPaper] = useState<PaperId | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    registerPreview((j) => { setTemplate(undefined); setPaper(undefined); setJob(j); });
    return () => registerPreview(null);
  }, []);

  const info = job ? docInfo(job.doc) : undefined;
  const view = useMemo(() => (job ? job.render({ template, paper, duplicate: job.duplicate }) : null), [job, template, paper]);
  const current = info?.templates.find((t) => t.id === (template ?? view?.template));
  const papers = current?.papers ?? [];

  const close = () => setJob(null);
  const print = async () => {
    if (!job || !view) return;
    setBusy(true);
    try { await printNow(job, { template: view.template, paper: view.paper }); } finally { setBusy(false); }
    close();
  };

  return (
    <Dialog open={!!job} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Print preview</DialogTitle>
          <DialogDescription>
            {job?.duplicate
              ? `This has been printed before. It will be marked ${job.ctx.settings.integrity.duplicateText}.`
              : "Check the paper, then print. Change the layout or paper for this print if you need to."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3">
            {view && <PaperFrame html={view.html} paper={view.paper} />}
          </div>
          <div className="space-y-3">
            {info && info.templates.length > 1 && (
              <div className="space-y-1.5">
                <Label>Layout</Label>
                <div className="space-y-1.5" role="radiogroup" aria-label="Layout">
                  {info.templates.map((t) => (
                    <button key={t.id} type="button" role="radio" aria-checked={view?.template === t.id}
                      onClick={() => { setTemplate(t.id); setPaper(undefined); }}
                      className={`w-full rounded-md border px-3 py-2 text-left text-sm ${view?.template === t.id ? "border-brand bg-brand/5" : "hover:bg-accent"}`}>
                      <span className="font-medium">{t.label}</span>
                      <span className="block text-xs text-muted-foreground">{t.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {papers.length > 1 && (
              <div className="space-y-1.5">
                <Label>Paper</Label>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Paper">
                  {papers.map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={view?.paper === p}
                      onClick={() => setPaper(p)}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium ${view?.paper === p ? "border-brand bg-brand text-brand-foreground" : "hover:bg-accent"}`}>
                      {PAPERS[p].label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={print} loading={busy}><Printer className="h-4 w-4" /> Print</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One page drawn at its real paper size, then scaled to fit what room there is. */
export function PaperFrame({ html, paper, maxWidth }: { html: string; paper: PaperId; maxWidth?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(maxWidth ?? 640);
  const [height, setHeight] = useState<number | null>(null);
  const { w, h } = paperPx(paper);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = Math.min(1, Math.max(0.2, (width - 2) / w));
  const pageH = h ?? height ?? 640;

  return (
    <div ref={box} className="w-full">
      <div style={{ width: w * scale, height: pageH * scale }} className="mx-auto overflow-hidden bg-white shadow-md">
        <iframe
          ref={frame}
          title="Paper preview"
          srcDoc={previewHtml(html, paper)}
          style={{ width: w, height: pageH, border: 0, transform: `scale(${scale})`, transformOrigin: "top left", background: "#fff" }}
          onLoad={() => {
            if (h !== null) return;
            const b = frame.current?.contentDocument?.body;
            if (b) setHeight(Math.max(240, b.scrollHeight + 24));
          }}
        />
      </div>
    </div>
  );
}
